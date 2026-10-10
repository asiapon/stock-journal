-- ============================================================
-- stock-journal 交易记录与分析系统 · PostgreSQL 数据结构设计（专业加固版）
--
-- 设计要点：
--   1. 双账本：holdings 同时维护「加权平均成本」（统计权威）
--      和「摊薄成本」（展示口径），互不污染
--   2. 每笔卖出的已实现盈亏在成交时落库（transactions.realized_pnl），
--      按当时的加权平均成本计算，永不回头改
--   3. 轮次（round trip）= 空仓→建仓→清仓的完整过程，胜率统计基本单位
--   4. 费用成交时算好落库；费率挂在账户上可配置；DB 层用 CHECK 校验费用自洽
--   5. 支持公司行为：分红/送转/配股
--   6. 记录带分析维度：理由标签、事前计划、结果标签
--
-- 精度与舍入约定（对齐券商交割单）：
--   · 价格：NUMERIC(10,4)，A股 tick=0.01，4位兼容基金/债券净值
--   · 费用与金额：NUMERIC(18,4) 存储，展示层四舍五入到分（0.01）
--   · 舍入规则统一 ROUND_HALF_UP，禁止 float/money 类型
--   · 数量：INT，A股整手交易（科创板/北交所例外由应用层校验）
--
-- A股费率体系（口径与 trade-manager 完全一致，单位 ‰ 千分比）：
--   rate     佣金      双向   0.06‰，最低 5 元/笔
--   stamp    印花税    仅卖出 0.5‰   （2023-08-28 减半后现行）
--   transfer 过户费    双向   0.01‰  （沪深北均收）
--   handling 经手费    双向   沪深 0.034‰ / 北交所 0.125‰
--   gov      证管费    双向   沪深 0.02‰  / 北交所 0（北交所无此项）
--   红利税   卖出时补扣：持股>1年免，1月~1年 10%，<1月 20%
--            （券商按先进先出自动算，交割单体现，本表记入 other_fee）
-- ============================================================

-- ------------------------------------------------------------
-- 公共：updated_at 自动维护
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- 用户
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    password_hash VARCHAR(200) NOT NULL,
    role          VARCHAR(10)  NOT NULL DEFAULT 'user'
                  CHECK (role IN ('admin', 'user')),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- 账户（多券商/多策略分户）。费率不在本表——独立 fee_schedules 表，版本化管理
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id        BIGINT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           VARCHAR(50)   NOT NULL DEFAULT 'default',
    broker         VARCHAR(50),                   -- 券商名，备忘
    account_no     VARCHAR(30),                   -- 资金账号（脱敏存尾4位亦可）
    initial_assets NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (initial_assets >= 0),
    cash           NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (cash >= 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);
CREATE TRIGGER trg_accounts_touch BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ------------------------------------------------------------
-- 费率表：版本化、可调整、可追溯
--   · 一行 = 一个生效版本；调费率 = 插入新行（旧行改 effective_to，永不 UPDATE 数值）
--   · account_id 为 NULL 表示全局默认；账户可覆盖全局（如谈了专属佣金）
--   · 取费率规则：优先 account+market+成交日命中的版本，否则全局+market+成交日
--   · 单位 ‰（千分比），口径与 trade-manager 一致；min_commission 为佣金最低收费（元）
--   · stamp_duty_only_sell 由引擎遵守（A股现行规则），此处不设开关避免误配置
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_schedules (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id      BIGINT REFERENCES accounts(id) ON DELETE CASCADE,  -- NULL = 全局默认
    market          VARCHAR(2)  NOT NULL CHECK (market IN ('sh', 'sz', 'bj')),

    rate            NUMERIC(10,6) NOT NULL CHECK (rate >= 0),           -- 佣金（双向）
    min_commission  NUMERIC(10,4) NOT NULL DEFAULT 5 CHECK (min_commission >= 0),
    stamp           NUMERIC(10,6) NOT NULL DEFAULT 0.5 CHECK (stamp >= 0),      -- 印花税（仅卖出）
    transfer        NUMERIC(10,6) NOT NULL DEFAULT 0.01 CHECK (transfer >= 0),  -- 过户费（双向）
    handling        NUMERIC(10,6) NOT NULL DEFAULT 0.034 CHECK (handling >= 0), -- 经手费（双向）
    gov             NUMERIC(10,6) NOT NULL DEFAULT 0.02 CHECK (gov >= 0),       -- 证管费（双向，北交所为0）
    other           JSONB,                                              -- 预留：红利税等特殊项

    effective_from  DATE NOT NULL,
    effective_to    DATE,                                               -- NULL = 长期有效
    note            VARCHAR(200),                                       -- 如"2026年调佣至万0.8"

    -- 归一化键：无账户时用 0，供排他约束分组（生成列，免维护）
    account_key     BIGINT GENERATED ALWAYS AS (COALESCE(account_id, 0)) STORED,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- 校验：区间合法
    CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX idx_fee_lookup ON fee_schedules(account_id, market, effective_from DESC);
CREATE INDEX idx_fee_global ON fee_schedules(market, effective_from DESC)
    WHERE account_id IS NULL;

-- 防重叠：同账户（或全局）同市场在同一日期最多一个生效版本
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE fee_schedules ADD CONSTRAINT uq_fee_no_overlap
    EXCLUDE USING gist (
        account_key WITH =,
        market      WITH =,
        daterange(effective_from, effective_to, '[)') WITH &&
    );

-- 取费率函数：交易入库时调用，返回成交日生效的费率行
CREATE OR REPLACE FUNCTION fn_get_fee_rate(
    p_account_id BIGINT, p_market VARCHAR, p_trade_date DATE
) RETURNS SETOF fee_schedules AS $$
    SELECT * FROM fee_schedules
    WHERE market = p_market
      AND effective_from <= p_trade_date
      AND (effective_to IS NULL OR effective_to >= p_trade_date)
      AND (account_id = p_account_id OR account_id IS NULL)
    ORDER BY account_id NULLS LAST, effective_from DESC
    LIMIT 1;   -- 账户级优先于全局
$$ LANGUAGE sql STABLE;

-- ------------------------------------------------------------
-- 轮次：空仓→建仓→清仓（统计基本单位）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rounds (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id     BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    stock_code     VARCHAR(10)  NOT NULL,
    stock_name     VARCHAR(50),
    status         VARCHAR(10)  NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'closed')),
    opened_at      DATE NOT NULL,
    closed_at      DATE,

    buy_count      INT NOT NULL DEFAULT 0 CHECK (buy_count  >= 0),
    sell_count     INT NOT NULL DEFAULT 0 CHECK (sell_count >= 0),
    total_buy_qty  BIGINT NOT NULL DEFAULT 0 CHECK (total_buy_qty  >= 0),
    total_sell_qty BIGINT NOT NULL DEFAULT 0 CHECK (total_sell_qty >= 0),

    realized_pnl   NUMERIC(18,4) NOT NULL DEFAULT 0,
    total_buy_cost NUMERIC(18,4) NOT NULL DEFAULT 0,   -- 整轮买入含费总投入
    total_sell_net NUMERIC(18,4) NOT NULL DEFAULT 0,   -- 整轮卖出净得（含费后）

    max_high       NUMERIC(10,4),                      -- 期间最高价（行情回填）
    max_low        NUMERIC(10,4),
    max_drawdown   NUMERIC(10,4),

    is_base_position BOOLEAN NOT NULL DEFAULT false,   -- 底仓：手动封轮，永不闭合
    note           VARCHAR(500),

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 闭合轮次必须有闭合日；在途轮次不允许有
    CHECK ((status = 'closed' AND closed_at IS NOT NULL AND closed_at >= opened_at)
        OR (status = 'open'  AND closed_at IS NULL))
);
CREATE INDEX idx_rounds_account_status ON rounds(account_id, status);
CREATE INDEX idx_rounds_stock ON rounds(stock_code);
CREATE UNIQUE INDEX uq_rounds_open ON rounds(account_id, stock_code)
    WHERE status = 'open';
CREATE TRIGGER trg_rounds_touch BEFORE UPDATE ON rounds
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ------------------------------------------------------------
-- 交易流水：唯一事实源（append-only + 冲正标记，不物理删除）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id       BIGINT      NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    round_id         BIGINT      REFERENCES rounds(id),

    transaction_time TIMESTAMPTZ NOT NULL,
    -- 交易日（按上海时区取日期，生成列，报文分组/对账用，应用层免维护）
    trade_date       DATE GENERATED ALWAYS AS
                     ((transaction_time AT TIME ZONE 'Asia/Shanghai')::date) STORED,
    stock_code       VARCHAR(10) NOT NULL,
    stock_name       VARCHAR(50),
    market           VARCHAR(2)  NOT NULL CHECK (market IN ('sh', 'sz', 'bj')),

    transaction_type VARCHAR(12) NOT NULL
                     CHECK (transaction_type IN
                       ('buy', 'sell', 'dividend', 'split', 'rights',
                        'transfer_in', 'transfer_out')),
    quantity         INT,                -- buy/sell 必填>0；dividend 可空；split 用 ratio
    price            NUMERIC(10,4),      -- buy/sell 成交价；rights 配股价；dividend=每股股利
    ratio            NUMERIC(10,6),      -- split：每10送X → 0.X

    -- ---- 费用明细：成交时按账户 fee_config 对应市场费率算好落库 ----
    -- 命名对应 trade-manager：commission=broker(佣金rate)，其余同名；单位元，精度0.0001，展示取2位
    commission       NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (commission  >= 0),
    stamp_duty       NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (stamp_duty  >= 0),
    transfer_fee     NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (transfer_fee >= 0),
    handling_fee     NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (handling_fee >= 0),
    gov_fee          NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (gov_fee     >= 0),
    other_fee        NUMERIC(12,4) NOT NULL DEFAULT 0 CHECK (other_fee   >= 0),  -- 红利税等
    fee_total        NUMERIC(12,4) NOT NULL DEFAULT 0,
    gross_amount     NUMERIC(18,4),      -- 成交金额 = qty*price
    net_amount       NUMERIC(18,4),      -- buy: gross+费；sell: gross-费

    -- ---- 双账本核心 ----
    cost_price_at    NUMERIC(10,6),      -- 成交时点加权平均成本价快照（审计/对账）
    realized_pnl     NUMERIC(18,4),      -- 本笔卖出已实现盈亏 = net_amount - qty*cost_price_at

    -- ---- 分析维度 ----
    reason_tag       VARCHAR(20),        -- breakout/technical/news/follow/add_down/plan_other
    plan             JSONB,              -- {"target_price":x,"stop_price":y,"expect_days":n}
    result_tag       VARCHAR(20),        -- as_expected/trapped/panic_sold/took_profit
    note             VARCHAR(1000),
    source           VARCHAR(10) NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual', 'ai', 'import')),
    voided           BOOLEAN NOT NULL DEFAULT false,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- ---- 业务规则硬约束（数据库兜底，不依赖应用层自觉）----
    -- 买卖：数量价格必填且为正
    CHECK (NOT transaction_type IN ('buy', 'sell')
           OR (quantity > 0 AND price > 0)),
    -- 分红：每股股利必填
    CHECK (transaction_type <> 'dividend' OR (price > 0 AND quantity IS NULL)),
    -- 送转：比例必填
    CHECK (transaction_type <> 'split' OR (ratio > 0)),
    -- 配股：配股价与数量必填
    CHECK (transaction_type <> 'rights' OR (quantity > 0 AND price > 0)),
    -- realized_pnl 只允许出现在卖出上
    CHECK (transaction_type = 'sell' OR realized_pnl IS NULL),
    -- 费用自洽：fee_total 必须等于明细之和（容差 0.0001 吸收舍入）
    CHECK (abs(fee_total - (commission + stamp_duty + transfer_fee
                            + handling_fee + gov_fee + other_fee)) < 0.0001),
    -- 买卖必须有成交金额
    CHECK (NOT transaction_type IN ('buy', 'sell') OR gross_amount IS NOT NULL),
    -- 印花税只允许出现在卖出（A股现行规则）
    CHECK (transaction_type = 'sell' OR stamp_duty = 0)
);

CREATE INDEX idx_tx_account_time ON transactions(account_id, transaction_time DESC);
CREATE INDEX idx_tx_account_date ON transactions(account_id, trade_date);
CREATE INDEX idx_tx_stock        ON transactions(account_id, stock_code);
CREATE INDEX idx_tx_round        ON transactions(round_id) WHERE round_id IS NOT NULL;
-- 幂等：同账户同秒同票同向同量同价视为重复（导入对账单保护；冲正记录除外）
CREATE UNIQUE INDEX uq_tx_idempotent ON transactions(
    account_id, transaction_time, stock_code, transaction_type,
    COALESCE(quantity, 0), COALESCE(price, 0))
    WHERE voided = false;
CREATE TRIGGER trg_tx_touch BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ------------------------------------------------------------
-- 持仓快照：双账本并存
--   avg_cost / cost_value       加权平均账本（统计权威）
--   diluted_cost / ..._value    摊薄账本（展示）
--   数量/成本由引擎在同一事务里随 transactions 更新，此处只存结果
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holdings (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id         BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    round_id           BIGINT REFERENCES rounds(id),
    stock_code         VARCHAR(10) NOT NULL,
    stock_name         VARCHAR(50),
    market             VARCHAR(2)  NOT NULL CHECK (market IN ('sh', 'sz', 'bj')),

    quantity           INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    avg_cost           NUMERIC(10,6) NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),
    cost_value         NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (cost_value >= 0),

    diluted_cost       NUMERIC(10,6) NOT NULL DEFAULT 0,   -- 摊薄可为负（盈利滚入），允许
    diluted_cost_value NUMERIC(18,4) NOT NULL DEFAULT 0,
    realized_pnl_acc   NUMERIC(18,4) NOT NULL DEFAULT 0,   -- 未闭合部分的累计已实现盈亏

    latest_date        DATE NOT NULL DEFAULT CURRENT_DATE,
    latest_buy_qty     INT  NOT NULL DEFAULT 0 CHECK (latest_buy_qty >= 0),

    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 数量与成本联动：0 股必须有 0 成本
    CHECK ((quantity = 0 AND cost_value = 0)
        OR (quantity > 0 AND cost_value >= 0))
    -- avg_cost = cost_value/quantity 的自洽性由引擎在同一事务保证（除法精度不舍入存储）
);
CREATE UNIQUE INDEX uq_holding ON holdings(account_id, stock_code);
CREATE TRIGGER trg_holdings_touch BEFORE UPDATE ON holdings
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ------------------------------------------------------------
-- 日终持仓快照（资金曲线/回撤分析原料，行情任务回填收盘价）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS position_snapshots (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id   BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    snap_date    DATE   NOT NULL,
    stock_code   VARCHAR(10) NOT NULL,
    quantity     INT NOT NULL CHECK (quantity >= 0),
    avg_cost     NUMERIC(10,6),
    close_price  NUMERIC(10,4),
    market_value NUMERIC(18,4),
    float_pnl    NUMERIC(18,4),
    UNIQUE (account_id, snap_date, stock_code)
);

-- ============================================================
-- 视图：统计层直接消费
-- ============================================================

-- 已闭合轮次（胜率原料；在途轮次天然排除；check_pnl 用于对账校验）
CREATE OR REPLACE VIEW v_closed_rounds AS
SELECT
    r.*,
    (r.total_sell_net - r.total_buy_cost) AS check_pnl,
    (r.closed_at - r.opened_at)           AS holding_days,
    CASE WHEN r.realized_pnl > 0 THEN 1 ELSE 0 END AS is_win
FROM rounds r
WHERE r.status = 'closed';

-- 账户级汇总：胜率 / 盈亏比 / 持有天数（割盈持亏检测就看最后两列）
CREATE OR REPLACE VIEW v_round_stats AS
SELECT
    account_id,
    COUNT(*)                                                AS total_rounds,
    SUM(is_win)                                             AS win_rounds,
    ROUND(SUM(is_win)::NUMERIC / COUNT(*), 4)               AS win_rate,
    ROUND(AVG(realized_pnl) FILTER (WHERE is_win = 1), 2)   AS avg_win,
    ROUND(AVG(realized_pnl) FILTER (WHERE is_win = 0), 2)   AS avg_loss,
    ROUND(AVG(realized_pnl) FILTER (WHERE is_win = 1)
          / NULLIF(-AVG(realized_pnl) FILTER (WHERE is_win = 0), 0), 4)
                                                            AS profit_loss_ratio,
    ROUND(AVG(holding_days) FILTER (WHERE is_win = 1), 1)   AS avg_win_days,
    ROUND(AVG(holding_days) FILTER (WHERE is_win = 0), 1)   AS avg_loss_days
FROM v_closed_rounds
GROUP BY account_id;

-- 买入理由 × 轮次结果 交叉表（理由标签挂在轮次首笔买入上）
CREATE OR REPLACE VIEW v_reason_stats AS
WITH round_reason AS (
    SELECT DISTINCT ON (t.round_id)
        t.round_id, t.reason_tag
    FROM transactions t
    WHERE t.transaction_type = 'buy' AND t.voided = false AND t.reason_tag IS NOT NULL
    ORDER BY t.round_id, t.transaction_time
)
SELECT
    r.account_id,
    rr.reason_tag,
    COUNT(*)                                                     AS round_count,
    ROUND(AVG(r.realized_pnl), 2)                                AS avg_pnl_per_round,
    ROUND(SUM(r.realized_pnl > 0)::NUMERIC / COUNT(*), 4)        AS win_rate,
    ROUND(AVG(r.holding_days), 1)                                AS avg_holding_days
FROM rounds r
JOIN round_reason rr ON rr.round_id = r.id
WHERE r.status = 'closed'
GROUP BY r.account_id, rr.reason_tag;

-- ============================================================
-- 初始数据：全局默认费率（口径 = trade-manager DEFAULT_COST_SETTINGS，单位‰）
-- 调整费率时：UPDATE 旧行 effective_to = 变更日前一天，再 INSERT 新版本
-- ============================================================
INSERT INTO fee_schedules (account_id, market, rate, min_commission, stamp, transfer, handling, gov, effective_from, note)
VALUES
    (NULL, 'sh',  0.06, 5, 0.5, 0.01, 0.034, 0.02, '2024-01-01', '全局默认·沪市'),
    (NULL, 'sz',  0.06, 5, 0.5, 0.01, 0.034, 0.02, '2024-01-01', '全局默认·深市'),
    (NULL, 'bse', 0.06, 5, 0.5, 0.01, 0.125, 0,    '2024-01-01', '全局默认·北交所');

-- ============================================================
-- 核算引擎伪代码（应用层实现约定，注释即规范）：
--
--   取费率：SELECT * FROM fn_get_fee_rate(account_id, market, trade_date)
--
--   buy:  new_cost_value = cost_value + gross_amount + fee_total
--         new_avg_cost   = new_cost_value / new_quantity      -- 中间过程不舍入
--         （摊薄账本：diluted_cost_value += net_amount）
--
--   sell: realized_pnl  = net_amount - quantity * avg_cost     -- 按旧 avg_cost
--         cost_value   -= quantity * avg_cost                  -- 只减份额，avg_cost 不变
--         （摊薄账本：diluted_cost_value -= net_amount → 盈亏自动滚入）
--
--   清仓(quantity归0)：轮次 closed，realized_pnl 定稿，卖飞/逃顶回填触发
--   分红：记 income（不动成本，与轮次统计兼容）；送转：qty 调整 + avg_cost 等比下调
-- ============================================================

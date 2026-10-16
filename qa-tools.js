/* ============================================================
   v3.9.7 智能问答工具层（qa-tools.js）
   来源：trade-manager-97288 的「取数技能 + 选股技能」两层，本项目按需裁剪后整体迁移。
   ------------------------------------------------------------
   为什么单开一个文件：app.js 已经很长，工具层是"纯取数 + 纯计算"，
   与 UI/存储无关，单独成文件便于日后维护；它是普通脚本（非 module），
   在 index.html 里排在 analysis-extra.js 之后，因此可以直接复用
   analysis-extra.js 已经挂在全局词法作用域上的 state / fmtWan /
   parseJsonLoose / marketOf / qSnapshot / fetchQuotesTencent / computePositions。
   ------------------------------------------------------------
   相对源站的裁剪（源站有、本项目不迁）：
     · 妙想（mxapi.eastmoney.com）需要 OAuth Key 的技能中心与凭证体系；
       连同 mxQuery / mxNormalize / qaToolMxScreen / qaToolMxBlock / 技能开关一并去掉。
       —— 好处是：本项目所有取数**全部免费、无需任何 Key、不限次数**，
          代码里所有"需要启用技能"的提示分支也一并没有了。
     · 问答范围的 sysPrompt 设置、视觉模型选择（属核心对话层，已在 app.js）。
   相对源站保留的「绝不静默出错」约定：
     · 认不出的标的 → 返回 null，交给模型按自身知识回答，不编造；
     · 算不出来的筛选条件（如 MACD 顶背离、筹码分布）→ 明确报错并列替代问法，
       绝不把「近5日累计涨幅」偷偷换成「当日涨幅」后给一份"看着正常"的名单。
   ============================================================ */
'use strict';

/* ============================================================
   一、基础工具
   ============================================================ */
const DC_BASE = 'https://datacenter-web.eastmoney.com/api/data/v1/get?';

/* 东财返回里数值字段常是字符串（'-' 表示无数据），统一转 number 或 null */
function nOr(v) {
  return typeof v === 'number' ? v
    : (v !== undefined && v !== null && v !== '-' && !isNaN(parseFloat(v)) ? parseFloat(v) : null);
}
/* 只有 qa-tools 内部用到的局部今天字符串（app.js 里的同名变量是函数内局部量，互不影响） */
function todayStr() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* 取最近一个可用报告期：先问「最新 REPORTDATE」，失败则按今天往回推季度末 */
async function latestReportDate() {
  try {
    const url = DC_BASE + 'reportName=RPT_LICO_FN_CPD&columns=REPORTDATE&pageSize=1&pageNumber=1'
      + '&sortColumns=REPORTDATE&sortTypes=-1';
    const r = await fetch(url);
    const j = await r.json();
    const d = (j && j.result && j.result.data) || [];
    const dt = d[0] && String(d[0].REPORTDATE || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dt)) return dt;
  } catch (e) { /* 走下面的兜底 */ }
  const now = new Date();
  const qs = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i * 3, 1);
    const y = d.getFullYear(), m = d.getMonth();
    const qEnd = m < 3 ? [y - 1, 12] : [y, Math.floor(m / 3) * 3];
    const s = qEnd[0] + '-' + String(qEnd[1]).padStart(2, '0') + '-' + (qEnd[1] === 12 ? '31' : '30');
    if (qs.indexOf(s) < 0) qs.push(s);
  }
  return qs[0];
}

/* 取最近交易日（估值表的 TRADE_DATE 是 'YYYY-MM-DD 00:00:00' 格式） */
async function latestTradeDate() {
  try {
    const url = DC_BASE + 'reportName=RPT_VALUEANALYSIS_DET&columns=TRADE_DATE&pageSize=1&pageNumber=1'
      + '&sortColumns=TRADE_DATE&sortTypes=-1';
    const r = await fetch(url);
    const j = await r.json();
    const d = (j && j.result && j.result.data) || [];
    const dt = d[0] && String(d[0].TRADE_DATE || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dt)) return dt;
  } catch (e) { /* 兜底 */ }
  return todayStr();
}

/* 分页拉全量（pageSize 上限实测 500）。失败时若已有数据就截断返回，一条都没有才抛错。
   v3.9.13 审计：每轮拉取记一条——报告名/过滤条件/取得行数；0 行明示「未获取到」。 */
async function dcFetchAll(report, columns, filter, onPage) {
  const t0 = Date.now();
  const out = [];
  const url0 = DC_BASE + 'reportName=' + report + '&columns=' + columns + '&filter=' + String(filter).slice(0, 180);
  for (let p = 1; p <= 40; p++) {
    const url = DC_BASE + 'reportName=' + report + '&columns=' + columns
      + '&pageSize=500&pageNumber=' + p + '&sortColumns=SECURITY_CODE&sortTypes=1'
      + '&filter=' + encodeURIComponent(filter);
    let d = null;
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (j && j.code && j.code !== 0) throw new Error(j.message || ('返回 code ' + j.code));
      d = (j && j.result && j.result.data) || [];
    } catch (e) {
      NetLog.push('dc', '东财数据中心 ' + report, false, Date.now() - t0, '未获取到：' + (e.message || e),
        { url: url0, req: 'filter=' + filter, resp: '已取 ' + out.length + ' 行后失败', err: e.message || String(e) });
      if (!out.length) throw e; break;
    }
    if (!d.length) break;
    out.push.apply(out, d);
    if (onPage) onPage(out.length);
    if (d.length < 500) break;
  }
  NetLog.push('dc', '东财数据中心 ' + report, out.length > 0, Date.now() - t0,
    out.length ? out.length + ' 行' : '未获取到（0 行）',
    { url: url0, req: 'filter=' + String(filter).slice(0, 200), resp: out.length + ' 行', err: out.length ? '' : '未获取到' });
  return out;
}

/* 名称→代码兜底：用「财务表 + 报告期」按证券简称精确过滤（全市场字典里没收录时的安全网） */
async function resolveCodeByNameRemote(name) {
  const nm = String(name || '').trim();
  if (!nm) return '';
  const rd = await latestReportDate();
  const url = DC_BASE + 'reportName=RPT_LICO_FN_CPD&columns=SECURITY_CODE,SECURITY_NAME_ABBR&pageSize=5&pageNumber=1'
    + '&filter=' + encodeURIComponent("(REPORTDATE='" + rd + "')(SECURITY_NAME_ABBR=\"" + nm + "\")");
  try {
    const r = await fetch(url);
    const j = await r.json();
    const d = (j && j.result && j.result.data) || [];
    const hit = d.find(function (x) { return String(x.SECURITY_NAME_ABBR || '').trim() === nm; });
    return hit ? String(hit.SECURITY_CODE || '') : '';
  } catch (e) { return ''; }
}

/* ============================================================
   二、数据源：东方财富 / 腾讯 公开接口
   源站这三个域名都验证过允许跨域，浏览器可直连：
     qt.gtimg.cn / web.ifzq.gtimg.cn        → 实时行情 + 分时（主源，可直连）
     push2.eastmoney.com                    → 实时行情 + 估值（备源）
     datacenter-web.eastmoney.com           → 全市场快照 / 财务 / 估值 / 评级 / 席位
     np-anotice-stock.eastmoney.com         → 公司公告
     search-api-web.eastmoney.com           → 个股资讯（JSONP）
   ============================================================ */
function emYi(v) { return v == null ? '--' : (v / 1e8).toFixed(2) + ' 亿'; }
function emPct(v, d) { return v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(d == null ? 1 : d) + '%'; }
function emNum(v, d) { return v == null ? '--' : Number(v).toFixed(d == null ? 2 : d); }

/* 批量实时行情：走 action-extra 里已有的腾讯批量（GBK 解码 + 80 只以内的 URL 长度都安全），
   统一成源站那套字段名；腾讯整批失败再退东财 push2。
   注意本项目 fetchQuotesTencent 的 totalCap / floatCap / amount 单位是「亿元」，
   这里换算成「元」以保持与源站 emYi(÷1e8) 的展示口径一致。 */
async function emQuotes(codes) {
  const list = [...new Set((codes || []).map(String).filter(c => /^\d{6}$/.test(c)))];
  if (!list.length) return [];
  const out = [];
  for (let i = 0; i < list.length; i += 60) {
    const part = list.slice(i, i + 60);
    const m = await fetchQuotesTencent(part).catch(function () { return {}; });
    for (const c of part) {
      const q = m[c];
      if (!q) continue;
      out.push({
        src: '腾讯', code: c, name: q.name,
        price: q.price, prevClose: q.prevClose, open: q.open,
        chg: q.chg, pct: q.pct, high: q.high, low: q.low,
        turnover: q.turnover, pe: q.pe, peLabel: '市盈率(TTM)', pb: q.pb,
        volRatio: q.volRatio, amp: q.amp, amount: q.amount,
        mktCap: q.totalCap == null ? null : q.totalCap * 1e8,     // 亿元 → 元
        floatCap: q.floatCap == null ? null : q.floatCap * 1e8,
      });
    }
  }
  /* v3.9.13 审计：整轮批量行情的覆盖情况（缺的票明示，不静默） */
  NetLog.push('dc', '腾讯批量行情(问答工具层)', out.length > 0, 0,
    out.length ? `${out.length}/${list.length} 只` : '未获取到（0 只）',
    { url: 'https://qt.gtimg.cn/q=<分批 60 只/批>', resp: out.length + '/' + list.length + ' 只' + (out.length < list.length ? `（未返回 ${list.length - out.length} 只）` : ''), err: out.length ? '' : '未获取到' });
  if (!out.length) { try { return await emQuotesEast(list); } catch (e) { /* 两条源都挂了 → 空数组 */ } }
  return out;
}

/* 东财行情备源（push2） */
async function emQuotesEast(list) {
  const t0 = Date.now();
  const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2'
    + '&fields=f2,f3,f4,f8,f9,f12,f14,f15,f16,f17,f18,f20,f21,f23'
    + '&secids=' + list.map(secidOf).join(',');
  try {
    const res = await fetch(url);
    const j = await res.json();
    const rows = ((j.data && j.data.diff) || []).map(d => ({
      src: '东财', code: d.f12, name: d.f14,
      price: nOr(d.f2), pct: nOr(d.f3), chg: nOr(d.f4),
      open: nOr(d.f17), prevClose: nOr(d.f18), high: nOr(d.f15), low: nOr(d.f16),
      turnover: nOr(d.f8), pe: nOr(d.f9), peLabel: '市盈率(动)', pb: nOr(d.f23),
      mktCap: nOr(d.f20), floatCap: nOr(d.f21),
    }));
    /* v3.9.13 审计：返回行数；缺的票如实标注 */
    NetLog.push('dc', '东财行情 push2(备源)', rows.length > 0, Date.now() - t0,
      rows.length ? `${rows.length}/${list.length} 只` : '未获取到（0 行）',
      { url, resp: rows.length + '/' + list.length + ' 只', err: rows.length ? '' : '未获取到' });
    return rows;
  } catch (e) {
    NetLog.push('dc', '东财行情 push2(备源)', false, Date.now() - t0, '未获取到：' + (e.message || e), { url, err: e.message || String(e) });
    throw e;
  }
}

/* 分页批量（板块成分表要用几十~上百只，一次 URL 会太长） */
async function emQuotesPaged(codes) {
  const list = [...new Set((codes || []).map(String).filter(function (c) { return /^\d{6}$/.test(c); }))];
  const out = [];
  for (let i = 0; i < list.length; i += 40) {
    const part = await emQuotes(list.slice(i, i + 40)).catch(function () { return []; });
    out.push.apply(out, part || []);
  }
  return out;
}

/* 东财数据中心通用取数 URL */
function dcUrl(report, filter, size, sortCol, sortType) {
  let u = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=' + report
    + '&columns=ALL&pageSize=' + (size || 1) + '&pageNumber=1';
  if (sortCol) u += '&sortColumns=' + sortCol + '&sortTypes=' + (sortType == null ? -1 : sortType);
  if (filter) u += '&filter=' + encodeURIComponent(filter);
  return u;
}
/* v3.9.13 审计小助手：单接口取数记一条（URL + 返回摘要；空结果明示「未获取到」，绝不静默） */
function qaAuditLog(name, url, t0, rows, failMsg) {
  NetLog.push('dc', name, !failMsg && rows > 0, Date.now() - t0,
    failMsg ? ('未获取到：' + failMsg) : (rows + ' 行'),
    { url, resp: failMsg ? '' : rows + ' 行', err: failMsg || '' });
}

/* 财务报表摘要（东财数据中心 · 最近一期） */
async function emFinance(code) {
  const t0 = Date.now();
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=ALL'
    + '&filter=' + encodeURIComponent('(SECURITY_CODE="' + code + '")')
    + '&pageSize=1&sortColumns=REPORTDATE&sortTypes=-1';
  try {
    const res = await fetch(url);
    const j = await res.json();
    const d = j && j.result && j.result.data && j.result.data[0];
    if (!d) { qaAuditLog('东财财务 ' + code, url, t0, 0, '返回空'); return null; }
    qaAuditLog('东财财务 ' + code, url, t0, 1);
    return {
    period: d.DATATYPE || (d.REPORTDATE || '').slice(0, 10),
    income: nOr(d.TOTAL_OPERATE_INCOME), netProfit: nOr(d.PARENT_NETPROFIT),
    roe: nOr(d.WEIGHTAVG_ROE), eps: nOr(d.BASIC_EPS), bps: nOr(d.BPS),
    grossMargin: nOr(d.XSMLL), incomeYoY: nOr(d.YSTZ), profitYoY: nOr(d.SJLTZ),
    board: d.BOARD_NAME || '', dividend: d.ASSIGNDSCRPT || '',
  };
  } catch (e) { qaAuditLog('东财财务 ' + code, url, t0, 0, e.message || String(e)); throw e; }
}

/* 估值快照（东财数据中心 · PE/PB/PS/PEG 与市值） */
async function emValuation(code) {
  const t0 = Date.now();
  const url = dcUrl('RPT_VALUEANALYSIS_DET', '(SECURITY_CODE="' + code + '")');
  try {
    const res = await fetch(url);
    const j = await res.json();
    const d = j && j.result && j.result.data && j.result.data[0];
    if (!d) { qaAuditLog('东财估值 ' + code, url, t0, 0, '返回空'); return null; }
    qaAuditLog('东财估值 ' + code, url, t0, 1);
    return {
      pe: nOr(d.PE_TTM), pb: nOr(d.PB_MRQ), ps: nOr(d.PS_TTM), pcf: nOr(d.PCF_OCF_TTM),
      peg: nOr(d.PEG_CAR), cap: nOr(d.TOTAL_MARKET_CAP),
      board: d.BOARD_NAME || '', date: String(d.TRADE_DATE || '').slice(0, 10),
    };
  } catch (e) { qaAuditLog('东财估值 ' + code, url, t0, 0, e.message || String(e)); throw e; }
}

/* 机构一致预期（东财数据中心 · 覆盖机构数 / 评级分布 / 目标价区间 / EPS 预测 / 概念板块） */
async function emRating(code) {
  const t0 = Date.now();
  const url = dcUrl('RPT_WEB_RESPREDICT', '(SECURITY_CODE="' + code + '")');
  try {
    const res = await fetch(url);
    const j = await res.json();
    const d = j && j.result && j.result.data && j.result.data[0];
    if (!d) { qaAuditLog('东财评级预期 ' + code, url, t0, 0, '返回空'); return null; }
    qaAuditLog('东财评级预期 ' + code, url, t0, 1);
  const eps = [[d.YEAR1, d.EPS1], [d.YEAR2, d.EPS2], [d.YEAR3, d.EPS3]]
    .filter(x => x[0] && x[1] != null).map(x => x[0] + 'E ' + Number(x[1]).toFixed(2));
  return {
    orgNum: nOr(d.RATING_ORG_NUM), buy: nOr(d.RATING_BUY_NUM), add: nOr(d.RATING_ADD_NUM),
    neutral: nOr(d.RATING_NEUTRAL_NUM), reduce: nOr(d.RATING_REDUCE_NUM),
    aimMax: nOr(d.DEC_AIMPRICEMAX), aimMin: nOr(d.DEC_AIMPRICEMIN),
    eps, board: d.INDUSTRY_BOARD || '',
    concepts: String(d.CONCEPTINDEX_BOARD || '').split(',').filter(Boolean).slice(0, 6),
  };
  } catch (e) { qaAuditLog('东财评级预期 ' + code, url, t0, 0, e.message || String(e)); throw e; }
}

/* 最近公告 */
async function emNotices(code, n) {
  const t0 = Date.now();
  const url = 'https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=' + (n || 6)
    + '&page_index=1&ann_type=A&client_source=web&stock_list=' + code;
  try {
    const res = await fetch(url);
    const j = await res.json();
    const list = ((j.data && j.data.list) || []).map(x => ({
      date: (x.notice_date || '').slice(0, 10),
      title: String(x.title || '').replace(/^[^:：]{2,12}[:：]/, '').trim(),
    }));
    qaAuditLog('东财公告 ' + code, url, t0, list.length, list.length ? '' : '返回空');
    return list;
  } catch (e) { qaAuditLog('东财公告 ' + code, url, t0, 0, e.message || String(e)); throw e; }
}

/* 个股相关新闻（东财搜索 · JSONP） */
async function emNews(name, n) {
  const t0 = Date.now();
  const param = encodeURIComponent(JSON.stringify({
    uid: '', keyword: name, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web', clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: n || 6 } },
  }));
  const url = 'https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=' + param;
  try {
    const res = await fetch(url);
    const text = await res.text();
    const a = text.indexOf('('), b = text.lastIndexOf(')');
    const j = parseJsonLoose(a >= 0 && b > a ? text.slice(a + 1, b) : text);
    const list = (j && j.result && j.result.cmsArticleWebOld) || [];
    const out = list.map(x => ({
      date: String(x.date || '').slice(0, 10),
      title: String(x.title || '').replace(/<\/?em>/g, '').trim(),
      src: x.mediaName || '',
    })).filter(x => x.title);
    qaAuditLog('东财资讯 ' + name, url, t0, out.length, out.length ? '' : '返回空');
    return out;
  } catch (e) { qaAuditLog('东财资讯 ' + name, url, t0, 0, e.message || String(e)); throw e; }
}

/* 当日分时（腾讯）：累计均价 vs 收盘 → 日内强弱与资金节奏 */
async function emMinute(code) {
  const t0 = Date.now();
  const sec = ({ sh: 'sh', sz: 'sz', bse: 'bj' })[marketOf(code)] + code;
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=' + sec;
  let res;
  try { res = await fetch(url); } catch (e) { qaAuditLog('腾讯分时 ' + code, url, t0, 0, e.message || String(e)); throw e; }
  const j = await res.json();
  const node = j && j.data && j.data[sec] && j.data[sec].data;
  const rows = (node && node.data) || [];
  /* v3.9.13 分时不足 5 点（如集合竞价时段）明示「未获取到」，调用方按无数据处理 */
  if (rows.length < 5) { qaAuditLog('腾讯分时 ' + code, url, t0, 0, '当日分时不足 5 点（非交易时段或停牌）'); return null; }
  const pts = [];
  for (const s of rows) {
    const p = String(s).split(' ');
    const price = parseFloat(p[1]), cumVol = parseFloat(p[2]) || 0, cumAmt = parseFloat(p[3]) || 0;
    if (isFinite(price)) pts.push({ t: p[0], price, cumVol, cumAmt });
  }
  if (pts.length < 5) { qaAuditLog('腾讯分时 ' + code, url, t0, 0, '当日分时不足 5 点'); return null; }
  qaAuditLog('腾讯分时 ' + code, url, t0, pts.length);
  const last = pts[pts.length - 1];
  const avg = last.cumVol > 0 ? last.cumAmt / (last.cumVol * 100) : null;   // 累计额 / (累计手 × 100) = 均价
  return {
    date: (node && node.date) || '', avg, last: last.price,
    amt: last.cumAmt, vol: last.cumVol,
    diffPct: avg ? (last.price / avg - 1) * 100 : null,
    pts,
  };
}

/* 近期龙虎榜（东财数据中心 · 近 120 天席位买卖） */
async function emBillboard(code) {
  const t0 = Date.now();
  const url = dcUrl('RPT_BILLBOARD_DAILYDETAILSBUY', '(SECURITY_CODE="' + code + '")', 60, 'TRADE_DATE', -1);
  let j;
  try {
    const res = await fetch(url);
    j = await res.json();
  } catch (e) { qaAuditLog('东财龙虎榜 ' + code, url, t0, 0, e.message || String(e)); throw e; }
  const rows = (j && j.result && j.result.data) || [];
  if (!rows.length) { qaAuditLog('东财龙虎榜 ' + code, url, t0, 0, '近 120 天无上榜记录（正常，非错误）'); return null; }
  qaAuditLog('东财龙虎榜 ' + code, url, t0, rows.length);
  const since = Date.now() - 120 * 864e5;
  const agg = new Map();
  for (const r of rows) {
    const dt = String(r.TRADE_DATE || '').slice(0, 10);
    if (!dt || new Date(dt + 'T00:00:00').getTime() < since) continue;
    const key = dt + '|' + (r.EXPLANATION || '');
    const g = agg.get(key) || { date: dt, reason: r.EXPLANATION || '', buy: 0, sell: 0, seats: 0 };
    g.buy += nOr(r.BUY) || 0; g.sell += nOr(r.SELL) || 0; g.seats++;
    agg.set(key, g);
  }
  const list = [...agg.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 4);
  return list.length ? list : null;
}

/* ============================================================
   三、渲染器
   ============================================================ */

/* 迷你走势图（内联 SVG）：近 N 根收盘价折线 + 20 日均线 + 首尾标注。
   颜色沿用 A 股习惯（涨红跌绿），与 style.css 的 --up / --down 同调。 */
function qaSparkSvg(bars, w, h) {
  w = w || 640; h = h || 150;
  const list = (bars || []).slice(-90);
  if (list.length < 6) return '';
  const closes = list.map(b => b.c);
  const ma = [];
  for (let i = 0; i < list.length; i++) {
    if (i < 19) { ma.push(null); continue; }
    let sum = 0;
    for (let k = i - 19; k <= i; k++) sum += list[k].c;
    ma.push(sum / 20);
  }
  const all = closes.concat(ma.filter(v => v != null));
  const min = Math.min.apply(null, all), max = Math.max.apply(null, all);
  const pad = (max - min) * 0.1 || Math.abs(max) * 0.02 || 1;
  const lo = min - pad, hi = max + pad;
  const X = i => 8 + i * (w - 16) / (list.length - 1);
  const Y = v => 8 + (hi - v) * (h - 16) / (hi - lo);
  const line = list.map((b, i) => X(i).toFixed(1) + ',' + Y(b.c).toFixed(1)).join(' ');
  const maPts = ma.map((v, i) => v == null ? null : X(i).toFixed(1) + ',' + Y(v).toFixed(1)).filter(Boolean).join(' ');
  const first = closes[0], last = closes[closes.length - 1];
  const up = last >= first;
  const col = up ? '#d03030' : '#12a150';                    // A 股惯例：涨红跌绿
  const baseY = (h - 8).toFixed(1);
  const area = '8,' + baseY + ' ' + line + ' ' + X(list.length - 1).toFixed(1) + ',' + baseY;
  const legend = '<div class="qa-chart-lg"><span class="' + (up ? 'up' : 'down') + '">近 ' + list.length + ' 日收盘 '
    + (up ? '▲' : '▼') + ' ' + ((last / first - 1) * 100).toFixed(1) + '%</span><span class="lg-ma">– – 20 日均线</span></div>';
  return legend + '<svg class="qa-spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img">'
    + '<polygon points="' + area + '" fill="' + col + '" opacity="0.09"></polygon>'
    + '<line x1="8" y1="' + baseY + '" x2="' + (w - 8) + '" y2="' + baseY + '" stroke="#e5e7eb" stroke-width="1" vector-effect="non-scaling-stroke"></line>'
    + '<polyline points="' + line + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"></polyline>'
    + (maPts ? '<polyline points="' + maPts + '" fill="none" stroke="#e0a800" stroke-width="1.4" stroke-dasharray="5 4" opacity="0.9" vector-effect="non-scaling-stroke"></polyline>' : '')
    + '</svg>';
}

/* 把数据表压成紧凑文本（喂给模型的那份；表头 + 数据行，模型据此复述数字） */
function qaTablesToText(res, maxRows) {
  const lim = maxRows || 60;
  const parts = [];
  (res.tables || []).forEach(function (t, i) {
    const cap = t.entity ? '【表' + (i + 1) + '】' + t.entity + (t.code ? '（' + t.code + '）' : '') : '【表' + (i + 1) + '】';
    const rows = t.rows.slice(0, lim);
    parts.push(cap + ' 共 ' + t.rows.length + ' 行' + (t.rows.length > lim ? '（仅列前 ' + lim + ' 行）' : ''));
    if (t.note) parts.push('说明：' + String(t.note).replace(/\n/g, '；'));
    parts.push((t.head || []).join(' | '));
    rows.forEach(function (r) { parts.push(r.map(function (x) { return x == null ? '' : String(x); }).join(' | ')); });
  });
  if (res.text) parts.push('原始返回：' + res.text);
  return parts.join('\n');
}

/* 渲染成可横向滚动的表格（给用户看的那份）。
   时序表（列名是日期、首列是内部指标编号）要丢掉编号列，编号对用户没意义。 */
/* v3.9.7 这一列的值要不要按正负上色（红涨绿跌）。
   旧写法只看「值末尾带 %」一个特征，于是条件选股表里那列涨跌幅（表头已写 (%)、单元格是 10.02
   这种不带百分号的纯数字）永远拿不到 .up / .down —— 用户在选股名单里根本看不到红绿，
   CSS 里那两条规则形同虚设（夹具页实测暴露出来的）。
   现在改成：值带 % 号 → 上色；否则看表头，是「涨跌 / 同比 / 环比 / 变动」这类自带方向的
   指标也上色。同时明确排除换手率、振幅、收益率、毛利率 —— 它们恒为正数，按符号上色会一片
   涨红，属于误用。第 0 列（名次）与代码/名称列因 /^[+-]?\d/ 与表头判定天然不参与。 */
function qaUpDownCol(head, s) {
  if (/%$/.test(s)) return true;
  const h = String(head == null ? '' : head);
  if (/率\(%\)$/.test(h)) return false;                 // 换手率(%) / 振幅(%) / 收益率(%) / 毛利率(%)
  return /涨跌|涨幅|跌幅|同比|环比|变动|回撤|盈亏|溢价|折价|超额/.test(h);
}
function qaTableHtml(res, maxRows) {
  if (!res || !res.tables || !res.tables.length) return '';
  const lim = maxRows || 30;
  let list = res.tables.filter(function (t) { return !t.ts; });
  if (!list.length) list = res.tables.slice(0, 2);       // 整批都是时序表 → 也给用户看一眼
  else list = list.slice().sort(function (a, b) { return b.rows.length - a.rows.length; }).slice(0, 3);
  return list.map(function (t) {
    let head = t.head, rows = t.rows;
    if (t.ts) { head = head.slice(1); rows = rows.map(function (r) { return r.slice(1); }); }
    rows = rows.slice(0, lim);
    const headHtml = head.map(function (h) { return '<th>' + esc(String(h == null ? '' : h)) + '</th>'; }).join('');
    const body = rows.map(function (r) {
      const tds = r.map(function (x, ci) {
        const s = x == null ? '' : String(x);
        let cls = '';
        if (ci > 0 && /^[+-]?\d/.test(s) && qaUpDownCol(head[ci], s)) {
          const n = parseFloat(s.replace(/,/g, ''));
          /* 旧写法 s.charAt(0) !== '-' 就判涨，会把 0.00 也染成红色；按数值正负判定更准，
             恰好为 0 时保持默认字色。 */
          if (n > 0) cls = ' class="up"'; else if (n < 0) cls = ' class="down"';
        }
        return '<td' + cls + '>' + esc(s) + '</td>';
      }).join('');
      return '<tr>' + tds + '</tr>';
    }).join('');
    const capTxt = t.note
      ? t.note + '\n共 ' + t.rows.length + ' 行' + (t.rows.length > lim ? '（此处展示前 ' + lim + ' 行）' : '')
      : [t.entity || '数据', t.code, '共 ' + t.rows.length + ' 行'].filter(Boolean).join(' · ')
        + (t.rows.length > lim ? '（此处展示前 ' + lim + ' 行）' : '');
    const cap = '<div class="qa-tbl-cap">' + esc(capTxt).replace(/\n/g, '<br>') + '</div>';
    return '<div class="qa-tbl-wrap"><table class="qa-tbl"><thead><tr>' + headHtml + '</tr></thead><tbody>' + body + '</tbody></table></div>' + cap;
  }).join('');
}

/* ============================================================
   四、全市场快照与榜单
   ============================================================ */
const SCREEN_TTL = 30 * 60 * 1000;
const _screenCache = {};
/* 估值快照用到的列。实测这张免费表本身就带 CLOSE_PRICE / CHANGE_RATE，
   所以「今日涨幅榜」这类纯行情问句不用另找数据源、不消耗任何额度。 */
const VAL_COLS = 'SECURITY_CODE,SECURITY_NAME_ABBR,PE_TTM,PB_MRQ,TOTAL_MARKET_CAP,PS_TTM,BOARD_NAME,CLOSE_PRICE,CHANGE_RATE';
const PERF_COLS = 'SECURITY_CODE,SECURITY_NAME_ABBR,WEIGHTAVG_ROE,BASIC_EPS,BPS,YSTZ,SJLTZ,XSMLL,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT,BOARD_NAME';

/* 取一张全市场快照，落 30 分钟内存缓存（整表约 12~13 页 × 500 行） */
async function dcSnapshot(kind) {
  const now = Date.now();
  const hit = _screenCache[kind];
  if (hit && now - hit.at < SCREEN_TTL) return hit;
  let map, date, n = 0;
  if (kind === 'val') {
    date = await latestTradeDate();
    const rows = await dcFetchAll('RPT_VALUEANALYSIS_DET', VAL_COLS, "(TRADE_DATE='" + date + "')");
    map = {};
    rows.forEach(function (x) {
      const c = String(x.SECURITY_CODE || '').trim();
      if (/^\d{6}$/.test(c)) { map[c] = x; n++; }
    });
  } else {
    date = await latestReportDate();
    const rows = await dcFetchAll('RPT_LICO_FN_CPD', PERF_COLS, "(REPORTDATE='" + date + "')");
    map = {};
    rows.forEach(function (x) {
      const c = String(x.SECURITY_CODE || '').trim();
      if (/^\d{6}$/.test(c)) { map[c] = x; n++; }
    });
  }
  const snap = { map: map, date: date, at: now, n: n };
  _screenCache[kind] = snap;
  return snap;
}

/* ---- 榜单快速通道 ----------------------------------------------------------
 * 「今日涨幅前 100」这类没有阈值、只要排名的问句：直接让数据中心按目标字段排序，
 * 只取最前面 1~2 页（500/页），比拉全市场快照（12 个请求）快得多，通常 1 个请求就够。
 * 多留 2 倍余量，因为后面还要剔掉 ST 与北交所。 */
const _rankCache = {};
const RANK_TTL = 60 * 1000;
async function dcRank(kind, key, dir, need) {
  const ck = kind + '|' + key + '|' + dir + '|' + need;
  const now = Date.now();
  const cached = _rankCache[ck];
  if (cached && now - cached.at < RANK_TTL) return cached;
  const report = kind === 'val' ? 'RPT_VALUEANALYSIS_DET' : 'RPT_LICO_FN_CPD';
  const cols = kind === 'val' ? VAL_COLS : PERF_COLS;
  const date = kind === 'val' ? await latestTradeDate() : await latestReportDate();
  const filter = kind === 'val' ? "(TRADE_DATE='" + date + "')" : "(REPORTDATE='" + date + "')";
  // 留足余量：后面还要剔掉 ST 与北交所，跌幅榜前列尤其容易被 ST 占满
  const want = Math.min(2000, Math.max(500, (need || 100) * 4));
  const rows = [];
  for (let p = 1; p <= Math.ceil(want / 500); p++) {
    const url = DC_BASE + 'reportName=' + report + '&columns=' + cols
      + '&pageSize=500&pageNumber=' + p + '&sortColumns=' + key + '&sortTypes=' + dir
      + '&filter=' + encodeURIComponent(filter);
    let d = null;
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (j && j.code && j.code !== 0) throw new Error(j.message || ('返回 code ' + j.code));
      d = (j && j.result && j.result.data) || [];
    } catch (e) { if (!rows.length) throw e; break; }
    if (!d.length) break;
    rows.push.apply(rows, d);
    if (d.length < 500) break;
  }
  const snap = { rows: rows, date: date, at: now };
  _rankCache[ck] = snap;
  return snap;
}

/* ============================================================
   五、条件选股（内置，完全免费）
   两张全市场表都按 SECURITY_CODE 分页取全量后在客户端 join：
     ① RPT_VALUEANALYSIS_DET —— 估值快照（PE_TTM / PB_MRQ / TOTAL_MARKET_CAP / 收盘价 / 涨跌幅）
     ② RPT_LICO_FN_CPD      —— 业绩报表（ROE / EPS / 营收同比 / 净利同比 / 毛利率）
   ============================================================ */
const SCREEN_COLS = {
  // ---- 估值 / 行情（东财数据中心公开表，免费）----
  pe:     { label: '市盈率(TTM)',   src: 'val',  key: 'PE_TTM',           scale: 1,   fmt: 'n2' },
  pb:     { label: '市净率',         src: 'val',  key: 'PB_MRQ',           scale: 1,   fmt: 'n2' },
  cap:    { label: '总市值(亿)',     src: 'val',  key: 'TOTAL_MARKET_CAP', scale: 1e8, fmt: 'n0' },
  ind:    { label: '所属行业',       src: 'val',  key: 'BOARD_NAME',       scale: 1,   fmt: 'n2' },
  chg:    { label: '涨跌幅(%)',      src: 'val',  key: 'CHANGE_RATE',      qkey: 'pct',   scale: 1, fmt: 'n2', quote: true },
  price:  { label: '最新价(元)',     src: 'val',  key: 'CLOSE_PRICE',      qkey: 'price', scale: 1, fmt: 'n2', quote: true },
  // ---- 盘中实时（腾讯行情，免费；只在问句真的用到时才按需拉全市场）----
  turn:   { label: '换手率(%)',      src: 'q',    key: 'turnover',  scale: 1, fmt: 'n2', quote: true },
  vr:     { label: '量比',           src: 'q',    key: 'volRatio',  scale: 1, fmt: 'n2', quote: true },
  amp:    { label: '振幅(%)',        src: 'q',    key: 'amp',       scale: 1, fmt: 'n2', quote: true },
  amt:    { label: '成交额(亿)',     src: 'q',    key: 'amount',    scale: 1, fmt: 'n2', quote: true },
  capf:   { label: '流通市值(亿)',   src: 'q',    key: 'floatCap',  scale: 1, fmt: 'n0', quote: true },
  // ---- 业绩（东财数据中心公开表，免费）----
  roe:    { label: '净资产收益率(%)', src: 'perf', key: 'WEIGHTAVG_ROE',    scale: 1,   fmt: 'n2' },
  eps:    { label: '每股收益(元)',   src: 'perf', key: 'BASIC_EPS',        scale: 1,   fmt: 'n2' },
  ystz:   { label: '营收同比(%)',    src: 'perf', key: 'YSTZ',             scale: 1,   fmt: 'n2' },
  sjltz:  { label: '净利同比(%)',    src: 'perf', key: 'SJLTZ',            scale: 1,   fmt: 'n2' },
  mll:    { label: '销售毛利率(%)',  src: 'perf', key: 'XSMLL',            scale: 1,   fmt: 'n2' },
  bps:    { label: '每股净资产(元)', src: 'perf', key: 'BPS',              scale: 1,   fmt: 'n2' },
  cash:   { label: '每股经营现金流', src: 'perf', key: 'MGJYXJJE',         scale: 1,   fmt: 'n2' },
};
// 表格里列的展示顺序（也是「只显示用户真正筛过 / 排过序的列」白名单）
const SCREEN_SHOW_KEYS = ['chg', 'price', 'turn', 'vr', 'amp', 'amt', 'capf', 'cap',
  'pe', 'pb', 'ind', 'roe', 'eps', 'ystz', 'sjltz', 'mll', 'bps', 'cash'];
// 用户常提、但当前免费数据源拿不到的指标 → 明确告知，而不是默默忽略
const SCREEN_UNSUPPORTED = ['股息率', '股东户数', '机构持仓', '北向资金', '研发费用', '商誉', '资产负债率', '负债率'];
// 问句里的说法 → 字段键（长的名字放前面，避免「净利同比」被「净利」抢先匹配）
const SCREEN_ALIAS = [
  ['sjltz', ['净利润同比增长', '净利润同比', '净利润增长率', '净利同比增长', '净利同比', '净利增速', '利润同比', '净利润增速']],
  ['ystz',  ['营业收入同比增长', '营业收入同比', '营业收入增长率', '营收同比增长', '营收同比', '营收增速', '收入同比', '收入增速']],
  ['roe',   ['净资产收益率', 'roe', 'ROE']],
  ['eps',   ['每股收益', 'eps', 'EPS']],
  ['mll',   ['销售毛利率', '毛利率']],
  ['bps',   ['每股净资产']],
  ['cash',  ['每股经营现金流', '经营现金流', '每股现金流']],
  ['pe',    ['市盈率', 'pe', 'PE']],
  ['pb',    ['市净率', 'pb', 'PB']],
  ['capf',  ['流通市值', '流通盘']],
  ['cap',   ['总市值', '市值']],
  // 行情类（涨跌幅 / 股价 / 换手率 / 量比 / 振幅 / 成交额）
  ['chg',   ['涨跌幅', '涨幅', '涨跌', '跌幅', '日涨跌幅']],
  ['turn',  ['换手率', '换手']],
  ['vr',    ['量比']],
  ['amp',   ['振幅']],
  ['amt',   ['成交额', '成交金额', '成交量']],
  ['price', ['最新价', '现价', '收盘价', '股价', '价格']],
];
const SCREEN_SORT_ALIAS = [
  ['roe', 'ROE'], ['roe', '净资产收益率'], ['pe', '市盈率'], ['pe', 'pe'], ['pe', 'PE'],
  ['pb', '市净率'], ['cap', '总市值'], ['cap', '市值'], ['ystz', '营收同比'], ['ystz', '营收'],
  ['sjltz', '净利同比'], ['sjltz', '净利'], ['sjltz', '净利润'], ['mll', '毛利率'],
  ['eps', '每股收益'], ['bps', '每股净资产'],
  ['chg', '涨跌幅'], ['chg', '涨幅'], ['chg', '跌幅'], ['chg', '涨跌'],
  ['turn', '换手率'], ['vr', '量比'], ['amp', '振幅'], ['amt', '成交额'], ['amt', '成交量'],
  ['price', '最新价'], ['price', '收盘价'], ['price', '股价'], ['price', '现价'], ['price', '价格'],
  ['capf', '流通市值'],
];
// 「涨幅榜 / 换手率前 50」这类没有阈值的排名问句 —— 只有排序方向，没有筛选条件
const SCREEN_RANK_RULES = [
  { k: 'chg',  dir: -1, re: /(?:涨幅|上涨)(?:榜|排名|排行|前列|居前)|涨幅(?:最大|最高|居前)|涨幅前\s*\d|涨得(?:最好|最多)|最(?:大|高)涨幅|涨停(?:榜|股|家数)/ },
  { k: 'chg',  dir:  1, re: /(?:跌幅|下跌)(?:榜|排名|排行|前列|居前)|跌幅(?:最大|最高|居前)|跌幅前\s*\d|跌得(?:最|多)|最(?:大|高)跌幅|跌停(?:榜|股|家数)/ },
  { k: 'turn', dir: -1, re: /换手率(?:榜|排名|排行|前列|居前|最高|最大)|换手率前\s*\d|换手最(?:活跃|高|大)/ },
  { k: 'vr',   dir: -1, re: /量比(?:榜|排名|排行|前列|居前|最高|最大)|量比前\s*\d/ },
  { k: 'amt',  dir: -1, re: /成交(?:额|量)(?:榜|排名|排行|前列|居前|最高|最大)|成交(?:额|量)前\s*\d|最活跃/ },
  { k: 'amp',  dir: -1, re: /振幅(?:榜|排名|排行|前列|居前|最高|最大)|振幅前\s*\d/ },
];
const SCREEN_OP_DOWN = /(?:低于|小于|不足|不超过|不高于|少于|至多|不到|以下|及以下|≤|<|＜)/;
const SCREEN_OP_UP = /(?:高于|大于|超过|不低于|不少于|至少|以上|及以上|≥|>|＞)/;

/* ---- 选股「范围」：用代码前缀判定，零请求、纯本地 ----
 * 「创业板中找…」这类问句以前完全不生效（范围词不是接口过滤条件），
 * 会被当成全市场筛选 —— 结果里混进主板股票，看着像"答非所问"。 */
const SCREEN_SCOPE_RULES = [
  { k: 'cyb',  label: '创业板',   re: /创业板|创业版/,                       test: c => /^(300|301)/.test(c) },
  { k: 'kcb',  label: '科创板',   re: /科创板|科创版/,                       test: c => /^688/.test(c) },
  { k: 'main', label: '沪深主板', re: /主板(?!块)|沪深主板/,                  test: c => /^(600|601|603|605|000|001|002|003)/.test(c) },
  { k: 'bse',  label: '北交所',   re: /北交所|北证/,                         test: c => /^(43|83|87|88|920)/.test(c) },
];

/* ---- 选股「算不了」的条件：需要逐只历史行情 ----
 * 全市场快照只有**当日**一个截面。凡是被 parseFormConds 认下来的（区间涨幅/均线/均量/
 * 连阳/新高/回撤/金叉）已在下方真算；这里剩下的是**仍然算不出来**的口径，必须显式拒答 ——
 * 否则「近 5 个交易日累计涨幅 > 15%」会被悄悄改成「当日涨幅 > 15%」，
 * 给出一份表面正常、实际完全不同的名单，错得看不出来，比报错危险得多。 */
const SCREEN_HIST_RULES = [
  { re: /(?:累计|区间|近\s*\d+\s*[个交]?[易]?[日天周月年]|过去\s*\d+\s*[个日天周月年]|连续\s*\d+\s*[日天]|连\s*\d+\s*[日天])[^，。；;]{0,14}(?:涨幅|涨跌|上涨|下跌|涨了|跌了)/, txt: '区间 / 累计涨幅（如「近 5 个交易日累计涨幅 > 15%」）' },
  { re: /(?:涨幅|涨跌|涨幅榜)[^，。；;]{0,10}(?:累计|区间|近\s*\d+\s*[日天])/, txt: '区间 / 累计涨幅' },
  { re: /(?:均量|平均成交量|放量|量能放大|缩量|成交量[^，。；;]{0,10}(?:放大|增加|萎缩|缩减))/, txt: '成交量相对均量的放大 / 萎缩（如「较 20 日均量放大 50%」）' },
  { re: /(?:站上|站回|跌破|失守|高于|低于|突破|上穿|下穿)[^，。；;]{0,6}(?:均线|半年线|年线|季线|月线|MA\s*\d+|\d+\s*日均线)/, txt: '均线位置（如「收盘价站上半年线」）' },
  { re: /(?:\d+\s*日均线|半年线|年线|季线|月线|MA\s*\d+)/, txt: '均线' },
  { re: /(?:创|刷|破)[^，。；;]{0,4}\d{0,3}\s*[日天]?(?:新高|新低)/, txt: '创新高 / 新低' },
  // 以下几条：问句里出现了、但本应用确实算不出来的口径
  { re: /(?:顶背离|底背离|背离)/, txt: 'MACD / RSI 背离形态' },
  { re: /(?:布林|BOLL)/i, txt: '布林带（BOLL）' },
  { re: /(?:筹码|获利盘|套牢盘|成本分布)/, txt: '筹码分布' },
  { re: /(?:缠论|中枢|波浪|浪型|缺口回补)/, txt: '缠论 / 波浪 / 缺口形态' },
];

/* ---- 路由：判断一个问句是不是「选股 / 榜单」类 ----
 * 老写法只认「筛选 / 涨幅前100 / 涨幅榜」这类固定说法，于是「在 A 股创业板中找…的标的，
 * 按累计涨幅降序给我前 10 只」这种自然语言选股问句全都漏判，掉进个股取数分支。
 * 现在补两类信号：① 数量 / 排序意图 ② 市场范围词。 */
const SCREEN_ROUTE_RE = /筛选|选股|挑出|选出|筛出|符合条件的?(股票|公司|标的|个股)|哪些(股票|公司|个股|标的)|成分股|概念股|板块内|产业链|排行榜|按.{0,6}排序|涨幅榜|跌幅榜|涨停榜|跌停榜|换手率榜|量比榜|成交额榜|振幅榜|涨幅前\s*\d|跌幅前\s*\d|换手率前\s*\d|量比前\s*\d|成交额前\s*\d|振幅前\s*\d|涨得最好|跌得最多|最活跃的股票/;
const SCREEN_LIST_INTENT_RE = /(?:给|列|取|要|来)\s*(?:我|出)?\s*前?\s*\d{1,3}\s*(?:只|个|名|支|档)|前\s*\d{1,3}\s*(?:只|个|名|支)|按\s*[^\s,，。；;、的]{1,12}\s*(?:降序|升序|从高到低|从低到高|由高到低|由低到高|递减|递增|倒序|排序)|排(?:名|序)|榜|名单/;
const SCREEN_NOUN_RE = /股票|个股|标的|证券|只|票/;
const SCREEN_SCOPE_WORD_RE = /全市场|两市|A\s*股|深市|沪市|创业板|创业版|科创板|科创版|主板|北交所|北证|沪深|行业里|板块里|概念里/;
// 形态选股信号：这些词 + 股票名词 → 判为「选股」（而不是把"站上MA20"当成单只股票的技术分析）
const SCREEN_FORM_ROUTE_RE = /区间涨幅|累计涨幅|阶段涨幅|近\s*\d{1,3}\s*[个交]?[易]?[日天周月][^，,。；;]{0,10}?(?:涨幅|上涨|下跌|跌幅)|站上|站回|跌破|失守|上穿|下穿|均线多头|多头排列|空头排列|放量|缩量|均量|连阳|连阴|连续\s*\d{1,2}\s*[日天]|创新高|创新低|阶段新高|阶段新低|历史新高|历史新低|高点回撤|MACD|KDJ|RSI|布林/;

/* ============================================================
   六、选股「区间 / 形态」条件（需要逐只日 K 才能算）
     ① 先用全市场快照把能算的条件筛一遍得到候选池（零额外请求，快照本就要拉）
     ② 再对候选池逐只并发拉日 K，逐只算区间涨幅 / 均线位置 / 均量 / 连阳 / 新高 / 回撤 / MACD·KDJ·RSI
     ③ 候选池超过 FORM_MAX 就明确报错、要求先加一个前筛条件 —— 绝不静默只扫一部分
   ============================================================ */
const FORM_MAX = 2000;        // 候选池上限（约 40 秒可扫完）
const FORM_KLINE_LMT = 620;   // 每只拉多少根日 K（覆盖年线 250 + 余量）
/* ⚠️ 节奏很关键：实测腾讯 K 线接口在 ~225 请求/秒下会触发 WAF（返回 501 拦截页，
   且会连带把「个股诊断」的 K 线一起打断）。按「并发 4 + 每次起步间隔 28ms」压到
   约 50 请求/秒，实测连续 700 只零拦截、失败率 <1%，全创业板 1368 只约 28 秒。 */
const FORM_CONC = 4;
const FORM_GAP = 28;

// 均线别称 → 周期
const MA_WORD = { '月线': 20, '季线': 60, '半年线': 120, '年线': 250 };

/* 把问句里的「形态条件」解析成结构化数组。
 * 返回 { conds: [...], spans: [[start,end],…] }
 *   spans 是已被识别并消费掉的字符区间 —— 上层用它判断「剩余还有没有算不出来的条件」，
 *   避免把已经支持的条件（如"站上MA20"）再当不支持拒答一次。 */
function parseFormConds(t) {
  const src = String(t || '').replace(/\s+/g, ' ');
  const conds = [], spans = [];
  const tailOf = function (idx, len) { return src.slice(idx + len); };
  const segOf = function (s) { return String(s || '').slice(0, 18).split(/[，,。；;、\n]/)[0]; };
  const eatOp = function (s) {
    const m = String(s || '').match(/^([^0-9]{0,12}?)(\d+(?:\.\d+)?)/);
    if (!m) return null;
    const between = m[1] || '', val = parseFloat(m[2]);
    if (!isFinite(val)) return null;
    if (SCREEN_OP_DOWN.test(between)) return { op: '<', val: val };
    if (SCREEN_OP_UP.test(between)) return { op: '>', val: val };
    return null;
  };
  const push = function (c, m) { conds.push(c); spans.push([m.index, m.index + m[0].length]); };
  const has = function (k, n) { return conds.some(function (x) { return x.k === k && x.n === n; }); };

  // ---- ① 区间 / 累计涨幅：近 N 个交易日累计涨幅 > x% ----
  (function () {
    const re = /(?:近|过去|最近|前)?\s*(\d{1,3})?\s*(?:个)?\s*(交易日|交日|日|天|周|星期|月)?\s*(?:内|以来|时间)?\s*(?:的)?\s*(累计|区间|阶段)?\s*(涨幅|上涨|涨了|涨|跌幅|下跌|跌了|跌)/g;
    let m;
    while ((m = re.exec(src))) {
      const kwAll = m[3] || '', kwDir = m[4] || '';
      if (!m[1] && !kwAll) continue;                        // 既没写 N 也没写"区间/累计/阶段" → 不是区间语义
      let n = m[1] ? parseInt(m[1], 10) : 60;               // 没写 N 时统一按近 60 个交易日
      const unit = m[2] || '日';
      if (unit === '周' || unit === '星期') n = n * 5;
      else if (unit === '月') n = n * 21;
      n = Math.max(1, Math.min(500, n));
      const opv = eatOp(segOf(tailOf(re.lastIndex, 0)));
      const down = /跌/.test(kwDir);
      let op, target;
      if (opv) { op = opv.op; target = opv.val; }
      else { op = down ? '<' : '>'; target = 0; }
      if (down) { op = op === '>' ? '<' : '>'; target = -target; }
      if (has('rngChg', n)) continue;
      // 「按累计涨幅降序」这类只有排序意图、没写阈值的写法：只当排序键，不当作筛选条件
      const sortOnly = (!m[1] && !opv) ? 1 : 0;
      push({ k: 'rngChg', n: n, op: op, target: target, dir: target >= 0 ? 1 : -1, sortOnly: sortOnly,
        text: '近 ' + n + ' 日涨幅' + (sortOnly ? '（仅作排序）' : ' ' + (op === '>' ? '>' : '<') + ' ' + target + '%') }, m);
    }
  })();

  // ---- ② 均线位置：收盘价站上 / 跌破 MA20、半年线、年线 ----
  (function () {
    const re = /(站上|站回|上穿|突破|收复|回到|位于|运行在|在|跌破|失守|下穿|跌穿|击穿|处于)[^，,。；;、]{0,6}?(MA\s*(\d{1,3})|(\d{1,3})\s*日(?:移动)?(?:均线|线)|月线|季线|半年线|年线)/g;
    let m;
    while ((m = re.exec(src))) {
      const verb = m[1], w = m[0];
      let n = null;
      if (m[3]) n = parseInt(m[3], 10);
      else if (m[4]) n = parseInt(m[4], 10);
      else { const key = (w.match(/月线|季线|半年线|年线/) || [])[0]; n = key ? MA_WORD[key] : null; }
      if (!n || n < 2 || n > 400) continue;
      const after = segOf(tailOf(re.lastIndex, 0)).slice(0, 4);
      let dir;
      if (/下方|之下|以下/.test(after)) dir = -1;
      else if (/上方|之上|以上/.test(after)) dir = 1;
      else dir = /^(跌破|失守|下穿|跌穿|击穿)/.test(verb) ? -1 : 1;
      if (has('maPos', n)) continue;
      push({ k: 'maPos', n: n, op: dir > 0 ? '>' : '<', target: 0, dir: dir,
        text: '收盘价' + (dir > 0 ? '站上' : '跌破') + ' MA' + n }, m);
    }
  })();

  // ---- ③ 均线多头 / 空头排列 ----
  (function () {
    const m = src.match(/(均线)?(多头排列|空头排列)/);
    if (m) {
      const up = m[2] === '多头排列';
      push({ k: 'maBull', n: 0, op: '>', target: 0, dir: up ? 1 : -1,
        text: up ? '均线多头排列（MA5>MA10>MA20）' : '均线空头排列（MA5<MA10<MA20）' }, m);
    }
  })();

  // ---- ④ 量能：较 N 日均量放大 / 萎缩 x% ----
  (function () {
    /* v3.9.7 修一处会「误拒」的漏判：「近 5 日均量较 20 日均量放量 50%」这种写法，
       原正则的方向动词表里只有「放大 / 缩小 …」而没有「放量 / 缩量」，整句匹配不上，
       于是掉到下面那条「见『放量』就按 1.5 倍」的兜底规则。倍数恰好一样（都对），
       但兜底规则记录的字符区间只覆盖「放量」两个字，导致上面 SCREEN_HIST_RULES 里的
       「均量」规则认为这段没被消费掉，最终把这条**本来完全算得出来**的问句当成
       "当前数据源算不出来"拒答 —— 而这正是本项目自带快捷提问里的一条，用户一点就撞。
       把「放量 / 缩量」补进方向表后整句被完整消费；顺手把两个 N 真解析出来
       （原来写死 5/20，用户写「较 30 日均量」也会被当成 20 日）。 */
    const re = /(?:较|比|相对)?\s*(?:近)?\s*(\d{1,3})?\s*日?均量([^，,。；;、]{0,10}?)(放大|放量|增加|上升|提升|高出|萎缩|缩量|缩小|下降|减少|低于|缩减)[^，,。；;、]{0,4}?(\d{1,3}(?:\.\d+)?)?\s*%/g;
    let m;
    while ((m = re.exec(src))) {
      const pct = m[4] ? parseFloat(m[4]) : 50;
      const up = !/萎缩|缩量|缩小|下降|减少|低于|缩减/.test(m[3]);
      let m0 = m[1] ? parseInt(m[1], 10) : 5;
      const mm = /(\d{1,3})\s*日?\s*均量/.exec(m[2] || '');
      let m1 = mm ? parseInt(mm[1], 10) : 20;
      if (!(m0 > 0 && m0 <= 250)) m0 = 5;
      if (!(m1 > 0 && m1 <= 250)) m1 = 20;
      if (has('volRatio', 0)) continue;
      push({ k: 'volRatio', n: 0, m0: m0, m1: m1, op: up ? '>' : '<', target: up ? 1 + pct / 100 : 1 - pct / 100,
        text: '近 ' + m0 + ' 日均量较 ' + m1 + ' 日均量' + (up ? '放大' : '萎缩') + pct + '%' }, m);
    }
    if (!has('volRatio', 0)) {
      if (/放量/.test(src)) push({ k: 'volRatio', n: 0, m0: 5, m1: 20, op: '>', target: 1.5, text: '放量（5 日均量 > 1.5 倍 20 日均量）' }, { index: src.indexOf('放量'), 0: '放量' });
      else if (/缩量/.test(src)) push({ k: 'volRatio', n: 0, m0: 5, m1: 20, op: '<', target: 0.7, text: '缩量（5 日均量 < 0.7 倍 20 日均量）' }, { index: src.indexOf('缩量'), 0: '缩量' });
    }
  })();

  // ---- ⑤ 连续 N 日上涨 / 下跌 ----
  (function () {
    let m = src.match(/(?:连续|连)\s*(\d{1,2})\s*(?:个)?\s*[日天][^，,。；;、]{0,4}?(上涨|收阳|红盘|阳线|下跌|收阴|绿盘|阴线)/);
    if (!m) m = src.match(/(\d{1,2})\s*连(阳|阴)/);
    if (m) {
      const n = parseInt(m[1], 10);
      const dir = /阳|上涨|红盘/.test(m[2]) ? 1 : -1;
      if (n >= 2 && n <= 20 && !has('streak', n)) {
        push({ k: 'streak', n: n, op: dir > 0 ? '>=' : '<=', target: dir > 0 ? n : -n, dir: dir,
          text: '连续 ' + n + ' 日' + (dir > 0 ? '上涨' : '下跌') }, m);
      }
    }
  })();

  // ---- ⑥ 创新高 / 创新低 ----
  (function () {
    const re = /(?:创|刷新|创出|突破)\s*(?:近)?\s*(\d{1,3})?\s*[日天]?\s*(?:以内|内|以来)?\s*(新高|新低)|(阶段新高|阶段新低|历史新高|历史新低)/g;
    let m;
    while ((m = re.exec(src))) {
      const kw = m[2] || m[3];
      const up = /新高/.test(kw);
      let n = m[1] ? parseInt(m[1], 10) : (/历史/.test(kw) ? 500 : 60);
      n = Math.max(5, Math.min(500, n));
      const kk = up ? 'newHigh' : 'newLow';
      if (has(kk, n)) continue;
      push({ k: kk, n: n, op: '>', target: 0, dir: 1,
        text: (n >= 500 ? '历史' : '近 ' + n + ' 日') + (up ? '新高' : '新低') }, m);
    }
  })();

  // ---- ⑦ 自 N 日高点回撤 x% ----
  (function () {
    const re = /(?:自|从|距|距离|相对)?\s*(?:近)?\s*(\d{1,3})?\s*[日天]?\s*(?:以内|内)?\s*(?:的)?\s*(?:最高|高点|高位|新高)[^，,。；;、]{0,6}?(?:回撤|回落|回调|下跌|跌了|跌幅)\s*(?:超过|大于|达到|超|逾|有)?\s*(\d{1,2}(?:\.\d+)?)\s*%/g;
    let m;
    while ((m = re.exec(src))) {
      const n = m[1] ? Math.max(2, Math.min(500, parseInt(m[1], 10))) : 60;
      const pct = parseFloat(m[2]);
      if (!isFinite(pct) || has('pullback', n)) continue;
      push({ k: 'pullback', n: n, op: '>', target: pct, dir: -1,
        text: '自近 ' + n + ' 日高点回撤 > ' + pct + '%' }, m);
    }
  })();

  // ---- ⑧ 技术指标金叉 / 死叉 / 阈值 ----
  (function () {
    let m = src.match(/MACD[^，,。；;、]{0,8}?(金叉|死叉)/);
    if (m) push({ k: 'macdCross', n: 5, op: '>', target: 0, dir: m[1] === '金叉' ? 1 : -1, text: 'MACD ' + m[1] + '（近 5 日内）' }, m);
    m = src.match(/KDJ[^，,。；;、]{0,8}?(金叉|死叉)/);
    if (m) push({ k: 'kdjCross', n: 5, op: '>', target: 0, dir: m[1] === '金叉' ? 1 : -1, text: 'KDJ ' + m[1] + '（近 5 日内）' }, m);
    m = src.match(/RSI[^，,。；;、]{0,6}?(低于|小于|不足|高于|大于|超过|超)\s*(\d{1,2})/);
    if (m) {
      const down = /低于|小于|不足/.test(m[1]);
      push({ k: 'rsi', n: 14, op: down ? '<' : '>', target: parseFloat(m[2]), dir: down ? 1 : -1, text: 'RSI(14) ' + (down ? '<' : '>') + ' ' + m[2] }, m);
    }
    m = src.match(/(?:MA\s*(\d{1,3})|(\d{1,3})\s*日均线)[^，,。；;、]{0,4}?(上穿|金叉|下穿|死叉)[^，,。；;、]{0,4}?(?:MA\s*(\d{1,3})|(\d{1,3})\s*日均线)/);
    if (m) {
      const f = parseInt(m[1] || m[2], 10), s = parseInt(m[4] || m[5], 10);
      const up = /上穿|金叉/.test(m[3]);
      if (f && s && f !== s) push({ k: 'maCross', n: 5, m0: Math.min(f, s), m1: Math.max(f, s), op: '>', target: 0, dir: up ? 1 : -1,
        text: 'MA' + Math.min(f, s) + (up ? ' 上穿 ' : ' 下穿 ') + 'MA' + Math.max(f, s) + '（近 5 日内）' }, m);
    }
  })();

  return { conds: conds, spans: spans };
}

// 单只股票的某个形态指标值（null = 数据不够，直接淘汰）
// calTail（可选）：市场交易日历（降序，[0]=最新），由池内全票末段日期投票得出 —— 「连续 N 日」用
function formMetric(c, bars, calTail) {
  const n = bars.length;
  if (!n || n < 5) return null;
  const i = n - 1;
  const closes = bars.map(function (b) { return b.c; });
  switch (c.k) {
    case 'rngChg': {
      const j = c.n > 0 ? Math.max(0, i - c.n) : 0;
      if (j >= i || !(closes[j] > 0)) return null;
      return (closes[i] / closes[j] - 1) * 100;
    }
    case 'maPos': {
      const ma = calcMA(closes, c.n)[i];
      if (ma == null || !(ma > 0)) return null;
      return (closes[i] / ma - 1) * 100;
    }
    case 'maBull': {
      const a = calcMA(closes, 5)[i], b = calcMA(closes, 10)[i], d = calcMA(closes, 20)[i];
      if (a == null || b == null || d == null) return null;
      return (a > b && b > d) ? 1 : 0;
    }
    case 'volRatio': {
      const vs = bars.map(function (b) { return b.v; });
      const a = calcMA(vs, c.m0 || 5)[i], b = calcMA(vs, c.m1 || 20)[i];
      if (!a || !b) return null;
      return a / b;
    }
    case 'streak': {
      /* v3.17.4 连续 N 日按「市场交易日历」对齐：本票在窗口内任一交易日缺 bar（停牌）
         → 直接淘汰，绝不把跨了停牌日的「伪连涨」当真。无日历可考（旧数据形状）时退回旧行为。 */
      if (calTail) {
        for (let j = 0; j <= c.n; j++) {
          const b2 = bars[bars.length - 1 - j];
          if (!b2 || b2.d !== calTail[j]) return null;
        }
      }
      let cnt = 0;
      for (let k = i; k > 0; k--) {
        const up = closes[k] > closes[k - 1], dn = closes[k] < closes[k - 1];
        if (c.dir > 0 ? up : dn) cnt++; else break;
      }
      return c.dir > 0 ? cnt : -cnt;
    }
    case 'newHigh': {
      const j = Math.max(0, i - c.n + 1);
      let hh = -Infinity;
      for (let k = j; k <= i; k++) hh = Math.max(hh, bars[k].h);
      return bars[i].h >= hh * 0.999 ? 1 : 0;
    }
    case 'newLow': {
      const j = Math.max(0, i - c.n + 1);
      let ll = Infinity;
      for (let k = j; k <= i; k++) ll = Math.min(ll, bars[k].l);
      return bars[i].l <= ll * 1.001 ? 1 : 0;
    }
    case 'pullback': {
      const j = Math.max(0, i - c.n + 1);
      let hh = -Infinity;
      for (let k = j; k <= i; k++) hh = Math.max(hh, bars[k].h);
      if (!(hh > 0)) return null;
      return (hh - closes[i]) / hh * 100;
    }
    case 'macdCross': {
      const mc = calcMACD(closes), w = c.n || 5;
      for (let k = i; k > i - w && k > 0; k--) {
        const now = mc.dif[k] > mc.dea[k], prev = mc.dif[k - 1] > mc.dea[k - 1];
        if (c.dir > 0 ? (now && !prev) : (!now && prev)) return 1;
      }
      return 0;
    }
    case 'kdjCross': {
      const kd = calcKDJ(bars), w = c.n || 5;
      for (let k = i; k > i - w && k > 0; k--) {
        if (c.dir > 0 ? (kd.K[k] > kd.D[k] && kd.K[k - 1] <= kd.D[k - 1]) : (kd.K[k] < kd.D[k] && kd.K[k - 1] >= kd.D[k - 1])) return 1;
      }
      return 0;
    }
    case 'rsi': {
      const r = calcRSI(closes, c.n || 14)[i];
      return r == null ? null : r;
    }
    case 'maCross': {
      const f = calcMA(closes, c.m0)[i], s = calcMA(closes, c.m1)[i];
      if (f == null || s == null) return null;
      const now = c.dir > 0 ? (f > s) : (f < s);
      return now ? 1 : 0;
    }
  }
  return null;
}
function formPass(c, v) {
  if (v == null) return false;
  switch (c.op) {
    case '>': return v > c.target;
    case '<': return v < c.target;
    case '>=': return v >= c.target;
    case '<=': return v <= c.target;
  }
  return false;
}
// 结果表格里该列显示什么
function formCell(c, v) {
  if (v == null) return '—';
  switch (c.k) {
    case 'rngChg': case 'maPos': case 'pullback': return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
    case 'volRatio': return v.toFixed(2) + ' 倍';
    case 'streak': return v > 0 ? (v + ' 连阳') : ((-v) + ' 连阴');
    case 'rsi': return v.toFixed(1);
    case 'maBull': case 'newHigh': case 'newLow': case 'macdCross': case 'kdjCross': case 'maCross':
      return v ? '✔' : '✘';
  }
  return String(Math.round(v * 100) / 100);
}
function formColLabel(c) {
  switch (c.k) {
    case 'rngChg': return c.n > 0 ? '近' + c.n + '日涨幅' : '区间涨幅';
    case 'maPos': return 'MA' + c.n + '偏离度';
    case 'maBull': return '均线排列';
    case 'volRatio': return '量比(5/20)';
    case 'streak': return '连续天数';
    case 'newHigh': return c.n >= 500 ? '历史新高' : '近' + c.n + '日新高';
    case 'newLow': return c.n >= 500 ? '历史新低' : '近' + c.n + '日新低';
    case 'pullback': return '距' + c.n + '日高点回撤';
    case 'macdCross': return 'MACD' + (c.dir > 0 ? '金叉' : '死叉');
    case 'kdjCross': return 'KDJ' + (c.dir > 0 ? '金叉' : '死叉');
    case 'rsi': return 'RSI(14)';
    case 'maCross': return 'MA' + c.m0 + '×MA' + c.m1;
  }
  return c.k;
}

// 批量抓取专用的腾讯日 K：复用 app.js 的多端点轮询，并把「被拦」与「本来没数据」区分开
async function fetchKlineTxSafe(code, lmt) {
  const r = await fetchKlineTxRaw(code, 'day', lmt || FORM_KLINE_LMT);
  if (r.bars.length) return r.bars;
  if (r.sawBlock) { const e = new Error('行情接口返回了拦截页'); e.waf = true; throw e; }
  return null;   // 全部端点都正常，但这只股票确实没有数据
}
// 批量拉日 K：并发 FORM_CONC + 起步限速 FORM_GAP（防 WAF）；失败重试一次；被拦截则立刻中止。
// onProgress(done, total)
async function fetchKlineBatch(codes, lmt, onProgress) {
  const map = {}, fail = [];
  let idx = 0, done = 0, lastStart = 0, consec = 0;
  const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const grab = async function (c) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const now = Date.now();
      const gap = lastStart + FORM_GAP - now;
      if (gap > 0) await wait(gap);
      lastStart = Date.now();
      try {
        const bars = await fetchKlineTxSafe(c, lmt);
        if (bars && bars.length >= 30) return bars;
        return null;
      } catch (e) {
        if (e && e.waf) { e.code = c; throw e; }     // 被 WAF 拦 → 立刻中止，不再空转打接口
        if (attempt === 1) return null;              // 网络抖动 → 重试一次
        await wait(220);
      }
    }
    return null;
  };
  const worker = async function () {
    while (idx < codes.length) {
      const c = codes[idx++];
      let bars = null;
      try { bars = await grab(c); }
      catch (e) { throw e; }
      if (bars) { map[c] = bars; consec = 0; } else { fail.push(c); consec++; }
      done++;
      if (onProgress) onProgress(done, codes.length);
      // 连续失败太多（且已经跑了一段）→ 大概率是被限流，直接中止，别把整轮时间耗光
      if (consec >= 30 && done >= 40) { const e = new Error('行情接口连续失败，判定为临时限流'); e.waf = true; throw e; }
    }
  };
  const w = Math.min(FORM_CONC, Math.max(1, codes.length));
  const workers = Array.from({ length: w }, worker);
  try { await Promise.all(workers); }
  catch (e) {
    if (e && e.waf) {
      const err = new Error('日 K 接口临时限流（腾讯行情返回了拦截页）。'
        + '已暂停本次扫描，避免把「个股诊断」等其它功能的 K 线一起拖累。请等 1~2 分钟再试，'
        + '或先用「创业板 / 科创板 / 某个板块 + 基本面条件」把候选池缩小之后再跑。');
      err.waf = true;
      throw err;
    }
    throw e;
  }
  return { map: map, fail: fail, total: codes.length };
}
/* 剩余时间文案（秒 → 「42 秒」/「3 分钟」） */
function formEtaText(sec) {
  if (!(sec > 0)) return '--';
  return sec < 60 ? Math.max(1, Math.ceil(sec)) + ' 秒' : Math.ceil(sec / 60) + ' 分钟';
}
/* 进度条：挂在问答消息区底部，跑完自动移除（找不到容器就静默不显示）。
   v3.9.7 旧写法一上来就拿「约 50 只/秒」这个写死的速率预估总耗时 —— 那是压腾讯 WAF 的
   保守下限，真实吞吐随网络波动（实测 2000 只候选 4 秒就跑完，折合 ~500 只/秒），于是会
   出现「预计 40 分钟」结果 4 秒结束这种自相矛盾的提示。
   现在改成：开场只报总数、不预测；拿到进度回调后用「已用时间 ÷ 已完成数」实测速率算剩余
   时间，数字随跑随收敛，不会再胡说。 */
function formProgressStart(total, label) {
  const box = document.getElementById('qaMessages');
  const t0 = Date.now();
  let el = null;
  if (box) {
    el = document.createElement('div');
    el.className = 'msg note form-prog';
    el.innerHTML = '<div class="fp-line">⏳ ' + esc(label || '区间 / 形态选股')
      + '：正在逐只拉取日 K 并计算（共 ' + total + ' 只候选）…</div>'
      + '<div class="fp-bar"><i style="width:0%"></i></div><div class="fp-txt">0 / ' + total + '</div>';
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }
  let lastPaint = 0;
  return {
    update: function (done, tot) {
      if (!el) return;
      const now = Date.now();
      if (done < tot && now - lastPaint < 110) return;   // 节流，避免上千次 DOM 重绘
      lastPaint = now;
      const bar = el.querySelector('.fp-bar > i'), txt = el.querySelector('.fp-txt');
      if (bar) bar.style.width = Math.round(done / Math.max(1, tot) * 100) + '%';
      if (txt) {
        const tail = (done > 0 && done < tot)
          ? '（约剩 ' + formEtaText((now - t0) / done * (tot - done) / 1000) + '）'
          : '';
        txt.textContent = done + ' / ' + tot + tail;
      }
      if (box) box.scrollTop = box.scrollHeight;
    },
    end: function () { if (el && el.parentNode) el.parentNode.removeChild(el); },
  };
}
// 两个已消费区间是否重叠
function spanHit(spans, a, b) {
  for (let i = 0; i < spans.length; i++) { if (a < spans[i][1] && b > spans[i][0]) return true; }
  return false;
}

// 把「问句」解析成结构化筛选条件
function parseScreenQuery(q) {
  const t = String(q || '').replace(/[（(]TTM[)）]/gi, '').replace(/\s+/g, ' ');
  // 形态条件先解析：它消费掉的字符区间（如「近20日累计涨幅超过20%」里的「涨幅」）
  // 不能再被下面的「当日涨跌幅」别名吃掉 —— 否则「近20日累计涨幅超过30%的股票」
  // 会被悄悄改写成「今日涨幅 > 30%」，结果 0 只命中，看着像"没这类股票"。
  const fp = parseFormConds(t);
  const conds = [], used = [];
  SCREEN_ALIAS.forEach(function (pair) {
    const k = pair[0];
    if (conds.some(function (c) { return c.k === k; })) return;
    for (const name of pair[1]) {
      // 找到第一个「不在形态条件区间内」的出现位置
      let idx = -1, from = 0;
      while (true) {
        const at = t.indexOf(name, from);
        if (at < 0) break;
        if (!spanHit(fp.spans, at, at + name.length)) { idx = at; break; }
        from = at + 1;
      }
      if (idx < 0) continue;
      const tail = t.slice(idx + name.length);
      // 「高于15%」「低于20倍」「在15倍以下」——数字前最多夹 14 个非数字字符
      const m = tail.match(/^([^0-9]{0,14}?)(\d+(?:\.\d+)?)/);
      if (!m) continue;
      const between = m[1] || '';
      let dir = null;
      if (SCREEN_OP_DOWN.test(between)) dir = -1;
      else if (SCREEN_OP_UP.test(between)) dir = 1;
      if (dir === null) continue;   // 没写清方向就不猜，宁可放宽条件也不给错结果
      // 「跌幅大于 5%」要按带符号的涨跌幅理解（= 涨跌幅 < -5%）。必须用 /^跌/ ——「涨跌幅」本身含「跌」字但它是中性词。
      let val = parseFloat(m[2]);
      if (k === 'chg' && /^跌/.test(name)) { dir = -dir; val = -val; }
      const coeff = (SCREEN_COLS[k].src === 'val' && SCREEN_COLS[k].key === 'TOTAL_MARKET_CAP' && /亿/.test(between) === false && /亿/.test(tail.slice(0, 6))) ? 1e8 : 1;
      conds.push({ k: k, dir: dir, val: val, scale: coeff });
      used.push(name + between + m[2]);
      break;
    }
  });
  // 排序
  let sort = null, sortDir = -1;
  const sm = t.match(/按\s*([^\s,，。；;、的]{1,14}?)\s*(?:降序|从高到低|由高到低|递减|倒序)/);
  const sm2 = t.match(/按\s*([^\s,，。；;、的]{1,14}?)\s*(?:升序|从低到高|由低到高|递增)/);
  if (sm || sm2) {
    const nm = (sm ? sm[1] : sm2[1]);
    sortDir = sm ? -1 : 1;
    const f = SCREEN_SORT_ALIAS.find(function (x) { return x[1] === nm || x[1].toLowerCase() === nm.toLowerCase(); });
    if (f) sort = f[0];
    // 「按跌幅降序」→ 想看的显然是跌得最狠的排前面，即涨跌幅升序
    if (sort === 'chg' && /^跌/.test(nm)) sortDir = -sortDir;
  }
  // 「涨幅榜 / 换手率前 50」这类没有阈值的排名问句：只给排序，不给筛选条件
  if (!sort) {
    for (const r of SCREEN_RANK_RULES) {
      if (r.re.test(t)) { sort = r.k; sortDir = r.dir; break; }
    }
  }
  // 取前 N
  let top = 20;
  const tm = t.match(/(?:前|top|TOP|Top|取)\s*(\d{1,3})/);
  if (tm) top = Math.min(500, Math.max(1, parseInt(tm[1], 10)));
  // 板块范围（创业板 / 科创板 / 主板 / 北交所）—— 问句里点名了才生效
  const scope = SCREEN_SCOPE_RULES.filter(function (r) { return r.re.test(t); });
  const all = /北交所|北证|全部A股|全市场|新三板|两市|沪深两市/.test(t) || scope.some(function (s) { return s.k === 'bse'; });
  const forms = fp.conds;
  // 「按累计涨幅降序」这类排序意图 → 用区间涨幅当作形态排序键
  if (forms.length && forms.some(function (x) { return x.k === 'rngChg'; })
    && /按[^，,。；;、]{0,12}?(区间|累计|阶段)?涨幅/.test(t)) {
    sort = 'rngChg';
    sortDir = /升序|从低到高|由低到高|递增/.test(t) ? 1 : -1;
  }
  // 需要历史行情、但**没被形态解析器认下来**的条件 → 仍然明确拒答（绝不静默忽略）
  const hist = [];
  SCREEN_HIST_RULES.forEach(function (r) {
    if (hist.indexOf(r.txt) >= 0) return;
    const flags = r.re.flags.indexOf('g') >= 0 ? r.re.flags : r.re.flags + 'g';
    const re = new RegExp(r.re.source, flags);
    let m, bad = false;
    while ((m = re.exec(t))) {
      if (!m[0]) { re.lastIndex++; continue; }
      if (!spanHit(fp.spans, m.index, m.index + m[0].length)) { bad = true; break; }
    }
    if (bad) hist.push(r.txt);
  });
  // 用户提到的、但当前数据源覆盖不到的指标 → 明确列出来
  const unsupported = SCREEN_UNSUPPORTED.filter(function (x) {
    return t.indexOf(x) >= 0 && !conds.some(function (c) { return SCREEN_COLS[c.k].label.indexOf(x) >= 0; });
  });
  return { conds: conds, used: used, sort: sort, sortDir: sortDir, top: top, all: all,
    unsupported: unsupported, scope: scope, hist: hist, forms: forms, formSpans: fp.spans };
}
// 数字格式化（条件选股表格用）
function skNum(v, fmt) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (isNaN(n)) return '—';
  if (fmt === 'n0') return String(Math.round(n));
  return String(Math.round(n * 100) / 100);
}

/* 条件选股主函数：解析问句 → 拉快照 → 逐条筛 → （可选）逐只日 K 算形态 → 排序取前 N */
async function emScreener(query) {
  const p = parseScreenQuery(query);
  const forms = p.forms || [];
  const sortCol = (p.sort && SCREEN_COLS[p.sort]) ? SCREEN_COLS[p.sort] : null;
  // 需要历史行情、且**形态解析器也认不下来**的条件 → 明确拒答。
  if (p.hist && p.hist.length) {
    const e = new Error('这个问句里有当前数据源算不出来的条件：' + p.hist.join('；') + '。\n'
      + '「区间 / 累计涨幅」「均线位置」「均量放大」「连续 N 日」「创新高 / 新低」「自高点回撤」「MACD / KDJ / RSI」这几类现在已经能真算了'
      + '（逐只拉日 K，全创业板约 7 秒），但上面这几条属于本应用目前仍无法从公开数据算出的口径，'
      + '我不会用一个近似的口径替你算出"看着像"的名单。\n'
      + '可行的替代：\n'
      + '  · 换成能算的形态写法：「创业板里近 20 日累计涨幅 > 20%」「站上 MA60 且近 5 日均量放量 50%」「连续 3 日上涨」\n'
      + '  · 当日口径：「创业板今日涨幅前10」「创业板换手率前20」\n'
      + '  · 单只的深度形态判断，用「🩺 个股诊断」（那里是拉真实 K 线算的）\n'
      + '当前支持的筛选指标：涨跌幅 / 最新价 / 换手率 / 量比 / 振幅 / 成交额 / 流通市值 / 市盈率 / 市净率 / 总市值 / ROE / 每股收益 / 营收同比 / 净利同比 / 毛利率 / 每股净资产；'
      + '形态类：区间涨幅 / 均线位置 / 均线排列 / 均量放大 / 连阳连阴 / 创新高新低 / 高点回撤 / MACD·KDJ 金叉 / RSI；范围可按「创业板 / 科创板 / 沪深主板 / 北交所」限定。');
    e.skHint = true;
    throw e;
  }
  // 既没有阈值条件、也没有排名方向、也没有形态条件 → 才算「没听懂」，这时才给示例
  if (!p.conds.length && !sortCol && !forms.length) {
    const e = new Error('没解析出筛选条件。请把条件写清楚，例如：\n'
      + '  「今日涨幅前100」「跌幅榜前50」「换手率前30」「成交额榜前20」\n'
      + '  「市盈率低于20倍且ROE高于15%，按ROE降序前20只」\n'
      + '支持的指标：涨跌幅 / 最新价 / 换手率 / 量比 / 振幅 / 成交额 / 流通市值 / 市盈率 / 市净率 / 总市值 / 净资产收益率(ROE) / 每股收益 / 营收同比 / 净利同比 / 毛利率 / 每股净资产；范围可按「创业板 / 科创板 / 沪深主板 / 北交所」限定');
    e.skHint = true;
    throw e;
  }
  const srcOf = function (k) { return (k && SCREEN_COLS[k]) ? SCREEN_COLS[k].src : ''; };
  const needPerf = p.conds.some(function (c) { return srcOf(c.k) === 'perf'; }) || srcOf(p.sort) === 'perf';
  const needQuote = p.conds.some(function (c) { return srcOf(c.k) === 'q'; }) || srcOf(p.sort) === 'q';
  // needQuote 时也要拉估值表（候选清单与 PE / 市值 / 行业都来自它）；有形态条件时也必须拉
  const needVal = p.conds.some(function (c) { return srcOf(c.k) === 'val'; }) || srcOf(p.sort) === 'val' || needQuote || forms.length > 0;
  // 展示哪些列 —— 只挑「这一轮真的拉到了数据」的那几张表的字段，避免出现整列「—」
  const askInd = /行业|申万|赛道|板块/.test(String(query || ''));
  const wantKeys = new Set();
  if (sortCol && sortCol.quote) {
    wantKeys.add(p.sort); wantKeys.add('chg'); wantKeys.add('price'); wantKeys.add('cap');
  } else {
    if (needVal) { wantKeys.add('pe'); wantKeys.add('cap'); }
    if (needPerf) { wantKeys.add('roe'); }
    if (!needVal && !needPerf) { wantKeys.add('pe'); wantKeys.add('roe'); }
  }
  p.conds.forEach(function (c) { wantKeys.add(c.k); });
  if (askInd) wantKeys.add('ind');
  // 问句里点名了行业 / 板块 / 概念 → 用免费的「板块成分表」取交集
  let boardSet = null, boardLabel = '';
  const bnRaw = String(query || '');
  if (/行业|板块|概念|成分股|产业链|赛道/.test(bnRaw)) {
    const bn = boardNameOf(bnRaw);
    if (bn && bn.length >= 2) {
      for (const cand of [bn, bn + 'Ⅱ', bn + 'Ⅲ', bn + 'Ⅰ']) {
        try {
          const bd = await dcFetchAll('RPT_BOARD_CONSTITUENT', 'BOARD_NAME,SECURITY_CODE', '(BOARD_NAME="' + cand + '")');
          if (bd.length) {
            boardSet = new Set(bd.map(function (x) { return String(x.SECURITY_CODE || '').trim(); }));
            boardLabel = cand; break;
          }
        } catch (e) { boardSet = null; }
      }
    }
  }
  // ---- 数据获取 ----
  let valMap = {}, perfMap = {}, qMap = null, valDate = '', perfDate = '';
  let cands = [], wholeMkt = 0;
  // 榜单快速通道：没有任何阈值条件、只要排名、也没限定板块/范围 → 只按目标字段拉最前面几页
  // ⚠️ 一旦限定了「创业板」这类范围，就必须拉全量快照再本地过滤（头部几页里可能压根没有创业板的票）
  const fastRank = !p.conds.length && !!sortCol && !boardSet && !p.scope.length && sortCol.src === 'val' && !forms.length;
  if (fastRank) {
    const rk = await dcRank('val', sortCol.key, p.sortDir, p.top);
    valDate = rk.date;
    cands = rk.rows.filter(function (x) {
      return /^\d{6}$/.test(String(x.SECURITY_CODE || '').trim());
    }).map(function (x) { return { code: String(x.SECURITY_CODE).trim(), v: x, f: {}, q: null }; });
    wholeMkt = cands.length;
  } else {
    const [v, f] = await Promise.all([
      needVal ? dcSnapshot('val') : Promise.resolve(null),
      needPerf ? dcSnapshot('perf') : Promise.resolve(null),
    ]);
    if (v) { valMap = v.map; valDate = v.date; }
    if (f) { perfMap = f.map; perfDate = f.date; }
    const baseMap = Object.keys(valMap).length ? valMap : perfMap;
    wholeMkt = Object.keys(baseMap).length;
    if (!wholeMkt) throw new Error('全市场快照拉取失败（东财数据中心没有返回数据），请稍后重试');
    cands = Object.keys(baseMap).map(function (c) {
      return { code: c, v: valMap[c] || {}, f: perfMap[c] || {}, q: null };
    });
  }
  // 行情字段尽量用实时数据：① 问句直接要换手率/量比/振幅/成交额，或 ② 估值表还停在上一交易日
  const usesQuote = p.conds.some(function (c) { return c.k === 'chg' || c.k === 'price'; })
    || p.sort === 'chg' || p.sort === 'price';
  const wantLive = needQuote || (usesQuote && !!valDate && valDate !== todayStr());
  if (wantLive) {
    try { qMap = (await qSnapshot()).map; }
    catch (e) {
      qMap = null;
      if (needQuote) {
        throw new Error('实时行情（换手率 / 量比 / 振幅 / 成交额）拉取失败，请稍后重试；'
          + '也可以换成免费收盘快照本来就支持的指标：涨跌幅 / 最新价 / 市盈率 / 市净率 / 总市值 / 财务指标');
      }
    }
  }
  const numOrNull = function (x) {
    if (x === null || x === undefined || x === '') return null;
    const n = Number(x); return isNaN(n) ? null : n;
  };
  const hit = [];
  cands.forEach(function (cand) {
    const c = cand.code, v = cand.v, f = cand.f;
    const isMain = /^(60|68|00|30)/.test(c);
    if (!isMain && !p.all) return;               // 默认只看沪深A股（含创业板/科创板）
    if (/^(4|8|9)/.test(c) && !p.all) return;    // 排除北交所（43/83/87/920）与 B 股
    if (boardSet && !boardSet.has(c)) return;    // 限定在指定板块内
    if (p.scope.length && !p.scope.some(function (s) { return s.test(c); })) return;
    const nm = v.SECURITY_NAME_ABBR || f.SECURITY_NAME_ABBR || '';
    if (!nm) return;
    // 带 ST 标记的默认排除（问句里点名要 ST 才放行）
    if (/(^|[\s*])ST/i.test(nm) && !/(ST股|\*ST|风险警示)/i.test(String(query))) return;
    // 行情：盘中实时优先，拿不到就退回估值表的收盘快照
    const qq = (qMap && qMap[c]) || null;
    const qv = {
      chg: (qq && qq.pct != null) ? qq.pct : numOrNull(v.CHANGE_RATE),
      price: (qq && qq.price != null) ? qq.price : numOrNull(v.CLOSE_PRICE),
      turn: qq ? numOrNull(qq.turnover) : null,
      vr: qq ? numOrNull(qq.volRatio) : null,
      amp: qq ? numOrNull(qq.amp) : null,
      amt: qq ? numOrNull(qq.amount) : null,
      capf: qq ? numOrNull(qq.floatCap) : null,
    };
    const rec = {
      code: c, name: nm, ind: v.BOARD_NAME || f.BOARD_NAME || '',
      pe: numOrNull(v.PE_TTM), pb: numOrNull(v.PB_MRQ), cap: numOrNull(v.TOTAL_MARKET_CAP),
      chg: qv.chg, price: qv.price, turn: qv.turn, vr: qv.vr, amp: qv.amp, amt: qv.amt, capf: qv.capf,
      roe: numOrNull(f.WEIGHTAVG_ROE), eps: numOrNull(f.BASIC_EPS), ystz: numOrNull(f.YSTZ),
      sjltz: numOrNull(f.SJLTZ), mll: numOrNull(f.XSMLL), bps: numOrNull(f.BPS),
      cash: numOrNull(f.MGJYXJJE),
    };
    for (const cd of p.conds) {
      const n = rec[cd.k];
      if (n === null || n === undefined) return;   // 缺数据 → 不入选
      const target = cd.scale && cd.scale !== 1 ? cd.val * cd.scale : cd.val;
      if (cd.dir < 0 && !(n < target)) return;
      if (cd.dir > 0 && !(n > target)) return;
    }
    hit.push(rec);
  });
  if (!hit.length) {
    return {
      proto: 'SCREEN', text: '', empty: true,
      tables: [{ entity: '条件选股 · 0 只命中', head: ['结果'], rows: [['没有股票同时满足这些条件，把阈值放宽一点再试']], ts: false }],
    };
  }
  // ---- 形态 / 区间条件：逐只拉日 K 逐个股算（免费、无需 Key）----
  forms.forEach(function (c, i) { c._id = 'f' + i; });
  let hits = hit, formFail = [], formScanned = 0, formBars = 0, klibHit = 0, klibStaleHint = false;
  if (forms.length) {
    const pool = hit.map(function (x) { return x.code; });
    if (pool.length > FORM_MAX) {
      const e = new Error('这个问句要逐只拉日 K 算形态，候选池有 ' + pool.length + ' 只，'
        + '超过本次能扫描的上限（' + FORM_MAX + ' 只，约 10 秒）。\n'
        + '请再加一个「快照就能算」的前筛条件把候选缩小，例如：\n'
        + '  · 限定范围：「创业板里近 20 日累计涨幅 > 20%」\n'
        + '  · 加基本面：「市盈率低于 60 倍且近 20 日累计涨幅 > 15%」\n'
        + '  · 加板块：「半导体板块里近 10 日累计涨幅 > 10%」\n'
        + '这样既快，也不会「只扫一部分」却不说，让你拿到一份看着正常、其实漏了的名单。');
      e.skHint = true;
      throw e;
    }
    formBars = Math.max(80, Math.min(FORM_KLINE_LMT,
      forms.reduce(function (s, c) {
        const need = Math.max(c.n || 0, c.m1 || 0, c.k === 'rsi' ? 40 : 0);
        return Math.max(s, need);
      }, 0) + 60));
    const prog = formProgressStart(pool.length);
    let bk;
    try {
      /* v3.17.4 K 线库优先：本机/云端 KLib 已覆盖所需根数且末根不旧于市场最新交易日
         → 零外呼直算（整库在内存，5573 只也是毫秒级）；缺票 / 根数不足（如「历史新高」
         要 500 根 > 库的 280）/ 未同步到最新交易日 → 仅这些票回落在线拉。
         库读取或对日失败都整体回落全在线路径，绝不因库挂掉阻断选股。 */
      let klibMap = null;
      try { if (typeof KLib !== 'undefined') klibMap = await KLib.all(); } catch (eK) { klibMap = null; }
      if (klibMap && klibMap.size > 500) {
        let mkt = null;
        try { mkt = await KLib.targetDate(); } catch (eK2) { mkt = null; }
        if (mkt) {
          const needOnline = [];
          const pre = {};
          for (const c of pool) {
            const rec = klibMap.get(c);
            if (rec && rec.bars.length >= formBars && rec.bars[rec.bars.length - 1][0] >= mkt) {
              pre[c] = rec.bars.slice(-formBars).map(b => ({ d: b[0], o: b[1], c: b[2], h: b[3], l: b[4], v: b[5] }));
            } else needOnline.push(c);
          }
          klibHit = Object.keys(pre).length;
          prog.update(klibHit, pool.length);
          const rest = needOnline.length
            ? await fetchKlineBatch(needOnline, formBars, (d, t) => prog.update(klibHit + d, pool.length))
            : { map: {}, fail: [] };
          bk = { map: Object.assign(pre, rest.map), fail: rest.fail, total: pool.length };
        }
      }
      if (!bk) bk = await fetchKlineBatch(pool, formBars, prog.update);
      if (klibMap && klibMap.size > 500 && !klibHit) klibStaleHint = true;   // 有库但一只都没接上 = 库没跟上最新交易日
    }
    finally { prog.end(); }
    formScanned = Object.keys(bk.map).length;
    formFail = bk.fail;
    if (!formScanned) throw new Error('日 K 接口本次一只都没取到（可能是网络波动或临时限流），请稍后重试');
    /* v3.17.4 市场交易日历（供「连续 N 日」对齐）：按「尾位逐位投票」—— 第 j 位（末根
       往前数）取池内出现最多的日期，停牌票的错位日期票数少赢不了多数。降序，[0]=最新。 */
    const streakMax = forms.reduce(function (s, c) { return c.k === 'streak' ? Math.max(s, c.n) : s; }, 0);
    let calTail = null;
    if (streakMax) {
      calTail = [];
      for (let j = 0; j <= streakMax; j++) {
        const f = new Map();
        for (const bars2 of Object.values(bk.map)) {
          const p = bars2.length - 1 - j;
          if (p < 0) continue;
          const d = bars2[p].d;
          f.set(d, (f.get(d) || 0) + 1);
        }
        let bd = '', bc = -1;
        for (const e of f) if (e[1] > bc || (e[1] === bc && e[0] > bd)) { bd = e[0]; bc = e[1]; }
        if (!bd) { calTail = null; break; }
        calTail.unshift(bd);
      }
    }
    const passed = [];
    hit.forEach(function (rec) {
      const bars = bk.map[rec.code];
      if (!bars) return;
      const val = {};
      for (const fc of forms) {
        const v = formMetric(fc, bars, calTail);
        if (v == null) return;                    // 数据不足 → 淘汰，不猜
        val[fc._id] = v;
        if (fc.sortOnly) continue;                // 只作排序键的条件不参与筛选
        if (!formPass(fc, v)) return;
      }
      rec._form = val;
      rec.lastPx = bars[bars.length - 1].c;
      passed.push(rec);
    });
    hits = passed;
    if (!hits.length) {
      return {
        proto: 'SCREEN', text: '', empty: true,
        tables: [{
          entity: '形态选股 · 0 只命中', head: ['结果'], rows: [['没有股票同时满足这些条件，把阈值放宽一点再试']], ts: false,
          note: '共扫描 ' + formScanned + ' 只（候选池 ' + pool.length + ' 只）｜形态条件：' + forms.map(function (c) { return c.text; }).join('；')
            + (formFail.length ? '\n⚠️ ' + formFail.length + ' 只日 K 取数失败已跳过' : ''),
        }],
      };
    }
  }
  // 排序：用户指定了按什么排就按什么排；给了形态条件就默认按「第一个形态指标」从高到低
  const formVal = function (rec, id) { return rec._form ? rec._form[id] : null; };
  const rngCond = forms.find(function (c) { return c.k === 'rngChg'; });
  let sk = p.sort, skDir = p.sortDir;
  if (sk === 'rngChg' && rngCond) sk = rngCond._id;
  if (!sk) {
    if (forms.length) { sk = forms[0]._id; skDir = forms[0].dir > 0 ? -1 : 1; }
    else if (p.conds.length) { sk = p.conds[0].k; skDir = p.conds[0].dir > 0 ? -1 : 1; }
    else { sk = 'roe'; }
  }
  const skCond = forms.find(function (c) { return c._id === sk; });
  const skVal = function (rec) {
    const raw = rec._form && rec._form[sk] !== undefined ? rec._form[sk] : Number(rec[sk]);
    return (raw === null || raw === undefined || isNaN(raw)) ? -Infinity : raw;
  };
  hits.sort(function (a, b) {
    const an = skVal(a), bn = skVal(b);
    return skDir < 0 ? bn - an : an - bn;
  });
  const top = hits.slice(0, p.top);   // 注意：变量名不能省，否则会落到全局 window.top
  // 列：形态条件各占一列排在最前，其后是用户实际筛过 / 排过序的快照指标列
  const snapCols = SCREEN_SHOW_KEYS.filter(function (k) { return wantKeys.has(k); });
  const rows = top.map(function (x, i) {
    const fCells = forms.map(function (c) { return formCell(c, formVal(x, c._id)); });
    const sCells = snapCols.map(function (k) {
      if (k === 'ind') return x.ind || '—';
      if (k === 'cap') return x.cap == null ? '—' : skNum(Number(x.cap) / 1e8, 'n0');
      /* v3.9.7 涨跌幅补上正号：表头已写「涨跌幅(%)」，单元格里不带 % 号，那么 10.02 与 -3.10
         只差一个负号，一眼看不出正负；补 '+' 后与板块成分表的口径一致。 */
      if (k === 'chg') return x.chg == null ? '—' : (x.chg > 0 ? '+' : '') + skNum(x.chg, 'n2');
      return skNum(x[k], SCREEN_COLS[k].fmt);
    });
    return [String(i + 1), x.code, x.name].concat(fCells, forms.length && x.lastPx ? [skNum(x.lastPx, 2)] : [], sCells);
  });
  const desc = (p.used.length ? p.used.join('、') + '｜' : '')
    + (forms.length ? '形态：' + forms.map(function (c) { return c.text; }).join(' 且 ') + '｜' : '')
    + '按' + (skCond ? formColLabel(skCond) : (SCREEN_COLS[sk] ? SCREEN_COLS[sk].label : sk))
    + (skDir < 0 ? '降序' : '升序') + '取前 ' + p.top;
  const mktLabel = boardLabel ? boardLabel + ' 板块内（' + (boardSet ? boardSet.size : 0) + ' 只）'
    : (p.scope.length ? p.scope.map(function (s) { return s.label; }).join(' + ') + '（按代码段限定）'
      : (p.all ? '全部A股' : '沪深A股（已排除 ST 与北交所）'));
  let dataNote = '';
  if (qMap) dataNote += '腾讯实时行情（' + todayStr() + '）';
  if (valDate) dataNote += (dataNote ? ' ＋ ' : '') + '估值 ' + valDate;
  if (perfDate) dataNote += (dataNote ? ' ＋ ' : '') + '业绩 ' + perfDate;
  if (forms.length) dataNote += (dataNote ? ' ＋ ' : '') + (klibHit
    ? 'K线库直算 ' + klibHit + ' 只' + (formScanned > klibHit ? '＋在线补 ' + (formScanned - klibHit) + ' 只' : '')
    : '腾讯日 K（每只 ' + formBars + ' 根）');
  const cap = '命中 ' + Math.min(hits.length, p.top) + ' 只（共命中 ' + hits.length + ' 只 / 候选 ' + wholeMkt + ' 只'
    + (dataNote ? ' · ' + dataNote : '') + '）｜范围：' + mktLabel
    + '\n筛选条件：' + desc + '｜数据来源：免费公开接口（东方财富数据中心 + 腾讯行情），不需要任何 Key'
    + (forms.length ? '\n形态口径：涨幅 / 均线 / 均量 / 连阳 / 新高 / 回撤均按前复权日 K 收盘价算，均线取最新一根；本次扫描 '
      + formScanned + ' 只' + (formFail.length ? '（' + formFail.length + ' 只取数失败已跳过）' : '') : '')
    + (p.unsupported.length ? '\n⚠️ 未纳入筛选：' + p.unsupported.join('、') + '（当前数据源不覆盖这些指标，本次结果未考虑它们）' : '')
    + (klibStaleHint ? '\n💡 本机K线库没跟上最新交易日（本次全部在线拉）。到「分析 → 动量筛选」同步一次K线库后，这类问题即可秒出' : '');
  return {
    proto: 'SCREEN', text: '',
    tables: [{
      entity: desc + ' · 命中 ' + hits.length + ' 只', code: '', ts: false, note: cap,
      head: ['#', '证券代码', '证券名称']
        .concat(forms.map(function (c) { return formColLabel(c); }))
        .concat(forms.length ? ['最新价'] : [])
        .concat(snapCols.map(function (k) { return SCREEN_COLS[k].label; })),
      rows: rows,
    }],
  };
}

/* ============================================================
   七、板块 / 概念 / 指数 成分股 + 股东与主营构成（东财公开数据中心，免费、无 Key、不限次）
   免费通道（浏览器同域直连，CORS 全放行）：
     RPT_BOARD_CONSTITUENT        filter=(BOARD_NAME="人形机器人")  → 304 只
                                  同一张表也覆盖行业：「医药生物」511、「电力设备」412、「银行」42
     RPT_INDEX_COMPONENT          filter=(INDEX_CODE="000300")      → 300 只（沪深300成分）
     RPT_F10_CORETHEME_BOARDTYPE  filter=(BOARD_NAME="人工智能")     → 751 只（兜底）
   注：东财 filter **不支持 like**（实测返回「不支持like查询」），只能精确匹配板块名；
       行业板块名常带罗马数字（白酒Ⅱ、银行Ⅱ），因此按 名 → 名Ⅱ → 名Ⅲ → 名Ⅰ 依次尝试。
   ============================================================ */
const BOARD_INDEX_ALIAS = [
  ['000300', ['沪深300', '沪深三百', 'hs300']],
  ['000016', ['上证50', '上证五十']],
  ['000905', ['中证500', '中证五百']],
  ['000852', ['中证1000', '中证一千']],
  ['000001', ['上证指数', '上证综指', '上证']],
  ['399001', ['深证成指', '深成指', '深证指数']],
  ['399006', ['创业板指', '创业板指数', '创业板']],
  ['399005', ['中小100', '中小板指', '中小板']],
  ['000688', ['科创50', '科创板50']],
];
// 问句噪音词：反复剥掉后，剩下的就是板块名（「人形机器人概念的成分股」→「人形机器人」）
const BOARD_NOISE_RE = /(成分股|成份股|概念股|概念板块|概念|行业板块|板块|行业|指数成分股|指数成分|指数|产业链|里的股票|里的个股|里的名单|里的|里面有|里面|有哪些股票|有哪些公司|有哪些|有什么|都有哪些|都有|全部|所有|包含|包括|属于|相关|的股票|的个股|的名单|个股|股票|名单|龙头股|龙头|公司|标的)/g;
function boardNameOf(q) {
  let t = String(q || '').replace(/\s+/g, '');
  t = t.split(/[，,；;。！!？?\n]/)[0] || '';
  t = t.replace(/^(?:帮我|请|麻烦|给我|我想|想要|看看|看下|看|查一下|查查|查询|找一下|找出|筛出|筛选|列出|列一下|罗列|选一下|来一份|来一个)+/, '');
  for (let i = 0; i < 5; i++) {
    const before = t;
    t = t.replace(BOARD_NOISE_RE, '');
    t = t.replace(/^[的里内中与和及上]+/, '').replace(/[的里内中与和及上下]+$/, '');
    if (t === before) break;
  }
  return t.trim();
}

async function emBoard(query) {
  const raw = String(query || '');
  let idxCode = '', idxName = '', codes = [], boardLabel = '', from = '';
  // 1) 指数优先（先按别名，再按 6 位指数代码）
  for (const pair of BOARD_INDEX_ALIAS) {
    if (pair[1].some(function (n) { return raw.indexOf(n) >= 0; })) { idxCode = pair[0]; idxName = pair[1][0]; break; }
  }
  if (!idxCode) {
    const cm = /(?:^|[^0-9])(000\d{3}|399\d{3})(?![0-9])/.exec(raw);
    if (cm && BOARD_INDEX_ALIAS.some(function (x) { return x[0] === cm[1]; })) { idxCode = cm[1]; idxName = cm[1]; }
  }
  const pick = function (d) { return (d || []).map(function (x) { return String(x.SECURITY_CODE || '').trim(); }); };
  if (idxCode) {
    const d = await dcFetchAll('RPT_INDEX_COMPONENT', 'INDEX_CODE,SECURITY_CODE', '(INDEX_CODE="' + idxCode + '")');
    codes = pick(d); boardLabel = idxName + ' 指数成分'; from = '指数成分表';
  } else {
    const nm = boardNameOf(raw);
    if (!nm || nm.length < 2) {
      const e = new Error('没能从问句里认出板块名（例如「人形机器人」「半导体」「医药生物」）');
      e.noLocal = true; throw e;
    }
    for (const cand of [nm, nm + 'Ⅱ', nm + 'Ⅲ', nm + 'Ⅰ']) {
      const d = await dcFetchAll('RPT_BOARD_CONSTITUENT', 'BOARD_NAME,BOARD_CODE_BK,SECURITY_CODE', '(BOARD_NAME="' + cand + '")');
      if (d.length) { codes = pick(d); boardLabel = cand; from = '板块成分表'; break; }
    }
    if (!codes.length) {
      const d = await dcFetchAll('RPT_F10_CORETHEME_BOARDTYPE', 'BOARD_NAME,BOARD_CODE,SECURITY_CODE', '(BOARD_NAME="' + nm + '")');
      if (d.length) { codes = pick(d); boardLabel = nm; from = '核心题材表'; }
    }
    if (!codes.length) {
      const e = new Error('免费板块库里没有「' + nm + '」这个板块 / 概念（可以换成「人形机器人」「半导体」「医药生物」这类标准说法，或改用「条件选股」按指标筛）');
      e.noLocal = true; throw e;
    }
  }
  codes = [...new Set(codes.filter(function (c) { return /^\d{6}$/.test(c); }))];
  if (!codes.length) { const e = new Error('板块成分表返回了空数据，请稍后重试'); e.noLocal = true; throw e; }
  // 2) 用全市场估值快照补名称 / PE / PB / 行业 / 市值（同域，30 分钟缓存，不额外花钱）
  let vmap = {};
  try { const v = await dcSnapshot('val'); vmap = (v && v.map) || {}; } catch (e) { vmap = {}; }
  const list = codes.map(function (c) {
    const v = vmap[c] || {};
    const pe = Number(v.PE_TTM);
    return {
      code: c, name: v.SECURITY_NAME_ABBR || '', pe: isNaN(pe) ? null : pe,
      pb: nOr(v.PB_MRQ), cap: nOr(v.TOTAL_MARKET_CAP), ind: v.BOARD_NAME || '',
      price: null, pct: null,
    };
  });
  // 3) 排序 + 取前 N
  const askPct = /涨跌幅|涨幅|领涨|涨得|跌幅|跌得/.test(raw);
  const sk = askPct ? 'pct' : (/市盈率|\bPE\b/i.test(raw) ? 'pe' : /市净率|\bPB\b/i.test(raw) ? 'pb' : 'cap');
  const asc = /升序|从小到大|从低到高|最低/.test(raw)
    || (askPct && /(领跌|跌幅最大|跌得最多|跌幅居前)/.test(raw));
  const cmp = function (a, b) {
    const an0 = Number(a[sk]), bn0 = Number(b[sk]);
    const an = (a[sk] === null || a[sk] === undefined || isNaN(an0)) ? -Infinity : an0;
    const bn = (b[sk] === null || b[sk] === undefined || isNaN(bn0)) ? -Infinity : bn0;
    return asc ? an - bn : bn - an;
  };
  if (sk !== 'pct') list.sort(cmp);
  let top = 20;
  const tm = /(?:前|top|TOP|Top|取|给出|列出|只要)\s*(\d{1,3})/.exec(raw);
  if (tm) top = Math.min(200, Math.max(1, parseInt(tm[1], 10)));
  // 按涨跌幅排序时必须先知道全部涨幅，所以先按市值粗排取一批、拉完行情再重排
  const lim = Math.min(list.length, askPct ? Math.max(top, 120) : top);
  const picked = list.slice(0, lim);
  let pctOK = false;
  try {
    const qs = await emQuotesPaged(picked.map(function (x) { return x.code; }));
    const qm = {};
    (qs || []).forEach(function (q) { qm[q.code] = q; });
    picked.forEach(function (x) {
      const q = qm[x.code];
      if (!q) return;
      x.price = q.price; x.pct = q.pct;
      if (!x.name && q.name) x.name = q.name;
      if (x.pe == null && q.pe != null) x.pe = Number(q.pe);
      if (x.cap == null && q.mktCap != null) x.cap = q.mktCap;
    });
    pctOK = picked.some(function (x) { return x.pct !== null; });
    if (askPct && pctOK) picked.sort(cmp);
  } catch (e) { /* 行情拿不到就只展示估值列 */ }
  if (!picked.length) {
    return { proto: 'SCREEN', text: '', empty: true, tables: [{ entity: '板块成分 · 0 只', head: ['结果'], rows: [['该板块成分表返回为空']] }] };
  }
  const show = picked.slice(0, top);
  const cols = ['price', 'pct', 'pe', 'pb', 'cap', 'ind'].filter(function (k) { return k !== 'pct' || pctOK; });
  const heads = { price: '现价/收盘', pct: '涨跌幅', pe: '市盈率(TTM)', pb: '市净率', cap: '总市值(亿)', ind: '所属行业' };
  const rows = show.map(function (x, i) {
    return [String(i + 1), x.code, x.name || '—'].concat(cols.map(function (k) {
      if (k === 'cap') return x.cap == null ? '—' : skNum(Number(x.cap) / 1e8, 'n0');
      if (k === 'pct') return x.pct == null ? '—' : (x.pct > 0 ? '+' : '') + skNum(x.pct, 'n2') + '%';
      return skNum(x[k], 'n2');
    }));
  });
  const sortLabel = { cap: '总市值', pe: '市盈率(TTM)', pb: '市净率', pct: '涨跌幅' }[sk];
  const desc = '板块：' + boardLabel + '｜成分共 ' + codes.length + ' 只｜按' + sortLabel + (asc ? '升序' : '降序') + '取前 ' + show.length
    + '\n数据来源：东方财富公开数据中心（' + from + '，免费、无 Key、不限次数）' + (pctOK ? '；价格与涨跌幅来自腾讯公开行情（免费）' : '')
    + (sk === 'pct' && !pctOK ? '\n⚠️ 本次未能取到行情，已退化为按总市值排序' : '');
  return {
    proto: 'SCREEN', text: '',
    tables: [{
      entity: boardLabel + ' · 成分 ' + codes.length + ' 只', code: '', ts: false, note: desc,
      head: ['#', '证券代码', '证券名称'].concat(cols.map(function (k) { return heads[k]; })),
      rows: rows,
    }],
  };
}

/* ---- 股东 / 主营构成（东财公开数据中心 F10 表，免费、无 Key、不限次）----------------
 * 实测：
 *   RPT_HOLDERNUMLATEST        filter=(SECURITY_CODE="600519") → 股东户数 + 环比
 *   RPT_F10_EH_FREEHOLDERS     filter=(SECUCODE="600519.SH") + END_DATE 倒序 → 最新期十大流通股东
 *   RPT_F10_FN_MAINOP          filter=(SECUCODE="600519.SH") + REPORT_DATE 倒序 → 最新期主营构成 */
async function emHolder(query) {
  const q = String(query || '');
  const codes = await skillPickCodes(q, 3);
  if (!codes.length) { const e = new Error('没认出要查哪只股票，请带上 6 位代码或股票名称'); e.noLocal = true; throw e; }
  const code = codes[0];
  const suf = /^(6|9)/.test(code) ? '.SH' : /^(4|8)/.test(code) ? '.BJ' : '.SZ';
  const secucode = code + suf;
  const wantNum = /户数|股东人数|多少股东|筹码集中|集中度/.test(q);
  const wantTop = /十大|前十大|流通股东|股东持股|机构持仓|谁在持有|持仓变动/.test(q);
  const wantBiz = /主营|业务构成|收入构成|产品结构|靠什么赚钱|营收构成/.test(q);
  const tables = [];
  let nm = '';
  const jobs = [];
  // 股东户数（默认带上：一句话就能说清筹码集中还是分散）
  if (wantNum || (!wantTop && !wantBiz)) jobs.push('num');
  if (wantTop) jobs.push('top');
  if (wantBiz) jobs.push('biz');
  for (const k of jobs) {
    if (k === 'num') {
      const d = await dcFetchAll('RPT_HOLDERNUMLATEST',
        'SECURITY_CODE,SECURITY_NAME_ABBR,HOLDER_NUM,PRE_HOLDER_NUM,HOLDER_NUM_CHANGE,HOLDER_NUM_RATIO,END_DATE,PRE_END_DATE,AVG_MARKET_CAP',
        '(SECURITY_CODE="' + code + '")');
      const x = d[0];
      if (!x) continue;
      nm = x.SECURITY_NAME_ABBR || nm;
      const chg = Number(x.HOLDER_NUM_CHANGE);
      tables.push({
        entity: (x.SECURITY_NAME_ABBR || code) + ' · 股东户数', note:
          '报告期 ' + String(x.END_DATE || '').slice(0, 10) + '（上一期 ' + String(x.PRE_END_DATE || '').slice(0, 10) + '）｜'
          + '股东户数 ' + x.HOLDER_NUM + ' 户，较上期 ' + (isNaN(chg) ? '—' : (chg > 0 ? '+' : '') + chg + ' 户')
          + '（' + (x.HOLDER_NUM_RATIO == null ? '—' : (Number(x.HOLDER_NUM_RATIO) > 0 ? '+' : '') + skNum(x.HOLDER_NUM_RATIO, 'n2') + '%') + '）｜'
          + '户均市值 ' + (x.AVG_MARKET_CAP == null ? '—' : skNum(Number(x.AVG_MARKET_CAP) / 1e4, 'n0') + ' 万元')
          + '｜数据来源：东方财富公开数据中心（免费、无 Key、不限次数）',
        head: ['项目', '本期', '上期'],
        rows: [
          ['股东户数（户）', String(x.HOLDER_NUM), String(x.PRE_HOLDER_NUM)],
          ['较上期变动', isNaN(chg) ? '—' : (chg > 0 ? '+' : '') + chg, '—'],
          ['变动幅度', x.HOLDER_NUM_RATIO == null ? '—' : (Number(x.HOLDER_NUM_RATIO) > 0 ? '+' : '') + skNum(x.HOLDER_NUM_RATIO, 'n2') + '%', '—'],
        ],
      });
    } else if (k === 'top') {
      const d = await dcFetchAll('RPT_F10_EH_FREEHOLDERS',
        'SECUCODE,END_DATE,HOLDER_NAME,HOLD_NUM,FREE_HOLDNUM_RATIO,HOLDER_RANK,HOLD_NUM_CHANGE',
        '(SECUCODE="' + secucode + '")');
      if (!d.length) continue;
      const latest = String(d[0].END_DATE || '').slice(0, 10);
      const one = d.filter(function (x) { return String(x.END_DATE || '').slice(0, 10) === latest; })
        .sort(function (a, b) { return (a.HOLDER_RANK || 99) - (b.HOLDER_RANK || 99); }).slice(0, 10);
      if (!one.length) continue;
      tables.push({
        entity: (nm || code) + ' · 十大流通股东', note:
          '报告期 ' + latest + '｜持股数为流通股口径｜数据来源：东方财富公开数据中心（免费、无 Key、不限次数）',
        head: ['排名', '股东名称', '持股数(万股)', '占流通股(%)', '较上期'],
        rows: one.map(function (x) {
          return [String(x.HOLDER_RANK || ''), x.HOLDER_NAME || '',
            x.HOLD_NUM == null ? '—' : skNum(Number(x.HOLD_NUM) / 1e4, 'n0'),
            x.FREE_HOLDNUM_RATIO == null ? '—' : skNum(x.FREE_HOLDNUM_RATIO, 'n2'),
            x.HOLD_NUM_CHANGE == null ? '—' : String(x.HOLD_NUM_CHANGE)];
        }),
      });
    } else if (k === 'biz') {
      const d = await dcFetchAll('RPT_F10_FN_MAINOP',
        'REPORT_DATE,MAINOP_TYPE,ITEM_NAME,MAIN_BUSINESS_INCOME,MBI_RATIO,GROSS_RPOFIT_RATIO',
        '(SECUCODE="' + secucode + '")');
      if (!d.length) continue;
      const latest = String(d[0].REPORT_DATE || '').slice(0, 10);
      const one = d.filter(function (x) { return String(x.REPORT_DATE || '').slice(0, 10) === latest; });
      const typeName = { '1': '按行业', '2': '按产品', '3': '按地区', '4': '按销售模式' };
      const t2 = one.filter(function (x) { return String(x.MAINOP_TYPE) === '2'; });
      const use = (t2.length ? t2 : one).sort(function (a, b) { return Number(b.MAIN_BUSINESS_INCOME || 0) - Number(a.MAIN_BUSINESS_INCOME || 0); }).slice(0, 12);
      tables.push({
        entity: (nm || code) + ' · 主营构成', note:
          '报告期 ' + latest + '｜按' + (t2.length ? '产品' : (typeName[String(one[0].MAINOP_TYPE)] || '构成').replace(/^按/, '')) + '拆分｜'
          + '数据来源：东方财富公开数据中心（免费、无 Key、不限次数）',
        head: ['构成项', '主营收入', '收入占比(%)', '毛利率(%)'],
        rows: use.map(function (x) {
          const inc = Number(x.MAIN_BUSINESS_INCOME);
          return [x.ITEM_NAME || '',
            isNaN(inc) ? '—' : (Math.abs(inc) >= 1e8 ? skNum(inc / 1e8, 'n2') + ' 亿' : skNum(inc / 1e4, 'n0') + ' 万'),
            x.MBI_RATIO == null ? '—' : skNum(Number(x.MBI_RATIO) * 100, 'n2'),
            x.GROSS_RPOFIT_RATIO == null ? '—' : skNum(Number(x.GROSS_RPOFIT_RATIO) * 100, 'n2')];
        }),
      });
    }
  }
  if (!tables.length) { const e = new Error('免费 F10 表没有返回这只股票的数据'); e.noLocal = true; throw e; }
  return { proto: 'DATA', text: '', tables: tables };
}

/* ============================================================
   八、K 线相似度：给定一只股票，从候选池里找走势最像的
   两个口径一起看，避免只看一个指标就说"像"：
     · 走势相关性 corr —— 日收益率的皮尔逊相关（同涨同跌的程度，可正可负）
     · 形态相似度 sim —— 把价格路径各自标准化（减均值除标准差）后算 RMS 距离 d，
       取 100/(1+d)。纯随机两条路径的基准分约 41 分，所以 >60 才算"形态接近"。
   排名按「形态相似度」降序 —— 用户问的"像"通常指 K 线形状像，而不只是方向一致。 */
function zScoreArr(a) {
  const n = a.length; if (!n) return [];
  const m = a.reduce((s, x) => s + x, 0) / n;
  const v = a.reduce((s, x) => s + (x - m) * (x - m), 0) / n;
  const sd = Math.sqrt(v) || 1e-9;
  return a.map(x => (x - m) / sd);
}
function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length); if (n < 3) return null;
  const za = zScoreArr(a.slice(0, n)), zb = zScoreArr(b.slice(0, n));
  let s = 0; for (let i = 0; i < n; i++) s += za[i] * zb[i];
  return s / n;
}
function klineShapeSim(barsA, barsB, n) {
  if (!barsA || !barsB || barsA.length < n + 1 || barsB.length < n + 1) return null;
  const A = barsA.slice(-(n + 1)).map(function (b) { return b.c; });
  const B = barsB.slice(-(n + 1)).map(function (b) { return b.c; });
  if (A.some(function (x) { return !(x > 0); }) || B.some(function (x) { return !(x > 0); })) return null;
  const ra = [], rb = [];
  for (let i = 1; i <= n; i++) { ra.push(Math.log(A[i] / A[i - 1])); rb.push(Math.log(B[i] / B[i - 1])); }
  const corr = pearsonCorr(ra, rb);
  const za = zScoreArr(A.map(function (v) { return v / A[0]; }));
  const zb = zScoreArr(B.map(function (v) { return v / B[0]; }));
  let s = 0; for (let i = 0; i < za.length; i++) { const dd = za[i] - zb[i]; s += dd * dd; }
  const dist = Math.sqrt(s / za.length);
  // chg 取「候选股」自己的区间涨幅（不是目标股的）—— 展示的是这一行的股票
  return { corr: corr, dist: dist, sim: 100 / (1 + dist), chg: (B[B.length - 1] / B[0] - 1) * 100 };
}

async function emKlineSim(query) {
  const raw = String(query || '');
  // ① 目标股
  let target = (raw.match(/\d{6}/) || [])[0] || null;
  if (!target) {
    const cs = await skillPickCodes(raw, 1).catch(function () { return []; });
    if (cs.length) target = cs[0];
  }
  if (!target) {
    const e = new Error('没认出要比对哪只股票。请写清目标股，例如：\n'
      + '  「找出和中兴通讯 K 线最相似的股票」\n'
      + '  「半导体板块里，K 线形态和 600519 最像的前 10 只」');
    e.skHint = true; throw e;
  }
  // ② 窗口 N 与取前 N
  let win = 60;
  const wm = raw.match(/(?:近|最近|过去)\s*(\d{1,3})\s*个?\s*[日天]/) || raw.match(/(\d{1,3})\s*[日天]\s*(?:走势|K\s*线|形态)/i);
  if (wm) win = parseInt(wm[1], 10);
  win = Math.max(10, Math.min(250, win));
  let top = 10;
  const tm = raw.match(/(?:前|top|TOP|Top|取)\s*(\d{1,3})/);
  if (tm) top = Math.max(1, Math.min(50, parseInt(tm[1], 10)));
  // ③ 候选池：板块（点名了就用板块）∪ 自选 + 持仓
  const own = [...new Set([
    ...(state.watch || []).map(function (w) { return String(w.stock_code || ''); }),
    ...computePositions().map(function (p) { return String(p.code || ''); }),
  ].filter(function (c) { return /^\d{6}$/.test(c); }))];
  let cands = own.slice(), uniLabel = own.length ? '自选 + 持仓' : '';
  if (/板块|概念|行业|成分股|指数/.test(raw)) {
    const bn = boardNameOf(raw);
    if (bn && bn.length >= 2) {
      for (const cand of [bn, bn + 'Ⅱ', bn + 'Ⅲ', bn + 'Ⅰ']) {
        try {
          const bd = await dcFetchAll('RPT_BOARD_CONSTITUENT', 'BOARD_NAME,SECURITY_CODE', '(BOARD_NAME="' + cand + '")');
          if (bd.length) {
            cands = [...new Set(cands.concat(bd.map(function (x) { return String(x.SECURITY_CODE || '').trim(); })))];
            uniLabel = (uniLabel ? uniLabel + ' + ' : '') + cand + ' 板块成分股（' + bd.length + ' 只）';
            break;
          }
        } catch (e) { /* 换下一个板块名写法 */ }
      }
    }
  }
  cands = cands.filter(function (c) { return c !== target; });
  if (!cands.length) {
    throw new Error('没有可比对的股票池：请点名一个板块 / 概念（如「半导体板块里，K 线与 XX 最像的」），'
      + '或先在「自选股」里加几只股票。');
  }
  if (cands.length > FORM_MAX) {
    const e = new Error('候选池有 ' + cands.length + ' 只，超过一次能扫描的上限（' + FORM_MAX + ' 只）。'
      + '请点名一个板块 / 概念，或先用自选股把范围缩小。');
    e.skHint = true; throw e;
  }
  // ④ 拉 K 线：目标股单拉，候选池批量（限速）
  const lmt = win + 80;
  const tk = await fetchKline(target, 101, lmt);
  if (!tk.bars || tk.bars.length < win + 1) throw new Error('目标股 K 线不足 ' + (win + 1) + ' 根，无法比对，建议把窗口改小一点');
  const prog = formProgressStart(cands.length, 'K 线相似度');
  let bk;
  try { bk = await fetchKlineBatch(cands, lmt, prog.update); }
  finally { prog.end(); }
  // ⑤ 逐只算相似度
  const rows = [];
  cands.forEach(function (c) {
    const bars = bk.map[c]; if (!bars) return;
    const s = klineShapeSim(tk.bars, bars, win);
    if (!s || s.corr == null) return;
    rows.push({ code: c, name: (state.stockDict[c] && state.stockDict[c].name) || '', s: s, px: bars[bars.length - 1].c });
  });
  if (!rows.length) {
    return {
      proto: 'SCREEN', text: '', empty: true,
      tables: [{ entity: 'K 线相似度 · 0 只', head: ['结果'], rows: [['候选池里没有取到足够的 K 线数据']], ts: false,
        note: '目标 ' + target + '｜候选 ' + cands.length + ' 只｜窗口 ' + win + ' 日' }],
    };
  }
  rows.sort(function (a, b) { return b.s.sim - a.s.sim; });
  const show = rows.slice(0, top);
  const heads = ['#', '证券代码', '证券名称', '形态相似度', '走势相关性', '近' + win + '日涨幅', '最新价'];
  const body = show.map(function (r, i) {
    return [String(i + 1), r.code, dispStockName(r.code, r.name), r.s.sim.toFixed(1),
      (r.s.corr >= 0 ? '+' : '') + r.s.corr.toFixed(2),
      (r.s.chg >= 0 ? '+' : '') + r.s.chg.toFixed(2) + '%', skNum(r.px, 2)];
  });
  const tName = dispStockName(target, (state.stockDict[target] && state.stockDict[target].name) || (tk.name && tk.name !== target ? tk.name : target));
  const note = '目标股：' + tName + '（' + target + '）｜比对窗口：最近 ' + win + ' 个交易日｜候选池：' + uniLabel
    + '（有效 ' + rows.length + ' 只）\n'
    + '口径：形态相似度 = 100/(1+标准化价格路径的 RMS 距离)，纯随机走势基准约 41 分，>60 才算形态接近；'
    + '走势相关性 = 日收益率皮尔逊相关（+1 完全同向，−1 完全反向）。相似 ≠ 后市会涨，只表示"图形长得像"。';
  return {
    proto: 'SCREEN', text: '',
    tables: [{ entity: 'K 线相似度 · 与 ' + tName + ' 最像的前 ' + show.length + ' 只', code: '', ts: false, note: note, head: heads, rows: body }],
  };
}

/* ============================================================
   九、标的解析：从问句里认股票
   顺序：6 位代码 → 本机持仓/自选/交易 → 全市场字典（名称最长优先）→ 数据中心精确名称查询
   ============================================================ */
async function skillPickCodes(text, limit) {
  const t = String(text || '');
  const lim = limit || 10;
  const codes = [];
  (t.match(/\d{6}/g) || []).forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); });
  if (codes.length) return codes.slice(0, lim);
  // 全市场字典扫「全部」匹配（支持一句问多只）；名称长的优先，避免「中国」把「中国长城」吃掉
  const dict = state.stockDict || {};
  const hits = [];
  for (const c in dict) {
    const n = dict[c] && dict[c].name;
    if (n && n.length >= 2 && t.indexOf(n) >= 0) hits.push({ c: c, len: n.length });
  }
  if (hits.length) {
    hits.sort(function (a, b) { return b.len - a.len || (a.c < b.c ? -1 : 1); });
    const seen = [];
    for (const h of hits) { if (seen.indexOf(h.c) < 0) seen.push(h.c); if (seen.length >= lim) break; }
    return seen;
  }
  // 字典里没有（新股/退市/名称写法不同）→ 退回持仓·自选·交易里的名字
  const s = resolveStockCode(t);
  if (s && /^\d{6}$/.test(s.code)) return [s.code];
  // 仍然认不出：拿问句里最长的几段中文去数据中心做精确名称查询
  const cand = (t.match(/[\u4e00-\u9fa5]{2,8}/g) || []).sort(function (a, b) { return b.length - a.length; });
  for (const nm of cand.slice(0, 3)) {
    const c = await resolveCodeByNameRemote(nm).catch(function () { return ''; });
    if (c) return [c];
  }
  return [];
}
async function skillPickName(text, codes) {
  const t = String(text || '');
  const dict = state.stockDict || {};
  if (codes && codes.length && dict[codes[0]]) return dict[codes[0]].name || codes[0];
  const s = resolveStockCode(t);
  if (s) return s.name || s.code;
  const h = (await skillPickCodes(t, 1).catch(function () { return []; }))[0];
  if (h && dict[h]) return dict[h].name;
  const m = t.match(/[\u4e00-\u9fa5]{2,6}/);
  return m ? m[0] : t.slice(0, 8);
}

/* 本地标的解析：只认「持仓 / 自选 / 交易过」的股票（零网络请求，快） */
function resolveStockCode(q) {
  if (!q) return null;
  const raw = String(q).trim();
  const cands = new Map();
  computePositions().forEach(p => cands.set(p.code, p.name));
  (state.watch || []).forEach(w => { if (!cands.has(w.stock_code)) cands.set(w.stock_code, w.stock_name || w.stock_code); });
  (state.trades || []).forEach(t => { if (!cands.has(t.stock_code)) cands.set(t.stock_code, t.stock_name || t.stock_code); });
  if (/^\d{6}$/.test(raw) && cands.has(raw)) return { code: raw, name: cands.get(raw) };
  for (const [c, n] of cands) if (n && (n === raw || n.includes(raw) || raw.includes(n))) return { code: c, name: n };
  if (/^\d{6}$/.test(raw)) return { code: raw, name: raw };
  return null;
}

/* ============================================================
   十、意图路由
   先走本地规则（零成本、零延迟），认不出来再花一次模型调用。
   ============================================================ */
function qaRouteByRule(q) {
  const t = String(q || '');
  if (!t || t.length > 500) return null;
  const has = re => re.test(t);
  let tool = '';
  /* v3.11.0 技能管理对话安装：最高优先级 —— 「安装涨停板技能」里也有涨停板，
     不先判会被 asd-zt/market 吃掉。动词 + 「技能」同现即入（直接短路返回，
     下面的 if/else if 链会覆盖先行赋值）。 */
  if (/安装|添加|加装|卸载|删除|删掉|移除|启用|开启|停用|禁用|关闭|列出|清单|列表|更新|升级/.test(t) && /技能/.test(t)) return { tool: 'skillmgr' };
  /* v3.11.0 用户自定义技能：触发词字面命中即路由（用户自定义优先于内置 —— 自己装的自己说了算） */
  {
    const us = userSkills().filter(u => u.enabled !== false && u.keywords && u.keywords.length);
    for (const u of us) { if (userSkillHit(u, t)) return { tool: u.id }; }
  }
  // 选股优先级最高：这类问句里常同时出现"诊断""分析"（如"筛选…再做综合诊断"），必须先判
  const listIntent = has(SCREEN_LIST_INTENT_RE) && (has(SCREEN_NOUN_RE) || has(SCREEN_SCOPE_WORD_RE))
    && !/我的(持仓|自选|股票|账户|组合)|我持有|持仓股/.test(t);
  // 形态信号 + 股票名词 → 也是选股（如「站上 MA60 且放量的创业板股票」）；
  // 单靠「站上 / MACD」不足以判定：问某一只（「中兴通讯站上 MA20 了吗」）没有股票名词，不会被这条吃掉。
  const formIntent = has(SCREEN_FORM_ROUTE_RE) && (has(SCREEN_NOUN_RE) || has(SCREEN_SCOPE_WORD_RE))
    && !/我的(持仓|自选|股票|账户|组合)|我持有|持仓股/.test(t);
  // K 线相似度优先级高于选股：问句里常同时出现「股票 / 前10只」这类选股词，
  // 但意图是"找走势最像的"，必须走相似度工具（同样逐只拉 K 线）。
  const simLike = /相似|克隆|同形态|(?:走势|K\s*线|形态|图形|周线|日线)[^，,。；;]{0,10}(?:像|接近)|(?:像|接近)[^，,。；;]{0,6}(?:走势|K\s*线|形态|图形)/.test(t);
  if (simLike) tool = 'sim';
  else if (has(SCREEN_ROUTE_RE) || listIntent || formIntent) tool = 'screener';
  else if (has(/五维|全面.{0,6}(诊断|分析|评估)|深入.{0,6}(诊断|分析)|深度(分析|研究|诊断|解读)|多维(度)?|综合(诊断|评估|分析|判断)|体检/)) tool = 'diag';
  else if (has(/回测|测算|模拟(交易|盘)|策略表现|胜率|盈利因子|网格|跌.{0,8}(买|买入)|涨.{0,8}(卖|卖出)/)) tool = 'backtest';
  else if (has(/复盘|我最近的操作|行为偏差|交易习惯|常犯.{0,4}错误/)) tool = 'review';
  else if (has(/组合风险|持仓风险|仓位风险|集中度|相关性|Beta|β|VaR|压力测试|最大回撤|对冲/)) tool = 'risk';
  else if (has(/技术分析|支撑位|阻力位|压力位|趋势线|均线|K\s?线|MACD|RSI|KDJ|金叉|死叉|买卖信号/)
    /* v3.9.7 补一条收紧规则：问句里点名了「本地认得出的某一只股票」且提到具体均线位
       （「贵州茅台站上 MA20 了吗」）→ 直接判 tech。源站这类问句会掉到模型路由，
       既多花一次调用、也可能被误判成市场取数；这里的附加条件是 resolveStockCode 认得出来，
       所以「创业板里站上 MA60 的股票」这类全市场问句不受影响（它已被上面的 screener 接走）。 */
    || (has(/\bMA\s*\d+/i) && !!resolveStockCode(t))) tool = 'tech';
  /* v3.11.1 持仓实时盈亏：截图反馈的「当我的持仓，截至目前的浮动盈亏」此前无工具命中。
     放在 review / risk 之后（「复盘我的盈亏」仍走复盘），market 之前。 */
  else if (has(/浮动盈亏|持仓盈亏|浮盈|浮亏|盈亏|亏损|赚了多少|亏了多少|赚多少|亏多少/)) tool = 'pnl';
  /* v3.10.4 a-stock-data 移植技能：优先级在 market 之前（market 的关键词表里有「分红」，
     不先判会被吃掉）。涨停类两分支：问原因/封板质量走同花顺揭秘，其余走东财四池；
     负向守卫排除「涨停了吗 / 涨停价」这类个股行情问句（继续走 market/tech）。 */
  else if (has(/涨停原因|封板率|封板成功率|涨停揭秘|涨停[^，。；]{0,8}(原因|题材)|(原因|题材)[^，。；]{0,8}涨停/)) tool = 'asd-thszt';
  else if (has(/涨停池|涨停板|炸板|跌停池|连板|打板|最高板|晋级率|涨停情绪|涨停家数|涨停的股票|涨停了?/)
    && !/涨停价|了吗|没有涨停|是否涨停/.test(t)) tool = 'asd-zt';
  else if (has(/解禁/)) tool = 'asd-lockup';
  else if (has(/可转债|转债|转股价值|转股溢价/)) tool = 'asd-cb';
  else if (has(/业绩预告|预增|预亏|扭亏为盈/)) tool = 'asd-forecast';
  else if (has(/LPR|lpr|贷款市场报价利率/)) tool = 'asd-lpr';
  else if (has(/分红送转|分红历史|历年分红|派息|送股|转增/)) tool = 'asd-dividend';
  else if (has(/估值|市盈率|市净率|市值|现价|股价|价格|多少钱|多少元|报价|最新价|行情|涨跌幅|涨跌|换手|成交量|量比|财务|营收|收入|净利润|利润|ROE|净资产收益|毛利率|每股收益|业绩|年报|半年报|季报|公告|分红|减持|增持|回购|研报|评级|目标价|机构|新闻|资讯|消息|动态|资金流|主力|净流入|北向|股东/)) tool = 'market';
  if (!tool) return null;
  // 组合级 / 全市场级工具无需标的。v3.10.4 起asd-* 七个工具也免标的：
  // 涨停四池 / 揭秘 / LPR / 可转债 / 业绩预告本来就是全市场口径；解禁 / 分红
  // 由包装器内 skillPickCodes 用全市场字典解析（认不出会明示报错，不静默）。
  // v3.11.0：skillmgr 与用户自定义技能同样免标的（技能管理/自定义执行器自己解析）。
  if (tool === 'review' || tool === 'risk' || tool === 'screener' || tool === 'sim'
    || tool.indexOf('asd-') === 0 || tool === 'skillmgr' || tool.indexOf('user-') === 0
    || tool === 'pnl') return { tool };
  // 主题（公告 / 财务 / 综合）在拿到标的之前就能判，先算出来备用
  const topic = /公告|分红|减持|增持|回购|研报|评级|目标价|新闻|资讯|消息|动态/.test(t) ? 'notice'
    : /财务|营收|收入|净利润|利润|ROE|净资产收益|毛利率|业绩|年报|半年报|季报|每股收益/.test(t) ? 'finance' : 'all';
  const s = resolveStockCode(t);
  if (!s) {
    // 本地认不出标的（不在持仓 / 自选 / 交易里）。行情与资讯类仍交给 market —— 取数用的是
    // 全市场字典（11000+ 只），能自己把标的解析出来；回测 / 技术分析必须要有确定标的，交给模型路由。
    if (tool === 'market') return { tool: 'market', stock: '', topic: topic };
    return null;
  }
  const out = { tool, stock: s.name || s.code };
  if (tool === 'backtest') {
    const mm = /(\d+)\s*个?月/.exec(t);
    out.months = mm ? Math.min(120, Math.max(1, parseInt(mm[1], 10)))
      : /半年/.test(t) ? 6 : /季度|三个月/.test(t) ? 3 : /三年|3\s*年/.test(t) ? 36 : 12;
    out.strategy = /MACD/i.test(t) ? 'macd' : /RSI/i.test(t) ? 'rsi' : /跌.{0,8}(买|买入)|网格/.test(t) ? 'drop'
      : /布林/i.test(t) ? 'boll' : /唐奇安|海龟|通道突破/i.test(t) ? 'donchian' : /趋势过滤|双均线/.test(t) ? 'matrend' : 'ma';
    if (out.strategy === 'drop') {
      const dm = /跌\s*(\d+(?:\.\d+)?)\s*%/.exec(t) || /回落\s*(\d+(?:\.\d+)?)/.exec(t);
      const rm = /涨\s*(\d+(?:\.\d+)?)\s*%/.exec(t) || /反弹\s*(\d+(?:\.\d+)?)/.exec(t);
      if (dm) out.dropPct = parseFloat(dm[1]);
      if (rm) out.risePct = parseFloat(rm[1]);
    }
    /* 风控参数：回测问句里可以直接点名（如「加 8% 止损、ATR 3 倍跟踪、回撤 20% 熔断」）。
       v3.9.7 每个参数都补一条「数字在前」的写法 —— 中文里「8% 止损」「20% 熔断」比
       「止损 8%」更常见，原正则只认后者，于是用户写了「加8%止损」时风控被静默忽略、
       回测跑出来的是**没有止损**的结果，看着正常但答非所问。 */
    let m2 = /止损\s*(\d+(?:\.\d+)?)\s*%/.exec(t) || /(\d+(?:\.\d+)?)\s*%\s*(?:的)?(?:固定)?止损/.exec(t);
    if (m2) out.stopPct = parseFloat(m2[1]);
    m2 = /ATR\s*(\d+(?:\.\d+)?)\s*倍/i.exec(t) || /(\d+(?:\.\d+)?)\s*倍\s*(?:的)?ATR/i.exec(t);
    if (m2) out.atrK = parseFloat(m2[1]);
    m2 = /(?:移动止盈|回撤止盈|浮盈回撤|跟踪止盈)\s*(\d+(?:\.\d+)?)\s*%/.exec(t)
      || /(\d+(?:\.\d+)?)\s*%\s*(?:的)?(?:移动止盈|回撤止盈|浮盈回撤|跟踪止盈)/.exec(t);
    if (m2) out.trailPct = parseFloat(m2[1]);
    m2 = /(?:回撤)?熔断\s*(\d+(?:\.\d+)?)\s*%/.exec(t) || /(\d+(?:\.\d+)?)\s*%\s*(?:的)?(?:回撤)?熔断/.exec(t);
    if (m2) out.circuitPct = parseFloat(m2[1]);
  }
  if (tool === 'market') out.topic = topic;
  return out;
}

/* 规则认不出来时的模型兜底路由（只输出 JSON） */
async function qaClassifyIntent(question, allowMarket) {
  const stockList = [...new Map([
    ...computePositions().map(p => [p.code, p.name]),
    ...(state.watch || []).map(w => [w.stock_code, w.stock_name || w.stock_code]),
    ...(state.trades || []).map(t => [t.stock_code, t.stock_name || t.stock_code]),
  ]).entries()].map(([c, n]) => `${n}(${c})`).join('、') || '（暂无）';
  const toolEnum = allowMarket ? 'none|backtest|tech|risk|review|diag|market|screener|sim' : 'none|backtest|tech|risk|review';
  const simDoc = allowMarket
    ? `- sim：**K 线相似度比对**（关键词：相似、走势像、K 线像、形态相似、克隆、和某只最像）。要求"找出一只股票在走势 / K 线形态上最接近的另一批股票"。写这类问句的人会同时出现"股票""前10只"等选股词，但意图是**找像的**而不是按条件筛 —— 出现"相似 / 像"就必须判 sim，不要判 screener。stock 留空。\n`
    : '';
  const screenerDoc = allowMarket
    ? `- screener：**全市场选股 / 筛选 / 排名榜单 / 板块取名单**（关键词：筛选、选股、挑出、选出、筛出、符合条件的股票、哪些股票、成分股、概念股、板块内、产业链、名单、按某指标排序、排行榜、涨幅榜、涨幅前100、跌幅榜、涨停榜、跌停榜、换手率榜、量比榜、成交额榜、振幅榜、最活跃的股票，以及**自然语言写法**：「在创业板/科创板/两市里找…的标的」「按某指标降序给我前 N 只」「给我前 10 只…的股票」）。问的是"全市场里排在前面的股票有哪些"→ 就是它，stock 必须留空。注意区分：问**某一只**股票的涨跌幅/股价/行情 → market；要**一份榜单或名单** → screener。⚠️ 如果条件里含「近 N 日累计涨幅 / 均量放大 / 站上某条均线 / 连续 N 日 / 创新高 / 自高点回撤 / MACD·KDJ 金叉 / RSI」这类**形态或区间**指标，仍判 screener —— 这些条件现在由选股工具逐只拉日 K 真实计算（全创业板约 7 秒），不要因为「像是技术分析」就改判成 tech 或 market。\n`
    : '';
  const diagDoc = allowMarket
    ? `- diag：对**单只股票**做跨维度的"体检式"综合诊断（关键词：全面诊断、深入诊断、深度分析、五维诊断、五维、多维度分析、基本面+技术面+资金面、综合评估、体检、全面研究、这只股票怎么样/值不值得买）。stock 必填。注意区分：只要行情估值财务→market；只要技术指标→tech；要求"多个维度综合起来看一只股票"→diag（优先级高于 market 与 tech）。\n`
    : '';
  const marketDoc = allowMarket
    ? `- market：查询个股的实时行情/估值/财务/公告（关键词：市盈率、PE、市净率、PB、市值、估值、股价多少、现价、涨跌幅、财务、营收、净利润、ROE、毛利率、每股收益、业绩、年报、半年报、季报、公告、分红、减持、增持、回购、研报、评级、目标价）。stock 必填；topic 取 quote（只要行情估值）|finance（只要财务）|notice（只要公告）|all（都要，拿不准就用 all）。\n`
    : '';
  const topicField = allowMarket ? ',"topic":"quote|finance|notice|all（仅 market 用，默认 all）"' : '';
  const text = await llmComplete([
    { role: 'system', content: `你是意图路由器，判断用户消息是否要求执行分析工具。用户名下的股票：${stockList}。只输出 JSON：
{"tool":"${toolEnum}","stock":"用户提到的股票名称或6位代码（未提则留空）","strategy":"ma|macd|rsi|drop|boll|donchian|matrend（仅 backtest 用，未指明默认 ma）","months":12${topicField}}
工具说明：
- backtest：要求回测/测算/模拟交易策略在一段时间内的表现（关键词：回测、测算、模拟、策略表现、胜率、盈利因子、成功率、信号）。months=月数（"最近1个月"=1、"一个季度"=3、"半年"=6、"一年"=12、"三年"=36）；策略选择：提"移动平均线/均线/金叉"→ma，"MACD"→macd，"RSI/背离"→rsi，"跌X%买涨Y%卖/网格/做T"→drop，"布林"→boll，"唐奇安/海龟/通道突破"→donchian，"趋势过滤/双均线"→matrend。若用户还提到风控（止损、ATR 跟踪、移动止盈、回撤熔断），在 stock 之外补字段：stopPct(固定止损%)、atrK(ATR倍数)、trailPct(移动止盈%)、circuitPct(回撤熔断%)，只填用户说了的。
- tech：对某只股票做技术分析（关键词：技术分析、支撑位、阻力位、压力位、趋势线、均线分析、MACD/RSI/KDJ 指标、买卖信号、K 线图）。stock 必填。
- risk：对整个持仓组合做风险分析（关键词：组合风险、持仓风险、仓位风险、分散、相关性、Beta、VaR、压力测试、对冲、最大回撤）。stock 留空。
- review：复盘用户自己的历史交易操作（关键词：复盘、我最近的操作、行为偏差、交易习惯、常犯错误）。
${diagDoc}${marketDoc}${simDoc}${screenerDoc}- none：普通问答、记账、持仓咨询、闲聊等，不需要跑工具。` },
    { role: 'user', content: '用户消息：\n<<<\n' + question + '\n>>>' },
  ], { json: true });
  let j = null;
  try { j = parseJsonLoose(text); } catch (e) { return { tool: 'none' }; }
  return j && j.tool ? j : { tool: 'none' };
}

/* ============================================================
   十一、工具实现
   每个 qaTool* 统一返回 { icon, title, lines, block, html?, chart?, skills? }
     · lines  → 便签上给用户看的摘要行
     · block  → 注入模型上下文的【工具计算结果】（回答必须引用这里的数字）
     · html   → 便签里附的数据表（可选）
   ============================================================ */
async function qaToolBacktest(intent) {
  const s = resolveStockCode(intent.stock);
  if (!s) return null;
  const lmt = btMonthsToLmt(intent.months);
  const t = await computeBacktestCore(s.code, intent.strategy || 'ma', lmt,
    { dropPct: intent.dropPct, risePct: intent.risePct, stopPct: intent.stopPct,
      atrK: intent.atrK, trailPct: intent.trailPct, circuitPct: intent.circuitPct });
  const m = t.m;
  const fmtPct = v => v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
  const trades = [...t.sim.trades, ...(t.sim.open ? [t.sim.open] : [])].slice(-10).map(x =>
    `${x.inD} 买@${x.inP.toFixed(2)} → ${x.open ? '持仓中' : x.outD + ' 卖'}@${x.outP.toFixed(2)} ${x.pnlPct > 0 ? '+' : ''}${x.pnlPct.toFixed(1)}%`);
  const lines = [
    `${s.name}（${s.code}）· ${t.stratLabel} · ${t.periodLabel}`,
    `${m.n} 笔 · 成功率 ${m.winRate == null ? '--' : m.winRate.toFixed(0) + '%'} · 盈利因子 ${fmtPf(m.pf)} · 收益 ${fmtPct(m.ret)}（持有 ${fmtPct(m.refRet)}）`,
  ];
  return {
    icon: '🧪', title: '已完成策略回测', lines,
    block: `【工具计算结果 · 策略回测】（以下为真实回测引擎算出的数字，回答时必须使用这些数字，不要编造）
股票：${s.name}（${s.code}）；策略：${t.stratLabel}（${t.stratDesc}）；区间：${t.periodLabel}；模拟口径：起始 10 万、信号次日开盘成交、含佣金税费
风控叠加：${t.riskDesc}；各风控触发次数 —— 固定止损 ${t.sim.triggers.stop}、ATR 跟踪 ${t.sim.triggers.atr}、移动止盈 ${t.sim.triggers.trail}、回撤熔断 ${t.sim.triggers.circuit}${t.sim.halted ? '（已熔断，剩余区间空仓）' : ''}
交易 ${m.n} 笔（其中未平仓 ${m.open ? 1 : 0} 笔），成功率 ${m.winRate == null ? '--' : m.winRate.toFixed(0) + '%'}，盈利因子 ${fmtPf(m.pf)}，盈亏比 ${m.pl == null ? '--' : m.pl.toFixed(2)}
策略总收益 ${fmtPct(m.ret)}（同期买入持有 ${fmtPct(m.refRet)}），最大回撤 ${m.mddPct.toFixed(1)}%（买入持有 ${m.refMddPct.toFixed(1)}%），平均持仓 ${m.avgDays == null ? '--' : m.avgDays.toFixed(0) + ' 天'}
平仓明细：\n${trades.join('\n') || '（无）'}
规则引擎改进建议：\n${t.sugg.map(x => '- ' + x[1]).join('\n')}
请基于以上结果回答用户的问题（解释数字含义、给出可执行建议），注意提示回测为历史模拟、不构成投资建议。`,
  };
}

async function qaToolTech(intent) {
  const s = resolveStockCode(intent.stock);
  if (!s) return null;
  const [daily, weekly] = await Promise.all([fetchKline(s.code, 101, 260), fetchKline(s.code, 102, 180)]);
  if (!daily.bars.length || !weekly.bars.length) throw new Error('K 线数据不足，无法分析');
  const d = analyzeTimeframe(daily.bars, '日线');
  const w = analyzeTimeframe(weekly.bars, '周线');
  const comb = combineTechSignal(d, w);
  const sig = comb.signal === 'buy' ? '买入' : comb.signal === 'sell' ? '卖出' : '持有';
  const rdesc = an => an.reasons.slice(0, 4).map(r => (r.dir > 0 ? '▲' : '▼') + r.text).join('；');
  return {
    icon: '📈', title: `已完成技术分析：${s.name}`, lines: [
      `${s.name}（${s.code}）· 综合${sig}（强度 ${comb.pct > 0 ? '+' : ''}${comb.pct}）`,
      `日线 ${d.pct > 0 ? '+' : ''}${d.pct} / 周线 ${w.pct > 0 ? '+' : ''}${w.pct} · 现价 ${d.price}`,
    ],
    chart: qaSparkSvg(daily.bars),
    block: `【工具计算结果 · 技术分析】（真实指标计算，回答必须使用这些数字）
股票：${s.name}（${s.code}）
日线：现价 ${d.price}，RSI=${d.rsi == null ? '-' : Math.round(d.rsi)}，KDJ K=${Math.round(d.kdj.K)}/D=${Math.round(d.kdj.D)}/J=${Math.round(d.kdj.J)}，MACD DIF=${(d.macd.dif[d.macd.dif.length - 1]).toFixed(2)}/DEA=${(d.macd.dea[d.macd.dea.length - 1]).toFixed(2)}，强度 ${d.pct}。支撑位：${d.levels.support.join(' / ') || '无明显支撑'}；压力位：${d.levels.resistance.join(' / ') || '无明显压力'}。要点：${rdesc(d)}
周线：强度 ${w.pct}。要点：${rdesc(w)}
综合信号：${sig}（${comb.pct}），${comb.note}
请基于以上结果给出分步操作建议（支撑/压力、趋势、均线、动量），提示风险。`,
  };
}

async function qaToolRisk() {
  const R = await computeRiskCore();
  const itemsDesc = R.items.map(x => `${x.name} 权重${(x.w * 100).toFixed(1)}% β=${x.beta != null ? x.beta.toFixed(2) : '-'} 波动率${x.annVol != null ? (x.annVol * 100).toFixed(0) + '%' : '-'}`).join('；');
  const corr = R.pairs.slice(0, 4).map(p => `${p.a}~${p.b}:${p.r.toFixed(2)}`).join('；') || '样本不足';
  return {
    icon: '🛡️', title: '已完成组合风险分析', lines: [
      `总市值 ${fmtWan(R.total)} · β=${R.betaP.toFixed(2)} · 年化波动 ${(R.portVolA * 100).toFixed(1)}%`,
      `日 VaR95 ${fmtWan(R.var95)} · 市场-20% 预估亏损 ${fmtWan(R.stressLoss)}`,
    ],
    block: `【工具计算结果 · 组合风险分析】（真实计算，回答必须使用这些数字）
持仓：${itemsDesc}
组合：总市值 ${fmtWan(R.total)}，年化波动率 ${(R.portVolA * 100).toFixed(1)}%，β=${R.betaP.toFixed(2)}，日 VaR95=${fmtWan(R.var95)}，市场-20% 压力测试预估亏损 ${fmtWan(R.stressLoss)}
相关性：${corr}
问题清单：\n${R.issues.map(i => '- ' + i.t).join('\n')}
再平衡建议：\n${R.reb.map(r => '- ' + r).join('\n')}
对冲参考：市场敞口 ${fmtWan(R.hedgeNotional)}，对冲 50% ≈ ${fmtWan(R.hedgeAmount)}（股指期货约 ${R.lots} 手或认沽期权），不对冲时市场-20%亏 ${fmtWan(R.stressLoss)}、对冲后约 ${fmtWan(R.stressLoss * 0.5)}
请给出综合解读与操作建议，提示线性估算的局限。`,
  };
}

async function qaToolReview() {
  const core = await computeReviewCore();
  if (!core) return null;
  const lines = core.closed.slice(-15).map(c =>
    `${c.name} 买@${c.entryPrice.toFixed(2)}(${c.entryDate.slice(5)}) → 卖@${c.exitPrice.toFixed(2)}(${c.exitDate.slice(5)}) 持有${c.holdDays}天 ${c.pnlPct > 0 ? '+' : ''}${c.pnlPct.toFixed(1)}%`);
  return {
    icon: '🔍', title: '已完成操作复盘', lines: [
      `复盘 ${core.closed.length} 笔 · 胜率 ${core.winRate.toFixed(0)}% · 盈亏比 ${core.plRatio != null ? core.plRatio.toFixed(2) : '--'}`,
      core.flags.slice(0, 2).map(f => f[1].slice(0, 40)).join('；'),
    ],
    block: `【工具计算结果 · 操作复盘】（真实配对计算，回答必须使用这些数字）
最近 ${core.closed.length} 笔已平仓交易：\n${lines.join('\n')}
统计：胜率 ${core.winRate.toFixed(0)}%，盈亏比 ${core.plRatio != null ? core.plRatio.toFixed(2) : '--'}，平均盈利 ${core.avgWinPct != null ? core.avgWinPct.toFixed(1) + '%' : '--'} / 平均亏损 ${core.avgLossPct != null ? core.avgLossPct.toFixed(1) + '%' : '--'}，盈利单平均持有 ${core.avgHoldWin != null ? core.avgHoldWin.toFixed(1) + '天' : '--'} / 亏损单 ${core.avgHoldLoss != null ? core.avgHoldLoss.toFixed(1) + '天' : '--'}，最近 30 天 ${core.recent30} 笔
检测到的行为偏差：\n${core.flags.map(f => '- ' + f[1]).join('\n')}
请分析反复出现的错误、错失的机会与行为偏差，并给出 3 条含具体数字的个性化规则。`,
  };
}

async function qaToolScreen(question) {
  const r = await emScreener(question);
  const t = r.tables[0];
  if (!t || r.empty || !t.rows.length) {
    throw new Error('没有任何股票同时满足这些条件，请把阈值放宽一点再试');
  }
  const desc = t.entity || '条件选股';
  const lines = [
    '条件：' + (question.length > 56 ? question.slice(0, 56) + '…' : question),
    '命中 ' + t.rows.length + ' 只（表格里列出的是前 ' + Math.min(t.rows.length, 20) + ' 名）',
    '数据：免费公开接口（东方财富数据中心 + 腾讯行情），无 Key、不限次数',
  ];
  return {
    icon: '🎯',
    title: '条件选股已完成',
    lines: lines,
    html: qaTableHtml(r, 20),
    skills: [{ id: 'em-screener', name: '条件选股', ms: 0 }],
    block: '【工具计算结果 · 条件选股 / 榜单（免费公开接口：东方财富数据中心 + 腾讯行情）】\n'
      + '用户原始筛选条件：\n' + question + '\n'
      + '实际执行的筛选：' + desc + '\n\n'
      + '以下是接口真实返回的数据表（表头 + 数据行），禁止改动任何数字、禁止补充表里没有的股票：\n'
      + qaTablesToText(r, 60) + '\n\n'
      + '【报告要求（务必紧凑，全文 1000 字以内）】\n'
      + '1. 先给结论：本次命中多少只、整体画像一句话概括。\n'
      + '2. 用 Markdown 表格列出命中的股票，列包含：代码、名称，以及用户点名要看的那几个指标的实际数值（只列表里确实有的字段，缺的写"—"）。若这是排行榜类问句（涨幅榜 / 换手率榜 / 成交额榜等），必须保持接口给的名次顺序，不要重新排序、不要只挑几只举例。\n'
      + '3. 逐条核验用户给的条件：哪些已被数据验证成立、哪些被数据削弱或推翻、哪些因表里没有对应字段而无法判断 —— 三类必须分开写清楚。\n'
      + '4. 挑出最值得关注的 3 只，各一句话说明理由（引用真实数字）。\n'
      + '5. 一节「证据缺口」：本次数据缺哪些字段（例如所属行业、技术面、资金面都不在这张表里）、对结论影响多大。\n'
      + '6. 结尾一行声明：数据为抓取时点快照（业绩为最近一期报告期，估值与涨跌幅为最近一个交易日收盘、盘中为实时行情），不构成投资建议。',
  };
}

async function qaToolSim(question) {
  const r = await emKlineSim(question);
  const t = r.tables[0];
  if (!t || r.empty || !t.rows.length) throw new Error('K 线相似度比对没有取到可用数据，请稍后重试或换个目标股');
  const lines = [
    '问句：' + (question.length > 56 ? question.slice(0, 56) + '…' : question),
    t.entity + '：' + t.rows.length + ' 只',
    '数据：腾讯前复权日 K（免费、无 Key），形态相似度 + 走势相关性双口径',
  ];
  return {
    icon: '🧬',
    title: 'K 线相似度已完成',
    lines: lines,
    html: qaTableHtml(r, 20),
    skills: [{ id: 'em-sim', name: 'K 线相似度', ms: 0 }],
    block: '【工具计算结果 · K 线相似度】（以下是真实 K 线算出的数字，回答时必须使用，不要编造）\n'
      + '用户原始问句：\n' + question + '\n'
      + '口径说明：' + (t.note || '') + '\n\n'
      + qaTablesToText(r, 60) + '\n\n'
      + '【报告要求（紧凑，全文 800 字以内）】\n'
      + '1. 先一句话给结论：与目标股形态最像的是哪几只。\n'
      + '2. 用 Markdown 表格列出前几名（代码、名称、形态相似度、走势相关性、近 N 日涨幅），数字照抄不要改。\n'
      + '3. 解释「像在哪」：结合走势相关性与区间涨幅，说明是"同步上涨""同步下跌"还是"同形态不同幅度"。\n'
      + '4. 必须写明风险提示：K 线相似只代表历史图形接近，不代表后续会复制走势，且相似度对窗口长度很敏感。\n'
      + '5. 结尾一行声明：历史 K 线为前复权数据，本结果不构成投资建议。',
  };
}

async function qaToolBoard(question) {
  const r = await emBoard(question);
  const t = r.tables[0];
  if (!t || !t.rows.length) throw new Error('板块成分表没有返回数据，请稍后重试');
  const lines = [
    '问句：' + (question.length > 56 ? question.slice(0, 56) + '…' : question),
    t.entity + '：列出 ' + t.rows.length + ' 只（表格里是前 ' + Math.min(t.rows.length, 20) + ' 名）',
    '数据：东方财富公开数据中心 · 板块成分表（免费、无 Key、不限次数）',
  ];
  return {
    icon: '🧩',
    title: '板块 / 概念成分股已取回',
    lines: lines,
    html: qaTableHtml(r, 20),
    skills: [{ id: 'em-board', name: '板块 / 概念成分股', ms: 0 }],
    block: '【工具计算结果 · 板块/概念/指数成分股（东财公开数据中心，免费）】\n'
      + '用户原始问句：\n' + question + '\n'
      + (t.note ? '接口说明：' + String(t.note).replace(/\n/g, '；') + '\n' : '') + '\n'
      + '以下是接口真实返回的名单（表头 + 数据行），禁止改动任何数字、禁止补充表里没有的股票：\n'
      + qaTablesToText(r, 60) + '\n\n'
      + '【回答要求（全文 900 字以内）】\n'
      + '1. 先说清这份名单覆盖多少只成分、数据来自哪张表（板块成分表 / 指数成分表 / 核心题材表）。\n'
      + '2. 用 Markdown 表格列出结果，只列用户点名要的字段；表里没有的字段写"—"，不要臆造。\n'
      + '3. 若用户要求了排序，说明是按哪个字段排的；若数据里没有该字段，明确说明无法按要求排序。\n'
      + '4. 结尾一行声明：数据为抓取时点快照，不构成投资建议。',
  };
}

async function qaToolHolder(question) {
  const r = await emHolder(question);
  if (!r.tables.length) throw new Error('股东 / 主营接口没有返回数据');
  const lines = r.tables.map(function (t) { return t.entity + '：' + t.rows.length + ' 行'; });
  lines.push('数据：东方财富公开数据中心 F10 表（免费、无 Key、不限次数）');
  return {
    icon: '🏛️',
    title: '股东 / 主营构成已取回',
    lines: lines,
    html: qaTableHtml(r, 20),
    skills: [{ id: 'em-holder', name: '股东与主营构成', ms: 0 }],
    block: '【工具计算结果 · 股东与主营构成（东财公开 F10，免费）】\n'
      + '用户问句：\n' + question + '\n'
      + r.tables.map(function (t) { return (t.note ? '说明：' + String(t.note).replace(/\n/g, '；') : ''); }).filter(Boolean).join('\n') + '\n\n'
      + '以下为接口真实返回的数据表（表头 + 数据行），禁止改动任何数字：\n'
      + qaTablesToText(r, 40) + '\n\n'
      + '【回答要求（全文 900 字以内）】\n'
      + '1. 先给结论：筹码是趋于集中还是分散 / 大股东结构说明了什么。\n'
      + '2. 用 Markdown 表格复述关键数据，只列用户问到的部分，缺的写"—"。\n'
      + '3. 若数据里含报告期，必须写明是哪一期，并提示可能不是最新。\n'
      + '4. 结尾一行声明：数据来自公开披露的定期报告快照，不构成投资建议。',
  };
}

/* ---- 个股取数（全部走公开免费接口，无 Key）----
 * 按问句挑需要的那几路数据，只跑用得上的，避免无谓请求：
 *   quote  → 腾讯实时行情 + 当日分时
 *   finance→ 东财业绩报表 + 估值快照 + 机构一致预期
 *   notice → 东财公告 + 东财资讯搜索
 * 标的解析统一走 skillPickCodes（全市场字典），认得出持仓之外的股票。 */
function marketSkillPlan(q) {
  const t = String(q || '');
  const askQuote = /现价|股价|价格|多少钱|报价|最新价|行情|涨跌|市值|换手|成交量|量比|多少元/.test(t);
  const askFin = /财务|营收|营业|收入|净利润|利润|ROE|净资产收益|毛利率|每股收益|EPS|业绩|年报|半年报|季报|分红|派息/.test(t);
  const askVal = /估值|市盈率|PE|市净率|PB|市销率|PS|PEG|目标价|评级|机构|贵不贵|低估|高估|值不值/.test(t);
  const askNews = /新闻|资讯|消息|公告|动态|研报|利好|利空/.test(t);
  const plan = [];
  if (askQuote || (!askFin && !askVal && !askNews)) plan.push('quote');
  if (askFin || askVal) plan.push('fin');
  if (askNews) plan.push('news');
  return plan;
}

async function qaToolMarket(question) {
  const q = String(question || '');
  const plan = marketSkillPlan(q);
  if (!plan.length) return null;
  const codes = await skillPickCodes(q, 1).catch(function () { return []; });
  if (!codes.length) return null;
  const code = codes[0];
  const safe = p => Promise.resolve(p).catch(() => null);
  const dictName = (state.stockDict[code] && state.stockDict[code].name) || '';
  const tables = [], got = [], bad = [];

  /* —— 实时行情 + 当日分时 —— */
  if (plan.indexOf('quote') >= 0) {
    const [qs, minu] = await Promise.all([safe(emQuotes([code])), safe(emMinute(code))]);
    const quote = (qs && qs[0]) || null;
    const nm = (quote && quote.name) || dictName || code;
    if (quote) {
      tables.push({
        entity: nm + '（' + code + '） · 实时行情', ts: false,
        note: '数据来源：腾讯公开行情（免费、无 Key）｜抓取于 ' + new Date().toLocaleString('zh-CN'),
        head: ['项目', '数值'],
        rows: [
          ['证券简称', quote.name || nm],
          ['最新价', emNum(quote.price) + ' 元'],
          ['涨跌幅', emPct(quote.pct)],
          ['涨跌额', emNum(quote.chg)],
          ['今开 / 昨收', emNum(quote.open) + ' / ' + emNum(quote.prevClose)],
          ['最高 / 最低', emNum(quote.high) + ' / ' + emNum(quote.low)],
          ['换手率', emNum(quote.turnover) + ' %'],
          ['量比', emNum(quote.volRatio)],
          ['振幅', emNum(quote.amp) + ' %'],
          ['成交额', emNum(quote.amount) + ' 亿'],
          ['总市值', emYi(quote.mktCap)],
          ['流通市值', emYi(quote.floatCap)],
          ['市盈率(TTM)', emNum(quote.pe)],
          ['市净率', emNum(quote.pb)],
        ],
      });
      got.push('实时行情');
    } else bad.push('实时行情');
    if (minu) {
      tables.push({
        entity: nm + '（' + code + '） · 当日分时（' + (minu.date || '') + '）', ts: false,
        note: '当日累计均量价关系｜数据来源：腾讯公开行情（免费、无 Key）',
        head: ['项目', '数值'],
        rows: [
          ['分时均价', emNum(minu.avg) + ' 元'],
          ['最新价', emNum(minu.last) + ' 元'],
          ['收盘相对均价', emPct(minu.diffPct)],
          ['当日成交额', emYi(minu.amt)],
          ['当日成交量', (minu.vol / 1e4).toFixed(2) + ' 万手'],
          ['日内强弱', minu.diffPct >= 0 ? '收盘价站上均价，日内多方占优' : '收盘价低于均价，日内空方占优'],
        ],
      });
      got.push('当日分时');
    }
  }
  /* —— 财务 + 估值 + 机构一致预期 —— */
  if (plan.indexOf('fin') >= 0) {
    const [fin, val, rating] = await Promise.all([safe(emFinance(code)), safe(emValuation(code)), safe(emRating(code))]);
    if (fin) {
      tables.push({
        entity: (dictName || code) + ' · 财务摘要（' + fin.period + '）', ts: false,
        note: '数据来源：东方财富公开数据中心 · 业绩报表（免费、无 Key）',
        head: ['项目', '数值'],
        rows: [
          ['报告期', fin.period],
          ['营业总收入', emYi(fin.income) + '（同比 ' + emPct(fin.incomeYoY) + '）'],
          ['归母净利润', emYi(fin.netProfit) + '（同比 ' + emPct(fin.profitYoY) + '）'],
          ['加权 ROE', emNum(fin.roe) + ' %'],
          ['销售毛利率', emNum(fin.grossMargin) + ' %'],
          ['基本每股收益', emNum(fin.eps) + ' 元'],
          ['每股净资产', emNum(fin.bps) + ' 元'],
          ['所属行业', fin.board || '—'],
          ['分红方案', fin.dividend || '—'],
        ],
      });
      got.push('财务');
    } else bad.push('财务');
    if (val) {
      tables.push({
        entity: (dictName || code) + ' · 估值快照（' + (val.date || '最新') + '）', ts: false,
        note: '数据来源：东方财富公开数据中心 · 估值分析（免费、无 Key）',
        head: ['项目', '数值'],
        rows: [
          ['PE(TTM)', emNum(val.pe)],
          ['市净率 PB', emNum(val.pb)],
          ['市销率 PS(TTM)', emNum(val.ps)],
          ['PE / 经营现金流', emNum(val.pcf)],
          ['PEG', emNum(val.peg)],
          ['总市值', emYi(val.cap)],
          ['所属行业', val.board || '—'],
        ],
      });
      got.push('估值');
    } else bad.push('估值');
    if (rating) {
      const total = rating.orgNum || ((rating.buy || 0) + (rating.add || 0) + (rating.neutral || 0));
      tables.push({
        entity: (dictName || code) + ' · 机构一致预期', ts: false,
        note: '数据来源：东方财富公开数据中心 · 机构预测（免费、无 Key）',
        head: ['项目', '数值'],
        rows: [
          ['机构覆盖家数', total || '—'],
          ['买入 / 增持 / 中性 / 减持', [rating.buy, rating.add, rating.neutral, rating.reduce].map(v => v == null ? '—' : v).join(' / ')],
          ['目标价区间', (rating.aimMin == null && rating.aimMax == null) ? '—' : (rating.aimMin == null ? '—' : rating.aimMin) + ' ~ ' + (rating.aimMax == null ? '—' : rating.aimMax) + ' 元'],
          ['机构盈利预测(EPS)', rating.eps.length ? rating.eps.join(' / ') : '—'],
          ['相关概念', rating.concepts.length ? rating.concepts.join('、') : '—'],
        ],
      });
      got.push('机构预期');
    }
  }
  /* —— 公告 + 资讯 —— */
  if (plan.indexOf('news') >= 0) {
    const nm = dictName || (await skillPickName(q, [code]));
    const [notices, news] = await Promise.all([safe(emNotices(code, 6)), safe(emNews(nm, 6))]);
    if (notices && notices.length) {
      tables.push({
        entity: (dictName || code) + ' · 最近公告', ts: false,
        note: '数据来源：东方财富公告接口（免费、无 Key）',
        head: ['日期', '公告标题'],
        rows: notices.map(x => [x.date, x.title]),
      });
      got.push('公告');
    }
    if (news && news.length) {
      tables.push({
        entity: (dictName || code) + ' · 近期资讯', ts: false,
        note: '数据来源：东方财富资讯搜索（按时间倒序，免费、无 Key）',
        head: ['日期', '标题', '来源'],
        rows: news.map(x => [x.date, x.title, x.src || '—']),
      });
      got.push('资讯');
    }
    if ((!notices || !notices.length) && (!news || !news.length)) bad.push('公告与资讯');
  }

  if (!tables.length) return null;
  const res = { proto: 'DATA', text: '', tables: tables };
  /* lines 必须是数组 —— toolNoteHtml 会对它做 .map()。
     v3.9.7 修正：原来这里写成了 `got.length ? got.map(...).join(' · ') : '本次未取到数据'`，
     三元的两支类型不一致（字符串 vs 字符串），看起来没错，但便签渲染会直接抛
     「m.lines.map is not a function」把整轮问答打断。 */
  const lines = got.map(function (n) { return n + ' ✓'; });
  if (bad.length) lines.push('未取到：' + bad.join('、'));
  if (!lines.length) lines.push('本次未取到数据');
  return {
    icon: '🌐',
    title: '已取回实时数据',
    lines: lines,
    html: qaTableHtml(res, 20),
    skills: got.map(function (n) { return { id: 'em-' + n, name: n, ms: 0 }; }),
    block: '【工具计算结果 · 个股实时数据（' + got.join(' + ') + '）】（抓取于 ' + new Date().toLocaleString('zh-CN') + '）\n'
      + '数据来源：腾讯公开行情 + 东方财富公开数据中心（全部免费、无需任何 Key）。\n'
      + '以下均为真实返回数据，回答时必须使用其中的数字，禁止编造：\n\n'
      + qaTablesToText(res, 40)
      + (bad.length ? '\n\n【本次未取到】' + bad.join('、') + '（请在回答中如实说明这部分缺失，不要用推测填补）' : '')
      + '\n\n【输出要求】直接回答用户的问题，引用上面的真实数字，不要罗列无关内容；全文 800 字以内。'
      + '数据为抓取时点快照，请提示以交易软件为准，并注意不构成投资建议。',
  };
}

/* 个股取数总入口：先看是不是股东/主营类问句（走免费 F10 表），否则走通用取数。
   v3.9.9 接入妙想补充通道：资金流向 / 北向 / 两融 / 机构调研这类口径免费公开表没有，
   配置了妙想 Key 且启用对应技能时额外问一次妙想（免费优先 —— 免费能取到的照旧走免费）。 */
async function qaToolMarketAuto(question) {
  const q = String(question || '');
  // 股东户数 / 十大流通股东 / 主营构成 —— 东财公开 F10 表就能拿，优先免费
  const holderAsk = /股东|户数|十大流通|前十大|主营构成|收入构成|业务构成|产品结构|靠什么赚钱/.test(q);
  if (holderAsk) {
    try {
      const r = await qaToolHolder(q);
      if (r) return r;
    } catch (e) { /* 免费 F10 取不到 → 继续走通用取数 */ }
  }
  const mxAsk = QA_MX_TOPIC_RE.test(q);
  const res = await qaToolMarket(q);
  if (!mxAsk) return res;
  if (!mxSkillReady()) {
    // 用户问了妙想口径但没配 Key：不能装作没听见 —— 明确告诉模型（和用户）缺什么、去哪配。
    if (res) {
      res.lines.push('资金流向等妙想口径：未配置（设置 → 技能 可粘贴 mkt_ 开头的妙想 Key）');
      res.block += '\n\n【数据缺口说明】用户问到了资金流向 / 北向 / 融资融券等口径，这类数据需要妙想 Key'
        + '（设置 → 技能 里配置），本次未能取到。请如实说明这部分缺失，不要用推测填补。';
    }
    return res;
  }
  try {
    const mx = await qaToolMx(q);
    if (!mx) return res;
    if (!res) return mx;   // 问句只有妙想口径（比如「中国长城主力资金净流入多少」）
    // 两边都有 → 合并：妙想的表接在免费表后面，注入块各附一段，来源各自标清
    res.html += mx.html;
    res.skills = (res.skills || []).concat(mx.skills);
    res.block += '\n\n' + mx.block;
  } catch (e) {
    // 妙想失败不影响免费数据照常回答，但要把失败说清楚（绝不静默出错）
    if (res) {
      res.lines.push('妙想补充口径调用失败：' + (e && e.message || e));
      res.block += '\n\n【妙想调用失败】' + (e && e.message || e) + '（免费公开数据已正常返回，回答时请以免费数据为准，并如实说明妙想口径缺失）';
    } else {
      return {
        icon: '⚠️', title: '妙想取数失败',
        lines: ['数据来源：东方财富妙想 Skills（用户 Key）', '失败原因：' + (e && e.message || e)],
        skills: [], block: '【工具执行失败】妙想接口调用失败：' + (e && e.message || e)
          + '。请如实告诉用户该工具本次执行失败，建议稍后重试；不要编造任何资金流向数字。',
      };
    }
  }
  return res;
}

/* 个股五维诊断（基本面与估值 / 技术趋势 / 资金行为 / 消息事件 / 机构观点） */
async function qaToolDiag(intent) {
  const s = resolveStockCode(intent.stock);
  if (!s) return null;
  const code = s.code;
  const safe = p => Promise.resolve(p).catch(() => null);
  const [quote, fin, val, rating, news, minu, bill, kd, kw] = await Promise.all([
    safe(emQuotes([code]).then(a => (a && a[0]) || null)),
    safe(emFinance(code)),
    safe(emValuation(code)),
    safe(emRating(code)),
    safe(emNews(s.name, 6)),
    safe(emMinute(code)),
    safe(emBillboard(code)),
    safe(fetchKline(code, 101, 260)),
    safe(fetchKline(code, 102, 180)),
  ]);
  const dailyBars = (kd && kd.bars) || [];
  const d = dailyBars.length ? analyzeTimeframe(dailyBars, '日线') : null;
  const w = (kw && kw.bars && kw.bars.length) ? analyzeTimeframe(kw.bars, '周线') : null;
  const comb = (d && w) ? combineTechSignal(d, w) : null;
  if (!quote && !fin && !val && !d) {
    return {
      icon: '⚠️', title: '五维诊断取数失败', lines: ['五个维度的数据接口本次全部不可用'],
      fallback: true,
      block: '【数据源提示】五维诊断所需的行情/财务/估值接口本次全部调用失败（可能是网络波动、标的停牌或数据缺失）。请如实告诉用户「本次未能取到实时数据，无法完成五维诊断」，不要编造任何价格、估值或财务数字，可建议稍后重试。',
    };
  }

  const dims = [];
  const got = [];
  const miss = [];
  const D = (n, title, body) => { dims.push('【维度' + n + ' · ' + title + '】\n' + body); };

  // 维度1 基本面与估值
  let d1 = [];
  if (quote && quote.price != null) {
    d1.push('行情：现价 ' + quote.price + ' 元（' + emPct(quote.pct) + '），今开 ' + quote.open + '，昨收 ' + quote.prevClose
      + '，最高 ' + quote.high + '，最低 ' + quote.low + '，换手率 ' + emNum(quote.turnover) + '%，量比 ' + emNum(quote.volRatio)
      + '，总市值 ' + emYi(quote.mktCap) + '，' + quote.peLabel + ' ' + emNum(quote.pe) + '，市净率 ' + emNum(quote.pb));
  }
  if (val) {
    d1.push('估值快照（' + (val.date || '最新') + '）：PE(TTM) ' + emNum(val.pe) + '，PB ' + emNum(val.pb)
      + '，PS(TTM) ' + emNum(val.ps) + '，PE/经营现金流 ' + emNum(val.pcf) + '，PEG ' + emNum(val.peg)
      + (val.board ? '，所属行业 ' + val.board : ''));
  }
  if (fin) {
    d1.push('最近财报（' + fin.period + '）：营业总收入 ' + emYi(fin.income) + '（同比 ' + emPct(fin.incomeYoY) + '），归母净利润 '
      + emYi(fin.netProfit) + '（同比 ' + emPct(fin.profitYoY) + '），加权ROE ' + emNum(fin.roe) + '%，销售毛利率 ' + emNum(fin.grossMargin)
      + '%，基本EPS ' + emNum(fin.eps) + ' 元，每股净资产 ' + emNum(fin.bps) + ' 元，分红方案 ' + (fin.dividend || '—'));
  }
  if (d1.length) { D(1, '基本面与估值', d1.join('\n')); got.push('基本面与估值'); } else miss.push('基本面与估值（财务/估值接口不可用）');

  // 维度2 技术趋势
  let d2 = [];
  if (d) {
    d2.push('日线：现价 ' + d.price + '，RSI ' + (d.rsi == null ? '-' : Math.round(d.rsi))
      + '，KDJ K/D/J ' + Math.round(d.kdj.K) + '/' + Math.round(d.kdj.D) + '/' + Math.round(d.kdj.J)
      + '，MACD DIF ' + d.macd.dif[d.macd.dif.length - 1].toFixed(2) + ' / DEA ' + d.macd.dea[d.macd.dea.length - 1].toFixed(2)
      + '，多维强度 ' + (d.pct > 0 ? '+' : '') + d.pct);
    d2.push('日线支撑：' + (d.levels.support.join(' / ') || '无明显支撑') + '；日线压力：' + (d.levels.resistance.join(' / ') || '无明显压力'));
    d2.push('日线要点：' + d.reasons.slice(0, 4).map(r => (r.dir > 0 ? '▲' : '▼') + r.text).join('；'));
  }
  if (w) {
    d2.push('周线强度 ' + (w.pct > 0 ? '+' : '') + w.pct + '；要点：' + w.reasons.slice(0, 3).map(r => (r.dir > 0 ? '▲' : '▼') + r.text).join('；'));
  }
  if (comb) d2.push('技术面综合信号：' + (comb.signal === 'buy' ? '偏多' : comb.signal === 'sell' ? '偏空' : '中性') + '（强度 ' + comb.pct + '）' + (comb.note ? '，' + comb.note : ''));
  if (dailyBars.length) d2.push('近 90 日区间：收盘 ' + dailyBars.slice(-90)[0].c + ' → ' + dailyBars[dailyBars.length - 1].c
    + '（' + (((dailyBars[dailyBars.length - 1].c / dailyBars.slice(-90)[0].c - 1) * 100).toFixed(1)) + '%）');
  if (d2.length) { D(2, '技术趋势', d2.join('\n')); got.push('技术趋势'); } else miss.push('技术趋势（K 线接口不可用）');

  // 维度3 资金行为
  let d3 = [];
  if (minu) {
    d3.push('当日量能（' + (minu.date || '') + '）：成交额 ' + emYi(minu.amt) + '，成交量 ' + (minu.vol / 1e4).toFixed(2) + ' 万手'
      + (quote ? '，换手率 ' + emNum(quote.turnover) + '%，量比 ' + emNum(quote.volRatio) : ''));
    d3.push('日内节奏：分时均价 ' + emNum(minu.avg) + ' 元，收盘 ' + emNum(minu.last) + ' 元，收盘相对均价 '
      + emPct(minu.diffPct) + '（' + (minu.diffPct >= 0 ? '收盘价站上均价，日内多方占优' : '收盘价低于均价，日内空方占优') + '）');
  }
  if (bill) {
    const bl = bill.map(g => g.date + ' 买入 ' + emYi(g.buy) + ' / 卖出 ' + emYi(g.sell) + '（' + g.seats + ' 个席位' + (g.reason ? '，' + g.reason : '') + '）');
    d3.push('近 120 天龙虎榜 ' + bill.length + ' 次上榜：\n' + bl.join('\n'));
  } else if (minu || quote) {
    d3.push('近 120 天未登上龙虎榜（无异动席位数据，属正常情况）');
  }
  if (d3.length) { D(3, '资金行为', d3.join('\n')); got.push('资金行为'); } else miss.push('资金行为（分时/席位接口不可用）');

  // 维度4 消息事件
  let d4 = [];
  if (rating && (rating.board || rating.concepts.length)) {
    d4.push('所属板块：' + (rating.board || '—') + (rating.concepts.length ? '；相关概念：' + rating.concepts.join('、') : ''));
  }
  if (news && news.length) {
    d4.push('近期资讯（东方财富资讯搜索，按时间倒序，共取回 ' + news.length + ' 条）：\n'
      + news.map(x => '- ' + x.date + ' ' + x.title + (x.src ? '（' + x.src + '）' : '')).join('\n'));
  } else {
    miss.push('消息事件（资讯/公告接口未取到数据，需在报告中明确标注为证据缺口）');
  }
  if (d4.length) { D(4, '消息事件', d4.join('\n')); got.push('消息事件'); }

  // 维度5 机构观点
  let d5 = [];
  if (rating) {
    const total = rating.orgNum || ((rating.buy || 0) + (rating.add || 0) + (rating.neutral || 0));
    d5.push('机构覆盖：' + (total || '—') + ' 家（买入 ' + (rating.buy == null ? '—' : rating.buy) + ' / 增持 '
      + (rating.add == null ? '—' : rating.add) + ' / 中性 ' + (rating.neutral == null ? '—' : rating.neutral) + ' / 减持 '
      + (rating.reduce == null ? '—' : rating.reduce) + '）');
    if (rating.aimMin != null || rating.aimMax != null) {
      const pos = quote && quote.price != null
        ? '现价 ' + quote.price + ' 元，位于目标价区间' + (quote.price < rating.aimMin ? '下方（低于下沿 '
          + (((quote.price / rating.aimMin - 1) * 100).toFixed(1)) + '%）' : quote.price > rating.aimMax ? '上方（高于上沿 '
          + (((quote.price / rating.aimMax - 1) * 100).toFixed(1)) + '%）' : '之内')
        : '';
      d5.push('机构目标价区间：' + (rating.aimMin == null ? '—' : rating.aimMin) + ' ~ ' + (rating.aimMax == null ? '—' : rating.aimMax) + ' 元' + (pos ? '；' + pos : ''));
    }
    if (rating.eps.length) d5.push('机构一致盈利预测（每股收益，元）：' + rating.eps.join(' / '));
  } else {
    miss.push('机构观点（机构评级接口未取到数据，需标注为证据缺口）');
  }
  if (d5.length) { D(5, '机构观点', d5.join('\n')); got.push('机构观点'); }

  const summary = [];
  if (quote) summary.push(quote.name + ' 现价 ' + quote.price + ' 元（' + emPct(quote.pct) + '）');
  summary.push('五维数据取回 ' + got.length + '/5' + (got.length ? '：' + got.join('、') : ''));
  if (val) summary.push('PE(TTM) ' + emNum(val.pe) + ' / PB ' + emNum(val.pb));
  if (rating && rating.orgNum) summary.push('机构 ' + rating.orgNum + ' 家覆盖');
  if (comb) summary.push('技术面' + (comb.signal === 'buy' ? '偏多' : comb.signal === 'sell' ? '偏空' : '中性') + '（' + comb.pct + '）');

  return {
    icon: '🔬',
    title: '已完成五维诊断取数',
    lines: summary,
    chart: qaSparkSvg(dailyBars),
    block: `【工具计算结果 · 个股五维诊断数据包】（抓取于 ${new Date().toLocaleString('zh-CN')}）
标的：${s.name}（${code}）
数据来源：行情/分时来自腾讯公开接口，财务/估值/机构评级/席位来自东方财富公开数据中心，资讯来自东方财富资讯搜索。全部免费、无需任何 Key。
以下均为接口真实返回，回答时必须使用这些数字，禁止编造；不得虚构本数据包中未出现的新闻事件或机构评级。

${dims.join('\n\n')}

【本次证据缺口（必须在报告中如实呈现，不得用推测填补）】
${miss.length ? miss.map(x => '- ' + x).join('\n') : '- 五个维度均有数据，但均为公开数据快照，缺少机构研报正文、公司公告全文与主力资金逐笔明细。'}

【报告输出要求（务必紧凑，全文控制在 900 字以内，直接出结论、不要铺垫）】
1. 开篇一句话综合判断：方向 + 信心度 + 最主要依据。
2. 五个维度各 2~3 句：结论 → 关键数字（引用上面数据）→ 判断（看多 / 中性 / 看空）。
3. 一节「共识与冲突」：1~2 条互相印证之处 + 1~2 条互相矛盾之处，并点出矛盾可能的原因。
4. 一节「证据缺口」：一句话说明缺哪些数据、对结论可靠性影响多大。
5. 一节「风险与验证指标」：3 条风险（按可能性×影响排序），每条配一个可跟踪的验证指标与阈值（如"下季报营收同比能否转正""能否站上 20 日均线"）。
6. 结尾一句话声明：数据为抓取时点快照、以交易软件为准、不构成投资建议。
图表已在上方工具便签中给出（近 90 日收盘走势 + 20 日均线），正文直接引用走势结论即可，不要重复绘制。`,
  };
}

/* ============================================================
   十二、主入口：判断是否需要跑工具 → 返回注入主回答的【工具计算结果】文本
   ============================================================ */
/* ============================================================
   第十五章 v3.10.4 a-stock-data 移植技能（免费直连，零 Key、不花 token 外的任何额度）
   来源：github.com/simonlin1212/a-stock-data（Apache-2.0）。该项目本体是
   「SKILL.md + 内嵌 Python」，浏览器跑不了 Python；这里把它目录里
   浏览器可直连的 7 类端点用 JS 移植进来，取数逻辑与原项目一致，来源照实标注。
   大模型只负责「问句 → 调哪个工具」，取数全部免费直连 —— 与用户预期的
   「几乎不花费 token，只是大模型确定调用哪个」一致。
   ============================================================ */

/* 东财数据中心单页取数小助手（复用既有 dcUrl 的参数形状；ASD = a-stock-data）。
   source=WEB&client=WEB 是原项目 _em_datacenter_strict 的必带参数 —— 缺了部分报表
   （如 RPT_BOND_CB_LIST）会返回空，属于「参数不完整」而非「没数据」。 */
async function asdDc(report, filter, size, sortCol, sortTypes, extra) {
  let u = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=' + report
    + '&columns=ALL&pageSize=' + (size || 20) + '&pageNumber=1'
    + '&source=WEB&client=WEB';
  if (sortCol) u += '&sortColumns=' + sortCol + '&sortTypes=' + (sortTypes == null ? -1 : sortTypes);
  if (filter) u += '&filter=' + encodeURIComponent(filter);
  if (extra) u += '&' + extra;
  const t0 = Date.now();
  try {
    const res = await fetch(u);
    const j = await res.json();
    const rows = (j && j.result && j.result.data) || [];
    qaAuditLog('a-stock-data ' + report, u, t0, rows.length, rows.length ? '' : (j && j.message) || '返回空');
    return rows;
  } catch (e) {
    qaAuditLog('a-stock-data ' + report, u, t0, 0, e.message || String(e));
    throw e;
  }
}

/* —— 8.1 东财涨停板四池（push2ex，零鉴权） —— */
const ASD_ZT_UT = '7eea3edcaed734bea9cbfc24409ed989';
function asdZtTime(t) {
  const s = String(t == null ? '' : t).padStart(6, '0');
  return s.slice(0, 2) + ':' + s.slice(2, 4) + ':' + s.slice(4, 6);
}
async function asdZtApi(endpoint, sort, date) {
  const t0 = Date.now();
  const url = 'https://push2ex.eastmoney.com/' + endpoint + '?ut=' + ASD_ZT_UT
    + '&dpt=wz.ztzt&Pageindex=0&pagesize=10000&sort=' + sort + '&date=' + date;
  try {
    const res = await fetch(url, { headers: { 'Referer': 'https://quote.eastmoney.com/' } });
    const j = await res.json();
    const pool = (j && j.data && j.data.pool) || [];
    qaAuditLog('a-stock-data ' + endpoint, url, t0, pool.length, pool.length ? '' : '返回空（可能非交易日）');
    return pool;
  } catch (e) {
    qaAuditLog('a-stock-data ' + endpoint, url, t0, 0, e.message || String(e));
    return [];
  }
}
function asdZtRow(p) {
  return {
    code: p.c, name: p.n, price: p.p / 1000, pct: Math.round(p.zdp * 100) / 100,
    turnover: p.hs == null ? null : Math.round(p.hs * 100) / 100,
    industry: p.hybk || '',
    ztStat: String((p.zttj || {}).days || '?') + '天' + String((p.zttj || {}).ct || '?') + '板',
  };
}
/* 问句里抠日期（2026-10-15 / 20261015 / 10月15日 …），缺省今天（北京时间） */
function asdDateFromQ(q) {
  const m = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/.exec(String(q || ''));
  if (m) return m[1] + String(m[2]).padStart(2, '0') + String(m[3]).padStart(2, '0');
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
}
async function asdZtPools(date) {
  const [ztRaw, zbRaw, dtRaw, yzRaw] = await Promise.all([
    asdZtApi('getTopicZTPool', 'fbt:asc', date),
    asdZtApi('getTopicZBPool', 'fbt:asc', date),
    asdZtApi('getTopicDTPool', 'fund:asc', date),
    asdZtApi('getYesterdayZTPool', 'zs:desc', date),
  ]);
  const zt = ztRaw.map(p => Object.assign(asdZtRow(p), {
    amount: p.amount, floatCap: p.ltsz, limitDays: p.lbc,
    firstSeal: asdZtTime(p.fbt), lastSeal: asdZtTime(p.lbt), sealFund: p.fund, breakTimes: p.zbc,
  }));
  const zb = zbRaw.map(p => Object.assign(asdZtRow(p), {
    limitPrice: p.ztp / 1000, firstSeal: asdZtTime(p.fbt), breakTimes: p.zbc, amp: p.zf,
  }));
  const dt = dtRaw.map(p => Object.assign(asdZtRow(p), {
    sealFund: p.fund, lastSeal: asdZtTime(p.lbt), dtDays: p.days, openTimes: p.oc,
  }));
  const yz = yzRaw.map(p => Object.assign(asdZtRow(p), { amp: p.zf, yLimitDays: p.ylbc }));
  /* 8.3 情绪速算：炸板率 / 最高连板 / 连板梯队 */
  const ladder = {};
  zt.forEach(s => { ladder[s.limitDays] = (ladder[s.limitDays] || 0) + 1; });
  const sentiment = {
    zt: zt.length, zb: zb.length, dt: dt.length,
    breakRate: (zt.length + zb.length) ? Math.round(zb.length / (zt.length + zb.length) * 1000) / 10 : 0,
    maxHeight: zt.reduce((m, s) => Math.max(m, s.limitDays || 0), 0),
    ladder: Object.keys(ladder).sort((a, b) => a - b).map(k => k + '板' + ladder[k] + '家').join(' · ') || '—',
  };
  return { zt, zb, dt, yz, sentiment, date };
}

/* —— 8.2 同花顺涨停揭秘（原因题材 + 封板质量） ——
   ⚠ 该接口未确认开放 CORS，浏览器可能读不到响应 —— 取不到就明示，绝不静默编造 */
async function asdThsZt(date) {
  const t0 = Date.now();
  const url = 'https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool?page=1&limit=200'
    + '&field=199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004'
    + '&filter=HS,GEM2STAR&order_field=330324&order_type=0&date=' + date;
  try {
    const res = await fetch(url);
    const j = await res.json();
    const info = (j && j.data && j.data.info) || [];
    qaAuditLog('a-stock-data 同花顺涨停揭秘', url, t0, info.length, info.length ? '' : '返回空');
    return info.map(it => ({
      code: it.code, name: it.name, price: it.latest, pct: it.change_rate,
      reason: it.reason_type || '', boardType: it.limit_up_type || '',
      sealRate: it.limit_up_suc_rate == null ? null : Math.round(it.limit_up_suc_rate * 1000) / 10,
      breakTimes: it.open_num || 0, highDays: it.high_days || '',
      firstTime: it.first_limit_up_time ? new Date(it.first_limit_up_time * 1000).toTimeString().slice(0, 8) : '',
    }));
  } catch (e) {
    qaAuditLog('a-stock-data 同花顺涨停揭秘', url, t0, 0, e.message || String(e) + '（可能被浏览器 CORS 拦截）');
    throw new Error('同花顺涨停揭秘接口取不到（可能被浏览器跨域拦截）：' + (e.message || e));
  }
}

/* —— 3.6 限售解禁（RPT_LIFT_STAGE） —— */
async function asdLockup(code, days) {
  const start = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + (days || 90) * 86400000).toISOString().slice(0, 10);
  const map = r => ({
    date: String(r.FREE_DATE || '').slice(0, 10),
    type: r.FREE_SHARES_TYPE || '',
    shares: r.FREE_SHARES, ableShares: r.ABLE_FREE_SHARES,
    ratio: r.FREE_RATIO == null ? null : Math.round(r.FREE_RATIO * 10000) / 100,   // 小数 → %
  });
  const hist = await asdDc('RPT_LIFT_STAGE', '(SECURITY_CODE="' + code + '")', 10, 'FREE_DATE', -1);
  const up = await asdDc('RPT_LIFT_STAGE',
    '(SECURITY_CODE="' + code + '")(FREE_DATE>=\'' + start + '\')(FREE_DATE<=\'' + end + '\')', 20, 'FREE_DATE', 1);
  return { history: hist.map(map), upcoming: up.map(map), end: end };
}

/* —— 4.4 分红送转（RPT_SHAREBONUS_DET） —— */
async function asdDividend(code) {
  const rows = await asdDc('RPT_SHAREBONUS_DET', '(SECURITY_CODE="' + code + '")', 20, 'EX_DIVIDEND_DATE', -1);
  return rows.map(r => ({
    date: String(r.EX_DIVIDEND_DATE || '').slice(0, 10),
    bonusRmb: r.PRETAX_BONUS_RMB, transfer: r.TRANSFER_RATIO, bonus: r.BONUS_RATIO,
    progress: r.ASSIGN_PROGRESS || '',
  }));
}

/* —— 14.1 业绩预告（RPT_PUBLIC_OP_NEWPREDICT）：code 空 = 全市场最新 30 条 —— */
async function asdForecast(code) {
  const rows = await asdDc('RPT_PUBLIC_OP_NEWPREDICT', code ? '(SECURITY_CODE="' + code + '")' : '',
    30, 'NOTICE_DATE', -1);
  const yi = v => (v == null || !isFinite(v)) ? null : Math.abs(v) >= 1e8 ? Math.round(v / 1e8 * 100) / 100 + '亿' : Math.round(v / 1e4) + '万';
  return rows.map(r => ({
    code: r.SECURITY_CODE, name: r.SECURITY_NAME_ABBR,
    noticeDate: String(r.NOTICE_DATE || '').slice(0, 10), reportDate: String(r.REPORT_DATE || '').slice(0, 10),
    indicator: r.PREDICT_FINANCE || '', type: r.PREDICT_TYPE || '',
    range: (r.PREDICT_AMT_LOWER != null && r.PREDICT_AMT_UPPER != null)
      ? yi(r.PREDICT_AMT_LOWER) + ' ~ ' + yi(r.PREDICT_AMT_UPPER) : '',
    chg: (r.ADD_AMP_LOWER != null && r.ADD_AMP_UPPER != null)
      ? r.ADD_AMP_LOWER + '% ~ ' + r.ADD_AMP_UPPER + '%' : '',
    content: String(r.PREDICT_CONTENT || '').slice(0, 80),
  }));
}

/* —— 11.5 LPR（RPTA_WEB_RATE）：全历史从 1991 年起远超 500 行，倒序取最近 12 期 —— */
async function asdLpr() {
  const rows = await asdDc('RPTA_WEB_RATE', '', 12, 'TRADE_DATE', -1);
  const list = rows.filter(r => r.LPR1Y != null)
    .map(r => ({ date: String(r.TRADE_DATE || '').slice(0, 10), y1: r.LPR1Y, y5: r.LPR5Y }));
  return list.reverse();
}

/* —— 15.1 可转债（RPT_BOND_CB_LIST + 服务端报价列） ——
   只拉最近上市约 1500 只（3 页）；历史摘牌不全，如实标注 —— */
const ASD_CB_QUOTES = 'quoteColumns=' + encodeURIComponent(
  'f2~01~CONVERT_STOCK_CODE~CONVERT_STOCK_PRICE,f235~10~SECURITY_CODE~TRANSFER_PRICE,'
  + 'f236~10~SECURITY_CODE~TRANSFER_VALUE,f2~10~SECURITY_CODE~CURRENT_BOND_PRICE,'
  + 'f237~10~SECURITY_CODE~TRANSFER_PREMIUM_RATIO') + '&quoteType=0';
async function asdCb() {
  let rows = [];
  for (let p = 1; p <= 3; p++) {
    const part = await asdDc('RPT_BOND_CB_LIST', '', 500, 'PUBLIC_START_DATE,SECURITY_CODE', '-1,1',
      ASD_CB_QUOTES + '&pageNumber=' + p);
    rows = rows.concat(part);
    if (part.length < 500) break;
  }
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return rows.map(r => {
    const listing = String(r.LISTING_DATE || '').slice(0, 10);
    const delist = String(r.DELIST_DATE || '').slice(0, 10);
    return {
      code: r.SECURITY_CODE, name: r.SECURITY_NAME_ABBR || r.SECURITY_NAME || '',
      stockName: r.CONVERT_STOCK_NAME || '',
      status: (delist && delist <= today) ? '已摘牌' : (listing && listing <= today) ? '交易中' : '未上市',
      listing: listing, delist: delist,
      convertPrice: r.CONVERT_PRICE, stockPrice: r.CONVERT_STOCK_PRICE,
      bondPrice: r.CURRENT_BOND_PRICE, convValue: r.TRANSFER_VALUE,
      premium: r.TRANSFER_PREMIUM_RATIO,
    };
  });
}

/* ---------- 工具包装器（问句 → 便签 + 数据表 + 给模型的 block） ---------- */
const ASD_SRC_TXT = 'a-stock-data 移植 · 东财公开接口（免费、无 Key）';

function asdTable(entity, head, rows, srcTxt) {
  return { entity: entity, ts: false, note: '数据来源：' + (srcTxt || ASD_SRC_TXT) + '｜抓取于 ' + new Date().toLocaleString('zh-CN'), head: head, rows: rows };
}
function asdBlock(title, question, r, notes) {
  return '【工具计算结果 · ' + title + '（a-stock-data 移植 · 免费公开接口）】\n'
    + '用户原始问句：\n' + question + '\n'
    + (notes || '') + '\n'
    + '以下是接口真实返回（表头 + 数据行），禁止改动任何数字、禁止补充表里没有的内容：\n'
    + qaTablesToText(r, 60) + '\n\n'
    + '【回答要求（全文 900 字以内）】\n'
    + '1. 用 Markdown 表格呈现，只列用户关心的列；表里没有的写「—」，不要臆造。\n'
    + '2. 数据为抓取时点快照，结尾声明不构成投资建议。';
}

async function qaToolAsdZt(question) {
  const date = asdDateFromQ(question);
  const r = await asdZtPools(date);
  const s = r.sentiment;
  if (!s.zt && !s.zb && !s.dt) throw new Error('涨停板四池当日为空（' + date + '，可能是非交易日或接口改版）');
  const tables = [];
  if (r.zt.length) tables.push(asdTable('涨停池（' + r.zt.length + ' 只）',
    ['代码', '名称', '现价', '涨幅%', '连板', '几天几板', '首封', '封板资金(亿)', '炸板次', '行业'],
    r.zt.slice(0, 30).map(x => [x.code, x.name, x.price, x.pct, x.limitDays, x.ztStat, x.firstSeal,
      x.sealFund == null ? '—' : Math.round(x.sealFund / 1e8 * 100) / 100, x.breakTimes || 0, x.industry])));
  if (r.zb.length) tables.push(asdTable('炸板池（' + r.zb.length + ' 只）',
    ['代码', '名称', '现价', '涨幅%', '涨停价', '炸板次', '几天几板', '行业'],
    r.zb.slice(0, 20).map(x => [x.code, x.name, x.price, x.pct, x.limitPrice, x.breakTimes || 0, x.ztStat, x.industry])));
  if (r.dt.length) tables.push(asdTable('跌停池（' + r.dt.length + ' 只）',
    ['代码', '名称', '现价', '跌幅%', '连续跌停', '开板次', '行业'],
    r.dt.slice(0, 20).map(x => [x.code, x.name, x.price, x.pct, x.dtDays || 0, x.openTimes || 0, x.industry])));
  if (r.yz.length) tables.push(asdTable('昨涨停今日表现（' + r.yz.length + ' 只）',
    ['代码', '名称', '现价', '今日涨幅%', '昨连板', '几天几板', '行业'],
    r.yz.slice(0, 20).map(x => [x.code, x.name, x.price, x.pct, x.yLimitDays, x.ztStat, x.industry])));
  const out = { tables: tables };
  return {
    icon: '🚦',
    title: '涨停板四池与打板情绪已取回（' + date + '）',
    lines: [
      '涨停 ' + s.zt + ' · 炸板 ' + s.zb + '（炸板率 ' + s.breakRate + '%）· 跌停 ' + s.dt,
      '最高连板 ' + s.maxHeight + ' 板 ｜ 连板梯队：' + s.ladder,
      '数据来源：东财涨停板行情中心（免费、无 Key）· a-stock-data 移植',
    ],
    html: qaTableHtml(out, 20),
    skills: [{ id: 'asd-zt', name: '涨停板四池 · 打板情绪', ms: 0 }],
    block: asdBlock('涨停板四池 · 打板情绪', question, out,
      '情绪速算（由四池计算）：涨停' + s.zt + ' 炸板' + s.zb + '（炸板率' + s.breakRate + '%）跌停' + s.dt
      + '，最高' + s.maxHeight + '连板，连板梯队：' + s.ladder + '。'),
  };
}

async function qaToolAsdThsZt(question) {
  const date = asdDateFromQ(question);
  const list = await asdThsZt(date);
  if (!list.length) throw new Error('同花顺涨停揭秘当日为空（' + date + '）');
  const out = { tables: [asdTable('涨停揭秘 · 原因题材（前 30，共 ' + list.length + '）',
    ['代码', '名称', '现价', '涨幅%', '涨停原因', '板型', '封板率%', '炸板次', '几天几板', '首封时间'],
    list.slice(0, 30).map(x => [x.code, x.name, x.price, x.pct, x.reason, x.boardType,
      x.sealRate == null ? '—' : x.sealRate, x.breakTimes, x.highDays, x.firstTime]))] };
  return {
    icon: '🔥',
    title: '涨停原因题材已取回（' + date + '）',
    lines: [
      '共 ' + list.length + ' 只涨停（沪深主板+创业板+科创板口径）',
      '数据来源：同花顺涨停揭秘公开接口（免费、无 Key）· a-stock-data 移植',
    ],
    html: qaTableHtml(out, 20),
    skills: [{ id: 'asd-thszt', name: '涨停揭秘 · 原因题材', ms: 0 }],
    block: asdBlock('涨停揭秘 · 原因题材', question, out),
  };
}

async function qaToolAsdLockup(question) {
  const codes = await skillPickCodes(question, 1).catch(() => []);
  if (!codes.length) throw new Error('没有从问句里认出股票（解禁查询需要指定个股），请带上股票名称或代码');
  const code = codes[0];
  const name = (state.stockDict[code] && state.stockDict[code].name) || code;
  const r = await asdLockup(code, 90);
  const rows = r.upcoming.map(u => [u.date, u.type, u.shares, u.ableShares, u.ratio == null ? '—' : u.ratio + '%']);
  const out = { tables: [
    asdTable(name + '（' + code + '）· 未来 90 天待解禁（' + r.upcoming.length + ' 次）',
      ['解禁日', '解禁类型', '解禁股数(万股)', '实际可流通(万股)', '占总股本'],
      rows.length ? rows : [['（未来 90 天无解禁）', '', '', '', '']]),
    asdTable(name + '（' + code + '）· 解禁历史（最近 10 次）',
      ['解禁日', '解禁类型', '解禁股数(万股)', '实际可流通(万股)', '占总股本'],
      r.history.length ? r.history.map(u => [u.date, u.type, u.shares, u.ableShares, u.ratio == null ? '—' : u.ratio + '%'])
        : [['（无历史记录）', '', '', '', '']]),
  ] };
  return {
    icon: '🔓',
    title: name + ' 限售解禁已取回',
    lines: [
      '未来 90 天解禁 ' + r.upcoming.length + ' 次；历史 ' + r.history.length + ' 次',
      '数据来源：东财公开数据中心（免费、无 Key）· a-stock-data 移植',
    ],
    html: qaTableHtml(out, 20),
    skills: [{ id: 'asd-lockup', name: '限售解禁', ms: 0 }],
    block: asdBlock('限售解禁', question, out),
  };
}

async function qaToolAsdDividend(question) {
  const codes = await skillPickCodes(question, 1).catch(() => []);
  if (!codes.length) throw new Error('没有从问句里认出股票（分红查询需要指定个股），请带上股票名称或代码');
  const code = codes[0];
  const name = (state.stockDict[code] && state.stockDict[code].name) || code;
  const list = await asdDividend(code);
  const out = { tables: [asdTable(name + '（' + code + '）· 分红送转历史（' + list.length + ' 次）',
    ['除权除息日', '每股派息(税前,元)', '每10股送股', '每10股转增', '进度'],
    list.length ? list.map(d => [d.date, d.bonusRmb == null ? '—' : d.bonusRmb, d.bonus == null ? '—' : d.bonus,
      d.transfer == null ? '—' : d.transfer, d.progress]) : [['（无分红记录）', '', '', '', '']])] };
  return {
    icon: '💰',
    title: name + ' 分红送转历史已取回',
    lines: [
      '共 ' + list.length + ' 条分红记录',
      '数据来源：东财公开数据中心（免费、无 Key）· a-stock-data 移植',
    ],
    html: qaTableHtml(out, 20),
    skills: [{ id: 'asd-dividend', name: '分红送转', ms: 0 }],
    block: asdBlock('分红送转历史', question, out),
  };
}

async function qaToolAsdForecast(question) {
  const codes = await skillPickCodes(question, 1).catch(() => []);
  const code = codes[0] || '';
  const list = await asdForecast(code);
  if (!list.length) throw new Error('业绩预告接口返回空（该股可能没有预告，或数据源临时不可用）');
  const name = code ? ((state.stockDict[code] && state.stockDict[code].name) || code) : '全市场';
  const out = { tables: [asdTable(
    code ? name + '（' + code + '）· 业绩预告' : '全市场最新业绩预告（30 条）',
    ['代码', '名称', '公告日', '报告期', '指标', '类型', '预计区间', '同比变动', '内容摘要'],
    list.map(f => [f.code, f.name, f.noticeDate, f.reportDate, f.indicator, f.type, f.range || '—', f.chg || '—', f.content]))] };
  return {
    icon: '📢',
    title: (code ? name + ' ' : '') + '业绩预告已取回（' + list.length + ' 条）',
    lines: [
      code ? '个股口径' : '全市场口径（按公告日倒序前 30 条）',
      '数据来源：东财公开数据中心（免费、无 Key）· a-stock-data 移植',
    ],
    html: qaTableHtml(out, 20),
    skills: [{ id: 'asd-forecast', name: '业绩预告', ms: 0 }],
    block: asdBlock('业绩预告', question, out),
  };
}

async function qaToolAsdLpr() {
  const list = await asdLpr();
  if (!list.length) throw new Error('LPR 接口返回空（数据源临时不可用）');
  const out = { tables: [asdTable('LPR 贷款市场报价利率（最近 ' + list.length + ' 期）',
    ['日期', '1 年 LPR(%)', '5 年以上 LPR(%)'],
    list.map(x => [x.date, x.y1, x.y5]))] };
  const last = list[list.length - 1];
  return {
    icon: '🏦',
    title: 'LPR 已取回（最新 ' + last.date + '）',
    lines: [
      '最新：1 年 ' + last.y1 + '% ｜ 5 年以上 ' + last.y5 + '%',
      '数据来源：东财公开数据中心（免费、无 Key）· a-stock-data 移植',
    ],
    html: qaTableHtml(out, 20),
    skills: [{ id: 'asd-lpr', name: 'LPR 利率', ms: 0 }],
    block: asdBlock('LPR 利率', 'LPR 利率历史', out),
  };
}

async function qaToolAsdCb(question) {
  const wantListed = !/摘牌|退市/.test(String(question || ''));
  let list = await asdCb();
  const total = list.length;
  list = list.filter(b => wantListed ? b.status === '交易中' : true);
  if (!list.length) throw new Error('可转债接口返回空（数据源临时不可用）');
  /* 问句里点名了具体转债/正股 → 过滤 */
  const kw = String(question || '').replace(/的可转债|转债|列出|看看|查询|哪些|什么/g, '').trim();
  const hit = kw.length >= 2 ? list.filter(b => (b.name || '').indexOf(kw) >= 0 || (b.stockName || '').indexOf(kw) >= 0) : [];
  const show = (hit.length ? hit : list).slice(0, 30);
  const out = { tables: [asdTable(
    (hit.length ? '命中「' + kw + '」的转债（' + hit.length + ' 只）' : '交易中可转债（按上市日倒序前 30，共约 ' + list.length + ' 只）'),
    ['代码', '转债', '正股', '状态', '转股价', '正股价', '债价', '转股价值', '溢价率%', '上市日'],
    show.map(b => [b.code, b.name, b.stockName, b.status, b.convertPrice == null ? '—' : b.convertPrice,
      b.stockPrice == null ? '—' : b.stockPrice, b.bondPrice == null ? '—' : b.bondPrice,
      b.convValue == null ? '—' : b.convValue, b.premium == null ? '—' : b.premium, b.listing]))] };
  return {
    icon: '💱',
    title: '可转债已取回（' + (hit.length ? '命中 ' + hit.length : '交易中约 ' + list.length) + ' 只）',
    lines: [
      '接口共取回 ' + total + ' 只（最近上市约 1500 只口径，历史摘牌不全——如实标注）',
      '数据来源：东财公开数据中心（免费、无 Key）· a-stock-data 移植',
    ],
    html: qaTableHtml(out, 20),
    skills: [{ id: 'asd-cb', name: '可转债', ms: 0 }],
    block: asdBlock('可转债', question, out,
      '说明：行情类字段由东财服务端按最新报价填入（盘中实时、停牌为空）。转股价值 = 100 / 转股价 × 正股价；溢价率 = 债价 / 转股价值 − 1。'),
  };
}

/* ---------- v3.11.1 持仓实时盈亏（本地路由直达；也是 agent 回路的 get_holdings_pnl） ----------
   截图反馈的问句「当我的持仓，截至目前的浮动盈亏」此前无工具命中：
   上下文里的持仓小抄用的是 S.quotes（可能陈旧），模型只能诚实说"没取到实时行情"。
   现在：computeHoldings()（页面同一引擎）+ emQuotes() 实时行情 → 逐股与合计浮动盈亏。 */
async function qaToolPnl(question) {
  if (typeof computeHoldings !== 'function') throw new Error('持仓引擎不可用');
  const hs = computeHoldings().filter(h => h.qty > 0);
  if (!hs.length) throw new Error('当前无持仓（还没有买入记录，或已全部卖出）');
  const qs = await emQuotes(hs.map(h => h.code));
  const qm = new Map(qs.map(q => [q.code, q]));
  let totMv = 0, totCost = 0, miss = [];
  const rows = hs.map(h => {
    const q = qm.get(h.code);
    const px = q && q.price != null ? q.price : null;
    const costW = h.costValue / h.qty;
    const mv = px != null ? h.qty * px : null;
    const pnl = mv != null ? mv - h.costValue : null;
    const pnlPct = pnl != null && h.costValue > 0 ? pnl / h.costValue * 100 : null;
    const dayPct = q && q.pct != null ? q.pct : null;
    if (mv != null) { totMv += mv; totCost += h.costValue; } else miss.push(h.code);
    return [h.name || h.code, h.code, h.qty, costW.toFixed(3),
      px == null ? '—' : px,
      mv == null ? '—' : mv.toFixed(2),
      pnl == null ? '—' : (pnl >= 0 ? '+' : '') + pnl.toFixed(2),
      pnlPct == null ? '—' : (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(2) + '%',
      dayPct == null ? '—' : (dayPct >= 0 ? '+' : '') + dayPct.toFixed(2) + '%'];
  });
  const totPnl = totMv - totCost;
  rows.push(['合计', '—', '—', '—', '—', totMv.toFixed(2),
    (totPnl >= 0 ? '+' : '') + totPnl.toFixed(2),
    totCost > 0 ? (totPnl >= 0 ? '+' : '') + (totPnl / totCost * 100).toFixed(2) + '%' : '—', '—']);
  const out = { tables: [asdTable('持仓实时浮动盈亏（' + hs.length + ' 只' + (miss.length ? '，' + miss.length + ' 只未取到行情' : '') + '）',
    ['名称', '代码', '数量', '加权成本', '现价', '市值', '浮动盈亏', '盈亏%', '今日涨跌'],
    rows, '腾讯公开行情 + 本机持仓引擎（免费、无 Key）')] };
  const srcLabel = qaSkillSrc('pnl');
  return {
    icon: '💼',
    title: '持仓浮动盈亏已取回（合计 ' + (totPnl >= 0 ? '+' : '') + totPnl.toFixed(2) + ' 元）',
    lines: [
      '市值 ' + totMv.toFixed(2) + ' 元 · 成本 ' + totCost.toFixed(2) + ' 元 · 浮动盈亏 '
        + (totPnl >= 0 ? '+' : '') + totPnl.toFixed(2) + ' 元（' + (totCost > 0 ? (totPnl / totCost * 100).toFixed(2) : '0') + '%）',
      (miss.length ? '⚠ ' + miss.join('、') + ' 未取到实时行情，已标「—」' : '全部持仓均取到实时行情')
        + ' · 数据来源：腾讯公开行情（免费、无 Key）',
    ],
    html: qaTableHtml(out, 20),
    skills: [{ id: 'pnl', name: '持仓实时盈亏', ms: 0 }],
    block: '【工具计算结果 · 持仓实时浮动盈亏（持仓引擎 computeHoldings + 腾讯实时行情，免费）】\n'
      + '用户原始问句：\n' + question + '\n'
      + (miss.length ? '注意：' + miss.join('、') + ' 未取到行情（表中为「—」），请如实说明这部分缺失。\n' : '')
      + '以下是逐股与合计的真实数字，禁止改动任何数字：\n'
      + qaTablesToText(out, 40) + '\n\n'
      + '【回答要求（全文 600 字以内）】先给合计浮动盈亏与收益率，再用 Markdown 表格列逐股明细；'
      + '结尾声明：数据为抓取时点快照，不构成投资建议。',
  };
}

/* v3.12.4 工具取数中断守卫：fn 执行期间每次 fetch 前检查 signal.aborted，
   命中即抛 AbortError（sendQa 的 catch 会按「已停止生成」处理）。结束恢复原 fetch。 */
function qaWithFetchGuard(signal, fn) {
  const chk = () => {
    if (signal && signal.aborted) throw Object.assign(new Error('已中断'), { name: 'AbortError' });
  };
  const g = (typeof window !== 'undefined') ? window : globalThis;   // Node 测试环境（qa_lib）也兼容
  const orig = g.fetch;
  g.fetch = function () { chk(); return orig.apply(this, arguments); };
  return Promise.resolve().then(fn).finally(function () { g.fetch = orig; });
}

async function qaRunTools(question, box, holder, signal) {
  if (!question || question.length > 500) return '';
  /* v3.12.4 停止按钮修复：工具取数阶段（可能数分钟）也要能中断——
     用 fetch 守卫包裹：每次发起网络请求前检查 abort，命中即抛 AbortError。
     （此前 signal 从未传入工具层，停止按钮在取数阶段完全无效。） */
  if (signal && signal.aborted) throw Object.assign(new Error('已中断'), { name: 'AbortError' });
  const convId = qaState.conversationId;      // 会话快照：切走后便签不插到别的会话
  // 先用本地规则路由：命中就不用再花一次模型调用做意图识别（显著降低首字延迟与额度消耗）
  let intent = qaRouteByRule(question);
  if (!intent) {
    try { intent = await qaClassifyIntent(question, true); } catch (e) { return ''; }
  }
  if (!intent || intent.tool === 'none' || !intent.tool) return '';
  let res = null;
  try {
    /* v3.9.13 审计：本轮问答触发的所有网络调用标上「智能问答·工具名」。
       注意：不能写 res = await withCtx(...) —— withCtx 的返回值会把闭包内
       对 res 的赋值覆盖成 undefined，工具结果就丢了。
       v3.12.4：整个工具阶段包上 fetch 中断守卫（停止按钮可随时打断取数）。 */
    await NetLog.withCtx('智能问答·' + intent.tool + '：' + String(question).slice(0, 24), async () => {
      await qaWithFetchGuard(signal, async () => {
    if (intent.tool === 'screener') {
      const parsed = parseScreenQuery(question);
      // 「XX 板块/概念/指数成分股」这类问法没有数值条件 → 走免费的「板块/概念成分股」
      const wantBlock = /成分股|概念|板块|指数|产业链|龙头|名单/.test(question);
      // 有阈值条件、或只要排名榜单、或含形态条件（区间涨幅/站上均线/放量…）→ 都走内置免费选股
      const gotTask = parsed.conds.length > 0 || !!parsed.sort || (parsed.forms && parsed.forms.length > 0);
      if (gotTask) res = await qaToolScreen(question);
      else if (wantBlock) res = await qaToolBoard(question);
      else res = await qaToolScreen(question);   // 条件没写清 → 抛出带示例的提示
    } else if (intent.tool === 'backtest') res = await qaToolBacktest(intent);
    else if (intent.tool === 'sim') res = await qaToolSim(question);
    else if (intent.tool === 'tech') res = await qaToolTech(intent);
    else if (intent.tool === 'risk') res = await qaToolRisk();
    else if (intent.tool === 'review') res = await qaToolReview();
    else if (intent.tool === 'diag') res = await qaToolDiag(intent);
    else if (intent.tool === 'market') res = await qaToolMarketAuto(question);
  /* v3.10.4 a-stock-data 移植技能：按开关放行，停用即交给模型（与技能中心开关真实联动） */
    else if (intent.tool === 'asd-zt') res = skillEnabled('asd-zt') ? await qaToolAsdZt(question) : null;
    else if (intent.tool === 'asd-thszt') res = skillEnabled('asd-thszt') ? await qaToolAsdThsZt(question) : null;
    else if (intent.tool === 'asd-lockup') res = skillEnabled('asd-lockup') ? await qaToolAsdLockup(question) : null;
    else if (intent.tool === 'asd-dividend') res = skillEnabled('asd-dividend') ? await qaToolAsdDividend(question) : null;
    else if (intent.tool === 'asd-forecast') res = skillEnabled('asd-forecast') ? await qaToolAsdForecast(question) : null;
    else if (intent.tool === 'asd-lpr') res = skillEnabled('asd-lpr') ? await qaToolAsdLpr() : null;
    else if (intent.tool === 'asd-cb') res = skillEnabled('asd-cb') ? await qaToolAsdCb(question) : null;
  /* v3.11.0 技能管理（对话安装/卸载/启停）与用户自定义技能 */
    else if (intent.tool === 'skillmgr') res = await qaToolSkillManage(question);
    else if (String(intent.tool).indexOf('user-') === 0) res = await runUserSkill(intent.tool, question);
  /* v3.11.1 持仓实时盈亏 */
    else if (intent.tool === 'pnl') res = await qaToolPnl(question);
      });
    });
  } catch (e) {
    /* 中断要向上抛（sendQa 才能真正停），不能当成工具失败吞掉 */
    if (e && e.name === 'AbortError') throw e;
    return `【工具执行失败】${intent.tool}：${e && e.message || e}。请如实告诉用户该工具本次执行失败，建议稍后重试或去对应功能页操作。`;
  }
  if (!res || !res.block) return '';
  // 问答流里插一张工具结果便签（skills 用于在回答上方标注本轮实际调用了哪些能力）
  const msg = { role: 'tool', icon: res.icon, title: res.title, lines: res.lines || [], chart: res.chart || '', html: res.html || '', skills: res.skills || null };
  if (qaState.conversationId === convId) {     // 已切走会话 → 便签不入别的会话（结果仍会注入模型上下文）
    if (qaState.messages) qaState.messages.push(msg);
    const el = document.createElement('div');
    el.className = 'msg note';
    el.innerHTML = toolNoteHtml(msg);
    if (holder && box && holder.parentNode === box) box.insertBefore(el, holder);
    else if (box) box.appendChild(el);
    if (box) box.scrollTop = box.scrollHeight;
  }
  return res.block;
}

/* 工具便签的 HTML（技能标注 + 摘要行 + 数据表 + 走势图） */
function toolNoteHtml(m) {
  /* v3.9.9 数据来源透明化：用户要求「数据调用用了什么都要明确显示」。
     每个能力标签后面用浅色小字标注数据来源（东财公开数据 / 腾讯行情 / 妙想Key…），
     让用户一眼看出这一轮问答的数字是哪来的、哪些走了他的妙想额度。 */
  const sk = (m.skills && m.skills.length)
    ? '<div class="qa-skill-tag">🔧 已调用能力：' + m.skills.map(function (s) {
        const src = qaSkillSrc(s.id);
        return esc(s.name)
          + (src ? ' <span class="qa-skill-src">· ' + esc(src) + '</span>' : '')
          + (s.ms ? ' <span class="qa-skill-ms">' + s.ms + 'ms</span>' : '');
      }).join(' ＋ ') + '</div>'
    : '';
  /* 摘要行容错：约定是字符串数组，但万一某个工具传了字符串/undefined，
     也只让它少显示一行，不能让便签渲染抛错把整轮问答带崩。 */
  const lines = Array.isArray(m.lines) ? m.lines : (m.lines ? [String(m.lines)] : []);
  return `${m.icon || '🔧'} ${esc(m.title || '工具结果')}<br>` + sk + lines.map(l => esc(l)).join('<br>')
    + (m.html || '')
    + (m.chart ? `<div class="qa-chart">${m.chart}</div>` : '');
}


/* ============================================================
   十三、记录类问题的本地直答（v3.9.8）
   背景：用户问「持仓多少」，模型把【持仓】【自选】【交易记录】三块小抄依次复述一遍，
   「空仓」在相邻三句里出现三次、自选名单出现两次 —— 又长又没信息量。
   这类问题的答案**完全在本地**（交易记录 / 自选 / 持仓都是本机数据），根本不需要模型、
   也不需要联网。所以这里加一条直答通道：命中就直接给一两句确定答案，不请求模型。

   两个附带好处：
     · 快 —— 没有网络往返，也不用等首字；
     · 稳 —— 不会啰嗦、不会打错字（旧回答里把「自选股」写成了「自选作」）、不会有幻觉。

   触发条件刻意收紧（宁可漏判、交给模型，也不要抢答）：
     ① 长度 ≤ 24 字；② 命中记录类词；③ 不含任何「要实时数据 / 要分析判断」的词。
   ============================================================ */
const QA_LOCAL_HOLD_RE = /(持仓|仓位|空仓|满仓|持股|持仓成本|我的成本)/;
const QA_LOCAL_WATCH_RE = /(自选|关注股|关注的股|关注列表)/;
const QA_LOCAL_TRADE_RE = /(交易记录|买卖记录|操作记录|成交记录|交易历史|操作历史|交易流水|最近交易|最近操作|最近买卖|最近几笔|最近做过)/;
/* 反向词：问到这些说明用户要的是实时行情 / 分析判断 / 建议 —— 必须交给模型（它有工具层能
   真取数），绝不能拿本地记录值去回答「今天涨了多少」。含「涨/跌/盈/亏」这类字的一律放行。
   两个「宁可不要」的取舍（都被测试逮到过）：
     · 不放「现在 / 当前」—— 它们只是时间状语（「我现在空仓吗」），不是要新鲜数据；
       本地直答用的现价来自页面同一份行情缓存，口径一致，不会误导。
     · 不放「选股」—— 它会误伤「自选股」（自+选股），而这类问句正是本地直答要接的；
       真正的选股类问句另有「推荐 / 筛选 / 找出 / 龙头」兜住。 */
const QA_LOCAL_BLOCK_RE = /(今天|今日|实时|走势|分析|建议|该不该|能不能|要不要|值不值|预测|估值|诊断|对比|比较|新闻|公告|财报|财务|为什么|怎么|如何|涨|跌|盈|亏|赚|赔|机会|风险|买点|卖点|加仓|减仓|补仓|清仓|止盈|止损|行业|板块|概念|龙头|筛选|找出|帮我找|推荐|复盘|回测)/;

/* 从问句里认「问的是哪一块」，认不出或属于该交给模型的问题就返回 null */
function qaLocalIntent(q) {
  const s = String(q || '').trim();
  if (!s || s.length > 24) return null;
  if (QA_LOCAL_BLOCK_RE.test(s)) return null;
  const hold = QA_LOCAL_HOLD_RE.test(s);
  const watch = QA_LOCAL_WATCH_RE.test(s);
  const trade = QA_LOCAL_TRADE_RE.test(s);
  if (!hold && !watch && !trade) return null;
  return { hold: hold, watch: watch, trade: trade };
}

/* 持仓事实包：直接用 app.js 的 computeHoldings()（页面显示的同一份口径）。
   单位说明：costValue / dilutedValue / gross_amount 都是**元**（不是分），
   qty 是股数；realized / realizedOp 也是元。 */
function qaHoldFacts() {
  const qm = (typeof quoteMap === 'function') ? quoteMap() : new Map();
  const rows = [], cleared = [];
  let floatSum = 0, realizedSum = 0;
  const hs = (typeof computeHoldings === 'function') ? computeHoldings() : [];
  hs.forEach(function (h) {
    const q = qm.get(h.code);
    const px = q && q.price != null ? Number(q.price) : null;
    const realized = Number(h.realized) || 0;
    realizedSum += realized;
    const item = { code: h.code, name: h.name || h.code, qty: Number(h.qty) || 0, px: px, realized: realized };
    if (item.qty > 0) {
      item.costW = h.costValue / item.qty;                 // 加权成本（含手续费），元/股
      item.costD = h.dilutedValue / item.qty;              // 摊薄成本（已实现盈亏滚入）
      item.float = px != null ? item.qty * px - h.costValue : null;
      if (item.float != null) floatSum += item.float;
      rows.push(item);
    } else {
      cleared.push(item);
    }
  });
  /* 只报市值最重的前 8 只，避免持仓很多时又变成一大段小抄 */
  rows.sort(function (a, b) { return (b.px != null ? b.qty * b.px : 0) - (a.px != null ? a.qty * a.px : 0); });
  cleared.sort(function (a, b) { return Math.abs(b.realized) - Math.abs(a.realized); });
  return { rows: rows, cleared: cleared, floatSum: floatSum, realizedSum: realizedSum };
}
/* 问句里点了名（"中兴通讯还在持仓吗"）就只答那一只；没点名就答全部 */
function qaNarrow(q, arr) {
  const hit = arr.filter(function (r) { return r.name && q.indexOf(r.name) >= 0; });
  return hit.length ? hit : arr;
}
function qaMoney(v) { return (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(2); }

function qaLocalHoldText(q) {
  const f = qaHoldFacts();
  const parts = [];
  if (!f.rows.length) {
    parts.push('**持仓**：目前空仓，没有持仓。');
    const cl = qaNarrow(q, f.cleared);
    if (cl.length && cl.length <= 8) {
      parts.push('已清仓：' + cl.map(function (r) {
        return r.name + '(' + r.code + ')' + (r.realized ? '（' + (r.realized >= 0 ? '盈利 ' : '亏损 ') + qaMoney(r.realized) + ' 元）' : '');
      }).join('、') + '。');
    }
    const rs = f.realizedSum;
    if (rs) parts.push('累计已实现盈亏 ' + qaMoney(rs) + ' 元。');
    return parts.join('\n');
  }
  const rows = qaNarrow(q, f.rows);
  const head = rows.length === 1
    ? '**持仓**：'
    : '**持仓** ' + rows.length + ' 只' + (f.floatSum ? '，合计浮动 ' + qaMoney(f.floatSum) + ' 元' : '') + '：';
  const lines = rows.slice(0, 8).map(function (r) {
    return '· ' + r.name + '(' + r.code + ')：' + r.qty + ' 股，加权成本 ' + r.costW.toFixed(3)
      + '，摊薄成本 ' + r.costD.toFixed(3)
      + (r.px != null ? '，现价 ' + r.px : '')
      + (r.float != null ? '，浮动 ' + qaMoney(r.float) + ' 元' : '');
  });
  if (rows.length > 8) lines.push('（只列出市值最大的 8 只，共 ' + rows.length + ' 只）');
  lines.unshift(head);
  return lines.join('\n');
}
function qaLocalWatchText() {
  const w = (typeof S !== 'undefined' && S.watchlist) ? S.watchlist : [];
  if (!w.length) return '**自选股**：还没有加自选。';
  return '**自选股** ' + w.length + ' 只：'
    + w.map(function (x) { return (x.stock_name || x.stock_code) + (x.note ? '（' + x.note + '）' : ''); }).join('、') + '。';
}
function qaLocalTradeText() {
  const ts = (typeof S !== 'undefined' && S.trades) ? S.trades.slice() : [];
  if (!ts.length) return '**交易记录**：还没有记录。';
  /* 云端 trades 表的真实列是 transaction_time / transaction_type，
     排序与展示都不能用 tm 那套 trade_date / action（实测该表没有这两列）。 */
  ts.sort(function (a, b) { return String(b.transaction_time || '').localeCompare(String(a.transaction_time || '')); });
  const n = Math.min(5, ts.length);
  return '**最近 ' + n + ' 笔交易**（新→旧）\n' + ts.slice(0, n).map(function (t) {
    return '· ' + String(t.transaction_time || '').replace('T', ' ').slice(0, 16)
      + ' ' + (t.transaction_type === 'buy' ? '买入' : '卖出') + ' '
      + (t.stock_name || t.stock_code) + '(' + t.stock_code + ') '
      + t.quantity + ' 股 @' + Number(t.price).toFixed(3);
  }).join('\n') + (ts.length > n ? '\n（共 ' + ts.length + ' 笔，只列最近 ' + n + ' 笔）' : '');
}

/* 主入口：命中记录类问题就返回答案文本，否则返回 ''（交给模型） */
function qaLocalAnswer(q) {
  const it = qaLocalIntent(q);
  if (!it) return '';
  const seg = [];
  try {
    if (it.hold) seg.push(qaLocalHoldText(q));
    if (it.watch) seg.push(qaLocalWatchText(q));
    if (it.trade) seg.push(qaLocalTradeText(q));
  } catch (e) {
    return '';   // 本地直答出任何意外都静默退回模型，不能让提问挂掉
  }
  return seg.filter(Boolean).join('\n\n');
}

/* ============================================================
   十四、技能中心（v3.9.9）
   用户诉求：「我申请了东方财富的 Key，没地方配置」「设置里可以添加删除哪些技能」
   「数据调用用了什么都要明确显示」。参考 trade-agent 的技能框架移植：

   · 技能 = 一份声明式清单 + 一个执行器。本应用两类执行器：
       em（builtin）—— qa-tools.js 内置的免费公开数据源（东财数据中心 / 腾讯行情，无需 Key）
       mx（http）   —— 东方财富妙想 Skills（需 mkt_ 开头的 Key，每日限量免费额度，服务端按
                       问句自动路由到对应 skill 并扣它的额度）
   · 开关注册表存本机 localStorage（sj_skills_v1）：installed / removed / seedV；
     Key 只存本机（sj_mx_key_v1），都不上传云端。
   · 数据来源透明化：每张表的 note 里写数据来源（已有）；工具便签的技能标签也会
     标注来源（QA_SKILL_SRC）；设置→技能 里每个技能卡片直接写明数据来源。
   ============================================================ */
const SKILL_STORE = 'sj_skills_v1';
const MX_KEY_STORE = 'sj_mx_key_v1';
const MX_API_URL = 'https://mkapi2.dfcfs.com/finskillshub/api/claw/query';
/* 妙想免费额度有 QPS 限制：实测 2 秒内连发两次会拿到 code 112。全局最小间隔串行排队，
   遇到 112 自动退避重试一次，上层调用不用关心限流细节。 */
const MX_MIN_GAP = 1800;
const SKILL_SEED_V = 2;   // 调整 SKILL_CATALOG 清单时 +1，老用户下次打开自动补装/清理

/* 本机存储兜底：隐私模式 / 测试环境（vm）里 localStorage 可能不存在 */
const _memStore = {};
function sjStoreGet(k) { try { return localStorage.getItem(k); } catch (e) { return _memStore[k] != null ? _memStore[k] : null; } }
function sjStoreSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { _memStore[k] = v; } }

/* 技能目录：vendor=em 免费内置 / vendor=mx 妙想官方。src 是给人看的数据来源说明。 */
const SKILL_CATALOG = [
  // ---------- 免费内置（对应 qa-tools.js 里的取数实现） ----------
  { id: 'em-screen', name: '条件选股 / 榜单', icon: '🎯', vendor: 'em', src: '东方财富公开数据中心（免费、无 Key、不限次）',
    desc: '按估值 / 行情 / 财务条件全市场筛选，或直接要榜单（「今日涨幅前10」「PE<15 且 ROE>15」）。' },
  { id: 'em-form', name: '形态 · 区间选股', icon: '📐', vendor: 'em', src: '腾讯公开日 K（免费、无 Key，逐只拉取计算）',
    desc: '区间涨幅 / 均线位置与排列 / 量能 / 连涨连跌 / 新高新低 / 回撤 / 金叉死叉等 13 类形态条件。' },
  { id: 'em-board', name: '板块 · 概念成分股', icon: '🗂', vendor: 'em', src: '东方财富公开数据中心（免费、无 Key）',
    desc: '概念 / 行业板块的成分股名单与排名（「人形机器人概念成分股，按市值降序前10」）。' },
  { id: 'em-holder', name: '股东与主营构成', icon: '👥', vendor: 'em', src: '东方财富公开 F10（免费、无 Key）',
    desc: '股东户数变化、十大流通股东、主营构成三张表。' },
  { id: 'em-sim', name: 'K 线相似度', icon: '🧬', vendor: 'em', src: '腾讯公开日 K（免费、无 Key，形态相关度计算）',
    desc: '找和某只股票历史走势最像的其它股票。' },
  { id: 'em-market', name: '行情 · 财务 · 公告 · 资讯', icon: '🌐', vendor: 'em', src: '腾讯公开行情 + 东方财富公开数据中心（免费、无 Key）',
    desc: '实时行情、当日分时、财务摘要、估值快照、机构评级、公告、个股资讯。' },
  { id: 'em-diag', name: '个股五维诊断', icon: '🩺', vendor: 'em', src: '复用分析中心引擎 + 免费公开数据',
    desc: '基本面估值 / 技术趋势 / 资金行为 / 消息事件 / 机构观点五维体检。' },
  { id: 'em-tech', name: '技术分析', icon: '📈', vendor: 'em', src: '腾讯公开日 K + 本项目指标引擎（免费）',
    desc: '单只股票的均线 / MACD / RSI / KDJ / 支撑压力位分析。' },
  { id: 'em-backtest', name: '策略回测', icon: '🧪', vendor: 'em', src: '腾讯公开日 K + 本项目回测引擎（免费）',
    desc: '按策略与风控参数对某只股票回测（含止损 / ATR / 移动止盈）。' },
  { id: 'em-review', name: '操作复盘', icon: '🧾', vendor: 'em', src: '本机交易记录（不联网）',
    desc: 'FIFO 买卖配对、交易行为评分、阶段总结。' },
  { id: 'em-risk', name: '组合风险', icon: '🛡', vendor: 'em', src: '本机持仓 + 腾讯公开行情（免费）',
    desc: '持仓集中度、相关性、Beta、压力测试。' },
  // ---------- a-stock-data 移植 7 个（github.com/simonlin1212/a-stock-data，Apache-2.0；
  // 浏览器 JS 直连同款免费接口，逻辑移植、来源照实标注） ----------
  { id: 'asd-zt', name: '涨停板四池 · 打板情绪', icon: '🚦', vendor: 'asd',
    src: '东财涨停板行情中心 push2ex（免费、无 Key）— 移植自开源项目 a-stock-data',
    desc: '涨停 / 炸板 / 跌停 / 昨涨停四池 + 情绪速算（炸板率、最高连板、连板梯队）。「今日涨停池」「打板情绪」。「最高连板」。' },
  { id: 'asd-thszt', name: '涨停揭秘 · 原因题材', icon: '🔥', vendor: 'asd',
    src: '同花顺涨停揭秘公开接口（免费、无 Key）— 移植自 a-stock-data（浏览器跨域不确定，取不到会明示）',
    desc: '涨停原因题材、板型（一字 / T字 / 换手板）、封板成功率、几天几板。「今天涨停的股票都是什么原因」。' },
  { id: 'asd-lockup', name: '限售解禁', icon: '🔓', vendor: 'asd',
    src: '东财公开数据中心 RPT_LIFT_STAGE（免费、无 Key）— 移植自 a-stock-data',
    desc: '个股解禁历史 + 未来 90 天待解禁（股数 / 占总股本比）。「中兴通讯什么时候解禁」。' },
  { id: 'asd-dividend', name: '分红送转', icon: '💰', vendor: 'asd',
    src: '东财公开数据中心 RPT_SHAREBONUS_DET（免费、无 Key）— 移植自 a-stock-data',
    desc: '分红送转历史：每股派息 / 送股 / 转增 / 进度。「茅台历年分红」。' },
  { id: 'asd-forecast', name: '业绩预告', icon: '📢', vendor: 'asd',
    src: '东财公开数据中心 RPT_PUBLIC_OP_NEWPREDICT（免费、无 Key）— 移植自 a-stock-data',
    desc: '个股或全市场最新业绩预告（预增 / 预亏 / 净利润区间与同比）。「最近有哪些业绩预增」。' },
  { id: 'asd-lpr', name: 'LPR 利率', icon: '🏦', vendor: 'asd',
    src: '东财公开数据中心 RPTA_WEB_RATE（免费、无 Key）— 移植自 a-stock-data',
    desc: 'LPR 1 年 / 5 年报价历史（最近 12 期）。「现在 LPR 多少」。' },
  { id: 'asd-cb', name: '可转债', icon: '💱', vendor: 'asd',
    src: '东财公开数据中心 RPT_BOND_CB_LIST（免费、无 Key）— 移植自 a-stock-data',
    desc: '可转债条款 + 债价 / 正股价 / 转股价值 / 溢价率（最近上市约 1500 只，历史摘牌不全会如实标注）。' },
  // ---------- 妙想官方 6 个（与妙想 App 配额页一一对应；额度各自独立、按自然日刷新） ----------
  { id: 'mx-finance-data', name: '妙想 · 金融数据', icon: '📊', vendor: 'mx', quota: 150, support: 'full',
    src: '东方财富妙想 Skills（需 mkt_ Key，每日 150 次免费额度）',
    desc: '资金流向、北向 / 南向、融资融券、机构调研等免费公开表没有的口径（「中国长城资金流向」）。' },
  { id: 'mx-finance-search', name: '妙想 · 资讯搜索', icon: '🔍', vendor: 'mx', quota: 150, support: 'partial',
    src: '东方财富妙想 Skills（需 mkt_ Key，每日 150 次免费额度）',
    desc: '全市场财经资讯检索（部分问法可能返回空表，换个说法再试）。' },
  { id: 'mx-stocks-screener', name: '妙想 · 智能选股', icon: '🎯', vendor: 'mx', quota: 150, support: 'todo',
    src: '东方财富妙想 Skills（需 mkt_ Key，每日 150 次免费额度）',
    desc: '妙想的自然语言选股。内置免费选股已覆盖大部分场景，这里保留作为补充（未逐一实测）。' },
  { id: 'mx-portfolio-manager', name: '妙想 · 模拟组合管理', icon: '💼', vendor: 'mx', quota: 1000, support: 'todo',
    src: '东方财富妙想 Skills（需 mkt_ Key，每日 1000 次免费额度）',
    desc: '妙想的模拟组合：持仓、调仓与业绩表现（未逐一实测）。' },
  { id: 'mx-watchlist-manager', name: '妙想 · 自选股管理', icon: '⭐', vendor: 'mx', quota: 200, support: 'todo',
    src: '东方财富妙想 Skills（需 mkt_ Key，每日 200 次免费额度）',
    desc: '自选股的维护与批量行情，可把关注池交给妙想跟踪（未逐一实测）。' },
  { id: 'mx-ai-community', name: '妙想 · AI社区', icon: '💬', vendor: 'mx', quota: 20, support: 'todo',
    src: '东方财富妙想 Skills（需 mkt_ Key，每日 20 次免费额度）',
    desc: '妙想 AI 社区的市场观点与热门讨论（未逐一实测）。' },
];
const SUPPORT_TXT = { full: '✅ 已实测', partial: '⚠️ 部分问法可用', todo: '⚪ 未实测，可自行试跑' };

/* ---------- 注册表（本机 localStorage；首次使用把整个目录装好并启用，保证开箱即用） ---------- */
let _skillReg = null;
function skillReg() {
  if (_skillReg) return _skillReg;
  const d = { installed: {}, removed: [], seedV: 0, seeded: false };
  let j = null;
  try { j = JSON.parse(sjStoreGet(SKILL_STORE) || 'null'); } catch (e) { j = null; }
  if (j && typeof j === 'object') {
    if (j.installed && typeof j.installed === 'object') d.installed = j.installed;
    if (Array.isArray(j.removed)) d.removed = j.removed;
    if (typeof j.seedV === 'number') d.seedV = j.seedV;
    d.seeded = !!j.seeded;
  }
  const ids = {}; SKILL_CATALOG.forEach(s => { ids[s.id] = 1; });
  // 迁移：清掉已不在目录里的技能（目录改版后的僵尸卡片）
  Object.keys(d.installed).forEach(id => { if (!ids[id]) delete d.installed[id]; });
  d.removed = (d.removed || []).filter(id => ids[id]);
  if (d.seedV !== SKILL_SEED_V || !d.seeded) {
    const canAdd = s => !d.installed[s.id] && d.removed.indexOf(s.id) < 0;
    if (!d.seeded) SKILL_CATALOG.forEach(s => { if (canAdd(s)) d.installed[s.id] = { enabled: true, at: Date.now() }; });
    else SKILL_CATALOG.forEach(s => { if (canAdd(s)) d.installed[s.id] = { enabled: true, at: Date.now() }; });
    d.seedV = SKILL_SEED_V; d.seeded = true;
  }
  _skillReg = d;
  skillRegSave();
  return d;
}
function skillRegSave() { sjStoreSet(SKILL_STORE, JSON.stringify(_skillReg || skillReg())); }

/* ============================================================
   v3.11.0 用户自定义技能（表格化管理 + 对话安装/卸载/启停）
   ------------------------------------------------------------
   内置目录（SKILL_CATALOG）是随应用发版的；用户还想自己「装」新技能 ——
   形态：一张声明式配置（名称 + 触发关键词 + 东财数据中心报表名 + 列映射），
   存本机 sj_user_skills_v1，由通用执行器 runUserSkill 执行。
   为什么是「东财报表 + 列映射」而不是任意代码：浏览器不可能执行安装来的
   代码（安全），而 a-stock-data 的 54 个端点里一大半正是这种「报表+过滤+
   排序+选列」的形态 —— 声明式已经覆盖最高频的安装需求，且零风险。
   ============================================================ */
const USER_SKILL_STORE = 'sj_user_skills_v1';
function userSkills() {
  try { const l = JSON.parse(sjStoreGet(USER_SKILL_STORE) || '[]'); return Array.isArray(l) ? l : []; }
  catch (e) { return []; }
}
function userSkillsSave(list) { sjStoreSet(USER_SKILL_STORE, JSON.stringify(list)); }
function userSkillById(id) { return userSkills().find(u => u.id === id) || null; }
function userSkillSaveRec(rec) {
  const l = userSkills();
  const i = l.findIndex(u => u.id === rec.id);
  if (i >= 0) l[i] = rec; else l.push(rec);
  userSkillsSave(l);
}
function userSkillDelete(id) { userSkillsSave(userSkills().filter(u => u.id !== id)); }
function userSkillEnabled(id) {
  const u = userSkillById(id);
  return !!(u && u.enabled !== false);
}

/* ---------- v3.12.0 SKILL.md 技能包（整包安装，Python 执行在自托管后端） ----------
   浏览器跑不了 Python，所以「安装完整技能包」= 后端装包 + 前端调用执行端点。
   运行时地址 sj_runtime_url：空 = 同源（自托管整站）；填 http(s)://服务器 = 混合模式
   （WorkBuddy 托管界面与数据，自己服务器只跑技能包）。 */
const PACK_STORE = 'sj_skill_packs_v1';
const RUNTIME_KEY = 'sj_runtime_url';
const A_STOCK_URL = 'https://cdn.jsdelivr.net/gh/simonlin1212/a-stock-data@main/SKILL.md';
/* 运行时地址：显式配置优先；否则跟随「后端服务器地址」（sj_backend_url，混合模式）；
   都没有 = 同源（自托管整站）。 */
function runtimeBase() {
  const explicit = String(sjStoreGet(RUNTIME_KEY) || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  try { return String(localStorage.getItem('sj_backend_url') || '').trim().replace(/\/+$/, ''); }
  catch (e) { return ''; }
}
function skillPacks() {
  try { const l = JSON.parse(sjStoreGet(PACK_STORE) || '[]'); return Array.isArray(l) ? l : []; }
  catch (e) { return []; }
}
function skillPacksSave(l) { sjStoreSet(PACK_STORE, JSON.stringify(l)); }
function skillPackById(id) { return skillPacks().find(p => p.id === id) || null; }
function skillPackSaveRec(rec) {
  const l = skillPacks();
  const i = l.findIndex(p => p.id === rec.id);
  if (i >= 0) l[i] = rec; else l.push(rec);
  skillPacksSave(l);
}
function skillPackDelete(id) { skillPacksSave(skillPacks().filter(p => p.id !== id)); }
/* 安装：调运行时后端下载/合成/注册，成功后本机记一条（供表格与 agent 工具用）。
   重复安装 = 升级（幂等覆盖同名模块）；返回带 added/removed 函数清单对比。 */
async function skillPackInstall(url, name) {
  const base = runtimeBase();
  if (!base) throw new Error('未配置技能运行时地址：自托管整站填「同源」即可；WorkBuddy 托管版请到 设置 → 技能 → 技能包运行时 填你服务器的地址（需 HTTPS）');
  const prev = skillPacks().find(p => p.packName === (name || 'askill'));
  const prevFns = prev ? (prev.functions || []).map(f => f.name || f) : null;
  const res = await fetch(base + '/api/pack/install', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url || A_STOCK_URL, name: name || 'askill' }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.msg || ('安装失败 HTTP ' + res.status));
  const newFns = j.list || [];
  const added = prevFns ? newFns.filter(f => prevFns.indexOf(f) < 0) : [];
  const removed = prevFns ? prevFns.filter(f => newFns.indexOf(f) < 0) : [];
  skillPackSaveRec({
    id: 'pack-' + j.name, name: '技能包 · ' + j.name, icon: '📦', enabled: true,
    packName: j.name, url: url, functions: newFns,
    at: Date.now(),
  });
  return Object.assign({ added: added, removed: removed, prevCount: prevFns ? prevFns.length : null }, j);
}
/* 执行：pack 内任意函数，结果 JSON 文本回传给 agent 回路 */
async function skillPackExec(packId, fn, args) {
  const p = skillPackById(packId);
  const base = runtimeBase();
  if (!base) throw new Error('未配置技能运行时地址（设置 → 技能 → 技能包运行时）');
  if (p && p.functions && fn && !p.functions.some(f => f.name === fn || f === fn)) {
    /* 未在清单里也放行（清单是安装时快照），但给个提示词头 */
  }
  const res = await fetch(base + '/api/pack/execute', {
    /* v3.15.1 公网部署：带上会话 token（服务端校验 x-sj-token） */
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(typeof S !== 'undefined' && S.token ? { 'x-sj-token': S.token } : {}) },
    body: JSON.stringify({ pack: (p && p.packName) || String(packId).replace(/^pack-/, ''), fn: fn, args: args || {} }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.msg || ('执行失败 HTTP ' + res.status));
  return j.data;
}
/* 触发词 → 安全正则：只做「关键词字面包含」，不解析用户输入的正则（防注入/防呆） */
function userSkillHit(u, text) {
  return (u.keywords || []).some(kw => kw && String(text || '').indexOf(kw) >= 0);
}
/* 全部技能视图（内置目录 + 用户自建 + 技能包），供表格渲染 / 对话安装匹配 */
function skillListAll() {
  const cat = SKILL_CATALOG.map(s => Object.assign({ isUser: false,
    installed: !!skillReg().installed[s.id],
    enabled: skillEnabled(s.id) }, s));
  const usr = userSkills().map(u => Object.assign({ isUser: true, vendor: 'user',
    installed: true, enabled: u.enabled !== false,
    src: '自定义 · 东财数据中心 ' + u.report + '（免费、无 Key）',
    desc: '触发词：' + (u.keywords || []).join('、') + (u.stock ? ' ｜ 需指定个股' : ' ｜ 全市场'),
    icon: u.icon || '🧩' }, u));
  const packs = skillPacks().map(p => Object.assign({ isPack: true, vendor: 'pack',
    installed: true, enabled: p.enabled !== false,
    src: 'SKILL.md 技能包（Python 执行于自托管后端）· ' + (p.url || ''),
    desc: (p.functions || []).length + ' 个函数端点：' + (p.functions || []).slice(0, 12).map(f => f.name || f).join('、')
      + ((p.functions || []).length > 12 ? ' 等' : ''),
    icon: p.icon || '📦' }, p));
  return cat.concat(usr).concat(packs);
}

/* 通用执行器：报表 + 过滤(可选个股) + 排序 + 列映射 → 便签 + 数据表 */
async function runUserSkill(id, question) {
  const u = userSkillById(id);
  if (!u) throw new Error('技能不存在（可能已被删除）');
  let filter = '';
  let stockName = '';
  if (u.stock) {
    const codes = await skillPickCodes(question, 1).catch(() => []);
    if (!codes.length) throw new Error('「' + u.name + '」需要指定个股，但问句里没有认出股票，请带上股票名称或代码');
    filter = '(SECURITY_CODE="' + codes[0] + '")';
    stockName = (state.stockDict[codes[0]] && state.stockDict[codes[0]].name) || codes[0];
  }
  const rows = await asdDc(u.report, filter, u.size || 30, u.sortCol || '', u.sortTypes == null ? -1 : u.sortTypes);
  if (!rows.length) throw new Error('「' + u.name + '」接口返回空（无记录 / 非交易日 / 报表名可能写错）');
  const cols = (u.cols || []).filter(c => c && c.f);
  const head = cols.length ? cols.map(c => c.t || c.f)
    : Object.keys(rows[0]).filter(k => k !== 'SECUCODE').slice(0, 8);
  const tableRows = rows.slice(0, 30).map(r => cols.length
    ? cols.map(c => (r[c.f] == null ? '—' : r[c.f]))
    : head.map(h => (r[h] == null ? '—' : r[h])));
  const entity = (u.stock ? stockName + '（' + (rows[0].SECURITY_CODE || '') + '）· ' : '') + u.name
    + '（' + rows.length + ' 行' + (rows.length > 30 ? '，示前 30' : '') + '）';
  const out = { tables: [asdTable(entity, head, tableRows,
    '自定义技能「' + u.name + '」· 东财数据中心 ' + u.report + '（免费、无 Key）')] };
  const srcLabel = qaSkillSrc(id) || '自定义技能';
  return {
    icon: u.icon || '🧩',
    title: '「' + u.name + '」已取回（' + rows.length + ' 行）',
    lines: [
      entity,
      '数据来源：东财数据中心 ' + u.report + '（免费、无 Key）· 自定义技能',
    ],
    html: qaTableHtml(out, 20),
    skills: [{ id: id, name: u.name, ms: 0 }],
    block: '【工具计算结果 · ' + u.name + '（自定义技能 · 东财数据中心 ' + u.report + ' · 免费公开接口）】\n'
      + '用户原始问句：\n' + question + '\n'
      + '以下是接口真实返回（表头 + 数据行），禁止改动任何数字、禁止补充表里没有的内容；\n'
      + '字段名是东财原始列名（如无列映射），请按常识解释（如 PRETAX_BONUS_RMB=每股税前派息）。\n'
      + qaTablesToText(out, 60) + '\n\n'
      + '【回答要求（全文 900 字以内）】用 Markdown 表格呈现；结尾声明数据为抓取时点快照，不构成投资建议。',
  };
}

/* ---------- 对话安装 / 卸载 / 启停（本地执行，模型只负责路由，绝不靠模型编造结果） ---------- */
/* 从问句里匹配目标技能：把「安装/技能/一下…」等动词虚词剥掉，剩下的词去技能名里找包含关系 */
function matchSkillFromQ(q) {
  const cleaned = String(q || '')
    .replace(/[，。！？、？?！.]/g, ' ')
    .replace(/给我|帮我|麻烦|请|一下|这个|那个|把|将|的|了|吗|呢|技能|安装|加装|添加|卸载|删除|删掉|移除|停用|禁用|关闭|关掉|启用|开启|打开|打开|列出|清单|列表|哪些|看看|查询/g, ' ')
    .trim();
  const terms = cleaned.split(/\s+/).filter(w => w.length >= 2);
  if (!terms.length) return null;
  let best = null;
  for (const s of skillListAll()) {
    for (const w of terms) {
      if (s.name.indexOf(w) >= 0 && (!best || s.name.length > best.name.length)) { best = s; break; }
    }
  }
  return best;
}
async function qaToolSkillManage(question) {
  const q = String(question || '');
  const isDel = /卸载|删除|移除|删掉/.test(q);
  const isUpd = /更新|升级/.test(q);
  const isOff = /停用|禁用|关闭|关掉/.test(q);
  const isOn = /启用|开启/.test(q);
  const isList = /列表|清单|有哪些|都装了|装了哪些|列出/.test(q);
  const isAdd = /安装|添加|加装/.test(q);
  const isHow = /怎么|如何|能不能|可以.*吗|怎么弄/.test(q);

  if (isList || (!isAdd && !isDel && !isOff && !isOn)) {
    /* 列表 / 或只是泛泛问技能管理 → 给全表 + 操作指引 */
    const all = skillListAll();
    const out = { tables: [{ entity: '技能清单（内置 ' + SKILL_CATALOG.length + ' + 自定义 ' + userSkills().length + '）',
      ts: false, note: '数据来源：本机技能注册表｜' + new Date().toLocaleString('zh-CN'),
      head: ['技能', '类别', '状态', '说明'],
      rows: all.map(s => [s.icon + ' ' + s.name, s.isUser ? '自定义' : s.vendor === 'mx' ? '妙想' : s.vendor === 'asd' ? 'a-stock-data 移植' : '内置',
        s.enabled ? '启用中' : s.installed ? '已停用' : '未安装', s.desc]) }] };
    return {
      icon: '🧩',
      title: '技能清单（' + all.filter(s => s.enabled).length + ' 个启用中 / 共 ' + all.length + ' 个）',
      lines: [
        '对话可直接说：「安装涨停板四池技能」「卸载分红技能」「停用LPR技能」',
        '新建自定义技能（接任意东财报表）：设置 → 技能 → ➕ 新建自定义技能',
      ],
      html: qaTableHtml(out, 40),
      skills: [{ id: 'skillmgr', name: '技能管理', ms: 0 }],
      block: '【技能管理结果】\n技能清单如上表（本机注册表真实状态）。\n'
        + '可执行的对话操作：安装/卸载/启用/停用某个技能（例如「安装涨停板四池技能」）；'
        + '新建自定义技能请到 设置 → 技能 → ➕ 新建自定义技能（表单式，接任意东财公开报表）。\n'
        + '请按上表如实回答用户当前装了什么、启用了什么。',
    };
  }

  const target = matchSkillFromQ(q);
  /* v3.12.0 技能包（SKILL.md / a-stock-data）对话安装：调运行时后端整包装入 */
  /* v3.12.2 技能包更新：更新/升级 + 技能包（或点名 a-stock-data）→ 重新安装（幂等覆盖=升级），报告函数增删 */
  if (isUpd && !target && /a-stock-data|技能包|SKILL/i.test(q)) {
    const mUrl = /(https?:\/\/\S+\.md)/i.exec(q);
    const prev = skillPacks().find(p => /a-stock-data|askill/i.test(p.packName));
    try {
      const r = await skillPackInstall(mUrl ? mUrl[1] : (prev ? prev.url : A_STOCK_URL), prev ? prev.packName : 'askill');
      try { renderSkillCenter(); qaRefreshSkillHint(); } catch (e) { /* */ }
      const diffTxt = (r.added.length ? '，新增 ' + r.added.length + ' 个函数' : '') + (r.removed.length ? '，移除 ' + r.removed.length + ' 个' : '');
      return {
        icon: '📦',
        title: '技能包「' + r.name + '」已更新（' + r.functions + ' 个函数' + diffTxt + '）',
        lines: [
          '升级方式：直接重新安装即可（幂等覆盖），无需先卸载',
          '函数清单：' + (r.list || []).slice(0, 15).join('、') + ((r.list || []).length > 15 ? ' 等' : ''),
        ],
        html: '',
        skills: [{ id: 'skillmgr', name: '技能管理', ms: 0 }],
        block: '【技能管理结果 · 本机已执行】技能包「' + r.name + '」已更新到最新版（' + r.functions
          + ' 个函数' + diffTxt + '）。升级 = 幂等重装，无需先卸载。请如实转告用户。',
      };
    } catch (e) {
      return {
        icon: '📦',
        title: '技能包更新失败：' + (e.message || e),
        lines: ['更新需自托管后端在线（设置 → 技能 → 后端服务器地址）'],
        html: '',
        skills: [{ id: 'skillmgr', name: '技能管理', ms: 0 }],
        block: '【技能管理结果】技能包更新失败：' + (e.message || e) + '。请如实转告用户。',
      };
    }
  }
  /* 内置技能（asd 与 em 系列）的「更新」= 应用升级，说明即可（不可谎称已单独升级） */
  if (isUpd && target && !target.isUser && !target.isPack && target.vendor !== 'mx') {
    return {
      icon: '🧩',
      title: '「' + target.name + '」是内置技能，随应用一起升级',
      lines: [
        '内置技能的代码编译在应用里，升级 = 应用升级（服务器 git pull 后重跑安装脚本 / WorkBuddy 版由我发版）',
        '如果只是想停用它：对话说「停用' + target.name + '」或在表格里点 ⏸',
      ],
      html: '',
      skills: [{ id: 'skillmgr', name: '技能管理', ms: 0 }],
      block: '【技能管理说明】' + target.name + ' 是内置技能，代码随应用发布。升级方式 = 应用升级（自托管：git pull + 重跑安装脚本；WorkBuddy 托管版：由维护者发布新版本）。不要谎称已单独升级该技能。',
    };
  }
  if (!target && /a-stock-data|技能包|SKILL/i.test(q)) {
    const mUrl = /(https?:\/\/\S+\.md)/i.exec(q);
    try {
      const r = await skillPackInstall(mUrl ? mUrl[1] : A_STOCK_URL, /a-stock-data/i.test(q) ? 'askill' : undefined);
      try { renderSkillCenter(); qaRefreshSkillHint(); } catch (e) { /* */ }
      return {
        icon: '📦',
        title: '技能包「' + r.name + '」已整包安装（' + r.functions + ' 个函数端点）',
        lines: [
          '函数清单：' + (r.list || []).slice(0, 20).join('、') + ((r.list || []).length > 20 ? ' 等' : ''),
          '问答里已可调用（agentic 回路会自动带上 askill 工具）；如执行报缺依赖，到服务器上 pip install requests pandas',
        ],
        html: '',
        skills: [{ id: 'skillmgr', name: '技能管理', ms: 0 }],
        block: '【技能管理结果 · 本机已执行】已整包安装 SKILL.md 技能包「' + r.name + '」（' + r.functions
          + ' 个函数）。之后遇到相关数据问题可调用 askill 工具（pack=' + r.name + '，函数见清单）。请如实转告用户。',
      };
    } catch (e) {
      return {
        icon: '📦',
        title: '技能包安装失败：' + (e.message || e),
        lines: [
          '整包安装（Python 执行）需要自托管后端：设置 → 技能 → 「技能包运行时」填你服务器地址（需 HTTPS）',
          'WorkBuddy 托管版没有 Python 运行时，只能用内置的 a-stock-data 移植技能（7 个常用端点）',
        ],
        html: '',
        skills: [{ id: 'skillmgr', name: '技能管理', ms: 0 }],
        block: '【技能管理结果】技能包安装失败：' + (e.message || e)
          + '。请如实告知用户：整包安装需要自托管后端（deploy/），并到 设置 → 技能 配置「技能包运行时」地址；不要假装安装成功。',
      };
    }
  }
  /* 技能包目标 + 更新 → 幂等重装并报告函数增删 */
  if (isUpd && target && target.isPack) {
    try {
      const r = await skillPackInstall(target.url, target.packName);
      try { renderSkillCenter(); qaRefreshSkillHint(); } catch (e) { /* */ }
      const diffTxt = (r.added.length ? '，新增 ' + r.added.length + ' 个函数' : '') + (r.removed.length ? '，移除 ' + r.removed.length + ' 个' : '');
      return {
        icon: '📦',
        title: '技能包「' + r.name + '」已更新（' + r.functions + ' 个函数' + diffTxt + '）',
        lines: [
          '升级方式：直接重新安装即可（幂等覆盖），无需先卸载',
          '函数清单：' + (r.list || []).slice(0, 15).join('、') + ((r.list || []).length > 15 ? ' 等' : ''),
        ],
        html: '',
        skills: [{ id: 'skillmgr', name: '技能管理', ms: 0 }],
        block: '【技能管理结果 · 本机已执行】技能包「' + r.name + '」已更新（' + r.functions + ' 个函数' + diffTxt + '）。请如实转告用户。',
      };
    } catch (e) {
      return {
        icon: '📦',
        title: '技能包更新失败：' + (e.message || e),
        lines: ['更新需自托管后端在线（设置 → 技能 → 后端服务器地址）'],
        html: '',
        skills: [{ id: 'skillmgr', name: '技能管理', ms: 0 }],
        block: '【技能管理结果】技能包更新失败：' + (e.message || e) + '。请如实转告用户。',
      };
    }
  }
  if (!target) {
    const names = skillListAll().map(s => s.icon + s.name).join('、');
    return {
      icon: '🧩',
      title: '没有从问句里认出要操作哪个技能',
      lines: [
        '内置 + 已装技能：' + names,
        '想装目录里没有的？设置 → 技能 → ➕ 新建自定义技能（接任意东财公开报表）',
      ],
      html: '',
      skills: [{ id: 'skillmgr', name: '技能管理', ms: 0 }],
      block: '【技能管理结果】用户想' + (isDel ? '卸载' : isAdd ? '安装' : isOn ? '启用' : '停用')
        + '技能，但问句里认不出具体是哪个技能。请把上面列出的可用技能名单告诉用户，让 ta 说得具体一点'
        + '（或到 设置 → 技能 里操作）。不要假装安装成功。',
    };
  }

  if (isHow) {
    return {
      icon: '🧩',
      title: '技能管理方式说明',
      lines: [
        '对话安装：直接说「安装' + target.name + '」即可（本机执行，立即生效）',
        '表格管理：设置 → 技能（每行有 停用/启用/卸载 按钮）',
      ],
      html: '',
      skills: [{ id: 'skillmgr', name: '技能管理', ms: 0 }],
      block: '【技能管理说明】技能用两种方式管理：① 对话直接说「安装/卸载/停用/启用 某技能」；'
        + '② 设置 → 技能 的表格里逐行操作。新建接东财报表的自定义技能：设置 → 技能 → ➕ 新建自定义技能。',
    };
  }

  /* 执行（改完必须 renderSkillCenter 才能反映到设置页；由调用方 qaRunTools 外层刷新） */
  let msg = '';
  if (isAdd) {
    if (target.isUser) { userSkillSaveRec(Object.assign({}, userSkillById(target.id), { enabled: true })); msg = '自定义技能「' + target.name + '」已启用'; }
    else if (target.installed && target.enabled) msg = '「' + target.name + '」本来就装着且启用中，无需重复安装';
    else if (target.installed) { skillSetEnabled(target.id, true); msg = '「' + target.name + '」已重新启用'; }
    else { skillInstall(target.id); msg = '「' + target.name + '」已安装并启用'; }
  } else if (isDel) {
    if (target.isUser) { userSkillDelete(target.id); msg = '自定义技能「' + target.name + '」已删除（如需再用请在设置 → 技能 里重新创建）'; }
    else { skillUninstall(target.id); msg = '「' + target.name + '」已卸载（可在 设置 → 技能 的「可添加的技能」里装回来）'; }
  } else if (isOff) {
    if (target.isUser) userSkillSaveRec(Object.assign({}, userSkillById(target.id), { enabled: false }));
    else skillSetEnabled(target.id, false);
    msg = '「' + target.name + '」已停用（问答不再调用它）';
  } else if (isOn) {
    if (target.isUser) userSkillSaveRec(Object.assign({}, userSkillById(target.id), { enabled: true }));
    else skillInstall(target.id);
    msg = '「' + target.name + '」已启用';
  }
  /* 同步设置页与状态条 */
  try { renderSkillCenter(); qaRefreshSkillHint(); } catch (e) { /* 不在设置页时元素不存在，忽略 */ }
  return {
    icon: '🧩',
    title: msg,
    lines: [msg, '当前启用 ' + skillListAll().filter(s => s.enabled).length + ' 个技能；表格管理在 设置 → 技能'],
    html: '',
    skills: [{ id: 'skillmgr', name: '技能管理', ms: 0 }],
    block: '【技能管理结果 · 本机已执行】' + msg + '\n'
      + '请把这句话如实转告用户。注意：这是本机注册表的真实操作结果，不是模拟。',
  };
}

function skillById(id) {
  if (String(id).indexOf('user-') === 0) return userSkillById(id);
  if (String(id).indexOf('pack-') === 0) return skillPackById(id);
  return SKILL_CATALOG.find(s => s.id === id) || null;
}
function skillEnabled(id) {
  if (String(id).indexOf('user-') === 0) return userSkillEnabled(id);
  if (String(id).indexOf('pack-') === 0) { const p = skillPackById(id); return !!(p && p.enabled !== false); }
  const e = skillReg().installed[id]; return !!(e && e.enabled && skillById(id));
}
function skillEnabledOfVendor(vendor) { return SKILL_CATALOG.filter(s => s.vendor === vendor && skillEnabled(s.id)); }
function skillSetEnabled(id, on) {
  if (String(id).indexOf('user-') === 0) { const u = userSkillById(id); if (u) { u.enabled = !!on; userSkillSaveRec(u); } return; }
  if (String(id).indexOf('pack-') === 0) { const p = skillPackById(id); if (p) { p.enabled = !!on; skillPackSaveRec(p); } return; }
  const r = skillReg();
  if (!r.installed[id]) r.installed[id] = { at: Date.now() };
  r.installed[id].enabled = !!on;
  skillRegSave();
}
function skillUninstall(id) {
  if (String(id).indexOf('user-') === 0) { userSkillDelete(id); return; }
  if (String(id).indexOf('pack-') === 0) {
    const p = skillPackById(id);
    skillPackDelete(id);
    /* 后端文件也一并移除（尽力而为；跨域失败不阻断本机记录删除） */
    if (p) fetch(runtimeBase() + '/api/pack/remove', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(typeof S !== 'undefined' && S.token ? { 'x-sj-token': S.token } : {}) }, body: JSON.stringify({ name: p.packName }) }).catch(() => { });
    return;
  }
  const r = skillReg();
  delete r.installed[id];
  // 记一笔「用户主动卸载过」：目录升级补装时要跳过，不能把人家卸掉的又塞回来
  r.removed = (r.removed || []).filter(x => x !== id).concat([id]);
  skillRegSave();
}
function skillInstall(id) {
  if (String(id).indexOf('user-') === 0) { const u = userSkillById(id); if (u) { u.enabled = true; userSkillSaveRec(u); } return; }
  if (String(id).indexOf('pack-') === 0) { const p = skillPackById(id); if (p) { p.enabled = true; skillPackSaveRec(p); } return; }
  const r = skillReg();
  r.installed[id] = { enabled: true, at: Date.now() };
  r.removed = (r.removed || []).filter(x => x !== id);
  skillRegSave();
}

/* ---------- 妙想 Key（只存本机，不上云） ---------- */
function mxKeyGet() { return String(sjStoreGet(MX_KEY_STORE) || '').trim(); }
function mxKeySet(k) { const v = String(k || '').trim(); sjStoreSet(MX_KEY_STORE, v || null); }
function mxKeyMask() {
  const k = mxKeyGet();
  if (!k) return '';
  return k.length <= 10 ? k.slice(0, 4) + '****' : k.slice(0, 7) + '****' + k.slice(-4);
}
function mxSkillReady() { return !!mxKeyGet() && skillEnabledOfVendor('mx').length > 0; }

/* ---------- 妙想执行器 ---------- */
let _mxLastAt = 0, _mxQueue = Promise.resolve();
function mxThrottle(fn) {
  const run = _mxQueue.then(async function () {
    const wait = MX_MIN_GAP - (Date.now() - _mxLastAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try { return await fn(); } finally { _mxLastAt = Date.now(); }
  });
  _mxQueue = run.then(function () {}, function () {});   // 队列不能被某一次失败卡死
  return run;
}
function mxErrText(code, msg) {
  if (code === 112) return '妙想免费额度请求过快（同一 Key 约 2 秒才能问一次），请稍等几秒再试';
  if (code === 114) return '妙想 API KEY 不存在或已失效，请到「设置 → 技能」重新配置 mkt_ 开头的 Key';
  if (code === 401 || code === 403) return '妙想拒绝访问（' + (msg || '凭据无效或已过期') + '）';
  return '妙想接口返回错误 ' + code + (msg ? '：' + msg : '');
}
/* 调一次妙想：自然语言问句进，结构化数据表出。o.key 供「测试连接」用临时 Key。 */
async function mxQuery(question, o) {
  const opt = o || {};
  const t0 = Date.now();
  const key = (opt.key || mxKeyGet()).trim();
  if (!key) { const e = new Error('尚未配置妙想 API Key（设置 → 技能）'); e.mxNoKey = true; throw e; }
  return mxThrottle(async function () {
    for (let attempt = 0; ; attempt++) {
      const ac = new AbortController();
      const tm = setTimeout(function () { ac.abort(); }, opt.timeout || 45000);
      if (opt.signal) {
        if (opt.signal.aborted) ac.abort();
        else opt.signal.addEventListener('abort', function () { ac.abort(); }, { once: true });
      }
      let r;
      try {
        r = await fetch(MX_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: key },
          body: JSON.stringify({ toolQuery: String(question || '') }),
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(tm);
        if (e && e.name === 'AbortError') throw new Error('妙想接口响应超时（可能是问题范围过大，建议缩小条件）');
        throw new Error('妙想接口请求失败：' + (e && e.message ? e.message : '网络异常'));
      }
      clearTimeout(tm);
      if (!r.ok) throw new Error('妙想接口返回 HTTP ' + r.status + (r.status === 401 || r.status === 403 ? '（Key 无效或已过期）' : ''));
      let j;
      try { j = await r.json(); } catch (e) { throw new Error('妙想接口返回内容无法解析'); }
      const code = (j && typeof j.code === 'number' && j.code !== 0) ? j.code : 0;
      if (code) {
        if (code === 112 && attempt < 1) { await new Promise(res => setTimeout(res, 4200)); continue; }
        /* v3.9.13 审计：妙想调用失败明示（错误码 + 人话原因） */
        NetLog.push('dc', '妙想技能 ' + String(question).slice(0, 20), false, Date.now() - t0,
          '未获取到：' + mxErrText(code, j && j.message),
          { url: MX_API_URL, req: 'toolQuery=' + String(question).slice(0, 120), err: 'code=' + code + ' ' + (j && j.message || '') });
        const e = new Error(mxErrText(code, j && j.message)); e.mxCode = code; throw e;
      }
      if (!j || j.success === false) throw new Error((j && (j.message || j.msg)) || '妙想接口返回失败');
      const norm = mxNormalize(j);
      norm.ms = Date.now() - t0;
      /* v3.9.13 审计：妙想返回行数（空表也如实记 0 行） */
      NetLog.push('dc', '妙想技能 ' + String(question).slice(0, 20), true, Date.now() - t0,
        (norm.rows || []).length + ' 行',
        { url: MX_API_URL, req: 'toolQuery=' + String(question).slice(0, 120), resp: (norm.rows || []).length + ' 行' });
      return norm;
    }
  });
}
/* 妙想返回 → 与 qaTableHtml 兼容的 { tables:[{entity,code,head,rows,ts}] } 形状 */
function mxNormalize(j) {
  const d = j && j.data && j.data.data;
  if (!d) throw new Error('妙想返回结构异常');
  const out = { proto: d.protocolType || '', tables: [], text: '' };
  const list = (d.searchDataResultDTO && d.searchDataResultDTO.dataTableDTOList) || [];
  list.forEach(function (t) {
    if (!t || !t.table) return;
    const head = Array.isArray(t.table.headName) ? t.table.headName.slice() : [];
    const keys = Object.keys(t.table).filter(k => k !== 'headName');
    if (!keys.length) return;
    const nums = keys.filter(k => /^\d+$/.test(k)).map(k => parseInt(k, 10)).sort((a, b) => a - b);
    // 两种返回形态：① 行=数据行（key 为 0,1,2… 连续整数）② 列=数据列（headName 是日期，key 是指标号）
    const rowStyle = nums.length === keys.length && nums.length > 1 && nums[0] === 0 && nums[nums.length - 1] === nums.length - 1;
    if (rowStyle) {
      const rows = nums.map(n => { const v = t.table[String(n)]; return Array.isArray(v) ? v.slice() : [v]; });
      out.tables.push({ entity: t.entityName || '', code: t.code || '', head: head, rows: rows, ts: false });
    } else {
      const rows = keys.map(k => { const v = t.table[k]; return [k].concat(Array.isArray(v) ? v.slice() : [v]); });
      const isTs = head.length > 0 && head.every(h => /^\d{4}-\d{2}/.test(String(h)));
      out.tables.push({ entity: t.entityName || '', code: t.code || '', head: ['指标'].concat(head), rows: rows, ts: isTs });
    }
  });
  if (!out.tables.length) {
    // 妙想对「答不了 / 免费额度不含」的问句返回 HTTP 200 + 空表。不能把原始 JSON 甩给用户，要说清原因。
    const entityTags = (d.searchDataResultDTO && d.searchDataResultDTO.entityTagDTOList) || [];
    out.empty = true;
    out.text = '妙想本次未返回数据表（返回包 ' + JSON.stringify(d).length + ' 字节'
      + (entityTags.length ? '，但识别到了 ' + entityTags.length + ' 个标的' : '') + '）。'
      + '常见原因：① 免费额度不含这类能力（条件选股 / 宏观 / 基金类问句常空手而归，'
      + '「点名标的 + 单个指标」的问法最容易出表）；② 问句修饰太多把意图打散了。建议换个更直接的问法。';
  }
  return out;
}

/* ---------- 妙想工具实现：作为 market 工具的补充口径 ---------- */
/* 这些口径免费公开表确实没有（资金流向 / 北向 / 两融 / 机构调研），配了 Key 才启用 —— 免费优先原则 */
const QA_MX_TOPIC_RE = /资金流|主力资金|净流入|净流出|北向|南向|融资融券|两融|机构调研|筹码分布|筹码集中/;
async function qaToolMx(question) {
  const q = String(question || '');
  const skillId = /新闻|资讯|消息|研报/.test(q) ? 'mx-finance-search' : 'mx-finance-data';
  const s = skillById(skillId);
  const res = await mxQuery(q);
  const ms = res.ms || 0;
  if (res.empty) {
    return {
      icon: '📊', title: s.name + ' · 本次未返回数据表',
      lines: ['数据来源：' + s.src, '耗时 ' + ms + 'ms', '说明：' + res.text],
      html: '', skills: [{ id: skillId, name: s.name, ms: ms }],
      block: '【工具计算结果 · 妙想数据】本次调用「' + s.name + '」（数据来源：东方财富妙想 Skills，用户配置的 API Key）'
        + '未返回数据表。请如实告诉用户这次没有取到数据，并转述上面的原因与建议，不要编造任何数字。',
    };
  }
  return {
    icon: '📊', title: '已取回妙想数据',
    lines: ['数据来源：' + s.src, '耗时 ' + ms + 'ms'],
    html: qaTableHtml(res, 15),
    skills: [{ id: skillId, name: s.name, ms: ms }],
    block: '【工具计算结果 · 妙想数据】（数据来源：东方财富妙想 Skills —— 用户配置的 API Key 实时查询，抓取于 '
      + new Date().toLocaleString('zh-CN') + '）\n以下均为真实返回数据，回答时必须使用其中的数字，禁止编造：\n\n'
      + qaTablesToText(res, 40)
      + '\n\n【输出要求】直接回答用户的问题，引用上面的真实数字；数据为抓取时点快照，请提示以交易软件为准，不构成投资建议。',
  };
}

/* ---------- 数据来源标注：工具便签的技能标签按 id 标来源 ---------- */
const QA_SKILL_SRC = {
  'em-screen': '东财公开数据', 'em-form': '腾讯日K', 'em-board': '东财公开数据', 'em-holder': '东财公开F10',
  'em-sim': '腾讯日K', 'em-diag': '免费公开数据', 'em-tech': '腾讯日K', 'em-backtest': '腾讯日K',
  'em-review': '本机记录', 'em-risk': '本机+公开行情',
  'em-实时行情': '腾讯行情', 'em-当日分时': '腾讯行情', 'em-财务': '东财数据中心', 'em-估值': '东财数据中心',
  'em-评级': '东财数据中心', 'em-公告': '东财公告接口', 'em-资讯': '东财资讯搜索',
  'asd-zt': '东财打板池', 'asd-thszt': '同花顺涨停揭秘', 'asd-lockup': '东财数据中心',
  'asd-dividend': '东财数据中心', 'asd-forecast': '东财数据中心', 'asd-lpr': '东财数据中心', 'asd-cb': '东财数据中心',
  'pnl': '腾讯行情 + 持仓引擎', 'skillmgr': '本机技能注册表',
};
function qaSkillSrc(id) {
  if (QA_SKILL_SRC[id]) return QA_SKILL_SRC[id];
  if (String(id || '').indexOf('mx-') === 0) return '妙想Key';
  if (String(id || '').indexOf('user-') === 0) {
    const u = userSkillById(id);
    return u ? '自定义 · 东财 ' + u.report : '自定义技能';
  }
  if (String(id || '').indexOf('asd-') === 0) return 'a-stock-data 移植';
  if (String(id || '').indexOf('em-') === 0) return '免费公开数据';
  return '';
}

/* ---------- 问答页技能状态条（输入框上方一行小字，随技能/Key 变化刷新） ---------- */
function qaSkillHintText() {
  const em = skillEnabledOfVendor('em').length;
  const asd = skillEnabledOfVendor('asd').length;
  const usr = userSkills().filter(u => u.enabled !== false).length;
  const mx = skillEnabledOfVendor('mx');
  if (!em && !asd && !usr && !mx.length) return '取数技能：未启用任何技能，问答只用模型自身知识回答';
  let s = '取数技能：' + em + ' 个内置（免费公开数据，无需 Key）';
  if (asd) s += ' ＋ ' + asd + ' 个 a-stock-data 移植（免费公开接口，无需 Key）';
  if (usr) s += ' ＋ ' + usr + ' 个自定义';
  if (mx.length) s += ' ＋ ' + mx.length + ' 个妙想（' + (mxKeyGet() ? 'Key 已配置 ' + mxKeyMask() : '待配置 Key：设置 → 技能') + '）';
  return s;
}
function qaRefreshSkillHint() {
  const el = document.getElementById('qaSkillHint');
  if (el) el.textContent = qaSkillHintText();
}

/* ---------- 设置 → 技能：渲染与交互（事件绑定在 app.js，这里只出 HTML） ---------- */
function skillCardHtml(s, installed) {
  const on = installed && skillReg().installed[s.id] && skillReg().installed[s.id].enabled;
  const noKey = s.vendor === 'mx' && !mxKeyGet();
  const badges = []
    .concat(s.vendor === 'mx' ? ['<span class="sk-badge mx">妙想 Key</span>'] : [])
    .concat(s.quota ? ['<span class="sk-badge quota">额度 ' + s.quota + '/日</span>'] : [])
    .concat(s.support && s.vendor === 'mx' ? ['<span class="sk-badge sup">' + SUPPORT_TXT[s.support] + '</span>'] : [])
    .concat(noKey ? ['<span class="sk-badge warn">待配置凭据</span>'] : []);
  const actions = installed
    ? '<button type="button" class="btn ghost sm" data-sk="toggle" data-sid="' + s.id + '">' + (on ? '⏸ 停用' : '▶ 启用') + '</button>'
      + '<button type="button" class="btn ghost sm" data-sk="del" data-sid="' + s.id + '">卸载</button>'
    : '<button type="button" class="btn primary sm" data-sk="add" data-sid="' + s.id + '">＋ 添加</button>';
  return '<div class="sk-item' + (installed && !on ? ' off' : '') + '">'
    + '<div class="sk-head"><span class="sk-ico">' + s.icon + '</span><b>' + esc(s.name) + '</b>' + badges.join('') + '</div>'
    + '<div class="sk-desc">' + esc(s.desc) + '</div>'
    + '<div class="sk-src">数据来源：' + esc(s.src) + '</div>'
    + '<div class="sk-actions">' + actions + '</div>'
    + '</div>';
}
function renderSkillCenter() {
  skillReg();   // 确保注册表已初始化
  const onBox = document.getElementById('skillListOn');
  const offBox = document.getElementById('skillListOff');
  const offBlock = document.getElementById('skillOffBlock');
  const sum = document.getElementById('skillSummary');
  /* v3.11.0 表格化管理：每行 = 技能｜来源｜状态｜操作（按钮沿用 data-sk 委托协议） */
  const catBadge = s => (s.vendor === 'mx' && !mxKeyGet() ? '<span class="sk-badge warn">待配置凭据</span>' : '')
    + (s.isUser ? '<span class="sk-badge">自定义</span>'
    : s.vendor === 'mx' ? '<span class="sk-badge mx">妙想 Key</span>'
    : s.vendor === 'asd' ? '<span class="sk-badge">a-stock-data</span>' : '');
  const skRow = s => {
    const on = s.enabled;
    const actions = s.installed
      ? '<button type="button" class="btn ghost sm" data-sk="toggle" data-sid="' + s.id + '">' + (on ? '⏸ 停用' : '▶ 启用') + '</button> '
        + (s.isPack ? '<button type="button" class="btn ghost sm" data-sk="upd" data-sid="' + s.id + '" title="重新下载 SKILL.md 并覆盖安装">🔄 更新</button> ' : '')
        + '<button type="button" class="btn ghost sm" data-sk="del" data-sid="' + s.id + '">' + (s.isUser ? '🗑 删除' : '卸载') + '</button>'
      : '<button type="button" class="btn primary sm" data-sk="add" data-sid="' + s.id + '">＋ 安装</button>';
    return '<tr' + (s.installed && !on ? ' class="qa-dim"' : '') + '>'
      + '<td>' + s.icon + ' ' + esc(s.name) + ' ' + catBadge(s) + '</td>'
      + '<td>' + esc(s.desc) + '<br><span style="color:var(--ink-3)">数据来源：' + esc(s.src) + '</span></td>'
      + '<td>' + (s.installed ? (on ? '✅ 启用中' : '⏸ 已停用') : '— 未安装 —') + '</td>'
      + '<td style="white-space:nowrap">' + actions + '</td></tr>';
  };
  const skTable = list => '<div class="table-wrap"><table class="qa-tbl"><thead><tr>'
    + '<th>技能</th><th>说明 / 来源</th><th>状态</th><th>操作</th></tr></thead><tbody>'
    + (list.length ? list.map(skRow).join('') : '<tr><td colspan="4">（无）</td></tr>')
    + '</tbody></table></div>';
  if (onBox) {
    const installed = skillListAll().filter(s => s.installed);
    onBox.innerHTML = skTable(installed);
  }
  if (offBox) {
    const removed = skillListAll().filter(s => !s.installed);
    offBox.innerHTML = skTable(removed);
    if (offBlock) offBlock.hidden = !removed.length;
  }
  if (sum) {
    const all = skillListAll();
    const enabledCnt = all.filter(s => s.enabled).length;
    const em = skillEnabledOfVendor('em').length, asd = skillEnabledOfVendor('asd').length,
      mx = skillEnabledOfVendor('mx').length, usr = all.filter(s => s.isUser && s.enabled).length;
    sum.textContent = '已启用 ' + enabledCnt + ' / ' + all.length + ' 个技能：' + em + ' 个内置免费（无需 Key）+ '
      + asd + ' 个 a-stock-data 移植（免费公开接口，无需 Key）+ ' + usr + ' 个自定义 + ' + mx + ' 个妙想'
      + (mx ? (mxKeyGet() ? '（Key 已配置）' : '（待配置 Key）') : '')
      + '。对话里也可以直接说「安装/卸载/停用 某技能」；只有已启用的技能才会被问答调用。';
  }
  const tbl = document.getElementById('skillSrcTbl');
  if (tbl) {
    tbl.innerHTML = '<table class="qa-tbl"><thead><tr><th>技能</th><th>数据来源</th><th>说明</th></tr></thead><tbody>'
      + skillListAll().map(s => '<tr><td>' + s.icon + ' ' + esc(s.name) + '</td><td>' + esc(s.src) + '</td><td>' + esc(s.desc) + '</td></tr>').join('')
      + '</tbody></table>';
  }
  const st = document.getElementById('mxKeyStatus');
  if (st && !st.dataset.dirty) mxKeyStatusRender();
}
function mxKeyStatusRender(extra) {
  const st = document.getElementById('mxKeyStatus');
  if (!st) return;
  if (extra) { st.innerHTML = extra; return; }
  const k = mxKeyGet();
  st.innerHTML = k
    ? '当前状态：<span class="mx-ok">已配置</span>（' + esc(mxKeyMask()) + '）· 仅保存在本机浏览器，不上传云端；保存后妙想类技能立即可用。'
    : '当前状态：<span class="mx-err">未配置</span> · 妙想类技能显示「待配置凭据」；问答自动只用免费公开数据源（功能略少，仍可用）。';
}

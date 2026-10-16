/* ============================================================
   操作日记 · 重构版 app.js
   架构：存储适配层（云端 RPC / 本地 localStorage）+ 费用引擎
        + 持仓引擎（移动加权平均）+ 自然语言解析 + 五视图渲染
   ============================================================ */
'use strict';

/* ---------------- 云端配置 ----------------
   云端访问 key 与应用域名绑定（服务端校验 Origin）；
   云端运行走相对路径，本地打开走云端绝对地址，均指向同一后端
   v3.8.63 曾迁至应用「股票操作日记」（appId wbapp_nRQHqCtwORJYvXyAPTEn0E，域名
   trade-journal-94951）；v3.8.64 按用户要求把链接前缀改成 stock-journal ——
   平台域名前缀只在建应用时确定、事后不可改（文档原文 "cannot be changed later"），
   所以另建新应用「股票日记」（appId wbapp_mtCmnoJVwocZG4iRlx6CMe，
   stock-journal-07300）并逐字复刻整套 7 表 / 15 函数云库。
   旧应用 stock-journal-84311、trade-journal-94951 及各自数据保持不变、互不影响 */
const CLOUD_HOST = 'https://stock-journal-07300.app.workbuddy.host';
/* v3.12.0 混合模式：WorkBuddy 托管界面，数据/技能包跑在自己的服务器。
   「后端服务器地址」（设置 → 技能 → 后端服务器地址，存 sj_backend_url）非空时，
   RPC 全部指向它；留空 = 云端数据、同源相对路径，行为与之前完全一致。
   注意：WorkBuddy 页面是 HTTPS，按浏览器混合内容规则，后端地址必须是 HTTPS
   （纯 IP 无法签发受信证书 —— 建议挂一个免费域名 + Caddy 自动证书）。 */
const BACKEND_URL = (() => {
  try { return String(localStorage.getItem('sj_backend_url') || '').trim().replace(/\/+$/, ''); }
  catch (e) { return ''; }
})();
const RPC_BASE = (location.protocol === 'file:')
  ? (BACKEND_URL || CLOUD_HOST) + '/.cloud/database/rest/rpc'
  : (BACKEND_URL ? BACKEND_URL + '/.cloud/database/rest/rpc' : '/.cloud/database/rest/rpc');
const ACCESS_KEY = 'wbpk_mtCmnoJVwocZG4iRlx6CMe_NtYKw83A5VMgiaYhXnfV80AIGKO1rMbm';
/* 云端 LLM（免密钥）：模型目录 + 对话调用，与旧版 trade-manager 同一通道 */
let cloudLlm = null;
function initCloudLlm() {
  if (!window.WorkBuddyCloud) return null;
  try { return WorkBuddyCloud.createWorkBuddyCloud({ endpoint: CLOUD_HOST, publishableKey: ACCESS_KEY }); }
  catch (e) { return null; }
}
/* v3.9.0 新增 qa_history（智能问答历史，云端）。加入 TABLES 后 localStore 的
   清空/读写会一并覆盖，云端则由 app_query/app_insert/app_delete 的白名单放行。 */
const TABLES = ['trades', 'watchlist', 'quotes', 'settings', 'op_logs', 'qa_history'];

/* ---------------- 全局状态 ---------------- */
const S = {
  mode: null,            // 'cloud' | 'local'
  token: null,
  user: null,            // {username, role, local?}
  trades: [], watchlist: [], quotes: [], settings: {}, opLogs: [],
  editingTradeId: null,
  editingWatchId: null,
  editingPriceCode: null,
};

const $ = id => document.getElementById(id);

/* ============================================================
   工具
   ============================================================ */
function toast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => { t.className = ''; }, 2200);
}
function fmt2(n) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
/* v3.8.61 价格类数值固定 3 位小数（原为 maximumFractionDigits:3，会抹掉末尾零，
   使 44.810 显示成 44.81，同一列数字长短不齐）。改为 min=max=3 与 fmt2 同构。
   影响：持仓表成本价、展开区「成本」胶囊、自选锚点价、交易价格文案 —— 均为价格语义，口径统一。 */
function fmtP(n) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 3, maximumFractionDigits: 3 }); }
function fmtPct(n) { return (n > 0 ? '+' : '') + (n * 100).toFixed(2) + '%'; }
function pnlCls(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'neu'; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtTime(ts, withYear) {
  const d = new Date(ts);
  if (isNaN(d)) return '—';
  const p = n => String(n).padStart(2, '0');
  const base = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withYear ? `${d.getFullYear()}-${base}` : base;
}
function nowLocalInput() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function inferMarket(code) {
  if (/^6/.test(code)) return 'sh';
  if (/^(0|3)/.test(code)) return 'sz';
  if (/^(4|8|9)/.test(code)) return 'bj';
  return 'sz';
}
const MKT_NAME = { sh: '沪市', sz: '深市', bj: '北交所', bse: '北交所' };
const APP_VER = '3.17.3';

/* v3.8.44 分组行「动作按钮」图标：与导航图标同一套线框风格（24 格 / 1.6 描边 / 圆角）
   folderPlus = 新建分组，trash = 删除当前分组。v3.8.45 起与短词并排使用。 */
const ICO = {
  folderPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h3.2l1.6 2h9.2A1.5 1.5 0 0 1 20.5 9.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M12 11v5.5M9.25 13.75h5.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7M6.9 7l.8 11.4A1.6 1.6 0 0 0 9.3 20h5.4a1.6 1.6 0 0 0 1.6-1.6L17.1 7"/></svg>',
};

/* ============================================================
   全市场股票字典（离线联想：代码 / 名称 / 拼音首字母）
   与 trade-manager 同源数据：stock-dict.json 5573 条全市场
   基础数据随应用发布，localStorage 缓存 7 天；用户数据持续学习。
   ============================================================ */
const StockDict = {
  d: {},          // code -> {name, py, mkt}
  ready: false,
  async init() {
    const SEED_KEY = 'sj_stock_dict_seed', AT_KEY = 'sj_stock_dict_at';
    const TTL = 7 * 24 * 3600 * 1000;
    let seeded = false;
    try {
      const at = Number(localStorage.getItem(AT_KEY) || 0);
      const seed = localStorage.getItem(SEED_KEY);
      if (seed && at && Date.now() - at < TTL) { seeded = this.apply(seed) >= 1000; }
    } catch (e) { /* */ }
    if (!seeded) {
      const t0 = Date.now();
      try {
        const res = await fetch('stock-dict.json?v=' + APP_VER, { cache: 'no-cache' });
        const raw = await res.text();
        if (this.apply(raw) >= 1000) {
          NetLog.push('dict', '股票字典 stock-dict.json', true, Date.now() - t0, '种子载入');
          try { localStorage.setItem(SEED_KEY, raw); localStorage.setItem(AT_KEY, String(Date.now())); } catch (e) { /* 配额满 */ }
        }
      } catch (e) { NetLog.push('dict', '股票字典 stock-dict.json', false, Date.now() - t0, e.message || String(e)); /* 拉取失败：仅用已学到的条目 */ }
    }
    this.ready = true;
    this.learnFromState();
  },
  apply(raw) {
    let j = null;
    try { j = JSON.parse(raw); } catch (e) { return 0; }
    const arr = (j && j.d) || [];
    let n = 0;
    for (const row of arr) {
      const code = String(row[0] || ''), name = String(row[1] || ''), py = String(row[2] || '');
      if (!/^\d{6}$/.test(code) || !name) continue;
      this.d[code] = { name, py, mkt: inferMarket(code) };
      n++;
    }
    return n;
  },
  /* 从既有数据（交易/自选/行情）补充字典条目。
     ⚠️ v3.8.60：**绝不覆盖字典已有条目**。
     历史教训：一笔误录的「603393 红四方」经 learnFromState() 把字典里
     「603393 = 新天然气」改成了「红四方」，而 603393 是真实存在的股票 ——
     污染后输入「红四方」联想给 603393、输入 603393 显示红四方，越用越乱，
     且会在每次启动时自我复现。故只在代码**不在字典中**时才学习（用于补新股）。 */
  learn(code, name) {
    code = String(code || '').trim(); name = String(name || '').trim();
    if (!/^\d{6}$/.test(code) || !name) return;
    if (this.d[code]) return;   // 字典已有该代码：以字典为准，不被用户数据覆盖
    this.d[code] = { name, py: '', mkt: inferMarket(code) };
  },
  learnFromState() {
    if (!this.ready) return;
    (S.trades || []).forEach(t => this.learn(t.stock_code, t.stock_name));
    (S.watchlist || []).forEach(w => this.learn(w.stock_code, w.stock_name));
    (S.quotes || []).forEach(q => { if (q && q.stock_code) this.learn(q.stock_code, q.stock_name); });
  },
  /* 匹配优先级：代码前缀 > 拼音首字母前缀 > 名称包含 > 拼音包含 */
  search(txt, limit) {
    txt = String(txt || '').trim().toLowerCase();
    if (!txt) return [];
    const out = [];
    for (const code in this.d) {
      const d = this.d[code];
      const nm = d.name.toLowerCase();
      const py = d.py || '';
      let r = -1;
      if (code.indexOf(txt) === 0) r = 0;
      else if (py && py.indexOf(txt) === 0) r = 1;
      else if (nm.indexOf(txt) >= 0) r = 2;
      else if (py && py.indexOf(txt) >= 0) r = 3;
      if (r < 0) continue;
      out.push({ code, name: d.name, mkt: d.mkt, _r: r });
    }
    out.sort((a, b) => a._r - b._r || (a.code < b.code ? -1 : 1));
    const res = out.slice(0, limit || 8);
    res.forEach(x => delete x._r);
    return res;
  },
  /* 「600519 贵州茅台」/「600519」/「gzmt」/「贵州茅台」统一解析
     ⚠️ v3.8.60：「代码 + 名称」组合与字典冲突时，**以字典为准**并置 `conflict`。
     历史教训：用户误输入「红四方 603393」（603393 实为「新天然气」）时，
     原实现直接返回 {code:603393, name:红四方} 并静默入库 —— 名称与代码张冠李戴，
     且经 learnFromState() 进一步污染整本字典。现在改为：只要字典里这个代码有归属，
     就采信字典的名称，并把用户原本写的名称放进 conflict.typedName 供上层提示。 */
  resolve(txt) {
    txt = String(txt || '').trim();
    const m = txt.match(/^(\d{5,6})(?:[\s·、,，]+(.*))?$/);
    if (m) {
      const code = m[1];
      const known = this.d[code];
      const typedName = (m[2] && m[2].trim()) || '';
      /* 字典有该代码：名称一律以字典为准 */
      if (known) {
        const conflict = typedName && typedName !== known.name
          ? { typedName, dictName: known.name } : null;
        return { code, name: known.name, mkt: known.mkt || inferMarket(code), conflict };
      }
      /* 字典没有该代码：允许手动录入（可能是字典未收录的新股），但名称用用户写的 */
      return { code, name: typedName, mkt: inferMarket(code), unknown: true };
    }
    const hits = this.search(txt, 1);
    return hits.length ? hits[0] : null;
  }
};

/* ---------- 通用联想下拉（自选 / 交易表单共用） ---------- */
/* v3.8.86 加自选弹窗 PC 档隐藏股票联想（CSS 里 `#watchModal #tvWfSug{display:none}`）。
   但只隐藏视觉不够：`input` 事件照旧会触发 showShield() 插入全屏透明防护罩
   （.modal-mask 内 inset:0 / z-index:29），用户点「添加」按钮时第一次点击会被它吞掉。
   所以这里做双保险 —— 候选压根不渲染，也不插罩。 */
const SUG_OFF_IN_WATCH_PC = (() => {
  let mql = null;
  try { mql = window.matchMedia('(min-width: 721px)'); } catch (e) { /* 老浏览器忽略 */ }
  return boxId => {
    if (boxId !== 'tvWfSug') return false;
    return !!(mql && mql.matches);
  };
})();

function bindSuggest(inputId, boxId, onPick) {
  const inp = $(inputId), box = $(boxId);
  let items = [], shield = null, shieldTimer = null;
  /* 候选打开期间的透明防护罩：第一次点空白处只收起下拉，避免误触下方按钮；
     收起后延迟 350ms 再撤罩，吞掉选中后浏览器补发的 click，防止落到下方按钮上 */
  const removeShieldNow = () => {
    if (shieldTimer) { clearTimeout(shieldTimer); shieldTimer = null; }
    if (shield) { shield.remove(); shield = null; }
  };
  const showShield = () => {
    if (SUG_OFF_IN_WATCH_PC(boxId)) return;   /* v3.8.86 PC 弹窗内联想已关，别插罩拦点击 */
    if (shield) { if (shieldTimer) { clearTimeout(shieldTimer); shieldTimer = null; } return; }
    shield = document.createElement('div');
    shield.className = 'sug-shield';
    const stop = e => { e.preventDefault(); e.stopPropagation(); close(); };
    shield.addEventListener('pointerdown', stop);
    shield.addEventListener('touchstart', stop, { passive: false });
    (box.closest('.modal-mask') || document.body).appendChild(shield);
  };
  const close = () => {
    box.hidden = true; box.innerHTML = ''; items = [];
    if (shield && !shieldTimer) shieldTimer = setTimeout(removeShieldNow, 350);
  };
  inp.addEventListener('input', () => {
    /* v3.8.86 PC 弹窗内直接不渲染候选（顺手把可能残留的下拉/防护罩收掉），
       输入框本身仍照常收字符，提交走 StockDict.resolve 不受影响。 */
    if (SUG_OFF_IN_WATCH_PC(boxId)) { close(); removeShieldNow(); return; }
    const v = inp.value.trim();
    if (!v || !StockDict.ready) { close(); return; }
    items = StockDict.search(v, 8);
    if (!items.length) {
      box.innerHTML = '<div class="sug-empty">无匹配结果，可直接手动录入</div>';
      box.hidden = false;
      showShield();
      return;
    }
    box.innerHTML = items.map(h =>
      `<div class="sug-item" data-code="${esc(h.code)}" data-name="${esc(h.name)}" data-mkt="${esc(h.mkt)}"><b>${esc(h.code)}</b>${esc(h.name)}<span>${esc(MKT_NAME[h.mkt] || '')}</span></div>`
    ).join('');
    box.hidden = false;
    showShield();
    /* v3.8.79 下拉不再整块 scrollIntoView。
       旧写法 `box.scrollIntoView({block:'nearest'})` 在弹窗（.modal-lg 自身可滚）内会
       把「下拉 + 弹窗」一起滚动，视觉上下拉像被顶到屏幕中间、盖住大半个页面，
       用户反馈「下拉筛选股票会把页面全挡」。
       现在只保证**股票输入框**留在视野内即可 —— 下拉紧贴其下方，自然跟着可见。 */
    try { inp.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* */ }
  });
  const pick = e => {
    const it = e.target.closest('.sug-item');
    if (!it) return;
    e.preventDefault();
    onPick({ code: it.dataset.code, name: it.dataset.name, mkt: it.dataset.mkt });
    close();
  };
  box.addEventListener('pointerdown', pick);
  box.addEventListener('touchstart', pick, { passive: false });
  box.addEventListener('click', pick);
  inp.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  inp.addEventListener('blur', () => setTimeout(close, 120));
}

/* 确认模态（v3.8.43 起同一套骨架兼做「输入模态」，仅多一行输入框） */
let confirmCb = null;
let confirmInputCb = null;
function confirmDlg(title, desc, onOk, okText) {
  $('confirmTitle').textContent = title;
  const d = $('confirmDesc'); d.textContent = desc; d.hidden = false;
  const inp = $('confirmInput'); inp.hidden = true; inp.value = '';
  const ok = $('confirmOk'); ok.textContent = okText || '确认'; ok.className = 'btn danger';
  confirmCb = onOk; confirmInputCb = null;
  $('confirmModal').hidden = false;
}
/* v3.8.43 输入模态：与 confirmDlg 完全同款，多一行输入框；onOk 收到去掉首尾空格的文本 */
function promptDlg(title, desc, onOk, opt) {
  opt = opt || {};
  $('confirmTitle').textContent = title;
  const d = $('confirmDesc'); d.textContent = desc || ''; d.hidden = !desc;
  const inp = $('confirmInput');
  inp.hidden = false; inp.value = opt.value || ''; inp.placeholder = opt.placeholder || '';
  const ok = $('confirmOk'); ok.textContent = opt.okText || '确定'; ok.className = 'btn primary';
  confirmInputCb = onOk; confirmCb = null;
  $('confirmModal').hidden = false;
  setTimeout(() => { try { inp.focus(); inp.select(); } catch (e) { /* */ } }, 30);
}
function closeConfirm() {
  $('confirmModal').hidden = true;
  const inp = $('confirmInput'); inp.hidden = true; inp.value = '';
  confirmCb = null; confirmInputCb = null;
}

/* ============================================================
   费用引擎（口径与 trade-manager 一致，‰，三市独立）
   ============================================================ */
const DEFAULT_FEES = {
  sh:  { rate: 0.06, min: 5, stamp: 0.5, transfer: 0.01, handling: 0.034, gov: 0.02 },
  sz:  { rate: 0.06, min: 5, stamp: 0.5, transfer: 0.01, handling: 0.034, gov: 0.02 },
  bse: { rate: 0.06, min: 0, stamp: 0.5, transfer: 0.01, handling: 0.125, gov: 0 }
};
function feeCfg(market) {
  /* 键名归一：inferMarket 产出 'bj'，费率表键为 'bse'（v3.8.32 修 —— 此前北交所单会误落到深市费率） */
  const key = market === 'bj' ? 'bse' : market;
  const cfg = S.settings.fee || {};
  return Object.assign({}, DEFAULT_FEES[key] || DEFAULT_FEES.sz, cfg[key] || {});
}
/* v3.8.31 场内基金（ETF/LOF）费率：固定佣金万1全包（含规费）、免印花税、最低5元
   依据广发交割单 1445 笔实测：纳斯达克ETF 49笔全部 = 金额×0.0001（<500元按5元收） */
const FUND_FEES = { rate: 0.1, min: 5, stamp: 0, transfer: 0, handling: 0, gov: 0 };
function isFundCode(code) { return !!code && /^(5|1[56])/.test(String(code)); }
/* v3.8.32 口径改为「券商式逐项取整」：每个费用项先四舍五入到分，再汇总计入总费用
   （依据广发交割单 1445 笔实测：该口径对账吻合率 62.5%，优于原「各项高精度相加后取整」的 57.4%，
   且分项之和天然等于合计，费用明细不再出现 1 分钱对不上） */
const r2 = x => Math.round((x + 1e-9) * 100) / 100;
function calcFees(amount, type, market, code) {
  /* 最低费用 min 针对规费(过户+经手+证管)+佣金 合计，不足时由佣金补足；印花税不参与 */
  const f = (market === 'fund' || isFundCode(code)) ? FUND_FEES : feeCfg(market);
  const stamp = type === 'sell' ? r2(amount * f.stamp / 1000) : 0;
  const transfer = r2(amount * f.transfer / 1000);
  const gov = r2(amount * (f.gov || 0) / 1000);
  const handling = r2(amount * f.handling / 1000);
  const rawComm = r2(amount * f.rate / 1000);
  const fixTotal = transfer + gov + handling;
  const minFee = Number(f.min) || 0;
  const comm = amount > 0 && (fixTotal + rawComm) < minFee ? r2(Math.max(minFee - fixTotal, 0)) : rawComm;
  return { commission: comm, stamp, transfer, handling, gov, total: r2(stamp + fixTotal + comm) };
}
/* 初始持仓记录（费用手动置 0，成本=初始建仓价）：不参与「重算历史费用」，避免成本被改写 */
function isInitTrade(t) {
  if (!t) return false;
  if (/初始化/.test(t.note || '')) return true;
  const f = t.fee;
  return !!f && typeof f === 'object' && Object.keys(f).length === 0;
}
function buildTradeRow({ type, code, name, market, price, qty, time, note }) {
  const gross = Math.round(price * qty * 10000) / 10000;
  const fee = calcFees(gross, type, market, code);
  const net = type === 'buy' ? gross + fee.total : gross - fee.total;
  return {
    transaction_time: new Date(time).toISOString(),
    transaction_type: type,
    stock_code: code, stock_name: name || '', market,
    quantity: qty, price, gross_amount: gross, fee, net_amount: net,
    note: note || '', source: 'manual'
  };
}

/* ============================================================
   持仓引擎：移动加权平均（统计权威）+ 摊薄成本（展示）
   ============================================================ */
function computeHoldings() {
  const map = new Map();
  const sorted = [...S.trades].sort((a, b) => new Date(a.transaction_time) - new Date(b.transaction_time));
  /* v3.8.56 当日配对池：卖出时优先用「同日买入」的成本配对，剩余部分才回落到历史持仓成本。
     目的：做 T（当日买、当日卖）时「已实现盈亏」反映这一手操作的真实收益，
     而不是拿隔夜老仓的高成本去比（那会得出与直觉相反的巨额亏损）。
     dayKey = 本地交易日 YYYY-MM-DD，日切时重置池。 */
  let dayKey = '', dayQty = 0, dayCost = 0;
  for (const t of sorted) {
    const k = t.stock_code;
    if (!map.has(k)) map.set(k, { code: k, name: t.stock_name || '', market: t.market, qty: 0, costValue: 0, dilutedValue: 0, realized: 0, realizedOp: 0, timeline: [] });
    const h = map.get(k);
    if (t.stock_name) h.name = t.stock_name;
    if (t.market) h.market = t.market;
    const feeTotal = (t.fee && t.fee.total) || 0;
    const net = t.net_amount != null ? Number(t.net_amount) : t.gross_amount - feeTotal;
    /* 日切：换了一天就清空配对池（按该笔自身的交易日期） */
    const d = new Date(t.transaction_time);
    const tKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (tKey !== dayKey) { dayKey = tKey; dayQty = 0; dayCost = 0; }
    if (t.transaction_type === 'buy') {
      h.qty += t.quantity;
      h.costValue += t.gross_amount + feeTotal;      // 加权：费用计入成本
      h.dilutedValue += t.gross_amount + feeTotal;
      dayQty += t.quantity; dayCost += t.gross_amount + feeTotal;
      h.timeline.push({ t, avg: h.qty ? h.costValue / h.qty : 0, realized: null, realizedOp: null });
    } else {
      const avg = h.qty ? h.costValue / h.qty : 0;
      const pnl = net - t.quantity * avg;            // 整轮口径：这笔卖 vs 持仓加权成本
      h.realized += pnl;
      /* 当笔口径：先用当日买入池配对，剩余部分再用历史加权成本 */
      let pnlOp;
      if (dayQty > 0) {
        const useQty = Math.min(t.quantity, dayQty);
        const avgDay = dayCost / dayQty;
        pnlOp = useQty * ((net / t.quantity) - avgDay); // 配对部分：卖出净价 − 当日买入成本
        dayCost -= useQty * avgDay; dayQty -= useQty;
        const rest = t.quantity - useQty;
        if (rest > 0) pnlOp += rest * ((net / t.quantity) - avg);
      } else {
        pnlOp = pnl;
      }
      h.realizedOp += pnlOp;
      h.costValue -= t.quantity * avg;
      h.dilutedValue -= net;                          // 摊薄：盈亏滚入
      h.qty -= t.quantity;
      if (h.qty <= 0.0001) { h.qty = 0; h.costValue = 0; h.dilutedValue = 0; }
      h.timeline.push({ t, avg, realized: pnl, realizedOp: pnlOp });
    }
  }
  return [...map.values()];
}
function quoteMap() {
  return NetQuote.map;   // 统一走网络行情（腾讯公开接口），不再读手填价格表
}

/* ============================================================
   v3.8.23 网络日志：所有网络调用（云RPC / 行情 / K线）统一记录
   内存环 + localStorage 持久化；「我的 → 数据管理」可下载 .log 文件
   ============================================================ */
/* v3.9.13 网络日志升级为「审计级」：此前每条只有 kind/name/ms/detail，
   看不出「哪个功能触发的、调了哪个接口、参数是什么、返回了什么」，
   股票数据没法核对准确性。现在每条记录带：
   src（触发来源：功能·操作，由 NetLog.withCtx 压栈自动带上）
   url（请求地址）req（请求参数摘要）resp（返回摘要）err（失败原因）
   取不到数据时如实记 FAIL + 原因，绝不静默编造。 */
/* v3.15.1 自托管 API 统一带会话 token（公网部署时服务端校验 x-sj-token） */
function sjTokenHeaders(extra) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  if (typeof S !== 'undefined' && S.token) h['x-sj-token'] = S.token;
  return h;
}
const NetLog = {
  buf: [],
  max: 800,
  _saveT: null,
  _ctx: [],                                    // 触发来源栈（后进先出）
  load() { try { this.buf = JSON.parse(localStorage.getItem('sj_netlog') || '[]'); } catch (e) { this.buf = []; } },
  /* withCtx('功能·操作', fn)：fn 同步或返回 Promise 均可，结束后恢复原栈。
     并发交错时以最内层为准（恢复按快照，尽力而为）——本项目数据调用基本是用户顺序触发，够用。 */
  withCtx(label, fn) {
    const prev = this._ctx.slice();
    this._ctx.push(label);
    try {
      const r = fn();
      if (r && typeof r.then === 'function') return r.finally(() => { this._ctx = prev; });
      this._ctx = prev;
      return r;
    } catch (e) { this._ctx = prev; throw e; }
  },
  curCtx() { return this._ctx[this._ctx.length - 1] || ''; },
  _cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; },
  push(kind, name, ok, ms, detail, extra) {
    const x = extra || {};
    const e = {
      t: new Date().toISOString(), kind, name, ok: !!ok, ms: Math.round(ms),
      detail: this._cut(detail, 400),
      src: this._cut(x.src != null ? x.src : this.curCtx(), 120),
      url: this._cut(x.url, 400),
      req: this._cut(x.req, 300),
      resp: this._cut(x.resp, 300),
      err: this._cut(x.err != null ? x.err : (ok ? '' : detail), 300),
    };
    this.buf.unshift(e);
    if (this.buf.length > this.max) this.buf.length = this.max;
    this._outbox.push(e);
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      try { localStorage.setItem('sj_netlog', JSON.stringify(this.buf.slice(0, 200))); } catch (err) { /* 存储满则只在内存 */ }
    }, 1500);
    if (!ok) console.warn('[net-fail]', kind, name, detail, Math.round(ms) + 'ms');
    this._scheduleUpload();
  },
  /* v3.12.4 上报：把每次调用批量发到自托管后端，落 logs/app-YYYYMMDD.log。
     云端托管版没有该端点（404）→ 本次会话静默停用；file:// 同理跳过。 */
  _outbox: [],
  _upDisabled: false,
  _upT: null,
  _scheduleUpload() {
    clearTimeout(this._upT);
    this._upT = setTimeout(() => this.flushToServer(), 2500);
  },
  flushToServer() {
    if (this._upDisabled || location.protocol === 'file:') return;
    if (!this._outbox.length) return;
    const entries = this._outbox.splice(0, this._outbox.length);
    fetch('/api/log', { method: 'POST', headers: sjTokenHeaders(),
      body: JSON.stringify({ entries: entries.map(x => ({ t: x.t, kind: x.kind, name: x.name, ok: x.ok, ms: x.ms, detail: x.detail, src: x.src })) }) })
      .then(r => { if (!r.ok) this._upDisabled = true; })
      .catch(() => { this._upDisabled = true; });
  },
  /* 下载文本：一条一块、带标签行，缺的字段不输出（不像旧版挤在一行什么都要猜） */
  text() {
    return this.buf.map((e, i) => {
      const lines = [
        `#${this.buf.length - i} ${e.t} [${e.ok ? 'OK' : 'FAIL 未获取到'}] ${e.kind} ${e.name} ${e.ms}ms`,
      ];
      if (e.src) lines.push('  触发：' + e.src);
      if (e.url) lines.push('  请求：' + e.url);
      if (e.req && e.req !== e.url) lines.push('  参数：' + e.req);
      lines.push(e.ok ? ('  返回：' + (e.resp || e.detail || '(空)')) : ('  错误：' + (e.err || e.detail || '未知')));
      if (e.ok && e.resp && e.detail && e.resp !== e.detail) lines.push('  摘要：' + e.detail);
      return lines.join('\n');
    }).join('\n');
  },
  clear() { this.buf = []; try { localStorage.removeItem('sj_netlog'); } catch (e) { /* */ } }
};
NetLog.load();

/* ============================================================
   网络行情（v3.8.24 东财主源 + 腾讯备选，浏览器可直连）
   v3.8.24：新浪 hq.sinajs.cn 服务端白名单校验 Referer（必须是新浪系
   域名），浏览器无法伪造 → 永远 403，弃用；改用东财 push2 实时快照
   （无 Referer/UA 要求，已实测浏览器可直连、批量、秒级时间戳）。
   map: code -> { price, name, pct, prevClose, open, high, low }
   获取失败的代码不在 map 中；quoteTime 为行情商报价时间
   ============================================================ */
const NetQuote = {
  map: new Map(),
  fetchedAt: 0,
  quoteTime: '',
  pending: null,
  ttl: 15 * 1000,            // v3.8.23 缓存 60s → 15s
  eastFailStreak: 0,
  eastDeadUntil: 0,          // 东财连续失败 3 次熔断 10 分钟（期间直接走腾讯）
  idx: new Map(),            // v3.8.26 指数快照：sym(sh000001) -> { name, price, pct }
  idxTime: 0,
  /* v3.8.62 大盘指数清单：前 3 项是原有的三大市场指数，后 3 项是大中小盘宽基，
     凑成「沪 / 深 / 创业板 + 大盘 / 中盘 / 小盘」的市场结构全景。
     本数组是纯配置——请求侧靠 secid 拼批量 URL、渲染侧逐项生成胶囊，都是
     数组驱动，以后增删指数只改这里，不必动任何逻辑。
     secid 规则：沪市与中证系 1.xxxxxx，深市 0.xxxxxx，北交所 0.899xxx。 */
  INDEXES: [
    { sym: 'sh000001', name: '上证指数', secid: '1.000001' },
    { sym: 'sz399001', name: '深证成指', secid: '0.399001' },
    { sym: 'sz399006', name: '创业板指', secid: '0.399006' },
    { sym: 'sh000300', name: '沪深300',  secid: '1.000300' },
    { sym: 'sh000905', name: '中证500',  secid: '1.000905' },
    { sym: 'sh000852', name: '中证1000', secid: '1.000852' },
  ],
  prefix(market, code) {
    if (market === 'bj' || market === 'bse') return 'bj' + code;
    if (market === 'sz') return 'sz' + code;
    if (market === 'sh') return 'sh' + code;
    return (/^(6|5|9)/.test(code) ? 'sh' : 'sz') + code;
  },
  allCodes() {
    const mk = {}, codes = [];
    const add = (c, m) => { if (c && !mk[c]) { mk[c] = m; codes.push(c); } };
    S.trades.forEach(t => add(t.stock_code, t.market));
    S.watchlist.forEach(w => add(w.stock_code, w.market));
    return { codes, mk };
  },
  /* 东财实时快照（主源）：push2 ulist 批量，JSON 无需转码
     secid: 沪 1.xxxx / 深·北 0.xxxx；f2现价 f3涨跌% f12代码 f14名称
     f15最高 f16最低 f17今开 f18昨收；fltt=2 直接返回小数 */
  async fetchEast(syms) {
    const t0 = Date.now();
    try {
      const secids = syms.map(s => (s.startsWith('sh') ? '1.' : '0.') + s.slice(2)).join(',');
      const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=' + secids
        + '&fields=f2,f3,f12,f14,f15,f16,f17,f18&fltt=2';
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const out = new Map(); let qt = '';
      const num = v => { const n = parseFloat(v); return (v == null || v === '-' || isNaN(n)) ? null : n; };
      for (const it of ((j.data && j.data.diff) || [])) {
        const price = num(it.f2), code = it.f12 && String(it.f12);
        if (!code || !(price > 0)) continue;     // 停牌/无数据
        out.set(code, { price, name: it.f14 || code, pct: num(it.f3),
          prevClose: num(it.f18), open: num(it.f17), high: num(it.f15), low: num(it.f16) });
      }
      /* 东财快照不带时间戳字段，报价时间取本机当前时间（误差≈请求耗时） */
      if (out.size) qt = new Date().toTimeString().slice(0, 8);
      /* v3.9.13 审计：URL + 覆盖数；缺的票如实记「未返回」 */
      NetLog.push('quote', '东财 push2.eastmoney.com', out.size > 0, Date.now() - t0, `${out.size}/${syms.length} 只`,
        { url, resp: `${out.size}/${syms.length} 只` + (out.size < syms.length ? `（未返回 ${syms.length - out.size} 只）` : '') });
      return out.size ? { out, qt } : null;
    } catch (e) {
      NetLog.push('quote', '东财 push2.eastmoney.com', false, Date.now() - t0, e.message || String(e), { err: e.message || String(e) });
      return null;
    }
  },
  /* 腾讯行情（备选）：v_sz000001="..."，~ 分隔 */
  async fetchTx(syms) {
    const t0 = Date.now();
    try {
      const url = 'https://qt.gtimg.cn/q=' + syms.join(',');
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buf);
      const out = new Map(); let qt = '';
      const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
      for (const m of text.matchAll(/v_[a-z]{2}(\d{6})="([^"]*)"/g)) {
        const p = m[2].split('~');
        if (p.length < 40) continue;
        const price = parseFloat(p[3]);
        if (!(price > 0)) continue;
        out.set(m[1], { price, name: p[1], pct: parseFloat(p[32]),
          prevClose: num(p[4]), open: num(p[5]), high: num(p[33]), low: num(p[34]) });
        if (p[30] && p[31]) qt = p[30].replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') + ' ' + p[31];
      }
      NetLog.push('quote', '腾讯 qt.gtimg.cn', out.size > 0, Date.now() - t0, `${out.size}/${syms.length} 只`,
        { url, resp: `${out.size}/${syms.length} 只` + (out.size < syms.length ? `（未返回 ${syms.length - out.size} 只）` : '') });
      return out.size ? { out, qt } : null;
    } catch (e) {
      NetLog.push('quote', '腾讯 qt.gtimg.cn', false, Date.now() - t0, e.message || String(e), { err: e.message || String(e) });
      return null;
    }
  },
  /* v3.8.26 指数快照：东财 ulist 主源（f12代码+f13市场避免与个股代码撞号）→ 腾讯备选
     v3.8.62 两处调整：① sym 改为按 secid 精确映射，不再用 f13 猜前缀——原写法
     `(it.f13 === 1 ? 'sh' : 'sz')` 会把北交所指数（如北证50，f13=0 且返回 899050）
     误判成 sz899050；② 主源缺项时用腾讯补齐，见下方调用处。 */
  async fetchIdx() {
    const t0 = Date.now();
    /* secid -> sym 反查表：东财返回的 f13 + f12 拼回 secid 后精确取回清单里声明的 sym，
       这样 sh / sz / bj 三种前缀都由清单本身说了算，不依赖任何猜测规则 */
    const symBySecid = new Map(this.INDEXES.map(i => [i.secid, i.sym]));
    const tryEast = async () => {
      const secids = this.INDEXES.map(i => i.secid).join(',');
      /* v3.8.69 补 f4（涨跌额）：手机端「每行一枚胶囊」有大量余量，用户要求把涨跌
         的具体数值也显示出来（原来只有百分比）。f4 = 涨跌额，实测与腾讯 p[31] 一致 */
      const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=' + secids
        + '&fields=f2,f3,f4,f12,f13,f14&fltt=2';
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const out = new Map();
      for (const it of ((j.data && j.data.diff) || [])) {
        const price = parseFloat(it.f2), code = it.f12 && String(it.f12);
        if (!code || !(price > 0)) continue;
        const sym = symBySecid.get(it.f13 + '.' + code)      // 精确匹配（含 bj 前缀）
          || ((it.f13 === 1 ? 'sh' : 'sz') + code);          // 兜底：清单之外的意外返回
        out.set(sym, { name: it.f14 || code, price, pct: parseFloat(it.f3), chg: parseFloat(it.f4) });
      }
      return out;
    };
    const tryTx = async () => {
      const res = await fetch('https://qt.gtimg.cn/q=' + this.INDEXES.map(i => i.sym).join(','));
      const buf = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buf);
      const out = new Map();
      /* v3.8.62 正则补 bj：北交所指数的腾讯代码是 bj899050 这种形式，原 (sh|sz) 会整条漏掉 */
      for (const m of text.matchAll(/v_(sh|sz|bj)(\d{6})="([^"]*)"/g)) {
        const p = m[3].split('~');
        const price = parseFloat(p[3]);
        /* v3.8.69 p[31] = 涨跌额（已带符号），与东财 f4 同口径 */
        if (price > 0) out.set(m[1] + m[2], { name: p[1], price, pct: parseFloat(p[32]), chg: parseFloat(p[31]) });
      }
      return out;
    };
    let out = null;
    if (Date.now() >= this.eastDeadUntil) {
      /* v3.9.13 审计：东财指数快照带 URL */
      const idxUrl = 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=' + this.INDEXES.map(i => i.secid).join(',') + '&fields=f2,f3,f4,f12,f13,f14&fltt=2';
      try { out = await tryEast(); NetLog.push('quote', '东财 指数快照', out.size > 0, Date.now() - t0, `${out.size}/${this.INDEXES.length} 个`, { url: idxUrl, resp: `${out.size}/${this.INDEXES.length} 个` }); }
      catch (e) { NetLog.push('quote', '东财 指数快照', false, Date.now() - t0, e.message || String(e), { url: idxUrl, err: e.message || String(e) }); }
    }
    /* v3.8.62 从「主源全失败才切备源」改成「只要不满员就补齐」：
       原判据 `!out.size` 在指数只有 3 个时够用，扩到 6 个后就不牢靠了——
       东财返回 5/6 也算「非空成功」，缺的那一枚会永远不显示，且不报错、不留痕。
       现在只要有缺项就拉腾讯补缺；已拿到的项不覆盖（腾讯仅补空位，不夺主源口径）。 */
    if (!out || out.size < this.INDEXES.length) {
      const t1 = Date.now();
      try {
        const tx = await tryTx();
        if (tx && tx.size) {
          if (!out) out = new Map();                 // 主源全失败：整体采用腾讯
          let filled = 0;
          for (const [k, v] of tx) if (!out.has(k)) { out.set(k, v); filled++; }
          NetLog.push('quote', '腾讯 指数快照', true, Date.now() - t1,
            filled ? `补齐 ${filled} 个（腾讯共返回 ${tx.size} 个）` : '主源已完整，无需补齐',
            { url: 'https://qt.gtimg.cn/q=' + this.INDEXES.map(i => i.sym).join(','), resp: `腾讯返回 ${tx.size} 个，补齐 ${filled} 个` });
        } else {
          NetLog.push('quote', '腾讯 指数快照', false, Date.now() - t1, `0/${this.INDEXES.length} 个（未获取到）`,
            { url: 'https://qt.gtimg.cn/q=' + this.INDEXES.map(i => i.sym).join(','), err: '未获取到' });
        }
      } catch (e) { NetLog.push('quote', '腾讯 指数快照', false, Date.now() - t1, e.message || String(e), { err: e.message || String(e) }); }
    }
    if (out && out.size) { this.idx = out; this.idxTime = Date.now(); }
  },
  async refresh(force = false) {
    const { codes, mk } = this.allCodes();
    if (this.pending) return this.pending;
    /* v3.8.49 指数与个股解耦判定：
       以前 `if (!codes.length) return` 会直接退出，指数只在「有自选/持仓」时顺带拉一次，
       于是新账号（空账户）登录后大盘指数一条都不显示。现在两条链路各自判新鲜度。 */
    const qFresh = codes.length > 0 && Date.now() - this.fetchedAt < this.ttl
      && codes.every(c => this.map.has(c));
    const iFresh = this.idx.size > 0 && Date.now() - this.idxTime < this.ttl;
    if (!force && qFresh && iFresh) return this.map;
    this.pending = (async () => {
      const merged = new Map(); let qt = ''; let used = [];
      for (let i = 0; i < codes.length; i += 50) {
        const batch = codes.slice(i, i + 50);
        const syms = batch.map(c => this.prefix(mk[c], c));
        let got = null;
        /* 主源东财（连续失败熔断期跳过，直接走腾讯） */
        if (Date.now() >= this.eastDeadUntil) {
          got = await this.fetchEast(syms);
          if (got) { this.eastFailStreak = 0; used.push('east'); }
          else {
            this.eastFailStreak++;
            if (this.eastFailStreak >= 3) {
              this.eastDeadUntil = Date.now() + 10 * 60 * 1000;
              NetLog.push('quote', '东财熔断→切腾讯', true, 0, `连续失败 ${this.eastFailStreak} 次，10 分钟后重试东财`);
            }
          }
        }
        /* 备选腾讯 */
        if (!got) {
          got = await this.fetchTx(syms);
          if (got) used.push('tx');
        }
        if (got) {
          for (const [k, v] of got.out) merged.set(k, v);
          if (got.qt) qt = got.qt;
        }
      }
      if (merged.size) {
        this.map = merged;
        this.fetchedAt = Date.now();
        if (qt) this.quoteTime = qt;
      }
      if (force || !iFresh) await this.fetchIdx();   // v3.8.26 指数随行情一并刷新 / v3.8.49 空账户也拉
      this.pending = null;
      return merged;
    })();
    return this.pending;
  },
  get(code) { return this.map.get(code) || null; }
};
/* 拉一次行情并刷新相关页面（登录后 / 手动刷新时调用） */
async function refreshQuotes(force = false) {
  /* v3.9.13 审计：这一轮行情请求标上触发来源（含后台切回前台自动强刷） */
  return NetLog.withCtx('总览/行情·刷新' + (force ? '(强刷)' : ''), async () => {
    await NetQuote.refresh(force);
    renderAll();
  });
}
/* v3.8.23 页面从后台切回前台时自动强刷行情（数据不实时补偿） */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && typeof S !== 'undefined' && S.token) refreshQuotes(true).catch(() => { /* */ });
});

/* ============================================================
   存储适配层
   ============================================================ */
async function rpc(fn, params) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${RPC_BASE}/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wb-webapp-access-key': ACCESS_KEY },
      body: JSON.stringify(params || {})
    });
    if (r.status === 404 || r.status >= 500) throw new Error('服务不可用(' + r.status + ')');
    const j = await r.json();
    /* v3.9.13 审计：RPC 记参数（脱敏 p_token）与返回；业务失败如实记 FAIL */
    const dbg = Object.assign({}, params || {}); delete dbg.p_token;
    NetLog.push('rpc', fn, !!(j && j.ok), Date.now() - t0, (j && !j.ok) ? (j.msg || '') : '',
      { url: RPC_BASE + '/' + fn, req: JSON.stringify(dbg).slice(0, 280), resp: (j && j.ok) ? ('ok' + (Array.isArray(j.data) ? ` · ${j.data.length} 行` : '')) : '', err: (j && !j.ok) ? (j.msg || '') : '' });
    return j;
  } catch (e) {
    NetLog.push('rpc', fn, false, Date.now() - t0, e.message || String(e), { url: RPC_BASE + '/' + fn, err: e.message || String(e) });
    throw e;
  }
}

const cloudStore = {
  mode: 'cloud',
  async query(table) {
    const r = await rpc('app_query', { p_token: S.token, p_table: table });
    if (!r.ok) { if (/会话已过期|未登录/.test(r.msg || '')) doLogout(true); throw new Error(r.msg || '查询失败'); }
    return r.data || [];
  },
  async insert(table, row) {
    const r = await rpc('app_insert', { p_token: S.token, p_table: table, p_data: row });
    if (!r.ok) throw new Error(r.msg || '写入失败');
    return r.data;
  },
  async update(table, id, patch) {
    const r = await rpc('app_update', { p_token: S.token, p_table: table, p_id: id, p_data: patch });
    if (!r.ok) throw new Error(r.msg || '更新失败');
    return r.data;
  },
  async remove(table, id) {
    const r = await rpc('app_delete', { p_token: S.token, p_table: table, p_id: id });
    if (!r.ok) throw new Error(r.msg || '删除失败');
  },
  async bulkInsert(table, rows) {
    const r = await rpc('app_bulk_insert', { p_token: S.token, p_table: table, p_rows: rows });
    return r;
  },
  async clearData(tables) {
    const r = await rpc('app_bulk_delete', { p_token: S.token, p_tables: tables });
    if (!r.ok) throw new Error(r.msg || '清空失败');
  },
  async log(action, summary) {
    try { await this.insert('op_logs', { action, summary }); } catch (e) { /* 日志失败不阻塞 */ }
  }
};

const localStore = {
  mode: 'local',
  _read(table) { try { return JSON.parse(localStorage.getItem('sj_' + table) || '[]'); } catch (e) { return []; } },
  _write(table, rows) { localStorage.setItem('sj_' + table, JSON.stringify(rows)); },
  _nextId(rows) { return rows.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1; },
  async query(table) { return this._read(table).sort((a, b) => b.id - a.id); },
  async insert(table, row) {
    const rows = this._read(table);
    const rec = Object.assign({ id: this._nextId(rows), created_at: new Date().toISOString() }, row);
    rows.push(rec); this._write(table, rows);
    return rec;
  },
  async update(table, id, patch) {
    const rows = this._read(table);
    const i = rows.findIndex(r => r.id === id);
    if (i < 0) throw new Error('记录不存在');
    rows[i] = Object.assign({}, rows[i], patch);
    this._write(table, rows);
    return rows[i];
  },
  async remove(table, id) {
    this._write(table, this._read(table).filter(r => r.id !== id));
  },
  async bulkInsert(table, newRows) {
    const rows = this._read(table);
    let n = this._nextId(rows);
    for (const row of newRows) rows.push(Object.assign({ id: n++, created_at: new Date().toISOString() }, row));
    this._write(table, rows);
    return { ok: true, count: newRows.length };
  },
  async clearData(tables) {
    for (const t of tables) { if (TABLES.includes(t)) this._write(t, []); }
  },
  async log(action, summary) {
    try { await this.insert('op_logs', { action, summary }); } catch (e) { /* */ }
  }
};
let store = null;

/* ============================================================
   AI 模型管理（云端模型目录 + 自定义 OpenAI 兼容模型）
   ============================================================ */
const ModelMgr = {
  platform: [],   // 云端模型目录
  custom: [],     // 自定义模型 {key,name,baseUrl,model,apiKey}
  cur: null,      // 当前模型
  loaded: false,
  loadCache() { try { this.platform = JSON.parse(localStorage.getItem('sj_model_list') || '[]'); } catch (e) { /* */ } },
  loadCustom() { try { this.custom = JSON.parse(localStorage.getItem('sj_custom_models') || '[]'); } catch (e) { this.custom = []; } },
  saveCustom() {
    localStorage.setItem('sj_custom_models', JSON.stringify(this.custom));
    /* 同步到云端：其他客户端也能解析「自定义模型」选择（含 apiKey，存于用户自己的 settings） */
    if (S.mode === 'cloud') saveSetting('model_custom', JSON.stringify(this.custom)).catch(() => {});
  },
  async reload() {
    if (!cloudLlm) throw new Error('云端模型服务不可用（本地模式）');
    const llm = cloudLlm.llm || cloudLlm;   // SDK 命名空间：cloud.llm.models / cloud.llm.chat
    const listed = (await llm.models.list()) || [];
    this.platform = listed.filter(m => m.disabled !== true);
    this.platform = listed.filter(m => m.disabled !== true);
    this.loaded = true;
    localStorage.setItem('sj_model_list', JSON.stringify(this.platform));
    this.loadCur(); this.render();
    return this.platform;
  },
  all() {
    return [...this.platform.map(m => Object.assign({ platform: true }, m)),
            ...this.custom.map(c => Object.assign({ custom: true }, c))];
  },
  modelId(m) { return m.custom ? 'c:' + m.key : 'p:' + m.id; },
  label(m) {
    if (!m) return '（未选择模型）';
    if (m.custom) return `${m.name}·${m.model}（自定义）`;
    const c = this.creditsText(m);
    return (m.name || m.id) + (m.vendor ? ' · ' + m.vendor : '') + (c ? '（费率 ' + c + '）' : '');
  },
  /* 积分费率："x0.08 credits" / "x0.05" → "0.08x" 风格展示；0 = 免费 */
  creditsText(m) {
    if (!m || m.custom || !m.credits) return '';
    const s = String(m.credits).replace(/\s*credits?$/i, '').replace(/^x/i, '').trim();
    if (!s || isNaN(parseFloat(s))) return '';
    return (parseFloat(s) === 0 ? '免费' : s + 'x');
  },
  /* 当前模型以「ID 字符串」持久化（与 trade-manager 一致），目录未加载时绝不降级覆盖，
     避免刷新后因目录缓存为空/过期把用户选择冲掉。 */
  loadCur() {
    let saved = localStorage.getItem('sj_model_cur') || '';
    if (saved.startsWith('{')) {
      // 旧版存的是完整对象 → 迁移为 ID
      try { const o = JSON.parse(saved); saved = o.custom ? 'c:' + o.key : (o.id ? 'p:' + o.id : ''); } catch (e) { saved = ''; }
      if (saved) localStorage.setItem('sj_model_cur', saved);
    }
    this.savedId = saved || null;
    const all = this.all();
    const found = saved ? all.find(m => this.modelId(m) === saved) : null;
    if (found) {
      this.cur = found;
    } else if (saved && !this.loaded) {
      this.cur = null;          // 目录还没就绪：保留 savedId，等 reload 后再解析
    } else {
      /* v3.15.2 没有保存选择时：优先选第一个「自定义模型」（用户自己的 Key），否则第一个可用 */
      this.cur = this.custom[0] || all[0] || null;
      if (this.cur) { this.savedId = this.modelId(this.cur); localStorage.setItem('sj_model_cur', this.savedId); }
    }
  },
  setCur(idStr) {
    const m = this.all().find(x => this.modelId(x) === idStr) || null;
    if (m) {
      this.cur = m; this.savedId = idStr;
      localStorage.setItem('sj_model_cur', idStr);
      this.persistCloud();
    }
    this.render();
  },
  /* 云端 settings 为权威（同 trade-manager 的 app_config 机制），写失败不阻塞 UI */
  async persistCloud() {
    if (S.mode !== 'cloud' || !this.cur) return;
    try { await saveSetting('model_config', JSON.stringify({ cur: this.modelId(this.cur) })); } catch (e) { /* */ }
  },
  /* 登录后调用：云端有配置时以云端为准（跨设备一致），本地仅作缓存 */
  applyCloudConfig() {
    /* 合并云端自定义模型：本地优先，按 key 去重 —— 否则其他客户端解析不了 c: 开头的当前模型 */
    const rawC = S.settings && S.settings['model_custom'];
    if (rawC) {
      try {
        const cloud = JSON.parse(rawC);
        if (Array.isArray(cloud)) {
          const map = new Map(cloud.map(c => [c.key, c]));
          for (const c of this.custom) map.set(c.key, c);
          this.custom = [...map.values()];
          localStorage.setItem('sj_custom_models', JSON.stringify(this.custom));
        }
      } catch (e) { /* */ }
    }
    const raw = S.settings && S.settings['model_config'];
    if (!raw) return;
    try {
      const v = JSON.parse(raw);
      if (v && v.cur) {
        localStorage.setItem('sj_model_cur', v.cur);
        this.savedId = v.cur;
      }
    } catch (e) { /* */ }
  },
  /* 下拉短标签：不带费率后缀（费率只在费率列表展示） */
  shortLabel(m) {
    if (!m) return '（未选择模型）';
    if (m.custom) return `${m.name}·${m.model}（自定义）`;
    return m.name || m.id;   // 不拼 vendor/费率：vendor 是接口返回的单字母缩写，无信息量
  },
  render() {
    const all = this.all();
    let inner;
    if (!all.length) {
      inner = '<option value="">（暂无可选模型）</option>';
    } else {
      const grp = (list, title) => list.length
        ? `<optgroup label="${title}">` + list.map(m => {
            const c = this.creditsText(m);   // 下拉选项带费率数值便于挑选；顶栏徽章不带
            const fee = m.custom ? '' : (c ? `（${c}）` : '');
            return `<option value="${esc(this.modelId(m))}">${esc(this.shortLabel(m) + fee)}</option>`;
          }).join('') + '</optgroup>'
        : '';
      inner = grp(this.platform.map(m => Object.assign({ platform: true }, m)), 'WorkBuddy 平台模型（消耗平台积分）')
            + grp(this.custom.map(c => Object.assign({ custom: true }, c)), '自定义模型（自己的 API Key）');
      /* v3.15.2 未选择时放一个占位项，别让浏览器默认选中第一项造成「看起来选了」 */
      if (!this.cur) inner = '<option value="" selected>— 请选择模型 —</option>' + inner;
    }
    for (const selId of ['modelCurSel']) {
      const sel = $(selId); if (!sel) continue;
      sel.innerHTML = inner;
      sel.value = this.cur ? this.modelId(this.cur) : '';
      sel.disabled = !all.length;
    }
    /* 顶栏：只读展示当前模型，未配置时提示（v3.15.2 点击直达 设置 → 模型） */
    const badge = $('modelBadge');
    if (badge) {
      badge.textContent = this.cur ? this.shortLabel(this.cur) : '未配置';
      badge.style.cursor = 'pointer';
      badge.onclick = () => { switchView('me'); switchSetPane('model'); };
    }
    const st = $('modelStatus');
    if (st) st.textContent = this.loaded
      ? `云端模型 ${this.platform.length} 个、自定义 ${this.custom.length} 个。模型用于「记一笔」AI 解析，云端模型免密钥直接调用。`
      : '模型用于「记一笔」自然语言解析，请先刷新模型列表。';
    const list = $('customModelList');
    if (list) list.innerHTML = this.custom.length ? this.custom.map(c => `
      <div class="mini-item"><div class="mini-main">
        <div class="mini-title">${esc(c.name)}</div>
        <div class="mini-sub">${esc(c.model)} · ${esc(c.baseUrl)}</div>
      </div><div class="mini-right"><button class="icon-btn del cm-del" data-key="${esc(c.key)}" type="button">删除</button></div></div>`).join('')
      : '<div class="empty">暂无自定义模型</div>';
  }
};

/* ---------- LLM 调用（流式，返回完整文本） ---------- */
async function customLlmStream(m, messages, opts) {
  let url = m.baseUrl.replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
  const onDelta = (opts && opts.onDelta) || null;
  const t0 = Date.now();
  let text = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + m.apiKey },
      body: JSON.stringify({ model: m.model, messages, stream: true })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('自定义模型请求失败 HTTP ' + res.status + (t ? '：' + t.slice(0, 200) : ''));
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (d && d.content) { text += d.content; if (onDelta) try { onDelta(d.content); } catch (e) { /* */ } }
        } catch (e) { /* 忽略无法解析的行 */ }
      }
    }
    NetLog.push('llm', '自定义模型 ' + m.model, true, Date.now() - t0, `${text.length} 字`,
      { url: m.url || '', req: `${(messages || []).length} 条消息`, resp: `返回 ${text.length} 字` });
    return text;
  } catch (e) {
    NetLog.push('llm', '自定义模型 ' + m.model, false, Date.now() - t0, e.message || String(e), { url: m.url || '', err: e.message || String(e) });
    throw e;
  }
}
async function llmComplete(messages, opts) {
  const m = ModelMgr.cur;
  if (!m) throw new Error('尚未选择模型，请到「设置 → AI 模型」选择');
  if (m.custom) return customLlmStream(m, messages, opts);
  if (!cloudLlm) throw new Error('云端模型服务不可用');
  const llm = cloudLlm.llm || cloudLlm;   // SDK 命名空间：cloud.llm.chat
  const t0 = Date.now();
  let text = '';
  try {
    const params = { model: m.id, messages, stream: true };
    for await (const chunk of llm.chat.completions.create(params)) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (d && d.content) { text += d.content; if (opts && opts.onDelta) try { opts.onDelta(d.content); } catch (e) { /* */ } }
    }
    NetLog.push('llm', '云端模型 ' + m.id, true, Date.now() - t0, `${text.length} 字`,
      { req: `${(messages || []).length} 条消息`, resp: `返回 ${text.length} 字` });
    return text;
  } catch (e) {
    NetLog.push('llm', '云端模型 ' + m.id, false, Date.now() - t0, e.message || String(e), { err: e.message || String(e) });
    throw e;
  }
}

/* ============================================================
   交易解析：AI 优先（结构化 JSON），本地规则兜底
   ============================================================ */
function nowStr() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} 周${'日一二三四五六'[d.getDay()]}`;
}
function tradeParseSys() {
  return `你是证券交易记录解析器，把用户描述的交易操作解析为 JSON，只输出 JSON。
当前时间：${nowStr()}（"今天/现在"以此为准）。
充分发挥你的证券知识，完成以下解析：
1. 逐笔拆分用户描述中的每笔交易，准确判断买卖方向（action: "buy" 或 "sell"）。
2. quantity 输出股数：A股 1手=100股（"5手"=500股）；price 输出每股成交价。两者都是纯数字，不要千分位逗号、不要带"股/手/元"等单位，不要把成交金额填进来。
3. 根据股票名称给出股票代码：A股为 6 位数字。**必须逐位核对代码，不确定就填空字符串**——
   相近代码极易混淆（如 603395「红四方」与 603393「新天然气」、600xxx 与 603xxx）；
   宁可留空也不要写一个不确定的代码，本地会用股票名称自动校正。
   但 stock_name 必填，且一律用交易所简称（如「中兴通讯」），不要写工商全称。
4. trade_date 输出 "YYYY-MM-DD HH:MM:SS"，从描述推断成交时间：含具体时间（如"14:23""9月25日上午10点半"）→ 解析成对应时间；只说"上午/早上"且没给时刻 → 该日 08:00:00；只说"下午/午后" → 该日 16:00:00；完全没提 → 用上面的当前时间。
5. 无法确定的字段置 null，不要编造。
输出格式：
{"trades":[{"stock_code":"","stock_name":"","action":"buy","quantity":0,"price":0,"trade_date":"YYYY-MM-DD HH:MM:SS"}],"summary":"一句话总结本次记录"}`;
}
function extractJson(text) {
  const t = String(text || '').replace(/```json|```/g, '').trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('模型未返回 JSON');
  return JSON.parse(t.slice(i, j + 1));
}
function cleanNum(v) {
  const m = String(v ?? '').replace(/[,，\s]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? m[0] : '';
}
/* 解析结果 → 待确认列表（统一结构 {type,code,name,market,qty,price,time}） */
function normalizeParsed(j) {
  const list = (j.trades || []).map(t => {
    if (!t || (!t.stock_code && !t.stock_name) || !t.action) return null;
    const qty = Number(cleanNum(t.quantity)), price = Number(cleanNum(t.price));
    if (!(qty > 0) || !(price > 0)) return null;
    const code = String(t.stock_code || '').trim();
    let time = nowLocalInput();
    if (t.trade_date && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(String(t.trade_date))) {
      const d = new Date(String(t.trade_date).replace(' ', 'T'));
      if (!isNaN(d)) time = toLocalInput(d);   // 转本地时间（此前 toISOString 是 UTC，差 8 小时）
    }
    return { type: t.action === 'sell' ? 'sell' : 'buy', code, name: String(t.stock_name || '').trim(), market: inferMarket(code), qty, price, time };
  }).filter(Boolean);
  if (!list.length) throw new Error('未解析出有效交易（需要：方向、数量、价格、股票）');
  return list.map(reconcileParsedCode);
}
/* ---------- v3.8.60 AI 解析结果以本地字典校正代码 ----------
   问题：prompt 允许模型「凭证券知识」直接给代码，而模型会把相近代码记混
   （实测「红四方」被解析成 603393，603393 实为「新天然气」），原实现原样采信、
   静默入库 —— 名称与代码张冠李戴，还会经 learnFromState() 污染整本字典。
   做法：拿到 code + name 后回查字典做一致性校正，分三种情形：
     · 代码有效但名称不符 → 以名称为准，用名称反查正确代码（本例即此，603393→603395）
     · 代码有效且名称相符 → 保留
     · 代码无效/未填但有名称 → 用名称反查补全
   校正结果挂在 `_fix` 上，由待确认列表提示用户「已自动纠正」，不静默改写。 */
function reconcileParsedCode(t) {
  if (!t) return t;
  if (!StockDict.ready) return t;            // 字典未就绪：不猜，原样返回
  const name = String(t.name || '').trim();
  let code = String(t.code || '').trim();
  let fix = null;
  if (!name) return t;                       // 没名称无从校正，原样返回
  const byCode = code ? StockDict.d[code] : null;
  if (code && byCode && byCode.name === name) return t;   // 代码与名称相符
  /* 名称反查（精确名优先，其次 search 首命中） */
  let hit = null;
  for (const c in StockDict.d) { if (StockDict.d[c].name === name) { hit = c; break; } }
  if (!hit) { const s = StockDict.search(name, 1); hit = s.length ? s[0].code : null; }
  if (hit && hit !== code) {
    fix = { from: code || '(空)', to: hit, reason: byCode ? `代码 ${code} 实为「${byCode.name}」` : '代码缺失或有误' };
    code = hit;
  } else if (!hit && code && !StockDict.d[code]) {
    fix = { from: code, to: code, reason: '该代码不在股票字典中，请确认', keep: true };
  }
  return Object.assign({}, t, { code, market: inferMarket(code), _fix: fix });
}
/* Date → 本地 "YYYY-MM-DDTHH:mm"（datetime-local 口径） */
function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function resToList(res) {
  return { type: res.type, code: res.code || '', name: res.name || '', market: res.market || inferMarket(res.code || ''), qty: res.qty, price: res.price, time: nowLocalInput() };
}

/* 本地规则解析（保留：AI 不可用时的兜底） */
function parseTradeText(raw) {
  const t = (raw || '').trim();
  if (!t) return null;
  const res = {};
  if (/买|购入|建仓|加仓/.test(t)) res.type = 'buy';
  else if (/卖|出掉|抛|减仓|清仓/.test(t)) res.type = 'sell';

  let m = t.match(/(\d+(?:\.\d+)?)\s*手/);
  if (m) res.qty = Math.round(parseFloat(m[1]) * 100);
  if (!res.qty) {
    m = t.match(/(\d+(?:\.\d+)?)\s*股/);
    if (m) res.qty = Math.round(parseFloat(m[1]));
  }

  m = t.match(/(?:单价|价格|价位|成本)\s*(\d+(?:\.\d+)?)/)
    || t.match(/@\s*(\d+(?:\.\d+)?)/)
    || t.match(/(\d+(?:\.\d+)?)\s*(?:块|元)/)
    || t.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(?:买入|卖出|买|卖)/)
    || t.match(/(?:买入|卖出|买|卖)(?:价)?\s*(\d+(?:\.\d+)?)/);
  if (m) res.price = parseFloat(m[1]);

  m = t.match(/\b([0-9]{6})\b/) || t.match(/\b([0-9]{5})\b/);
  if (m) { res.code = m[1]; res.market = inferMarket(res.code); }

  const names = (t.match(/[\u4e00-\u9fa5]{2,8}/g) || [])
    .filter(s => !/[买卖股手块元单价价格成本现价]/.test(s));
  if (names.length) res.name = names.sort((a, b) => b.length - a.length)[0];

  if (!res.type || res.price == null || !res.qty || (!res.code && !res.name)) return null;
  return res;
}

/* ---------- 解析入口：AI 优先，失败回落本地规则 ---------- */
let pendingTrades = [];
async function aiParseEntry(inputId, hintId) {
  const raw = $(inputId).value.trim();
  if (!raw) return;
  setManualOpen(false);   // 解析时收起手动录入区
  const el = $(hintId);
  el.hidden = false;
  el.className = 'quick-hint';
  const model = ModelMgr.cur;
  const aiReady = model && (model.custom || cloudLlm);
  if (!aiReady) {
    const res = parseTradeText(raw);
    if (!res) {
      el.className = 'quick-hint warn';
      el.innerHTML = esc(model ? '本地规则未能识别出交易信息。' : '尚未选择模型（设置 → AI 模型），本地规则也未能识别。')
        + '请重新输入，或 <button class="link-btn p-open-manual" type="button">手动录入</button>';
      return;
    }
    renderPending(hintId, inputId, [resToList(res)], '（本地规则识别，请核对）');
    return;
  }
  el.innerHTML = `AI 解析中（${esc(ModelMgr.shortLabel(model))}）…`;
  try {
    const text = await llmComplete([{ role: 'system', content: tradeParseSys() }, { role: 'user', content: raw }]);
    const list = normalizeParsed(extractJson(text));
    if (!list.length) {
      el.className = 'quick-hint warn';
      el.innerHTML = '未能解析出交易信息，请换个说法重新输入，或 <button class="link-btn p-open-manual" type="button">手动录入</button>';
      return;
    }
    renderPending(hintId, inputId, list, '');
  } catch (e) {
    const res = parseTradeText(raw);
    if (res) {
      renderPending(hintId, inputId, [resToList(res)], '');
      el.insertAdjacentHTML('afterbegin', `<div class="p-warn">AI 解析失败（${esc(e.message || '未知错误')}），以下为本地规则结果：</div>`);
    } else {
      el.className = 'quick-hint warn';
      el.innerHTML = 'AI 解析失败：' + esc(e.message || '未知错误') + '。请重新输入，或 <button class="link-btn p-open-manual" type="button">手动录入</button>';
    }
  }
}
function renderPending(hintId, inputId, list, summary) {
  pendingTrades = list;
  const el = $(hintId);
  el.className = 'quick-hint';
  el.innerHTML = (summary ? `<div class="p-sum">${esc(summary)}</div>` : '')
    + (list.length > 1 ? `<div class="p-saveall-row"><button class="btn primary sm p-saveall-btn" data-close="0" type="button">全部保存</button><button class="btn primary sm p-saveall-btn" data-close="1" type="button">全部保存并关闭（${list.length} 笔）</button></div>` : '')
    + `<div class="pending-list">` + list.map((t, i) => `
      <div class="p-item">
        <span class="tag ${t.type}">${t.type === 'buy' ? '买入' : '卖出'}</span>
        <span class="p-desc">${esc(t.name || t.code)} ${t.qty} 股 @${esc(t.price)} · ${esc(String(t.time).replace('T', ' ').slice(0, 16))}${t.code ? ` <span class="p-code">${esc(t.code)}</span>` : ''}</span>
        ${t._fix ? `<span class="p-fix${t._fix.keep ? ' warn' : ''}">${t._fix.keep ? esc(t._fix.reason) : `已纠正代码 ${esc(t._fix.from)} → ${esc(t._fix.to)}（${esc(t._fix.reason)}）`}</span>` : ''}
        <span class="p-btns">
          <button class="btn primary sm p-save-btn" data-hint="${hintId}" data-input="${inputId}" data-i="${i}" data-close="0" type="button">保存</button>
          ${list.length === 1 ? `<button class="btn primary sm p-save-btn" data-hint="${hintId}" data-input="${inputId}" data-i="${i}" data-close="1" type="button">保存并关闭</button>` : ''}
          <button class="btn ghost sm pfill-btn" data-hint="${hintId}" data-input="${inputId}" data-i="${i}" type="button">改</button>
        </span>
      </div>`).join('') + `</div>`;
}

/* ============================================================
   启动与认证
   ============================================================ */
async function boot() {
  bindEvents();
  /* 恢复上次所在页面 */
  try {
    const last = localStorage.getItem('sj_view');
    if (last && $('view-' + last)) switchView(last);
  } catch (e) { /* */ }
  $('tfTime').value = nowLocalInput();
  try {
    const probe = await Promise.race([
      rpc('app_has_users'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
    ]);
    store = cloudStore; S.mode = 'cloud';
    if (probe && probe.ok && !probe.data) {
      // 首次使用：显示初始化
      $('tabInit').hidden = false;
      $('tabInit').click();
      showAuth(); return;
    }
    // 已有会话则直接进入
    const saved = JSON.parse(localStorage.getItem('sj_user') || 'null');
    if (saved && localStorage.getItem('sj_token')) {
      S.token = localStorage.getItem('sj_token'); S.user = saved;
      try { await enterApp(); return; } catch (e) { /* 会话失效走登录 */ }
    }
    showAuth();
  } catch (e) {
    // 云端不可达 → 本地模式
    store = localStore; S.mode = 'local';
    enterApp({ username: '本地用户', role: null, local: true });
  }
}
function showAuth() {
  $('authView').hidden = false;
  $('appView').hidden = true;
  // 页签条仅在有"初始化"场景（尚无账号）时显示，避免与登录按钮形成两个"登录"
  $('authTabs').hidden = $('tabInit').hidden;
}

/* ============================================================
   v3.8.57 登录页键盘防遮挡——纯 CSS 静态方案（零 JS）
   ------------------------------------------------------------
   历史：
     v3.8.54 监听 visualViewport + 每次聚焦重算可视高度 + 动态位移，
             把卡片顶到键盘之上。实测体验差——输用户名时卡片中途挪动、
             再点密码框又跳一次，用户反馈「不能简单点吗，进入时就偏上一点」。
   现方案：完全不绑事件、不做任何位移，登录卡仍是 flex 居中，
           只在 `.auth-wrap` 底部加空白（padding-bottom）把内容整体上抬，
           见 style.css（默认上移 20vh，矮屏分档到 26vh / 30vh）。
   为什么可行：flex `align-items:center` 的参照点是「上内距底 ~ 下内距顶」
           的中点，底部内距加厚 2X 就等于内容整体上移 X。
   为什么不位移：transform / scroll 类动态方案在输入框之间切换时会跳，
           且受滚动锚定干扰；纯静态布局全程恒定，实测 focus/blur 后
           卡片位置一个像素都不动。
   ============================================================ */

async function doLogin(username, password) {
  const r = await rpc('app_login', { p_username: username, p_password: password });
  if (!r.ok) throw new Error(r.msg || '登录失败');
  S.token = r.token;
  S.user = { username: r.username, role: r.role, must_change_pwd: r.must_change_pwd };
  localStorage.setItem('sj_token', r.token);
  localStorage.setItem('sj_user', JSON.stringify(S.user));
  if (r.must_change_pwd) {
    switchAuthForm('forcePwdForm');
    $('forcePwdHint').textContent = `账号 ${r.username} 为初始密码，请修改后再进入。`;
    showAuth(); return;
  }
  await enterApp();
}
async function doLogout(silent) {
  if (!silent && S.token) { try { await rpc('app_logout', { p_token: S.token }); } catch (e) { /* */ } }
  localStorage.removeItem('sj_token');
  localStorage.removeItem('sj_user');
  if (silent) { showAuth(); switchAuthForm('loginForm'); return; }
  location.reload();
}
async function enterApp(user) {
  if (user) S.user = user;
  $('authView').hidden = true;
  $('appView').hidden = false;
  /* v3.12.4 顶栏显示当前连接的后端地址（自托管=本机/域名；混合模式=填的地址；云端托管=WorkBuddy 云） */
  const bb = $('backendBadge');
  if (bb) {
    if (BACKEND_URL) { bb.textContent = '后端 ' + BACKEND_URL.replace(/^https?:\/\//, ''); bb.title = '当前连接的后端服务器：' + BACKEND_URL + '（设置 → 技能 → 后端服务器地址 可切换）'; }
    else if (location.hostname.endsWith('workbuddy.host')) { bb.textContent = 'WorkBuddy 云端'; bb.title = '数据存 WorkBuddy 云数据库；如需切换到自托管服务器，到 设置 → 技能 → 后端服务器地址 填地址'; }
    else { bb.textContent = '后端 ' + (location.host || '本机'); bb.title = '当前连接的后端服务器：' + location.host; }
  }
  if (S.mode === 'cloud') {
    $('modeBadge').textContent = '云端';
    $('modeBadge').classList.remove('local');
    $('userName').textContent = S.user.username;
    $('userRole').hidden = S.user.role !== 'admin';
    $('logoutBtn').hidden = false;
  } else {
    $('modeBadge').textContent = '本地';
    $('modeBadge').classList.add('local');
    $('userName').textContent = '本地模式';
    $('userRole').hidden = true;
    $('logoutBtn').hidden = true;
  }
  $('aboutStorage').textContent = S.mode === 'cloud'
    ? '数据存储：WorkBuddy 云数据库（按账号隔离，跨设备同步）'
    : '数据存储：浏览器 localStorage（仅本机，请定期导出备份）';
  await loadAll();
  /* 模型初始化：先同步云端配置 → 缓存渲染 → 后台刷新目录（云端为权威，同 trade-manager）
     v3.15.2 每一步独立容错 —— 此前 initCloudLlm 在自托管域名抛错会让整个模型初始化中断，
     徽章永远停在 HTML 默认的「未配置」（设置页里模型明明已添加/选中）。 */
  if (!cloudLlm) { try { cloudLlm = initCloudLlm(); } catch (e) { console.warn('[model] 云端 LLM 初始化失败（自托管部署属正常现象，自定义模型不受影响）'); } }
  ModelMgr.loadCache(); ModelMgr.loadCustom();
  try { ModelMgr.applyCloudConfig(); } catch (e) { console.warn('[model] 云端配置合并失败', e); }
  try { ModelMgr.loadCur(); } catch (e) { console.warn('[model] 当前模型恢复失败', e); }
  try { ModelMgr.render(); } catch (e) { console.warn('[model] 渲染失败', e); }
  /* v3.9.0 智能问答初始化：必须在 loadAll 之后 —— 它要读 S.trades / S.watchlist
     组织上下文。initQa 里绑事件只做一次（重复登录不能重复绑），
     qaBoot 拉云端历史，失败不影响应用其它部分。
     注意顺序：initQa → qaSyncSendState 会读 ModelMgr.cur 写底部提示文案，
     所以它必须排在 ModelMgr.loadCur() 之后。旧版把问答放在模型之前，
     导致首次进入即使配好模型，底部也一直显示「尚未选择模型…」（且没有
     任何后续时机再刷新这行字）。 */
  if (typeof initQa === 'function') {
    if (!initQa._bound) { try { initQa(); initQa._bound = true; } catch (e) { /* */ } }
    else { renderQaMessages(); renderQaHistory(); qaSyncSendState(); }
    if (typeof qaBoot === 'function') qaBoot().catch(() => { /* */ });
  }
  /* v3.10.1 K线库每日自动入库：进入应用后后台静默增量（开关在 设置→数据管理→K线库，
     仅当库已建立且缺最新交易日才拉，30 分钟节流；首次回补不自动跑）。失败不影响进入应用。 */
  try {
    if (typeof KLib !== 'undefined') KLib.autoSyncIfStale().then(r => {
      if (r && !r.skipped && r.fetched) toast('K线库已自动同步：' + r.n + ' 只 · 最新 ' + r.targetDate);
    }).catch(() => { /* */ });
  } catch (e) { /* */ }
  if (cloudLlm) {
    /* 目录是异步拉的，拉到后 cur 可能从 null 变成实模型（savedId 二次解析），
       所以 reload 完成后必须再同步一次问答区文案，否则提示会停在旧状态。 */
    ModelMgr.reload().then(() => {
      try { if (typeof qaSyncSendState === 'function') qaSyncSendState(); } catch (e) { /* */ }
    }).catch(e => {
      const st = $('modelStatus');
      if (st) st.textContent = '模型列表加载失败：' + (e.message || e);
    });
  }
  StockDict.init();
  renderAll();
  refreshQuotes().catch(() => { /* 行情失败页面显示未获取 */ });   // 网络行情到齐后再刷一遍
}
function switchAuthForm(id) {
  for (const f of ['loginForm', 'initForm', 'forcePwdForm']) $(f).hidden = f !== id;
  $('tabLogin').classList.toggle('active', id === 'loginForm');
  $('tabInit').classList.toggle('active', id === 'initForm');
}
function authMsg(text, ok) {
  const el = $('authMsg');
  el.hidden = false;
  el.textContent = text;
  el.className = 'auth-msg ' + (ok ? 'ok' : 'err');
}

/* ============================================================
   数据加载
   ============================================================ */
async function loadAll() {
  const [trades, watchlist, quotes, settings, opLogs] = await Promise.all([
    store.query('trades'), store.query('watchlist'), store.query('quotes'),
    store.query('settings'), store.query('op_logs')
  ]);
  S.trades = trades; S.watchlist = watchlist; S.quotes = quotes; S.opLogs = opLogs;
  S.settings = {}; S._settingRows = {};
  for (const s of settings) { S.settings[s.key] = s.value; S._settingRows[s.key] = s; }
  if (typeof syncGroupList === 'function') syncGroupList();
}

/* 设置项 upsert */
async function saveSetting(key, value) {
  const row = S._settingRows && S._settingRows[key];
  if (row) await store.update('settings', row.id, { value });
  else {
    const rec = await store.insert('settings', { key, value });
    S._settingRows = S._settingRows || {};
    S._settingRows[key] = rec;
  }
  S.settings[key] = value;
}

/* ============================================================
   渲染
   ============================================================ */
function renderAll() {
  renderToday();
  renderHoldings();
  renderTrades();
  renderWatch();
  renderMe();
  /* v3.8.10 分析中心下拉随数据加载刷新：修复启动即落在分析中心时选股框永远"加载中…" */
  if (typeof renderAnalysisSelect === 'function') { try { renderAnalysisSelect(); } catch (e) { /* */ } }
  if (typeof renderBtOptions === 'function') { try { renderBtOptions(); } catch (e) { /* */ } }
}

/* ---------- 今日 ---------- */
/* 今日已实现盈亏：来自各持仓 timeline 的卖出事件（总览「持仓快照」与持仓页共用） */
function todayRealizedPnl() {
  const todayStr = new Date().toDateString();
  let s = 0;
  for (const h of computeHoldings()) {
    for (const ev of h.timeline) {
      if (ev.realized != null && new Date(ev.t.transaction_time).toDateString() === todayStr) s += ev.realized;
    }
  }
  return s;
}
function renderToday() {
  /* v3.8.46 总览页收敛为「大盘指数 / 持仓信息 / 自选列表」三个数据卡，
     原「快捷记一笔」「近期操作」两张卡已下线（记一笔入口在持仓信息卡与交易记录页，
     近期操作去交易记录页看）。这里只剩演示数据提示。 */
  const sh = $('seedHint');
  if (sh) sh.hidden = S.trades.length > 0;
}

/* ---------- 持仓 ---------- */
const WB_COLORS = ['#3468D6', '#D93A2B', '#0E9463', '#B7791F', '#7C5CBF', '#2E9AA8', '#C2557A', '#6B7280'];

/* ============================================================
   v3.8.34 持仓 / 自选模块的「挂载点」配置
   渲染逻辑与 DOM 挂载点解耦，只是 DOM 挂载点不同。
   —— v3.8.37 持仓页 / 自选页已下线，仅保留总览页挂载点；
      若日后需要再开专页，加回一条 HTML 区块 + 这里一条即可。
   ============================================================ */
const HOLD_MOUNTS = [
  { pc: 'tvHoldTable', mobile: 'tvHoldTableM', summary: 'tvHoldSummary', empty: 'tvHoldEmpty', recBtn: 'tvHoldEmptyRec', ext: true },
];
const WATCH_MOUNTS = [
  { root: 'view-today', form: 'tvWatchForm', input: 'tvWfInput', sug: 'tvWfSug', note: 'tvWfNoteQuick', group: 'tvWfGroupQuick',
    submit: 'tvWfSubmit', cancel: 'tvWfCancel', tabs: 'tvWatchTabs', table: 'tvWatchTable', empty: 'tvWatchEmpty', delGroup: 'tvDelGroupBtn',
    toggle: 'tvWatchAddBtn' },   /* v3.8.78 标题行「＋ 加自选」= 开弹窗入口（原折叠开关） */
];
function renderHoldings() {
  const all = computeHoldings();
  const qm = quoteMap();
  const NA = '<span class="na-tag">未获取</span>';

  /* 当日交易按代码分组（当日盈亏与今日清仓都要用） */
  const todayStr = nowLocalInput().slice(0, 10);
  const todayByCode = new Map();
  for (const t of S.trades) {
    if (t.source === 'init') continue; /* 初始化持仓不进当日交易 */
    if (t.transaction_time.slice(0, 10) !== todayStr) continue;
    if (!todayByCode.has(t.stock_code)) todayByCode.set(t.stock_code, []);
    todayByCode.get(t.stock_code).push(t);
  }
  /* 持仓表：正常持仓 + 今日清仓的股票（清仓当日保留展示，盈亏已落地） */
  const holds = all.filter(h => h.qty > 0 || (todayByCode.get(h.code) || []).some(t => t.transaction_type === 'sell'));
  /* 当日盈亏（券商口径）：卖出净得 + 期末持仓现价 − 买入净额 − 期初持仓×昨收
     净额含费用；期初持仓 = 期末 + 今日卖出 − 今日买入。对「今日买今日卖」做 T 与「今日清仓」均成立。
     v3.8.55 修复：只要拿得到「现价 + 昨收」，没有今日交易也应当能算出当日盈亏
     （= 期末持仓 × 现价 − 期末持仓 × 昨收），此前 `if (!tt.length) return null` 把
     无交易的日子一律判成「未获取」，所以老基线持仓永远看不到当日盈亏。 */
  function dayPnlOf(code, endQty, price, prevClose) {
    const tt = todayByCode.get(code) || [];
    if (!tt.length) {
      /* 无今日交易：纯隔夜持仓的当日盈亏 = 期末持仓 × (现价 − 昨收) */
      if (price == null || !(prevClose > 0) || endQty <= 0) return null;
      return endQty * (price - prevClose);
    }
    let buyNet = 0, buyQty = 0, sellNet = 0, sellQty = 0;
    for (const t of tt) {
      const f = (t.fee && t.fee.total) || 0;
      if (t.transaction_type === 'buy') { buyQty += t.quantity; buyNet += t.net_amount != null ? Number(t.net_amount) : t.gross_amount + f; }
      else { sellQty += t.quantity; sellNet += t.net_amount != null ? Number(t.net_amount) : t.gross_amount - f; }
    }
    const openQty = endQty + sellQty - buyQty;               // 期初（昨收时点）持仓
    if (!price && openQty <= 0) return sellNet - buyNet;     // 今买今卖全平，无行情也能算
    if (price == null || !(prevClose > 0)) return null;      // 隔夜部分缺昨收无法算
    return sellNet + endQty * price - buyNet - openQty * prevClose;
  }
  const rows = holds.map((h, i) => {
    const q = qm.get(h.code);
    const price = q ? q.price : null;
    const prevClose = q ? q.prevClose : null;
    const cleared = h.qty <= 0;                               // 今日清仓：保留展示，盈亏已落地
    /* 摊薄成本：持仓股=当前摊薄；清仓股=清仓前最后一笔的加权成本（不再平摊，保留作参考） */
    const costPrice = h.qty ? h.dilutedValue / h.qty
      : (h.timeline && h.timeline.length ? h.timeline[h.timeline.length - 1].avg : null);
    const mv = !cleared && price != null ? h.qty * price : null;
    const dayPnl = dayPnlOf(h.code, h.qty, price, prevClose);
    /* 清仓股盈亏列 = 该股全部已实现盈亏（整轮结果，vs 成本）；持仓股 = 摊薄累计盈亏 */
    const float = cleared ? (h.realized || 0) : (price != null ? h.qty * price - h.dilutedValue : null);
    const floatPct = !cleared && price != null && costPrice ? float / h.dilutedValue : null;
    const dayPct = price != null && prevClose > 0 ? (price - prevClose) / prevClose : null;
    return { h, cleared, price, prevClose, costPrice, mv, float, floatPct, dayPnl, dayPct, color: WB_COLORS[i % WB_COLORS.length] };
  });
  /* 今日清仓股的落地盈亏（已在 rows 中） */

  /* 持仓统计卡：摊薄口径，与表格行完全一致（浮动盈亏=累计盈亏，当日参考盈亏=券商口径） */
  let totalMV = 0, totalDayPnl = 0;
  for (const r of rows) {
    if (r.mv != null) { totalMV += r.mv; if (r.dayPnl != null) totalDayPnl += r.dayPnl; }
  }
  /* 今日清仓股的已落地盈亏计入当日参考盈亏 */
  totalDayPnl += rows.filter(r => r.cleared).reduce((s, r) => s + (r.dayPnl != null ? r.dayPnl : 0), 0);
  /* v3.8.23 持仓表头三态排序（与自选表一致）：降序→升序→取消，空值恒排最后 */
  if (holdSort.key && holdSort.dir) {
    const getter = {
      mv: r => r.mv, float: r => r.float, floatPct: r => r.floatPct,
      qty: r => r.cleared ? 0 : r.h.qty, cost: r => r.costPrice, price: r => r.price,
      dayPnl: r => r.dayPnl, dayPct: r => r.dayPct
    }[holdSort.key];
    if (getter) {
      rows.sort((a, b) => {
        const va = getter(a), vb = getter(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (vb - va) * holdSort.dir;
      });
    }
  }
  updateSortHead('#tvHoldTable', holdSort);
  /* 报价时间提示（持仓页 + 总览页同步） */
  const qtiTxt = NetQuote.quoteTime
    ? `行情报价时间 ${NetQuote.quoteTime}（${NetQuote.eastDeadUntil > Date.now() ? '腾讯备源' : '东财主源'}，缓存15秒）`
    : '行情未获取';
  /* v3.8.37 持仓页下线：报价时间/指数条只有总览页一处挂载点 */
  ['tvQuoteTime'].forEach(id => {
    const el = document.getElementById(id); if (el) el.textContent = qtiTxt;
  });
  /* v3.8.26 指数条（红涨绿跌）；v3.8.62 起为 6 枚：上证指数 / 深证成指 / 创业板指
     + 沪深300 / 中证500 / 中证1000（大中小盘宽基），全部由 NetQuote.INDEXES 驱动
     v3.8.69 手机端补「涨跌额」：窄屏每行一枚胶囊、右侧余量很大（实测 360px 下
     内容仅占 296px / 可用 332px），而原来只有百分比、看不到具体涨跌多少个点。
     v3.8.70 涨跌额改为**并入百分比括号内**（-0.74%(-28.19)）：原先它是第 4 枚
     独立 span（.i-chg），自带 5.5em 定宽右对齐，实测在百分比后隔出 35.8px 空隙，
     用户反馈「中间隔的空太多」。合并后不再需要独立列，定宽与空隙一并消失。
     括号段字号比主数值小一档（12px）、跟随涨跌着色，保持「补充信息」的主次。
     仍在窄屏才加：PC 端一行排 6 枚，多一段数值会把它们挤到换行。 */
  const idxNarrow = window.matchMedia('(max-width: 720px)').matches;
  const idxItems = NetQuote.INDEXES.map(ix => {
    const q = NetQuote.idx.get(ix.sym);
    if (!q || !(q.price > 0)) return '';
    const cls = q.pct >= 0 ? 'up' : 'down';
    const sign = q.pct >= 0 ? '+' : '';
    /* v3.8.70 涨跌额并进百分比（括号形式）；涨跌额缺失（个别源不返回）时只显示百分比 */
    const chgTxt = (idxNarrow && q.chg != null && !isNaN(q.chg))
      ? `<span class="i-chg">(${q.chg >= 0 ? '+' : ''}${fmt2(q.chg)})</span>` : '';
    return `<span class="idx-chip ${cls}"><span class="i-name">${esc(q.name || ix.name)}</span><span class="i-val">${fmt2(q.price)}</span><span class="i-pct">${sign}${q.pct.toFixed(2)}%</span>${chgTxt}</span>`;
  }).join('');
  ['tvIdxBar'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.hidden = !idxItems; el.innerHTML = idxItems;
  });
  const totalFloat = rows.reduce((s, r) => s + (r.float != null ? r.float : 0), 0);
  /* v3.8.38 总览页「持仓快照」统计：3 项，聚焦当前持仓本身
     （账户级「总市值/累计盈亏」已下线——那类口径可从「交易记录」统计得到）
     沿用与「大盘指数」同款胶囊，容器加 .idx-bar-eq 做等宽网格：PC 一行 / 手机两行 */
  const missingQty = rows.filter(r => !r.cleared && r.price == null).length;
  const sSgn = v => (v >= 0 ? '+' : '');
  const sCls = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const sPct = (v, base) => (base > 0 ? sSgn(v) + (v / base * 100).toFixed(2) + '%' : '');
  const statChip = (name, val, cls, pct) => `<span class="idx-chip${cls ? ' ' + cls : ''}">`
    + `<span class="i-name">${name}</span><span class="i-val">${val}</span>`
    + (pct ? `<span class="i-pct">${pct}</span>` : '') + '</span>';
  /* v3.8.75 去掉「持仓市值」的 ¥ 前缀：胶囊里已经有「持仓市值」这个语义标签，
     同一行其余两项（浮动盈亏/当日盈亏）也都是纯数字，带符号不带上限单位，
     保留 ¥ 反而让三项基线不齐、宽度被撑开。 */
  const tvStatsHtml = statChip('持仓市值', fmt2(totalMV), '', '')
    + statChip('浮动盈亏', sSgn(totalFloat) + fmt2(totalFloat), sCls(totalFloat), sPct(totalFloat, totalMV - totalFloat))
    + statChip('当日盈亏', sSgn(totalDayPnl) + fmt2(totalDayPnl), sCls(totalDayPnl), sPct(totalDayPnl, totalMV - totalDayPnl))
    + (missingQty ? `<span class="hold-warn">${missingQty} 只现价未获取</span>` : '');
  const sumHtmlOf = () => (rows.length ? tvStatsHtml : '');

  /* PC 全列表格：股票/市值/盈亏/盈亏%/数量/成本价/现价/当日盈亏/当日盈亏%
     （v3.8.50：「持仓/可用」改为「数量」——本表只是交易日志的持仓汇总，
      不存在「当日买入不可卖」的交易约束，故不再区分可用；「仓位」列一并下线，
      因为没有账户总资产口径，单股占比没有意义） */
  const pcHtml = rows.map(r => {
    const { h, price, costPrice, mv, float, floatPct, dayPnl, dayPct } = r;
    return `<tr data-code="${esc(h.code)}">
      <td><div class="stock-cell"><span class="sc-name">${esc(h.name || h.code)}${r.cleared ? ' <span class="tag cleared">已清仓</span>' : ''}</span><span class="sc-code">${esc(h.code)}</span></div></td>
      <td class="num">${mv != null ? fmt2(mv) : NA}</td>
      <td class="num ${float != null ? pnlCls(float) : ''}">${float != null ? (float >= 0 ? '+' : '') + fmt2(float) : NA}</td>
      <td class="num ${floatPct != null ? pnlCls(floatPct) : ''}">${floatPct != null ? fmtPct(floatPct) : NA}</td>
      <td class="num">${h.qty}</td>
      <td class="num">${costPrice != null ? fmtP(costPrice) : '—'}</td>
      <td class="num price-cell">${price != null ? fmt2(price) : NA}</td>
      <td class="num ${dayPnl != null ? pnlCls(dayPnl) : ''}">${dayPnl != null ? (dayPnl >= 0 ? '+' : '') + fmt2(dayPnl) : NA}</td>
      <td class="num ${dayPct != null ? pnlCls(dayPct) : ''}">${dayPct != null ? fmtPct(dayPct) : NA}</td>
    </tr>`;
  }).join('');

  /* 手机端合并列表格：市值(含股票信息) / 盈亏 / 数量 / 成本现价 / 当日盈亏
     （v3.8.50：市值列不再重复显示股票代码 → 名称 + 市值两行） */
  const mobileHtml = rows.map(r => {
    const { h, price, costPrice, mv, float, floatPct, dayPnl, dayPct } = r;
    const sgn = v => (v >= 0 ? '+' : '');
    return `<tr data-code="${esc(h.code)}">
      <td><div class="stock-cell"><span class="sc-name">${esc(h.name || h.code)}${r.cleared ? ' <span class="tag cleared">已清仓</span>' : ''}</span><span class="sc-mv">${mv != null ? fmt2(mv) : NA}</span></div></td>
      <td class="num"><div class="two-line"><b class="${float != null ? pnlCls(float) : ''}">${float != null ? sgn(float) + fmt2(float) : NA}</b><span class="sub ${floatPct != null ? pnlCls(floatPct) : ''}">${floatPct != null ? fmtPct(floatPct) : ''}</span></div></td>
      <td class="num">${h.qty}</td>
      <td class="num"><div class="two-line"><span>${costPrice != null ? fmtP(costPrice) : '—'}</span><span class="sub">${price != null ? fmt2(price) : '未获取'}</span></div></td>
      <td class="num"><div class="two-line"><b class="${dayPnl != null ? pnlCls(dayPnl) : ''}">${dayPnl != null ? sgn(dayPnl) + fmt2(dayPnl) : NA}</b><span class="sub ${dayPct != null ? pnlCls(dayPct) : ''}">${dayPct != null ? fmtPct(dayPct) : ''}</span></div></td>
    </tr>`;
  }).join('');

  /* v3.8.34 总览页与持仓页共用同一份渲染结果（挂载点见 HOLD_MOUNTS，删页只需去掉对应条目） */
  for (const m of HOLD_MOUNTS) {
    const pcEl = document.getElementById(m.pc);
    if (pcEl) pcEl.querySelector('tbody').innerHTML = pcHtml;
    const mbEl = document.getElementById(m.mobile);
    if (mbEl) mbEl.querySelector('tbody').innerHTML = mobileHtml;
    const sumEl = document.getElementById(m.summary);
    if (sumEl) sumEl.innerHTML = sumHtmlOf();
    const emptyEl = document.getElementById(m.empty);
    if (emptyEl) emptyEl.hidden = holds.length > 0;
  }
}

/* ---------- 操作（交易） ---------- */
/* 展开的费用明细行 id 集合：重渲染后恢复，仅再次点击才收起 */
const feeOpenIds = new Set();
/* 按股票视图：展开状态与最近一次聚合数据 */
let stockOpenCodes = new Set();
let lastStockAgg = new Map();
function stockDetailRow(g) {
  const list = [...g.trades].sort((a, b) => new Date(a.transaction_time) - new Date(b.transaction_time));
  const holdByCode = new Map();
  for (const h of computeHoldings()) holdByCode.set(h.code, h);
  let realizedSum = 0, realizedOpSum = 0;
  const items = list.map(t => {
    const fee = (t.fee && t.fee.total) || 0;
    const d = new Date(t.transaction_time), p = n => String(n).padStart(2, '0');
    return { t, fee, dateStr: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`, pnl: null, pnlOp: null };
  });
  /* 从 timeline 拿每笔卖出已实现盈亏（整轮口径 + 当笔配对口径） */
  const tlMap = new Map(), tlMapOp = new Map();
  for (const ev of (holdByCode.get(g.code) || { timeline: [] }).timeline) {
    if (ev.realized != null && ev.t) tlMap.set(String(ev.t.id), ev.realized);
    if (ev.realizedOp != null && ev.t) tlMapOp.set(String(ev.t.id), ev.realizedOp);
  }
  for (const it of items) {
    it.pnl = tlMap.has(String(it.t.id)) ? tlMap.get(String(it.t.id)) : null;
    it.pnlOp = tlMapOp.has(String(it.t.id)) ? tlMapOp.get(String(it.t.id)) : null;
    if (it.pnl != null) realizedSum += it.pnl;
    if (it.pnlOp != null) realizedOpSum += it.pnlOp;
  }
  /* v3.8.27 浮动盈亏改用加权成本口径：与期间已实现互斥，避免摊薄口径重复计入已实现盈利
     （摊薄口径的浮动已把卖出盈利滚入成本，若再与 realizedSum 相加会重复） */
  const h = holdByCode.get(g.code);
  const q = quoteMap().get(g.code);
  const floatNow = h && h.qty > 0 && q && q.price != null ? h.qty * q.price - h.costValue : 0;
  const holdingNote = h && h.qty > 0 ? `期末仍持有 ${h.qty} 股，浮动 ${floatNow >= 0 ? '+' : ''}${fmt2(floatNow)}` : '该股已清仓，盈亏全部落地';
  const total = realizedSum + floatNow;
  /* v3.8.29 展开区顶部加持仓明细卡同款 4 卡（全历史口径，与持仓页明细卡数字一致可互验） */
  const has = !!h;
  const costW = has && h.qty ? h.costValue / h.qty : 0;
  const costD = has && h.qty ? h.dilutedValue / h.qty : 0;
  const price = q && q.price != null ? Number(q.price) : null;
  /* v3.8.51 展开区统计改为与总览「大盘 / 持仓」同款胶囊（同字号 13px、同内距与圆角）
     期间口径（期间已实现 / 期间总盈亏）收进胶囊副文，原底部 sd-sum 汇总行随之下线 */
  const sdChip = (name, val, cls, sub) => `<span class="idx-chip${cls ? ' ' + cls : ''}">`
    + `<span class="i-name">${name}</span><span class="i-val">${val}</span>`
    + (sub ? `<span class="i-sub">${sub}</span>` : '') + '</span>';
  const sdSign = v => (v >= 0 ? '+' : '');
  const sdCls = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const chips = `
    <div class="idx-bar idx-bar-lg sd-chips">
      ${sdChip('持仓', has && h.qty ? h.qty + ' 股' : '已清仓', '', price != null ? '现价 ' + fmt2(price) : '现价未获取')}
      ${sdChip('成本', has && h.qty ? fmtP(costW) + ' / ' + fmtP(costD) : '—', '', '加权 / 摊薄')}
      ${sdChip('累计已实现', has ? sdSign(h.realized) + fmt2(h.realized) : '—', sdCls(has ? h.realized : 0), '期间 ' + sdSign(realizedSum) + fmt2(realizedSum))}
      ${sdChip('当笔盈亏', sdSign(realizedOpSum) + fmt2(realizedOpSum), sdCls(realizedOpSum), '卖出配当日买入')}
      ${sdChip('浮动盈亏', sdSign(floatNow) + fmt2(floatNow), sdCls(floatNow), '期间总盈亏 ' + sdSign(total) + fmt2(total))}
    </div>`;
  return `<tr class="stock-detail-row"><td colspan="6">
    <div class="sd-title">${esc(g.name)}（${esc(g.code)}）筛选期间共 ${list.length} 笔 · ${holdingNote}</div>
    ${chips}
    ${list.length ? `<div class="sd-tbl-scroll">
      <table class="sd-tbl">
        <thead><tr><th>时间</th><th>方向</th><th class="num">价格</th><th class="num">数量</th><th class="num">成交金额</th><th class="num">费用</th><th class="num">当笔盈亏</th><th class="num">累计已实现</th></tr></thead>
        <tbody>
          ${items.map(it => `<tr>
            <td>${it.dateStr}</td>
            <td><span class="tag ${it.t.transaction_type}">${it.t.transaction_type === 'buy' ? '买入' : '卖出'}</span></td>
            <td class="num">${fmt2(it.t.price)}</td>
            <td class="num">${it.t.quantity}</td>
            <td class="num">${fmt2(it.t.gross_amount)}</td>
            <td class="num">${fmt2(it.fee)}</td>
            <td class="num ${it.pnlOp != null ? pnlCls(it.pnlOp) : ''}">${it.pnlOp != null ? (it.pnlOp >= 0 ? '+' : '') + fmt2(it.pnlOp) : '—'}</td>
            <td class="num ${it.pnl != null ? pnlCls(it.pnl) : ''}">${it.pnl != null ? (it.pnl >= 0 ? '+' : '') + fmt2(it.pnl) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '<div class="empty" style="padding:10px">筛选期间无操作记录（持仓/盈亏见上方卡片）</div>'}
  </td></tr>`;
}
function tradeRowFiltered() {
  const from = $('ftFrom').value, to = $('ftTo').value;
  const allKw = $('ftKw').value.trim().toLowerCase();   // 全字段搜索：代码/名称/备注/原始语句/金额数量
  return S.trades.filter(t => {
    if (t.source === 'init') return false; /* 初始化持仓不进交易流水 */
    const d = t.transaction_time.slice(0, 10);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (allKw) {
      const hay = `${t.stock_code} ${t.stock_name || ''} ${t.note || ''} ${t.raw_text || ''} ${t.transaction_type === 'buy' ? '买入 卖' : '卖出 买'} ${t.quantity} ${t.price} ${t.gross_amount}`.toLowerCase();
      if (!hay.includes(allKw)) return false;
    }
    return true;
  });
}
/* 交易视图模式：list=默认（逐笔），stock=按股票汇总 */
let tradeMode = (() => { try { return localStorage.getItem('sj_tradeMode') || 'list'; } catch (e) { return 'list'; } })();
const TRADE_HEAD_LIST = '<th>时间</th><th>方向</th><th>股票</th><th class="num">价格</th><th class="num">数量</th>'
  + '<th class="num">成交金额</th><th class="num">费用</th><th class="num">发生金额</th><th>操作</th>';
const TRADE_HEAD_STOCK = '<th>股票</th><th class="num">成交量(买/卖)</th><th class="num">成交均价(买/卖)</th>'
  + '<th class="num">成交额</th><th class="num">买/卖笔数</th><th class="num">费用</th>';
function renderTrades() {
  const rows = tradeRowFiltered();
  $('tradeEmpty').hidden = rows.length > 0;
  $('tradeTheadRow').innerHTML = tradeMode === 'stock' ? TRADE_HEAD_STOCK : TRADE_HEAD_LIST;
  /* 按股票：时间范围内按代码汇总，点行展开每笔明细 + 期间总盈亏 */
  if (tradeMode === 'stock') {
    /* 每笔已实现盈亏：从持仓引擎 timeline 取（卖出时有值） */
    const pnlById = new Map(), holdByCode = new Map();
    for (const h of computeHoldings()) {
      holdByCode.set(h.code, h);
      for (const ev of h.timeline) if (ev.realized != null && ev.t) pnlById.set(String(ev.t.id), ev.realized);
    }
    const m = new Map();
    for (const t of rows) {
      const k = t.stock_code;
      if (!m.has(k)) m.set(k, { code: k, name: t.stock_name || k, qty: 0, amt: 0, fee: 0, buys: 0, sells: 0, buyQty: 0, buyAmt: 0, sellQty: 0, sellAmt: 0, trades: [] });
      const g = m.get(k);
      g.qty += t.quantity || 0;
      g.amt += t.gross_amount || 0;
      g.fee += (t.fee && t.fee.total) || 0;
      if (t.transaction_type === 'buy') { g.buys++; g.buyQty += t.quantity || 0; g.buyAmt += t.gross_amount || 0; }
      else { g.sells++; g.sellQty += t.quantity || 0; g.sellAmt += t.gross_amount || 0; }
      g.trades.push(t);
    }
    lastStockAgg = m;
    const list = [...m.values()].sort((a, b) => b.amt - a.amt);
    $('tradeTable').querySelector('tbody').innerHTML = list.map(g => `
      <tr class="stockagg" data-code="${esc(g.code)}" title="点击展开每笔明细与期间盈亏">
        <td><div class="stock-cell"><span class="sc-name">${esc(g.name)}</span><span class="sc-code">${esc(g.code)}</span></div></td>
        <td class="num">${g.buyQty || '—'} / ${g.sellQty || '—'}</td>
        <td class="num">${g.buyQty ? fmt2(g.buyAmt / g.buyQty) : '—'} / ${g.sellQty ? fmt2(g.sellAmt / g.sellQty) : '—'}</td>
        <td class="num">${fmt2(g.amt)}</td>
        <td class="num">${g.buys} / ${g.sells}</td>
        <td class="num">${fmt2(g.fee)}</td>
      </tr>`).join('');
    /* 恢复已展开的股票明细 */
    if (stockOpenCodes.size) {
      for (const tr of $('tradeTable').querySelectorAll('tbody tr.stockagg')) {
        if (!stockOpenCodes.has(tr.dataset.code)) continue;
        const g = lastStockAgg.get(tr.dataset.code);
        if (g) tr.insertAdjacentHTML('afterend', stockDetailRow(g));
      }
    }
    const stats = $('ftStats');
    if (stats) stats.innerHTML = `<span>${list.length} 只股票</span><span>共 <b>${rows.length}</b> 笔</span><span>点股票行可展开每笔明细</span>`;
    return;
  }
  $('tradeTable').querySelector('tbody').innerHTML = rows.map(t => {
    const fee = (t.fee && t.fee.total) || 0;
    const d = new Date(t.transaction_time), p2 = n => String(n).padStart(2, '0');
    const dateStr = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const timeStr = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    return `<tr data-id="${t.id}">
      <td class="tm-cell">${dateStr}<br><span class="tm-sub">${timeStr}</span></td>
      <td><span class="tag ${t.transaction_type}">${t.transaction_type === 'buy' ? '买入' : '卖出'}</span></td>
      <td><div class="stock-cell"><span class="sc-name">${esc(t.stock_name || '')}</span><span class="sc-code">${esc(t.stock_code)}</span></div></td>
      <td class="num">${fmt2(t.price)}</td>
      <td class="num">${t.quantity}</td>
      <td class="num">${fmt2(t.gross_amount)}</td>
      <td class="num fee-cell" data-id="${t.id}" title="点击展开费用明细">${fmt2(fee)}</td>
      <td class="num">${fmt2(Math.abs(t.net_amount != null ? t.net_amount : t.gross_amount - fee))}</td>
      <td><div class="row-actions">
        <button class="icon-btn edit-trade" data-id="${t.id}">编辑</button>
        <button class="icon-btn del del-trade" data-id="${t.id}">删除</button>
      </div></td>
    </tr>`;
  }).join('');
  /* 恢复已展开的费用明细行（重渲染后保持，直到用户再点一次收起） */
  if (feeOpenIds.size) {
    for (const tr of $('tradeTable').querySelectorAll('tbody tr[data-id]')) {
      if (!feeOpenIds.has(String(tr.dataset.id))) continue;
      const t = S.trades.find(x => String(x.id) === String(tr.dataset.id));
      if (t) tr.insertAdjacentHTML('afterend', feeDetailRow(t));
    }
  }
  /* 筛选结果汇总 */
  const stats = $('ftStats');
  if (stats) {
    if (!rows.length) { stats.innerHTML = ''; return; }
    const buyAmt = rows.filter(t => t.transaction_type === 'buy').reduce((s, t) => s + (t.gross_amount || 0), 0);
    const sellAmt = rows.filter(t => t.transaction_type === 'sell').reduce((s, t) => s + (t.gross_amount || 0), 0);
    const fees = rows.reduce((s, t) => s + ((t.fee && t.fee.total) || 0), 0);
    stats.innerHTML = `<span>共 <b>${rows.length}</b> 笔</span><span>买入 <b>${fmt2(buyAmt)}</b></span><span>卖出 <b>${fmt2(sellAmt)}</b></span><span>费用合计 <b>${fmt2(fees)}</b></span><span>净买入 <b class="${pnlCls(buyAmt - sellAmt)}">${fmt2(buyAmt - sellAmt)}</b></span>`;
  }
}
function feeDetailRow(t) {
  const f = t.fee || {};
  return `<tr class="fee-detail-row"><td></td><td colspan="8">
    <div class="fee-preview">
      <span>佣金 <b>${fmt2(f.commission || 0)}</b></span>
      <span>印花税 <b>${fmt2(f.stamp || 0)}</b></span>
      <span>过户费 <b>${fmt2(f.transfer || 0)}</b></span>
      <span>经手费 <b>${fmt2(f.handling || 0)}</b></span>
      <span>证管费 <b>${fmt2(f.gov || 0)}</b></span>
      <span>合计 <b>${fmt2(f.total || 0)}</b></span>
      ${t.note ? `<span>备注：${esc(t.note)}</span>` : ''}
    </div></td></tr>`;
}
function fillTradeForm(t) {
  S.editingTradeId = t.id;
  $('tfType').value = t.transaction_type;
  setTfStock(t.stock_code, t.stock_name || '');
  $('tfPrice').value = t.price;
  $('tfQty').value = t.quantity;
  const d = new Date(t.transaction_time), p = n => String(n).padStart(2, '0');
  $('tfTime').value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  $('tfNote').value = t.note || '';
  $('tfSubmit').textContent = '保存修改';
  /* 编辑模式锁定：只允许改备注/理由，买卖方向、股票、价格、数量、时间不可改 */
  ['tfPrice', 'tfQty', 'tfTime', 'tfStock'].forEach(id => { const el = $(id); if (el) el.readOnly = true; });
  $('tfType').disabled = true;
  document.querySelectorAll('#tfTypeTabs .wtab').forEach(x => x.disabled = true);
  document.querySelectorAll('#tradeForm input, #tradeForm select').forEach(el => el.classList.add('lock-dim'));
  $('tfNote').classList.remove('lock-dim');
  const hint = $('tfEditHint');
  if (hint) hint.hidden = false;
  setManualOpen(true);
  updateFeePreview();
  openRecModal(false);
}
function unlockTradeForm() {
  ['tfPrice', 'tfQty', 'tfTime', 'tfStock'].forEach(id => { const el = $(id); if (el) el.readOnly = false; });
  const sel = $('tfType'); if (sel) sel.disabled = false;
  document.querySelectorAll('#tfTypeTabs .wtab').forEach(x => x.disabled = false);
  document.querySelectorAll('#tradeForm .lock-dim').forEach(el => el.classList.remove('lock-dim'));
  const hint = $('tfEditHint');
  if (hint) hint.hidden = true;
}
function resetTradeForm() {
  S.editingTradeId = null;
  unlockTradeForm();
  $('tradeForm').reset();
  setTfStock('', '');
  $('tfTime').value = nowLocalInput();
  $('tfSubmit').textContent = '保存';
  updateFeePreview();
}
/* 「记一笔」弹窗 */
/* 记一笔弹窗滚到底（保存按钮可见） */
function scrollRecBottom() {
  const m = document.querySelector('#recModal .modal-lg');
  if (!m || $('recModal').hidden) return;
  const doScroll = () => { m.scrollTop = m.scrollHeight; };
  requestAnimationFrame(doScroll);
  setTimeout(doScroll, 120);   // 布局（如手机键盘/费用预览撑高）稳定后再校准一次
}
/* 键盘弹出时视口变小：弹窗高度跟随可视视口，保存按钮不会被键盘挡住 */
(function () {
  const vv = window.visualViewport;
  if (!vv) return;
  let t = null;
  const fit = () => {
    const m = document.querySelector('#recModal .modal-lg');
    if (!m || $('recModal').hidden) return;
    m.style.maxHeight = Math.max(200, Math.round(vv.height - 16)) + 'px';
    m.scrollTop = m.scrollHeight;   // 高度变化后保持在底部
  };
  vv.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(fit, 80); });
  vv.addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(fit, 80); });
})();
/* v3.8.55 记一笔弹窗：自然语言区与手动录入区互为手风琴——
   展开手动录入时收起上面的自然语言区（含快捷 chip），收起手动录入时再放回来。
   两边不会同时展开，弹窗不会又长又乱，也被迫让用户明确选一种录入方式。 */
function setNlOpen(open) {
  const w = $('nlWrap');
  if (w) w.hidden = !open;
}
function setManualOpen(open) {
  const w = $('tfManualWrap'), t = $('tfManualToggle');
  if (w) w.hidden = !open;
  if (t) t.textContent = open ? '收起手动录入 ▴' : '手动录入 ▸';
  setNlOpen(!open);                // 互斥：展开手动录入 ⇄ 收起自然语言
  if (open) scrollRecBottom();     // 展开后滚到底，保存按钮可见
}
function openRecModal(reset = true) {
  const m = $('recModal'); if (!m) return;
  if (reset) {
    resetTradeForm();
    setManualOpen(false);
    const nl = $('tradeNl'); if (nl) nl.value = '';   // 清掉上次的一句话描述
  }
  m.hidden = false;
}
function closeRecModal() {
  const m = $('recModal'); if (!m) return;
  m.hidden = true;
  const lg = m.querySelector('.modal-lg'); if (lg) lg.style.maxHeight = '';   // 清掉键盘适配的内联高度
  $('tradeHint').hidden = true;
  resetTradeForm();
}
/* 方向 Tab 状态与隐藏 select 同步 */
function syncTfTypeTabs() {
  const sel = $('tfType');
  if (!sel) return;
  document.querySelectorAll('#tfTypeTabs .wtab').forEach(b => b.classList.toggle('on', b.dataset.t === sel.value));
}
/* 股票联想框：选定即确定代码/名称，市场由代码推断 */
function setTfStock(code, name) {
  const inp = $('tfStock');
  inp.value = name ? `${code} ${name}` : code;
  inp.dataset.code = code || '';
  inp.dataset.sname = name || '';
}
function resolveTfStock() {
  const inp = $('tfStock');
  const txt = inp.value.trim();
  let code = inp.dataset.code || '', name = inp.dataset.sname || '';
  let conflict = null;
  if (!(code && txt.startsWith(code)) && txt) {
    const hit = StockDict.resolve(txt);
    if (hit && hit.code) { code = hit.code; name = hit.name || name; conflict = hit.conflict || null; }
    else if (/^\d{5,6}$/.test(txt)) { code = txt; name = ''; }
    else { code = ''; name = ''; }
  }
  if (code && !name) { const hit = StockDict.resolve(code); if (hit && hit.name) name = hit.name; }
  return { code, name, market: code ? inferMarket(code) : 'sh', conflict };
}
function updateFeePreview() {
  const price = parseFloat($('tfPrice').value), qty = parseInt($('tfQty').value, 10);
  const type = $('tfType').value, market = resolveTfStock().market;
  if (!(price > 0) || !(qty > 0)) { $('feePreview').innerHTML = ''; return; }
  const gross = price * qty;
  const f = calcFees(gross, type, market, resolveTfStock().code);
  const net = type === 'buy' ? gross + f.total : gross - f.total;
  $('feePreview').innerHTML = `
    <span>成交金额 <b>${fmt2(gross)}</b></span>
    <span>佣金 <b>${fmt2(f.commission)}</b></span>
    ${f.stamp ? `<span>印花税 <b>${fmt2(f.stamp)}</b></span>` : ''}
    <span>过户费 <b>${fmt2(f.transfer)}</b></span>
    <span>经手费 <b>${fmt2(f.handling)}</b></span>
    <span>证管费 <b>${fmt2(f.gov)}</b></span>
    <span>${type === 'buy' ? '总投入' : '净到手'} <b>${fmt2(net)}</b></span>`;
  scrollRecBottom();   // 费用预览出现/变化后滚到底，保存按钮可见
}

/* ---------- 自选 ---------- */
/* 买入自动加自选（「默认」组里没有这只票时才加）
   v3.8.83：判重口径从「全局存在即跳过」改为「目标分组内存在才跳过」，
   与手动加自选的同分组去重规则保持一致 —— 否则把票放进别的分组后，
   再买入这只票时就不会往「默认」组里补一条了。 */
async function autoWatchOnBuy(code, name) {
  try {
    if (!code || S.watchlist.some(w => w.stock_code === code && (w.group_name || '默认') === '默认')) return;
    let anchor = NetQuote.get(code);
    if (!anchor) { try { await refreshQuotes(true); } catch (e) { /* */ } anchor = NetQuote.get(code); }
    const row = { stock_code: code, stock_name: name || code, group_name: '默认', note: '买入自动加入', cur_price: anchor ? anchor.price : null, prev_close: null };
    await store.insert('watchlist', row);
    await store.log('watch', `买入自动加入自选 ${row.stock_name}（${code}）`);
    toast(`已自动加入自选 ${row.stock_name}`);
  } catch (e) { /* 失败不影响交易保存主流程 */ }
}
let watchTab = (() => { try { return localStorage.getItem('sj_watchTab') || '默认'; } catch (e) { return '默认'; } })();   // 当前分组 Tab（记住上次所在分组）
/* v3.8.50 分组名单独持久化：此前分组只能从 watchlist 的 group_name 反推，
   于是「新建了分组但里面还没有股票」→ 一刷新分组就消失，用起来很别扭。
   现在把分组名记进 localStorage，空分组也一直显示。 */
let watchGroups = (() => {
  try {
    const a = JSON.parse(localStorage.getItem('sj_groups') || '[]');
    return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x && x !== '默认') : [];
  } catch (e) { return []; }
})();
function saveWatchGroups() { try { localStorage.setItem('sj_groups', JSON.stringify(watchGroups)); } catch (e) { /* */ } }
function addWatchGroup(name) {
  name = (name || '').trim();
  if (!name || name === '默认' || watchGroups.includes(name)) return;
  watchGroups.push(name); saveWatchGroups();
}
function removeWatchGroup(name) {
  const i = watchGroups.indexOf(name);
  if (i >= 0) { watchGroups.splice(i, 1); saveWatchGroups(); }
}
/* 全部已存在的分组：默认 + 持久化的空分组 + 自选里实际用到的分组 */
function allWatchGroups() {
  return [...new Set(['默认', ...watchGroups, ...S.watchlist.map(w => w.group_name || '默认')])].filter(Boolean);
}
/* v3.8.22 自选表表头排序状态：dir 1=降序(第一次点击) / -1=升序 / 0=未排序 */
let watchSort = { key: null, dir: 0 };
/* v3.8.23 持仓表同款三态排序（自选功能复制试点） */
let holdSort = { key: null, dir: 0 };
function updateSortHead(tableSel, state) {
  /* v3.8.34 支持一次更新多处同源表格（持仓页/总览页共用一份数据） */
  const sels = Array.isArray(tableSel) ? tableSel : [tableSel];
  for (const sel of sels) document.querySelectorAll(sel + ' th.sortable').forEach(th => {
    th.classList.toggle('sorted-desc', state.key === th.dataset.sort && state.dir === 1);
    th.classList.toggle('sorted-asc', state.key === th.dataset.sort && state.dir === -1);
  });
}
function updateWatchHead() { updateSortHead('#tvWatchTable', watchSort); }
/* 自选数据模型：分组 Tab + 行数据（含排序），与挂载点无关 */
function watchModel() {
  const groups = allWatchGroups();
  const tabGroups = groups.includes(watchTab) ? groups : [...groups, watchTab].filter(Boolean);
  const list = S.watchlist.filter(w => !watchTab || (w.group_name || '默认') === watchTab);
  const qm = quoteMap();
  /* v3.8.83 分组统计：数量 + 组内涨跌幅平均值（跳过未知涨跌幅的票）。
     例：组内 5 只、只有 4 只有涨跌幅 → 用这 4 只的平均值代表该组涨跌幅；
     全组都没有涨跌幅（行情未到）→ avgChg 为 null，Tab 上不显示涨幅。 */
  const groupStat = new Map();
  for (const g of tabGroups) {
    const inG = S.watchlist.filter(w => (w.group_name || '默认') === g);
    let sum = 0, cnt = 0;
    for (const w of inG) {
      const q = qm.get(w.stock_code);
      if (q && q.pct != null && !isNaN(q.pct)) { sum += Number(q.pct); cnt++; }
    }
    groupStat.set(g, { count: inG.length, avgChg: cnt ? sum / cnt : null, known: cnt });
  }
  const backfilled = new Set();   // 本轮渲染中已触发锚点回填的自选 id
  /* v3.8.22 先算每行的展示数据，再按表头排序状态排序 */
  const items = list.map(w => {
    const q = qm.get(w.stock_code);
    const price = q ? q.price : null;                       // 网络现价
    const chg = q && q.pct != null && !isNaN(q.pct) ? q.pct / 100 : null;
    /* 自选收益：现价 vs 添加/手填时的价格锚点（cur_price） */
    let anchor = w.cur_price != null ? Number(w.cur_price) : null;
    /* 锚点缺失（加自选时行情未取到）→ 首次拿到行情时用最新价回填入库 */
    if (anchor == null && price != null && w.id != null && !backfilled.has(w.id)) {
      backfilled.add(w.id);
      store.update('watchlist', w.id, { cur_price: price }).catch(() => backfilled.delete(w.id));
      anchor = price;   // 本次渲染先用最新价展示
    }
    const gain = price != null && anchor ? (price - anchor) / anchor : null;
    const d = w.created_at ? new Date(w.created_at) : null;
    const addDate = d && !isNaN(d) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '—';
    return { w, q, price, chg, anchor, gain, addDate, ts: d && !isNaN(d) ? d.getTime() : null };
  });
  if (watchSort.key && watchSort.dir) {
    const getter = {
      price: it => it.price, chg: it => it.chg,
      open: it => it.q && it.q.open != null ? it.q.open : null,
      high: it => it.q && it.q.high != null ? it.q.high : null,
      low: it => it.q && it.q.low != null ? it.q.low : null,
      prevClose: it => it.q && it.q.prevClose != null ? it.q.prevClose : null,
      date: it => it.ts, anchor: it => it.anchor, gain: it => it.gain
    }[watchSort.key];
    if (getter) {
      items.sort((a, b) => {
        const va = getter(a), vb = getter(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;    // 空值恒排最后
        if (vb == null) return -1;
        return (vb - va) * watchSort.dir;   // dir=1 降序优先，dir=-1 升序
      });
    }
  }
  return { tabGroups, items, listLen: list.length, groupStat };
}
/* v3.8.34 把自选列表画到某个挂载点（总览页 / 自选页共用同一份模型） */
function paintWatch(m, M) {
  const el = id => document.getElementById(id);
  const tabs = el(m.tabs);
  /* v3.8.45 分组行结构：左侧是「内容」（分组 Tab），右侧是两个「动作」按钮
     = 图标 + 短词（folderPlus「新建分组」/ trash「删除分组」），样式上与 Tab 分层。
     删除按钮仅在具体分组（非「默认」）时出现。 */
  const canDelGroup = !!(watchTab && watchTab !== '默认');
  if (tabs) {
    /* v3.8.83 分组 Tab 增加「组内涨跌幅平均值」：数量徽标保留，后面跟一个涨跌胶囊。
       跳过未知涨跌幅的票（组内 5 只只有 4 只有值 → 取这 4 只的平均）；全组无值则不显示。
       涨幅配色沿用全局 pnlCls（红涨绿跌，A 股习惯）。 */
    tabs.innerHTML = M.tabGroups.map(g => {
      const st = (M.groupStat && M.groupStat.get(g)) || { count: 0, avgChg: null };
      const avg = st.avgChg != null
        ? `<em class="wtab-chg ${pnlCls(st.avgChg / 100)}">${fmtPct(st.avgChg / 100)}</em>`
        : '';
      return `<button class="wtab${watchTab === g ? ' on' : ''}" data-g="${esc(g)}">${esc(g)}<i>${st.count}</i>${avg}</button>`;
    }).join('')
      + `<button class="wtab wtab-act wtab-add" data-g="+" title="新建分组" aria-label="新建分组">${ICO.folderPlus}<span>新建分组</span></button>`
      + (m.delGroup ? `<button class="wtab wtab-act wtab-del" id="${m.delGroup}" type="button" aria-label="删除当前分组" title="删除当前分组，组内自选移回「默认」"${canDelGroup ? '' : ' hidden'}>${ICO.trash}<span>删除分组</span></button>` : '');
  }
  const table = el(m.table);
  if (!table) return;                       // 该挂载点不存在（例如页面已下线）
  const empty = el(m.empty);
  const FAIL = '<span class="na-tag">获取失败</span>';
  table.querySelector('tbody').innerHTML = M.items.map(({ w, q, price, chg, anchor, gain, addDate }) => {
    return `<tr data-id="${w.id}">
      <td><div class="stock-cell"><span class="sc-name">${esc(w.stock_name || '')}</span><span class="sc-code">${esc(w.stock_code)}</span></div></td>
      <td class="num">${price != null ? fmt2(price) : FAIL}</td>
      <td class="num ${chg != null ? pnlCls(chg) : ''}">${chg != null ? fmtPct(chg) : FAIL}</td>
      <td class="num">${q && q.open != null ? fmt2(q.open) : '—'}</td>
      <td class="num">${q && q.high != null ? fmt2(q.high) : '—'}</td>
      <td class="num">${q && q.low != null ? fmt2(q.low) : '—'}</td>
      <td class="num">${q && q.prevClose != null ? fmt2(q.prevClose) : '—'}</td>
      <td class="num hint adate">${addDate}</td>
      <td class="num">${anchor != null ? fmtP(anchor) : '—'}</td>
      <td class="num ${gain != null ? pnlCls(gain) : ''}">${gain != null ? fmtPct(gain) : '—'}</td>
      <td class="hint">${esc(w.note || '')}</td>
      <td><div class="row-actions">
        <button class="icon-btn edit-watch" data-id="${w.id}">编辑</button>
        <button class="icon-btn del del-watch" data-id="${w.id}">删除</button>
      </div></td>
    </tr>`;
  }).join('');
  if (empty) {
    empty.hidden = M.listLen > 0;
    /* v3.8.50 空态文案带可点的「＋ 加自选」链接：点它直接展开上方添加区 */
    const g = watchTab || '默认';
    empty.innerHTML = `分组「${esc(g)}」暂无自选，点<a href="javascript:void(0)" class="we-add">「＋ 加自选」</a>添加股票`;
  }
}
function renderWatch() {
  const M = watchModel();
  for (const m of WATCH_MOUNTS) paintWatch(m, M);
  // 分组 datalist 由 syncGroupList() 统一维护
  syncGroupList();
  updateWatchHead();
}
/* 分组下拉数据源（v3.8.82 起为自绘 .wg-list，原 datalist 已删除）：
   所有已用分组 + 当前分组（数据加载完即同步） */
function syncGroupList() {
  const groups = [...new Set([...allWatchGroups(), watchTab])].filter(Boolean);
  const dl = $('tvWfGroupList');
  if (dl) dl.innerHTML = groups.length
    ? groups.map(g => `<div class="wg-item${g === watchTab ? ' on' : ''}" data-g="${esc(g)}">${esc(g)}</div>`).join('')
    : '<div class="wg-empty">暂无分组，可直接输入新分组名</div>';
}
/* ============================================================
   v3.8.78 加自选改为「弹窗」（与「＋ 记一笔」同一交互模式）

   旧做法（v3.8.39~v3.8.77）：标题行「＋ 加自选」按钮在原地**展开**表单
   （.watch-form.open），再靠一整套 revealWatchForm 逻辑在手机键盘弹起后
   把表单滚进可视区 —— 需要 visualViewport 监听、body 补底部留白、多次定时补算，
   代码量大且仍会闪。改为弹窗后，遮罩层天然居中在键盘之上，这套滚动补偿
   逻辑整段不再需要（保留 v3.8.47 的函数仅供历史参考已删除）。

   交互对齐「记一笔」：
     · 点「＋ 加自选」→ 开弹窗（新增态，清空表单）
     · 点行内「编辑」→ 开弹窗并回填（票锁定，只改分组/理由）
     · 提交成功 / 取消 / 点遮罩 / 按 Esc → 关弹窗
   ============================================================ */
function openWatchModal(reset = true) {
  const m = document.getElementById('watchModal');
  if (!m) return;
  if (reset) resetWatchForm(false);            // 清空表单，但先不关弹窗（由下面统一控制）
  m.hidden = false;
  fitWatchModal();                             // v3.8.79 打开即按当前可视视口校准高度
  /* v3.8.79 焦点策略（修「输完光标自动下一个文本框」）：
     只有「用户显式点了我」才自动送光标 —— 点标题栏「＋ 加自选」或空态链接进来时，
     直接给股票框聚焦，省一次点击；从行内「编辑」进来时股票框已只读，光标给备注框。
     键盘 / 按钮触发（relatedTarget 为 null）时不再自动聚焦，避免手机上刚一点开
     就弹键盘、把下面的按钮顶出屏幕外。 */
  const target = watchFocusTarget();
  if (target) setTimeout(() => { try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (e2) { /* */ } } }, 60);
}
/* v3.8.79 弹窗打开后「光标该落在哪」：编辑态（股票框只读）→ 备注框；新增态 → 股票框 */
function watchFocusTarget() {
  const inp = document.getElementById('tvWfInput');
  const note = document.getElementById('tvWfNoteQuick');
  if (!inp) return note || null;
  return (inp.readOnly && note) ? note : inp;
}
function closeWatchModal() {
  const m = document.getElementById('watchModal');
  if (!m) return;
  m.hidden = true;
  const lg = m.querySelector('.modal-lg');
  if (lg) lg.style.maxHeight = '';             // v3.8.79 清掉键盘适配留下的内联高度
  resetWatchForm(false);                       // 关闭即复位（等同取消），不留半截输入
  const sb = document.getElementById('tvWfSug'); if (sb) sb.hidden = true;
  const gl = document.getElementById('tvWfGroupList'); if (gl) gl.hidden = true;   // v3.8.82 分组下拉一并收起
}
/* v3.8.79 加自选弹窗高度跟随可视视口
   —— 与「记一笔」的 scrollRecBottom/fit 同一套思路，但独立实现（两边弹窗高度策略不同：
   记一笔是「滚到底部」，加自选只需保证整窗不被键盘遮住）。
   窄屏时 .modal-lg 的 max-height 由 JS 写内联值（压过 CSS 的 88vh）；
   宽屏沿用 CSS，避免桌面档被多余地限制。
   注意：只有「可视视口比 layout 视口明显缩水（>60px，即键盘弹起的量级）」才跟随，
   否则用 innerHeight —— 地址栏伸缩 / 平板分屏也会让 vv.height 偏小，
   不设阈值的话弹窗会被无谓压扁（headless 截图已复现过这个误判）。 */
function fitWatchModal() {
  const m = document.getElementById('watchModal');
  if (!m || m.hidden) return;
  const lg = m.querySelector('.modal-lg');
  if (!lg) return;
  const vv = window.visualViewport;
  const narrow = window.matchMedia('(max-width: 639px)').matches;
  if (narrow) {
    let vh = window.innerHeight;
    if (vv && vv.height > 0 && window.innerHeight - vv.height > 60) vh = vv.height;
    /* v3.8.82 留白 100px：CSS 里 #watchModal 窄屏内距「上 10 下 90」（累计上移 40px），
       这里保持一致，弹窗才不会顶出视口。 */
    lg.style.maxHeight = Math.max(200, Math.round(vh - 100)) + 'px';
  } else {
    lg.style.maxHeight = '';                   // 宽屏交回 CSS（88vh）
  }
}
(function () {
  const vv = window.visualViewport;
  if (!vv) return;
  let t = null;
  const sync = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      fitWatchModal();
      /* v3.8.79 键盘高度写进 :root 的 --kb，供 style.css 里 #watchModal .modal-lg 的
         max-height 计算兜底（老浏览器没有 dvh 时靠它）。
         同 fitWatchModal：只有缩水超过 60px（键盘量级）才认，否则归 0。
         v3.8.84 顺带在 <html> 上挂 .kb-on：键盘真的弹起时收窄弹窗内下拉的高度
         （分组下拉 / 股票联想 200px 在键盘场景会整条压进键盘底下），见 style.css。 */
      const shrink = window.innerHeight - vv.height - vv.offsetTop;
      const kbOn = shrink > 60;
      document.documentElement.style.setProperty('--kb', kbOn ? Math.round(shrink) + 'px' : '0px');
      document.documentElement.classList.toggle('kb-on', kbOn);
      /* v3.8.84 「电脑端选分组时弹窗标题没了」的修复：
         旧写法只要 vv 触发 scroll/resize（电脑上**滚动页面就会触发**）就对聚焦控件
         scrollIntoView —— scrollIntoView 会连弹窗这个可滚祖先一起滚，把标题+股票框
         滚出弹窗可视区。现在只在「窄屏 + 键盘真的弹起」时才滚（那是它唯一该出场
         的场景：键盘弹起后聚焦框可能被压在键盘底下）。 */
      const m = $('watchModal');
      if (kbOn && window.matchMedia('(max-width: 639px)').matches && m && !m.hidden) {
        const el = document.activeElement;
        if (el && el !== document.body && m.contains(el) &&
            /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
          try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* */ }
        }
      }
    }, 80);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
})();
/* 兼容旧调用点：setWatchFormOpen(m, true/false) 现等价于「开/关弹窗」。
   保留这个函数名，是为了让 bindWatchCard 里的调用点不必全改。 */
function setWatchFormOpen(m, open) {
  if (open) openWatchModal(false);
  else closeWatchModal();
}

function fillWatchForm(w, m) {
  resetWatchForm();                          // 先清空所有挂载点，避免两个表单同时停在编辑态
  S.editingWatchId = w.id;
  const inp = document.getElementById(m.input);
  if (!inp) return;
  inp.value = `${w.stock_code} ${w.stock_name || ''}`;
  delete inp.dataset.picked;
  inp.readOnly = true;                       // 编辑时票不可改，只能改分组/理由
  inp.placeholder = '编辑中：股票不可修改';
  inp.classList.add('ro');
  const gq = document.getElementById(m.group); if (gq) gq.value = w.group_name || '默认';
  const nt = document.getElementById(m.note); if (nt) nt.value = w.note || '';
  const sub = document.getElementById(m.submit); if (sub) sub.textContent = '保存';   /* v3.8.35 编辑态：保存 */
  const cc = document.getElementById(m.cancel); if (cc) cc.hidden = false;
  /* v3.8.78 弹窗标题跟着态变：编辑 → 「编辑自选」 */
  const tt = $('watchModalTitle'); if (tt) tt.textContent = '编辑自选';
  /* v3.8.78 编辑：开弹窗并回填（不再原地展开）。传 reset=false 保留刚填的值 */
  openWatchModal(false);
}
/* v3.8.78 表单复位。参数已无意义（表单不再「展开/收起」，只是弹窗里的内容），
   保留形参是为了不破坏既有调用点；关弹窗由 closeWatchModal() 负责。 */
function resetWatchForm() {
  S.editingWatchId = null;
  /* v3.8.78 标题回到「加自选」（新增态） */
  const wt = document.getElementById('watchModalTitle'); if (wt) wt.textContent = '加自选';
  /* v3.8.34 所有挂载点一并复位 */
  for (const m of WATCH_MOUNTS) {
    const form = document.getElementById(m.form); if (form) form.reset();
    const inp = document.getElementById(m.input);
    if (inp) {
      inp.value = ''; delete inp.dataset.picked;
      inp.readOnly = false;
      inp.placeholder = '代码 / 名称 / 拼音首字母，如 600519、贵州茅台、gzmt';
      inp.classList.remove('ro');
    }
    /* v3.8.86 分组框默认填「当前选中的分组 Tab」。
       旧写法 `gq.value = ''` 每次打开都是空框，用户在「自选 A」组里点加自选，
       还得再手敲一遍分组名 —— 而绝大多数场景就是「加到我现在看的这个组」。
       这里只在新增态（resetWatchForm 仅由 reset=true 的 openWatchModal 调用）填默认值；
       编辑态走 openWatchModal(false)，不经过本函数，稍后由 fillWatchForm 用行内原值覆盖。
       注意：watchTab 是「当前 Tab」，不是「分组是否存在」——极端情况下 Tab 名可能不在
       分组列表里，但提交时后端按字符串存，不影响。 */
    const gq = document.getElementById(m.group);
    if (gq) gq.value = watchTab || '默认';
    const nt = document.getElementById(m.note); if (nt) nt.value = '';
    const sub = document.getElementById(m.submit); if (sub) sub.textContent = '添加';   /* v3.8.35 新增态：添加 */
    const cc = document.getElementById(m.cancel); if (cc) cc.hidden = true;
  }
}
/* ============================================================
   v3.8.34 为一个「自选卡片」挂载点绑定全部交互
   —— 总览页 / 自选页共用同一实现，后续下线某个页面只需移除挂载点
   ============================================================ */
function bindWatchCard(m) {
  const el = id => document.getElementById(id);
  const input = el(m.input);
  if (!input) return false;                    // 该挂载点不存在（页面已下线）
  bindSuggest(m.input, m.sug, h => {
    input.value = `${h.code} ${h.name}`;
    input.dataset.picked = h.code;
    /* v3.8.79 去掉「选完股票光标自动跳备注框」。旧写法无论用户下一步想干嘛都强行
       focus 到备注框，手机上等于「选完立刻弹一次键盘」，用户反馈不想要这个跳转。
       现在只改写 input 自身的 value，光标停在原地 —— 想接着填备注，点一下即可。 */
  });
  /* v3.8.82 分组下拉：原生 datalist 的弹层宽度由浏览器决定（PC 上能铺满半个弹窗），
     无法用 CSS 约束，改为自绘 .wg-list —— 与输入框同宽，聚焦展开、点选填入、
     点击外部 / Esc / 失焦收起；输入框仍可自由输入新分组名（不再聚焦清空）。 */
  const gq = el(m.group);
  if (gq) {
    const gList = document.getElementById('tvWfGroupList');
    const closeGList = () => { if (gList) gList.hidden = true; };
    if (gList) {
      const openGList = () => {
        syncGroupList();
        gList.hidden = false;
        /* v3.8.84 保险：弹窗内容并不需要滚动时（PC 上内容远小于 max-height），
           把可能被误滚的 scrollTop 复位回 0，保证「加自选」标题始终可见。 */
        const lg = gList.closest('.modal-lg');
        if (lg && lg.scrollHeight <= lg.clientHeight + 2 && lg.scrollTop > 0) lg.scrollTop = 0;
      };
      gq.addEventListener('focus', openGList);
      gq.addEventListener('input', openGList);          // 输入中也保持展开（可边输边点选）
      gq.addEventListener('blur', () => setTimeout(closeGList, 150));
      gq.addEventListener('keydown', e => { if (e.key === 'Escape') closeGList(); });
      gList.addEventListener('mousedown', e => {        // mousedown 抢在 blur 前完成点选
        const it = e.target.closest('.wg-item');
        if (!it) return;
        e.preventDefault();
        gq.value = it.dataset.g;
        closeGList();
      });
    }
  }
  /* 提交：编辑（票已定，只改理由/分组，可手动改）或新增 */
  el(m.form).addEventListener('submit', async e => {
    e.preventDefault();
    const noteEl = el(m.note), groupEl = el(m.group);
    const note = noteEl ? noteEl.value.trim() : '';
    const group = (groupEl ? groupEl.value.trim() : '') || watchTab || '默认';
    if (S.editingWatchId) {
      const w = S.watchlist.find(x => x.id == S.editingWatchId);
      if (!w) { resetWatchForm(); return; }
      /* v3.8.83 编辑（改分组）也要防重：同一分组里不允许出现重复标的（跨分组允许）。
         排除自己这条（w.id），把票挪进已含有该票的分组时直接拦下。 */
      if ((w.group_name || '默认') !== group) {
        const dup = S.watchlist.find(x => x.id != w.id &&
          x.stock_code === w.stock_code && (x.group_name || '默认') === group);
        if (dup) { toast(`${w.stock_name || w.stock_code} 已在「${group}」分组中，换个分组即可`, 'warn'); return; }
      }
      try {
        await store.update('watchlist', w.id, { group_name: group, note });
        await store.log('watch', `修改自选 ${w.stock_name || w.stock_code}（理由/分组）`);
        addWatchGroup(group);                // v3.8.50 用到的分组名一并记住
        toast('已保存');
        closeWatchModal();                   // v3.8.78 保存成功即关弹窗
        watchTab = group; try { localStorage.setItem('sj_watchTab', group); } catch (err) { /* */ }
        await loadAll(); renderWatch(); renderToday();
      } catch (err) { toast(err.message || '保存失败', 'warn'); }
      return;
    }
    /* 添加：联想命中 / 「代码 名称」/ 纯代码 / 名称拼音 */
    const picked = input.dataset.picked;
    const txt = input.value.trim();
    let hit = null;
    if (picked && txt.startsWith(picked)) hit = { code: picked, name: txt.slice(picked.length).trim() };
    else hit = StockDict.resolve(txt);
    if (!hit || !hit.code) { toast('未识别股票，请输入代码或名称', 'warn'); return; }
    if (!hit.name) hit.name = hit.code;
    /* v3.8.83 同分组去重：同一分组内不允许重复标的，跨分组可以各加一份
       （例如「600519 贵州茅台」同时进「白酒」和「核心持仓」）。
       旧行为是「全局只要存在就拒绝」（见 addQuick 里的 some 判断），
       导致无法把同一只票放进第二个分组。
       v3.8.85 提示语写清「换个分组就行」，避免用户误以为整只票加不进来。 */
    const dup = S.watchlist.find(x => x.stock_code === hit.code && (x.group_name || '默认') === group);
    if (dup) { toast(`${hit.name || hit.code} 已在「${group}」分组中，换个分组即可再添加`, 'warn'); return; }
    /* 添加时记一个现价锚点（供「自选收益」计算）；网络行情没有则留空 */
    let anchor = NetQuote.get(hit.code);
    if (!anchor) { try { await refreshQuotes(true); } catch (err) { /* */ } anchor = NetQuote.get(hit.code); }
    const row = {
      stock_code: hit.code,
      stock_name: hit.name,
      /* v3.8.85 分组名一律落库为非空字符串：DB 唯一约束是 (owner_id, stock_code, group_name)，
         而 SQL 里 NULL 互不相等，一旦写入 NULL 就等于绕过约束（同组能塞两条）。
         这里统一兜到「默认」，配合约束上的 NULLS NOT DISTINCT 双保险。 */
      group_name: group || '默认',
      note, cur_price: anchor ? anchor.price : null, prev_close: null
    };
    try {
      await store.insert('watchlist', row);
      await store.log('watch', `添加自选 ${row.stock_name}（${row.stock_code}）`);
      addWatchGroup(group);                  // v3.8.50 用到的分组名一并记住
      toast(`已添加自选 ${row.stock_name}`);
      closeWatchModal();                     // v3.8.78 添加成功即关弹窗
      watchTab = group; try { localStorage.setItem('sj_watchTab', group); } catch (err) { /* */ }
      await loadAll(); renderWatch(); renderToday();
    } catch (err) { toast(err.message || '保存失败', 'warn'); }
  });
  const cancelBtn = el(m.cancel);
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeWatchModal());
  /* v3.8.50 空态里的「＋ 加自选」链接（内容随渲染重建，故用事件委托） */
  const emptyEl = el(m.empty);
  if (emptyEl) emptyEl.addEventListener('click', e => {
    if (e.target.closest('.we-add')) openWatchModal(true);
  });  /* v3.8.78 标题行「＋ 加自选」：开弹窗（新增态）。旧版是原地展开/收起切换，
     现在只有「开」这一个动作 —— 关闭交给弹窗自己的 ✕ / 取消 / 遮罩 / Esc */
  const toggleBtn = m.toggle ? el(m.toggle) : null;
  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    openWatchModal(true);
    /* v3.8.79 只在**用户手动点击**（relatedTarget 为 null，即指针/触摸触发）时自动把
       光标送进股票框。键盘 Enter 激活按钮（relatedTarget 是按钮本身）时不抢焦点，
       否则会绕过 openWatchModal 里的「不自动聚焦」策略。 */
    const rt = window.event && window.event.relatedTarget;
    if (rt == null) {
      const t = watchFocusTarget();
      if (t) setTimeout(() => { try { t.focus({ preventScroll: true }); } catch (e) { /* */ } }, 80);
    }
  });
  /* v3.8.41 「删除该分组」按钮也渲染在分组 Tab 行内，走同一处事件委托 */
  const tabs = el(m.tabs);
  if (tabs) tabs.addEventListener('click', e => {
    const b = e.target.closest('.wtab'); if (!b) return;
    /* v3.8.50 只要是「处理分组」（切换 / 新建 / 删除），先把上面的添加区收起来，
       避免分组变了、添加区还停在上一次的半截输入上 */
    resetWatchForm();
    if (b.classList.contains('wtab-del')) { delWatchGroup(); return; }
    const g = b.dataset.g;
    if (g === '+') {
      /* v3.8.43 新建分组改用与「删除该分组」同款的自定义弹窗（原为浏览器原生 prompt） */
      promptDlg('新建分组', '输入新分组名称，确认后自动切到该分组。', name => {
        name = (name || '').trim();
        if (!name) return;
        addWatchGroup(name);                 // v3.8.50 落盘：空分组也要一直显示
        watchTab = name;
        try { localStorage.setItem('sj_watchTab', watchTab); } catch (err) { /* */ }
        renderWatch();
        const gqEl = el(m.group); if (gqEl) gqEl.value = name;
      }, { okText: '新建', placeholder: '如：白酒 / 新能源' });
      return;
    }
    watchTab = g;
    try { localStorage.setItem('sj_watchTab', watchTab); } catch (err) { /* */ }
    renderWatch();
    const gqEl = el(m.group); if (gqEl) gqEl.value = g || '';   // 当前分组即默认归组，可手动改
  });
  const table = el(m.table);
  /* v3.8.22 表头排序：点一下降序 → 再点升序 → 再点取消 */
  table.querySelector('thead').addEventListener('click', e => {
    const th = e.target.closest('th.sortable'); if (!th) return;
    const k = th.dataset.sort;
    if (watchSort.key !== k) watchSort = { key: k, dir: 1 };
    else if (watchSort.dir === 1) watchSort = { key: k, dir: -1 };
    else watchSort = { key: null, dir: 0 };
    renderWatch();
  });
  /* 行操作：编辑（回填到本卡表单） / 删除 */
  table.querySelector('tbody').addEventListener('click', async e => {
    const editBtn = e.target.closest('.edit-watch');
    const delBtn = e.target.closest('.del-watch');
    if (editBtn) {
      const w = S.watchlist.find(x => x.id == editBtn.dataset.id);
      if (w) {
        /* v3.8.78 改为弹窗后不再需要把表单滚进视野（弹窗自带居中），
           fillWatchForm 内部已调用 openWatchModal() */
        fillWatchForm(w, m);
      }
      return;
    }
    if (delBtn) {
      const w = S.watchlist.find(x => x.id == delBtn.dataset.id);
      confirmDlg('删除自选', `确认从自选中删除 ${w.stock_name || w.stock_code}？`, async () => {
        try {
          await store.remove('watchlist', w.id);
          await store.log('delete', `删除自选 ${w.stock_name || w.stock_code}`);
          await loadAll(); renderWatch(); renderToday();
          toast('已删除');
        } catch (err) { toast(err.message || '删除失败', 'warn'); }
      });
    }
  });
  return true;
}

/* v3.8.41 删除当前分组：组内股票移回「默认」
   （按钮渲染在分组 Tab 行的「＋ 新建分组」之后，由 bindWatchCard 的事件委托触发） */
function delWatchGroup() {
  if (!watchTab || watchTab === '默认') return;
  const g = watchTab;
  const n = S.watchlist.filter(w => (w.group_name || '默认') === g).length;
  confirmDlg('删除分组', `确认删除分组「${g}」？${n ? `组内 ${n} 只自选将移回「默认」分组` : '该分组当前为空'}。`, async () => {
    try {
      /* v3.9.11 移回「默认」前先查重：默认组里已有同代码的票时不再 update（否则默认组出现重复行），
         直接删掉本行完成去重 —— 去重由删除逻辑自己消化，全程静默不报错。 */
      const moved = new Set(); let dupN = 0;
      for (const w of S.watchlist.filter(w => (w.group_name || '默认') === g)) {
        const dup = moved.has(w.stock_code)
          || S.watchlist.some(o => o.id !== w.id && o.stock_code === w.stock_code && (o.group_name || '默认') === '默认');
        if (dup) { dupN++; await store.remove('watchlist', w.id); }
        else { moved.add(w.stock_code); await store.update('watchlist', w.id, { group_name: '默认' }); }
      }
      await store.log('update', `删除分组「${g}」（${moved.size} 只移回默认${dupN ? `，${dupN} 只与默认组重复已去重` : ''}）`);
      removeWatchGroup(g);                 // v3.8.50 从持久化分组里移除
      watchTab = '默认';
      try { localStorage.setItem('sj_watchTab', watchTab); } catch (err) { /* */ }
      resetWatchForm();
      await loadAll(); renderWatch(); renderToday();
      toast('分组已删除');
    } catch (err) { toast(err.message || '删除失败', 'warn'); }
  }, '删除');
}

/* ---------- 我的 ---------- */
function renderFeeEditor() {
  const mkts = ['sh', 'sz', 'bse'];
  $('feeEditor').innerHTML = mkts.map(mk => {
    const f = feeCfg(mk);
    const fields = [
      ['rate', '佣金费率 ‰'], ['min', '最低费用 元'],
      ['stamp', '印花税 ‰ (卖出)'], ['transfer', '过户费 ‰'],
      ['handling', '经手费 ‰'], ['gov', '证管费 ‰']
    ];
    return `<div class="fee-mkt">
      <div class="fee-mkt-head">${MKT_NAME[mk] || mk}<span class="hint">最低费用：佣金+规费合计不足该值时按该值收取（印花税除外）</span></div>
      <div class="fee-mkt-grid">
        ${fields.map(([k, label]) => `<label>${label}<input type="number" step="0.001" min="0" data-mkt="${mk}" data-key="${k}" value="${f[k]}"></label>`).join('')}
      </div>
    </div>`;
  }).join('');
}
async function saveFeeEditor() {
  const cfg = { sh: {}, sz: {}, bse: {} };
  $('feeEditor').querySelectorAll('input[data-mkt]').forEach(inp => {
    cfg[inp.dataset.mkt][inp.dataset.key] = parseFloat(inp.value) || 0;
  });
  await saveSetting('fee', cfg);
  await store.log('settings', '更新费率设置');
  toast('费率已保存');
}
/* v3.8.49 设置页「权限收敛」与页签切换
   普通用户（非管理员）只保留「交易费用」「用户管理（改自己密码）」两项；
   模型 / 数据管理 / 操作日志 对普通用户不显示、也不呈现空面板。 */
function switchSetPane(name) {
  document.querySelectorAll('#setTabs .set-tab').forEach(x => x.classList.toggle('active', x.dataset.set === name));
  document.querySelectorAll('#view-me .set-pane').forEach(p => { p.hidden = p.dataset.pane !== name; });
  /* v3.9.9 每次切到技能页都重渲染：Key / 技能开关可能在别处（问答页提示条）刚变过 */
  if (name === 'skill') renderSkillCenter();
}
function renderMe() {
  renderFeeEditor();
  renderLogs();
  renderNetLogUI();
  const cloud = S.mode === 'cloud' && !!S.user;
  const admin = !!(cloud && S.user.role === 'admin');
  const isAdminPane = n => n !== 'cost' && n !== 'user';
  document.querySelectorAll('#setTabs .set-tab').forEach(t => { t.hidden = isAdminPane(t.dataset.set) && !admin; });
  if (!admin) document.querySelectorAll('#view-me .set-pane').forEach(p => { if (isAdminPane(p.dataset.pane)) p.hidden = true; });
  /* 当前停留的页签被隐藏了（普通用户默认落在「模型」）→ 落到第一个可见页签 */
  const act = document.querySelector('#setTabs .set-tab.active');
  if (!act || act.hidden) {
    const first = document.querySelector('#setTabs .set-tab:not([hidden])');
    if (first) switchSetPane(first.dataset.set);
  }
  const acct = $('myAcctCard');
  if (acct) acct.hidden = !cloud;
  const ah = $('myAcctHint');
  if (ah) ah.textContent = cloud ? `当前账号 ${S.user.username}${admin ? '（管理员）' : ''}` : '—';
  $('userMgmtCard').hidden = !admin;
  if (admin) loadUsers();
}
/* ---------- v3.12.4 日志页：改为只读服务器日志文件（页面不再实时展示网络日志） ---------- */
function renderNetLogUI() {
  const el = $('netLogSummary');
  if (!el) return;
  const list = $('netLogList');
  const isSelf = !(location.hostname.endsWith('workbuddy.host')) && location.protocol !== 'file:';
  if (!isSelf) { el.textContent = '云端托管版没有日志文件；数据调用明细仅自托管后端有（deploy/logs/app-日期.log）。'; if (list) list.innerHTML = ''; return; }
  el.textContent = '日志文件：deploy/logs/app-' + new Date().toISOString().slice(0, 10) + '.log（每 2.5 秒批量上报一次调用明细）';
  if (list) list.textContent = '加载中…';
  fetch('/api/logs/tail?n=200', { headers: sjTokenHeaders() }).then(r => r.json()).then(j => {
    if (list) list.innerHTML = '<pre class="srv-log">' + esc((j.lines || []).join('\n') || '(空)') + '</pre>';
  }).catch(e => { if (list) list.textContent = '读取失败：' + (e.message || e); });
}
/* ---------- 费率编辑 ---------- */
function renderLogs() {
  const logs = S.opLogs.slice(0, 20);
  $('logList').innerHTML = logs.length ? logs.map(l => `<div class="mini-item">
    <div class="mini-main">
      <div class="mini-title">${esc(l.action)}</div>
      <div class="mini-sub">${esc(l.summary || '')}</div>
    </div>
    <div class="mini-right"><div class="m-sub">${fmtTime(l.created_at, true)}</div></div>
  </div>`).join('') : '<div class="empty">暂无日志</div>';
}
async function loadUsers() {
  try {
    const r = await rpc('app_list_users', { p_token: S.token });
    if (!r.ok) return;
    $('userTable').querySelector('tbody').innerHTML = r.data.map(u => `<tr>
      <td>${esc(u.username)}</td>
      <td>${u.role === 'admin' ? '<span class="tag">管理员</span>' : '<span class="tag" style="background:var(--bg);color:var(--ink-2)">用户</span>'}</td>
      <td>${fmtTime(u.created_at, true)}</td>
      <td><div class="row-actions">
        <button class="icon-btn reset-user" data-u="${esc(u.username)}">重置密码</button>
        <button class="icon-btn del del-user" data-u="${esc(u.username)}">删除</button>
      </div></td>
    </tr>`).join('');
  } catch (e) { /* 静默 */ }
}

/* ============================================================
   事件绑定
   ============================================================ */
function bindEvents() {
  /* 认证 */
  $('tabLogin').addEventListener('click', () => switchAuthForm('loginForm'));
  $('tabInit').addEventListener('click', () => switchAuthForm('initForm'));
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await doLogin($('loginUser').value.trim(), $('loginPass').value);
    } catch (err) { authMsg(err.message || '登录失败'); }
  });
  $('initForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const r = await rpc('app_setup_admin', { p_username: $('initUser').value.trim(), p_password: $('initPass').value });
      if (!r.ok) { authMsg(r.msg || '初始化失败'); return; }
      authMsg('管理员创建成功，自动登录中…', true);
      await doLogin($('initUser').value.trim(), $('initPass').value);
    } catch (err) { authMsg(err.message || '初始化失败'); }
  });
  $('forcePwdForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const r = await rpc('app_change_pwd', { p_token: S.token, p_old: $('forceOld').value, p_new: $('forceNew').value });
      if (!r.ok) { authMsg(r.msg || '修改失败'); return; }
      S.user.must_change_pwd = false;
      localStorage.setItem('sj_user', JSON.stringify(S.user));
      await enterApp();
      toast('密码已修改');
    } catch (err) { authMsg(err.message || '修改失败'); }
  });
  document.querySelectorAll('.pwd-eye').forEach(b => b.addEventListener('click', () => {
    const inp = $(b.dataset.eye);
    inp.type = inp.type === 'password' ? 'text' : 'password';
  }));
  /* v3.8.57 登录页键盘防遮挡改为纯 CSS 静态上偏（见 style.css .auth-card），
     不再绑定 focus/blur 事件做动态位移——避免输入框之间切换时卡片跳动。 */

  /* 导航 */
  document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  document.querySelectorAll('[data-goto]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.goto)));
  $('logoutBtn').addEventListener('click', () => doLogout(false));

  /* 模态：确认框与输入框共用同一个「确定」按钮（v3.8.43） */
  $('confirmCancel').addEventListener('click', closeConfirm);
  /* v3.8.50 点遮罩空白处即关闭（点弹窗内部不关），新建/删除分组等无需非点「取消」不可 */
  $('confirmModal').addEventListener('click', e => { if (e.target === $('confirmModal')) closeConfirm(); });
  $('confirmOk').addEventListener('click', () => {
    const cb = confirmInputCb || confirmCb;
    const val = confirmInputCb ? $('confirmInput').value.trim() : null;
    closeConfirm();
    if (cb) cb(val);
  });
  /* 输入框内：回车=确定，Esc=取消 */
  $('confirmInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); $('confirmOk').click(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeConfirm(); }
  });

  /* 交易页：AI 解析入口 + 待确认列表（v3.8.46 总览页的 quickNl 入口已随卡片下线） */
  $('tradeParseBtn').addEventListener('click', () => aiParseEntry('tradeNl', 'tradeHint'));
  ['tradeHint'].forEach(hid => $(hid).addEventListener('click', e => {
    const openM = e.target.closest('.p-open-manual');
    if (openM) { setManualOpen(true); return; }
    const saveAllB = e.target.closest('.p-saveall-btn');
    if (saveAllB) { saveAllPending(saveAllB, saveAllB.dataset.close === '1'); return; }
    const saveB = e.target.closest('.p-save-btn');
    if (saveB) {
      const t = pendingTrades[Number(saveB.dataset.i)];
      if (t) savePendingTrade(t, saveB, saveB.dataset.close === '1');
      return;
    }
    const b = e.target.closest('.pfill-btn');
    if (!b) return;
    const t = pendingTrades[Number(b.dataset.i)];
    if (!t) return;
    fillFormFromParsed(t);
    switchView('trades');
    openRecModal(false);
    $(b.dataset.hint).hidden = true;
    $(b.dataset.input).value = '';
  }));
  /* 解析结果一键入库（免表单） */
  async function savePendingTrade(t, btn, closeAfter = false) {
    if (t._saved) { toast('该笔已保存过'); return; }
    /* v3.8.60 入库前再校正一次代码（解析时字典可能尚未就绪，此处兜底） */
    t = reconcileParsedCode(t) || t;
    let code = t.code || '', name = t.name || '';
    if (!code && name) { const hit = StockDict.resolve(name); if (hit && hit.code) { code = hit.code; name = hit.name || name; } }
    if (!code) { toast('未能识别股票代码，请点「改」手动确认', 'warn'); return; }
    if (!(t.price > 0) || !(t.qty > 0)) { toast('价格或数量无法识别，请点「改」手动确认', 'warn'); return; }
    const row = buildTradeRow({
      type: t.type, code, name, market: t.market || inferMarket(code),
      price: parseFloat(t.price), qty: parseInt(t.qty, 10),
      time: (t.time && !isNaN(new Date(t.time))) ? t.time : nowLocalInput(), note: ''
    });
    btn.disabled = true;
    try {
      await store.insert('trades', row);
      await store.log('trade', `新增交易 ${row.stock_name || row.stock_code} ${row.transaction_type === 'buy' ? '买入' : '卖出'} ${row.quantity}股@${row.price}`);
      toast(`已保存：${row.stock_name || row.stock_code} ${row.transaction_type === 'buy' ? '买入' : '卖出'} ${row.quantity}股`);
      if (row.transaction_type === 'buy') await autoWatchOnBuy(code, row.stock_name);   // 买入自动加自选
      btn.textContent = '已存';
      t._saved = true;
      await loadAll(); renderAll(); refreshQuotes();
      if (closeAfter && $('recModal') && !$('recModal').hidden) closeRecModal();
    } catch (err) { btn.disabled = false; toast(err.message || '保存失败', 'warn'); }
  }
  /* 多条解析结果一键全部入库 */
  async function saveAllPending(btn, closeAfter = false) {
    const targets = pendingTrades.filter(t => !t._saved);
    if (!targets.length) { toast('没有待保存的记录'); return; }
    btn.disabled = true;
    let ok = 0;
    for (const t of targets) {
      const ghost = { disabled: false, textContent: '' };
      try { await savePendingTrade(t, ghost); if (t._saved) ok++; } catch (e) { /* 单笔失败继续 */ }
    }
    btn.disabled = false;
    if (ok === targets.length) {
      if (closeAfter) {
        if ($('recModal') && !$('recModal').hidden) closeRecModal(); else $('tradeHint').hidden = true;
        toast(`已全部保存（${ok} 笔）`);
      } else {
        /* 不关闭：刷新列表按钮状态，可继续解析录入 */
        const hid = btn.closest('.quick-hint');
        if (hid) hid.querySelectorAll('.p-save-btn').forEach(b => {
          const t = pendingTrades[Number(b.dataset.i)];
          if (t && t._saved) { b.textContent = '已存'; b.disabled = true; }
        });
        btn.textContent = '已全部保存';
        toast(`已全部保存（${ok} 笔）`);
      }
    } else {
      btn.textContent = `已保存 ${ok}/${targets.length}，其余请点「改」确认`;
    }
  }
  /* 记一笔弹窗：开关与关闭 */
  $('recModalBtn').addEventListener('click', () => { resetTradeForm(); openRecModal(); });
  $('recModalClose').addEventListener('click', closeRecModal);
  $('recModal').addEventListener('mousedown', e => { if (e.target === $('recModal')) closeRecModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('recModal').hidden) closeRecModal(); });
  /* v3.8.78 加自选弹窗：关闭按钮 / 点遮罩关闭 / Esc 关闭（与「记一笔」完全一致的关闭手势） */
  if ($('watchModal')) {
    $('watchModalClose').addEventListener('click', closeWatchModal);
    $('watchModal').addEventListener('mousedown', e => { if (e.target === $('watchModal')) closeWatchModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('watchModal').hidden) closeWatchModal(); });
  }

  /* AI 模型 */
  $('modelCurSel').addEventListener('change', () => { ModelMgr.setCur($('modelCurSel').value); toast('已切换模型'); });
  $('modelReloadBtn').addEventListener('click', async () => {
    const st = $('modelStatus');
    st.textContent = '模型列表刷新中…';
    try { await ModelMgr.reload(); toast('模型列表已刷新'); }
    catch (e) { st.textContent = '模型列表加载失败：' + (e.message || e); }
  });
  $('customModelForm').addEventListener('submit', e => {
    e.preventDefault();
    const m = {
      key: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: $('cmName').value.trim(),
      baseUrl: $('cmBaseUrl').value.trim(),
      model: $('cmModel').value.trim(),
      apiKey: $('cmApiKey').value.trim()
    };
    ModelMgr.custom.push(m);
    ModelMgr.saveCustom();
    /* v3.15.2 添加后自动启用。注意必须用 'c:' + key 字符串 —— 此前传原始对象给
       modelId()，对象上没有 custom 标记，生成的是 'p:undefined'，setCur 永远找不到，
       「配了 DeepSeek 却还在用旧模型/显示未配置」的真凶就是它 */
    ModelMgr.setCur('c:' + m.key);
    $('cmName').value = $('cmBaseUrl').value = $('cmModel').value = $('cmApiKey').value = '';
    toast('自定义模型已添加并启用：' + m.name);
  });
  $('customModelList').addEventListener('click', e => {
    const b = e.target.closest('.cm-del');
    if (!b) return;
    ModelMgr.custom = ModelMgr.custom.filter(c => c.key !== b.dataset.key);
    ModelMgr.saveCustom();
    ModelMgr.loadCur(); ModelMgr.render();
  });

  /* v3.9.9 技能中心：妙想 Key 配置 + 技能添加/删除/启停（事件委托，列表随渲染重建） */
  $('mxKeyEye').addEventListener('click', () => {
    const inp = $('mxKeyInput');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  $('mxKeySaveBtn').addEventListener('click', () => {
    const v = $('mxKeyInput').value.trim();
    if (!v) { toast('请先粘贴 mkt_ 开头的妙想 Key', 'warn'); return; }
    mxKeySet(v);
    $('mxKeyInput').value = '';
    const st = $('mxKeyStatus'); if (st) st.dataset.dirty = '1';
    mxKeyStatusRender('已保存：<span class="mx-ok">' + esc(mxKeyMask()) + '</span>（仅本机浏览器）· 妙想类技能立即可用，可点「测试连接」验证。');
    renderSkillCenter(); qaRefreshSkillHint();
    toast('妙想 Key 已保存（仅本机）');
  });
  $('mxKeyClearBtn').addEventListener('click', () => {
    if (!mxKeyGet()) { toast('当前没有保存过 Key'); return; }
    if (!confirm('确认清除本机保存的妙想 Key？清除后妙想类技能退回「待配置凭据」，问答改用免费公开数据源。')) return;
    mxKeySet('');
    const st = $('mxKeyStatus'); if (st) st.dataset.dirty = '1';
    mxKeyStatusRender();
    renderSkillCenter(); qaRefreshSkillHint();
    toast('妙想 Key 已清除');
  });
  $('mxKeyTestBtn').addEventListener('click', async () => {
    const v = $('mxKeyInput').value.trim() || mxKeyGet();
    const st = $('mxKeyStatus');
    if (!v) { mxKeyStatusRender('<span class="mx-err">请先粘贴 Key（或先保存过一把）再测试</span>'); return; }
    mxKeyStatusRender('测试连接中…（妙想免费额度约 2 秒才能问一次，请稍候）');
    try {
      const r = await mxQuery('贵州茅台最新收盘价', { key: v, timeout: 30000 });
      mxKeyStatusRender('<span class="mx-ok">✅ 连接成功</span>（耗时 ' + (r.ms || 0) + 'ms，返回 '
        + (r.tables && r.tables.length ? r.tables.length + ' 张数据表' : '文本结果') + '）。记得点「保存」把 Key 存进本机。');
      if (st) delete st.dataset.dirty;
    } catch (e) {
      mxKeyStatusRender('<span class="mx-err">❌ 连接失败：' + esc(e.message || e) + '</span>');
    }
  });
  /* v3.17.0 语音转写配置（本机 sj_asr_v1）：后端选择 + 硅基/腾讯密钥，全部不上云 */
  const asrStatusRender = t => { const st = $('asrStatus'); if (st) st.innerHTML = t; };
  (function asrInitUI() {
    const c = sjAsrCfgGet();
    $('asrBackend').value = c.backend;
    if (c.sfKey) $('asrSfKey').placeholder = '硅基流动 Key（已存本机 ' + c.sfKey.slice(0, 5) + '…' + c.sfKey.slice(-4) + '，可粘贴覆盖）';
    if (c.txId) $('asrTxId').placeholder = 'SecretId（已存本机 ' + c.txId.slice(0, 6) + '…，可粘贴覆盖）';
    if (c.txKey) $('asrTxKey').placeholder = 'SecretKey（已存本机 ****' + c.txKey.slice(-4) + '，可粘贴覆盖）';
  })();
  $('asrSfEye').addEventListener('click', () => {
    const i = $('asrSfKey'); i.type = i.type === 'password' ? 'text' : 'password';
  });
  $('asrSaveBtn').addEventListener('click', () => {
    const sf = $('asrSfKey').value.trim(), tid = $('asrTxId').value.trim(), tkey = $('asrTxKey').value.trim();
    const prev = sjAsrCfgGet();
    const c = sjAsrCfgSet({
      backend: $('asrBackend').value,
      sfKey: sf || prev.sfKey,
      txId: tid || prev.txId,
      txKey: tkey || prev.txKey,
    });
    $('asrSfKey').value = ''; $('asrTxId').value = ''; $('asrTxKey').value = '';
    asrStatusRender('<span class="mx-ok">✅ 已保存（仅本机）</span>：后端=' + esc(c.backend)
      + (c.sfKey ? ' · 硅基 Key 已存' : '') + (c.txId ? ' · 腾讯云密钥已存' : ''));
    toast('语音转写配置已保存（仅本机）');
  });
  $('asrClearBtn').addEventListener('click', () => {
    if (!confirm('确认清除本机保存的全部语音转写配置（后端选择 / 各 Key）？')) return;
    localStorage.removeItem('sj_asr_v1');
    $('asrBackend').value = 'auto';
    asrStatusRender('已清除');
    toast('语音转写配置已清除');
  });
  $('asrTestBtn').addEventListener('click', async () => {
    const c = sjAsrCfgGet();
    const lines = [];
    if (c.backend === 'tx' || c.backend === 'auto') {
      try {
        const r = await fetch('/api/asr/tencent', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, (typeof sjTokenHeaders === 'function' ? sjTokenHeaders() : {})),
          body: '{}',
        });
        const j = await r.json().catch(() => ({}));
        lines.push(r.status === 400 ? '✅ 腾讯云代理可达（服务器密钥已配置）'
          : r.status === 501 ? '⚠️ 腾讯云代理可达但未配密钥（服务器 .env 或上方表单填一对后保存）'
          : r.status === 404 ? '❌ 当前页面没有自托管后端（/api/asr/tencent 不存在）——云端版用不了腾讯云，请配硅基流动'
          : '❌ 腾讯云代理异常 HTTP ' + r.status + (j.msg ? '：' + esc(j.msg) : ''));
      } catch (e) { lines.push('❌ 腾讯云代理连不上（当前是云端版？腾讯云仅自托管可用）'); }
    }
    lines.push(c.sfKey ? '✅ 硅基流动 Key 已存本机' : '⚠️ 硅基流动 Key 未配置（云端版直连必需）');
    asrStatusRender(lines.join('<br>'));
  });

  const onSkillListClick = e => {
    const b = e.target.closest('[data-sk]');
    if (!b) return;
    const id = b.dataset.sid, act = b.dataset.sk;
    if (act === 'toggle') {
      const s = skillById(id);
      skillSetEnabled(id, !skillEnabled(id));
      toast(s && skillEnabled(id) ? '已启用「' + s.name + '」' : '已停用「' + (s && s.name || id) + '」');
    } else if (act === 'del') {
      const s = skillById(id);
      const isUser = String(id).indexOf('user-') === 0;
      if (!confirm(isUser
        ? '删除自定义技能「' + (s && s.name || id) + '」？删除后需重新创建（不可恢复）。'
        : '卸载「' + (s && s.name || id) + '」？卸载后问答不再调用它，可在「可添加的技能」里随时装回来。')) return;
      skillUninstall(id);
    } else if (act === 'add') {
      const s = skillById(id);
      skillInstall(id);
      toast('已添加「' + (s && s.name || id) + '」');
    } else if (act === 'upd') {
      /* v3.12.2 技能包更新：幂等重装（重新下载 SKILL.md 覆盖），报告函数增删 */
      const s = skillById(id);
      if (!s || !s.isPack) return;
      toast('正在更新「' + s.name + '」…');
      skillPackInstall(s.url, s.packName).then(r => {
        const diffTxt = (r.added && r.added.length ? '，新增 ' + r.added.length : '') + (r.removed && r.removed.length ? '，移除 ' + r.removed.length : '');
        toast('✅ 已更新「' + s.name + '」（' + r.functions + ' 个函数' + diffTxt + '）');
        renderSkillCenter(); qaRefreshSkillHint();
      }).catch(e => { toast('更新失败：' + (e.message || e), 'warn'); renderSkillCenter(); });
      return;
    }
    renderSkillCenter(); qaRefreshSkillHint();
  };
  $('skillListOn').addEventListener('click', onSkillListClick);
  $('skillListOff').addEventListener('click', onSkillListClick);

  /* v3.11.0 自定义技能：表单保存（名称/触发词/报表/排序/列映射 → 本机注册 → 立即可对话调用） */
  $('uskSaveBtn').addEventListener('click', () => {
    const name = $('uskName').value.trim();
    const kws = $('uskKeywords').value.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    const report = $('uskReport').value.trim().toUpperCase();
    const msg = $('uskMsg');
    if (!name || !kws.length || !report) { msg.textContent = '✗ 名称 / 触发关键词 / 报表名 都是必填'; return; }
    if (!/^RPT[A-Z0-9_]*$/.test(report)) { msg.textContent = '✗ 报表名应以 RPT 开头（东财数据中心命名），如 RPT_LIFT_STAGE'; return; }
    const cols = $('uskCols').value.split(/[,，]+/).map(s => s.trim()).filter(Boolean)
      .map(pair => { const m = pair.split('=').map(x => x.trim()); return { f: m[0], t: m[1] || m[0] }; });
    userSkillSaveRec({
      id: 'user-' + Date.now(),
      name: name,
      icon: '🧩',
      keywords: kws,
      report: report,
      sortCol: $('uskSortCol').value.trim().toUpperCase(),
      sortTypes: $('uskSortDir').value === '1' ? 1 : -1,
      size: Math.min(200, Math.max(1, parseInt($('uskSize').value, 10) || 30)),
      stock: $('uskStock').checked,
      cols: cols,
      enabled: true,
    });
    $('uskName').value = ''; $('uskKeywords').value = ''; $('uskReport').value = ''; $('uskCols').value = '';
    msg.textContent = '✅ 已保存并启用，去问答里用触发词试试（如「' + kws[0] + '」）';
    renderSkillCenter(); qaRefreshSkillHint();
    toast('自定义技能「' + name + '」已创建');
  });

  /* v3.12.0 SKILL.md 技能包：运行时地址 + 整包安装（a-stock-data 等）
     pkRuntime 读写 sj_backend_url —— 它同时是数据 RPC 的后端地址（混合模式总开关） */
  $('pkRuntime').value = BACKEND_URL;
  $('pkSaveRuntimeBtn').addEventListener('click', () => {
    try { localStorage.setItem('sj_backend_url', $('pkRuntime').value.trim().replace(/\/+$/, '')); } catch (e) { /* */ }
    $('pkMsg').textContent = '✅ 后端服务器地址已保存，刷新页面后生效（数据与技能包都会指向它；清空并刷新 = 回到 WorkBuddy 云端）';
    toast('后端服务器地址已更新');
  });
  $('pkInstallBtn').addEventListener('click', async () => {
    if (typeof skillPackInstall !== 'function') return;
    const btn = $('pkInstallBtn'), msg = $('pkMsg');
    btn.disabled = true; msg.textContent = '⏳ 正在下载 SKILL.md 并合成 Python 模块…';
    try {
      const r = await skillPackInstall($('pkUrl').value.trim(), /a-stock-data/i.test($('pkUrl').value) ? 'askill' : undefined);
      msg.textContent = '✅ 已安装「' + r.name + '」（' + r.functions + ' 个函数），表格里可启停，问答里模型会自动调用';
      toast('技能包「' + r.name + '」已安装');
      renderSkillCenter(); qaRefreshSkillHint();
    } catch (e) {
      msg.textContent = '✗ ' + (e.message || e);
      toast('技能包安装失败', 'warn');
    }
    btn.disabled = false;
  });

  /* 设置：分类页签切换 */
  $('setTabs').addEventListener('click', e => {
    const b = e.target.closest('.set-tab');
    if (!b || b.hidden) return;
    switchSetPane(b.dataset.set);
  });

  /* NL 示例词条：点击填入输入框 */
  $('tradeChips').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (c) { $('tradeNl').value = c.dataset.nl; $('tradeNl').focus(); }
  });

  /* 方向：买/卖 Tab 按钮（驱动隐藏 select） */
  $('tfTypeTabs').addEventListener('click', e => {
    const b = e.target.closest('.wtab'); if (!b) return;
    $('tfType').value = b.dataset.t;
    syncTfTypeTabs();
    updateFeePreview();
  });
  /* 手动录入区默认收起，点开关展开 */
  $('tfManualToggle').addEventListener('click', () => setManualOpen($('tfManualWrap').hidden));
  /* 交易表单：股票联想（选定后代码/名称/市场自动确定） */
  bindSuggest('tfStock', 'tfStockSug', h => {
    setTfStock(h.code, h.name);
    updateFeePreview();       // 内部已滚动到底
    $('tfPrice').focus();     // 选完股票，光标进价格框
  });
  $('tfStock').addEventListener('input', () => {
    const inp = $('tfStock');
    if (!(inp.dataset.code && inp.value.trim().startsWith(inp.dataset.code))) {
      delete inp.dataset.code; delete inp.dataset.sname;
    }
    updateFeePreview();
  });
  $('tfType').addEventListener('change', updateFeePreview);
  $('tfPrice').addEventListener('input', updateFeePreview);
  $('tfQty').addEventListener('input', updateFeePreview);
  $('tfReset').addEventListener('click', resetTradeForm);
  $('tradeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const st = resolveTfStock();
    if (!st.code) { toast('请先从联想中选定股票', 'warn'); return; }
    /* 「保存并关闭」或编辑列表记录 → 保存后关弹窗；「保存」则留在弹窗继续录入 */
    const closeAfter = (e.submitter && e.submitter.id === 'tfSubmitClose') || !!S.editingTradeId;
    const row = buildTradeRow({
      type: $('tfType').value,
      code: st.code,
      name: st.name,
      market: st.market,
      price: parseFloat($('tfPrice').value),
      qty: parseInt($('tfQty').value, 10),
      time: $('tfTime').value,
      note: $('tfNote').value.trim()
    });
    try {
      if (S.editingTradeId) {
        await store.update('trades', S.editingTradeId, row);
        await store.log('update', `修改交易 ${row.stock_name || row.stock_code} ${row.transaction_type === 'buy' ? '买入' : '卖出'} ${row.quantity}股@${row.price}`);
        toast('已保存修改');
      } else {
        await store.insert('trades', row);
        await store.log('trade', `新增交易 ${row.stock_name || row.stock_code} ${row.transaction_type === 'buy' ? '买入' : '卖出'} ${row.quantity}股@${row.price}`);
        toast('已记录一笔操作');
        if (row.transaction_type === 'buy') await autoWatchOnBuy(row.stock_code, row.stock_name);   // 买入自动加自选
      }
      resetTradeForm();
      await loadAll(); renderAll();
      if (closeAfter) closeRecModal();
    } catch (err) { toast(err.message || '保存失败', 'warn'); }
  });

  /* 交易列表：筛选 / 编辑 / 删除 / 费用展开 */
  $('tradeModeTabs').addEventListener('click', e => {
    const b = e.target.closest('.wtab'); if (!b) return;
    tradeMode = b.dataset.m || 'list';
    try { localStorage.setItem('sj_tradeMode', tradeMode); } catch (err) { /* */ }
    document.querySelectorAll('#tradeModeTabs .wtab').forEach(x => x.classList.toggle('on', x === b));
    renderTrades();
  });
  document.querySelectorAll('#tradeModeTabs .wtab').forEach(x => x.classList.toggle('on', (x.dataset.m || 'list') === tradeMode));
  /* 默认时间范围：今天（与 chips 初始高亮一致） */
  (() => {
    const now = new Date();
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    $('ftFrom').value = iso(now); $('ftTo').value = iso(now);
  })();
  ['ftFrom', 'ftTo'].forEach(id => $(id).addEventListener('change', () => {
    /* 手动改日期时高亮回落到「全部」；日期清空则回到全部 */
    document.querySelectorAll('#ftChips .fchip').forEach(x => x.classList.toggle('on', x.dataset.q === 'all' && !$('ftFrom').value && !$('ftTo').value));
    renderTrades();
  }));
  /* 快捷时间 chips：近7天 / 近30天 / 近3月 / 今年以来 / 全部 */
  $('ftChips').addEventListener('click', e => {
    const b = e.target.closest('.fchip'); if (!b) return;
    document.querySelectorAll('#ftChips .fchip').forEach(x => x.classList.toggle('on', x === b));
    const now = new Date();
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const q = b.dataset.q;
    if (q === 'all') { $('ftFrom').value = ''; $('ftTo').value = ''; }
    else {
      $('ftTo').value = iso(now);
      if (q === 'today') { $('ftFrom').value = $('ftTo').value; }
      else if (q === '7d') { const d = new Date(now); d.setDate(d.getDate() - 6); $('ftFrom').value = iso(d); }
      else if (q === '30d') { const d = new Date(now); d.setDate(d.getDate() - 29); $('ftFrom').value = iso(d); }
      else if (q === '3m') { const d = new Date(now); d.setMonth(d.getMonth() - 3); $('ftFrom').value = iso(d); }
      else if (q === 'year') $('ftFrom').value = `${now.getFullYear()}-01-01`;
    }
    renderTrades();
  });
  $('ftKw').addEventListener('input', renderTrades);
  $('ftClear').addEventListener('click', () => {
    $('ftFrom').value = ''; $('ftTo').value = ''; $('ftKw').value = '';
    document.querySelectorAll('#ftChips .fchip').forEach(x => x.classList.toggle('on', x.dataset.q === 'all'));
    renderTrades();
  });
  $('tradeTable').querySelector('tbody').addEventListener('click', async e => {
    const editBtn = e.target.closest('.edit-trade');
    const delBtn = e.target.closest('.del-trade');
    const feeCell = e.target.closest('.fee-cell');
    const aggRow = e.target.closest('tr.stockagg');
    if (!editBtn && !delBtn && !feeCell && aggRow) {
      const code = aggRow.dataset.code;
      const next = aggRow.nextElementSibling;
      if (next && next.classList.contains('stock-detail-row')) { next.remove(); stockOpenCodes.delete(code); }
      else {
        const g = lastStockAgg.get(code);
        if (g) { aggRow.insertAdjacentHTML('afterend', stockDetailRow(g)); stockOpenCodes.add(code); }
      }
      return;
    }
    if (editBtn) {
      const t = S.trades.find(x => x.id == editBtn.dataset.id);
      if (t) fillTradeForm(t);
      return;
    }
    if (delBtn) {
      const t = S.trades.find(x => x.id == delBtn.dataset.id);
      confirmDlg('删除记录', `确认删除 ${t.stock_name || t.stock_code} ${t.transaction_type === 'buy' ? '买入' : '卖出'} ${t.quantity}股 @${fmtP(t.price)} 的记录？删除后持仓将重新计算。`, async () => {
        try {
          await store.remove('trades', t.id);
          feeOpenIds.delete(String(t.id));
          await store.log('delete', `删除交易 ${t.stock_name || t.stock_code} ${fmtP(t.price)}x${t.quantity}`);
          await loadAll(); renderAll();
          toast('已删除');
        } catch (err) { toast(err.message || '删除失败', 'warn'); }
      });
      return;
    }
    if (feeCell) {
      const tr = feeCell.closest('tr');
      const id = String(feeCell.dataset.id);
      const next = tr.nextElementSibling;
      if (next && next.classList.contains('fee-detail-row')) { next.remove(); feeOpenIds.delete(id); }
      else {
        const t = S.trades.find(x => x.id == feeCell.dataset.id);
        if (t) { tr.insertAdjacentHTML('afterend', feeDetailRow(t)); feeOpenIds.add(id); }
      }
    }
  });

  /* ---------- 持仓：刷新 / 自动刷新 / 表头排序 / 改价 ---------- */
  /* v3.8.37 持仓页下线：行情刷新入口只剩总览页一处 */
  const refreshQuotesAll = async () => { await loadAll(); await refreshQuotes(true); };
  /* v3.8.65 刷新入口变两处：大盘卡右上角（原位）+ 悬浮条（滚出视野后出现）。
     挂载点数组本就是为此设计的，追加 id 即可自动共用同一套逻辑与状态 */
  ['tvRefreshBtn', 'tvRefreshFab'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', async (e) => {
      /* v3.9.6 点完主动失焦：按钮没有自定义 :focus 样式，用的是浏览器默认焦点环
         （按钮外圈那圈描边）。鼠标点过之后焦点一直留在按钮上，描边就那样挂着，
         直到用户点页面别处 —— 观感像「卡住了」。这里在点击处理的一开始就 blur，
         立刻消除描边（不等到刷新结束，网络慢时也不用盯着那圈框）。
         只对指针点击生效（e.detail > 0）：键盘 Enter/Space 触发的 click 其
         detail 为 0，此时保留焦点环才是正确的无障碍行为，也能连按 Enter 重复刷新。 */
      if (e && e.detail > 0 && document.activeElement === b) b.blur();
      await refreshQuotesAll();
      toast('已刷新行情');
    });
  });
  /* v3.8.65 悬浮条显隐：滚动/缩放时按需同步。
     用 rAF 节流 —— scroll 事件每秒可触发上百次，而 syncQuoteFab 里的
     getBoundingClientRect() 会强制同步布局，每次都跑代价太高 */
  if ($('quoteFab')) {
    let fabRaf = 0;
    const reqFabSync = () => {
      if (fabRaf) return;
      fabRaf = requestAnimationFrame(() => { fabRaf = 0; syncQuoteFab(); });
    };
    window.addEventListener('scroll', reqFabSync, { passive: true });
    window.addEventListener('resize', reqFabSync);
    /* v3.8.76 顺序调整：先定位、再决定显隐。
       旧顺序是 syncQuoteFab() 在前，会把 .on 加上触发淡入，而定位在下一行才做；
       同一次同步执行里浏览器一般来不及画中间帧，但先定位更稳妥（首帧就是正确位置）。 */
    initQuoteFabDrag();
    syncQuoteFab();
  }
  /* v3.8.69 跨 720px 断点时重渲染指数条：涨跌额只在窄屏显示，转屏 / 拉窗口后
     必须重新生成 HTML（否则从宽变窄不会冒出来）。只在「跨过断点」时触发一次，
     普通 resize（手机地址栏收起等）不重渲染，避免白白重建 DOM */
  let idxNarrowPrev = window.matchMedia('(max-width: 720px)').matches;
  window.addEventListener('resize', () => {
    const now = window.matchMedia('(max-width: 720px)').matches;
    if (now === idxNarrowPrev) return;
    idxNarrowPrev = now;
    if (typeof renderToday === 'function') renderToday();
  });
  $('holdRecBtn').addEventListener('click', () => openRecModal());
  /* 空态「去记一笔」：每个持仓挂载点各绑一份 */
  for (const m of HOLD_MOUNTS) {
    const rb = m.recBtn ? document.getElementById(m.recBtn) : null;
    if (rb) rb.addEventListener('click', () => openRecModal());
  }
  /* 自动刷新：总览页行情条的下拉
     v3.8.75 悬浮条已去掉「自动刷新」入口，挂载点只剩大盘卡里的 #tvAuto */
  let holdTimer = null;
  function setHoldAuto(sec, from) {
    if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
    sec = parseInt(sec, 10) || 0;
    ['tvAuto'].forEach(id => {
      const s = document.getElementById(id);
      if (s && s !== from) s.value = String(sec);
    });
    if (sec > 0) holdTimer = setInterval(() => { refreshQuotes(true).catch(() => { /* */ }); }, sec * 1000);
  }
  ['tvAuto'].forEach(id => {
    const s = document.getElementById(id);
    if (s) s.addEventListener('change', () => setHoldAuto(s.value, s));
  });
  setHoldAuto(($('tvAuto') || {}).value || '0');
  /* 点现价手填改价（总览页与持仓页挂载点共用） */
  function startPriceEdit(tr, code, name) {
    const cell = tr.querySelector('.price-cell');
    if (!cell || cell.querySelector('input')) return;
    const q = quoteMap().get(code);
    cell.innerHTML = `<input type="number" step="0.001" min="0" style="width:84px;padding:5px 8px;border:1px solid var(--blue);border-radius:6px" value="${q ? q.price ?? '' : ''}">`;
    const inp = cell.querySelector('input');
    inp.focus();
    const commit = async () => {
      const v = parseFloat(inp.value);
      if (!(v > 0)) { renderHoldings(); return; }
      try {
        const exist = S.quotes.find(x => x.stock_code === code);
        if (exist) await store.update('quotes', exist.id, { price: v, stock_name: name || exist.stock_name });
        else await store.insert('quotes', { stock_code: code, stock_name: name || '', price: v });
        await store.log('quote', `更新 ${name || code} 现价 ${v}`);
        await loadAll(); renderHoldings(); renderToday();
      } catch (err) { toast(err.message || '保存失败', 'warn'); renderHoldings(); }
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') renderHoldings(); });
    inp.addEventListener('blur', commit);
  }
  /* 持仓表：表头三态排序 + 点价改价（HOLD_MOUNTS 内每个挂载点都绑一份） */
  for (const m of HOLD_MOUNTS) {
    const tb = document.getElementById(m.pc);
    if (!tb) continue;
    const thead = tb.querySelector('thead');
    if (thead) thead.addEventListener('click', e => {
      const th = e.target.closest('th.sortable'); if (!th) return;
      const k = th.dataset.sort;
      if (holdSort.key !== k) holdSort = { key: k, dir: 1 };
      else if (holdSort.dir === 1) holdSort = { key: k, dir: -1 };
      else holdSort = { key: null, dir: 0 };
      renderHoldings();
    });
    const tbody = tb.querySelector('tbody');
    if (tbody) tbody.addEventListener('click', e => {
      const sp = e.target.closest('.set-price');
      if (sp) { startPriceEdit(sp.closest('tr'), sp.dataset.code, sp.dataset.name); return; }
    });
  }

  /* ---------- 自选：添加 / 编辑 / 分组 / 排序（WATCH_MOUNTS 内每个挂载点都绑一份） ---------- */
  for (const m of WATCH_MOUNTS) bindWatchCard(m);

  /* v3.8.23 网络日志：下载 / 清空 */
  $('netLogDlBtn').addEventListener('click', async () => {
    if (location.hostname.endsWith('workbuddy.host') || location.protocol === 'file:') return toast('云端托管版没有日志文件（仅自托管后端有）', 'warn');
    /* v3.15.1 下载走 fetch 带 token（location.href 无法带自定义头） */
    try {
      const r = await fetch('/api/logs/download', { headers: sjTokenHeaders() });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'app-' + new Date().toISOString().slice(0, 10) + '.log';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch (e) { toast('下载失败：' + (e.message || e), 'warn'); }
  });
  $('netLogClearBtn').addEventListener('click', () => { renderNetLogUI(); });

  /* v3.10.1 K线库：统计展示 + 自动同步开关 + 立即同步（设置 → 数据管理） */
  async function renderKlibStatUI() {
    const sum = $('klibStatSummary'), daily = $('klibStatDaily');
    if (!sum) return;
    /* v3.12.6 自托管：改用服务端「按 K 线交易日」的对账统计（此前按入库日分组，
       首次回补把 280 天历史全记在回补当天名下，极易误读为数据结构有问题） */
    const isSelf = !(location.hostname.endsWith('workbuddy.host')) && location.protocol !== 'file:';
    if (isSelf && S.mode === 'cloud') {
      sum.textContent = 'K线库（服务端 PostgreSQL）：每只股票一行，bars 数组每天一条 [日期,开,收,高,低,量,额]——按交易日可查任意一天的涨跌幅排名。';
      daily.innerHTML = '<p class="hint">交易日覆盖统计加载中…</p>';
      try {
        const j = await fetch('/api/klib/daily', { headers: sjTokenHeaders() }).then(r => r.json());
        if (!j.ok) throw new Error(j.msg || '统计失败');
        const pct = d => j.total ? (d.stocks / j.total * 100).toFixed(1) + '%' : '--';
        daily.innerHTML = '<div class="table-wrap"><table class="batch-table"><thead><tr>'
          + '<th>K线交易日</th><th class="num">当日有K线的股票数</th><th class="num">占总票数</th>'
          + '</tr></thead><tbody>'
          + j.rows.slice(0, 20).map(r => '<tr><td>' + esc(r.day) + '</td><td class="num">'
            + Number(r.stocks).toLocaleString('zh-CN') + '</td><td class="num">' + pct(r) + '</td></tr>').join('')
          + '</tbody></table></div>'
          + '<p class="hint">结构：每只股票一行（共 ' + j.total.toLocaleString('zh-CN') + ' 行），bars 数组每天一条记录；任意交易日的涨跌幅排名都可以按日期计算。统计缓存 10 分钟。</p>';
      } catch (e) {
        daily.innerHTML = '<p class="hint">交易日统计读取失败：' + esc(e.message || e) + '</p>';
      }
      return;
    }
    const meta = (typeof KLib !== 'undefined') ? await KLib.metaGet().catch(() => ({})) : {};
    let cloud = null;
    try { if (typeof KLib !== 'undefined' && S.mode === 'cloud' && S.token) cloud = await KLib.cloudStats(); }
    catch (e) { cloud = null; }
    const st = (typeof KLib !== 'undefined') ? KLib.statRows(cloud, meta) : { summary: '—', rows: [] };
    sum.textContent = st.summary;
    if (!st.rows.length) { daily.innerHTML = '<p class="hint">云端还没有入库记录。</p>'; return; }
    daily.innerHTML = '<div class="table-wrap"><table class="batch-table"><thead><tr>'
      + '<th>交易日</th><th class="num">入库股票数</th><th class="num">K线根数</th><th class="num">覆盖度</th>'
      + '</tr></thead><tbody>'
      + st.rows.slice(0, 15).map(r => '<tr><td>' + esc(r.d) + '</td><td class="num">' + r.stocks
        + '</td><td class="num">' + Number(r.bars).toLocaleString('zh-CN') + '</td><td class="num">'
        + (r.pct == null ? '--' : r.pct + '%') + '</td></tr>').join('')
      + '</tbody></table></div>'
      + (st.rows.length > 15 ? '<p class="hint">仅显示最近 15 个交易日，共 ' + st.rows.length + ' 天有入库记录。</p>' : '');
  }
  $('klibAutoChk').checked = (typeof KLib !== 'undefined') ? KLib.autoOn() : true;
  $('klibAutoChk').addEventListener('change', () => {
    if (typeof KLib === 'undefined') return;
    try { localStorage.setItem(KLib.AUTO_KEY, $('klibAutoChk').checked ? '1' : '0'); } catch (e) { /* */ }
    toast($('klibAutoChk').checked ? '已开启：打开应用时自动增量同步' : '已关闭自动同步');
  });
  $('klibSyncBtn').addEventListener('click', async () => {
    if (typeof KLib === 'undefined') return toast('K线库模块未加载');
    const btn = $('klibSyncBtn');
    btn.disabled = true; btn.textContent = '⏳ 同步中…';
    try {
      const r = await KLib.ensure(p => { btn.textContent = '⏳ ' + (p.stage || '同步中…').slice(0, 12); });
      toast('K线库已同步：' + r.n + ' 只 · 最新 ' + r.targetDate + (r.failed ? '（失败 ' + r.failed + '）' : ''));
    } catch (e) { toast('同步失败：' + (e && e.message || e)); }
    btn.disabled = false; btn.textContent = '🔄 立即同步';
    renderKlibStatUI();
  });
  /* 首次渲染必须等 kline-store.js 加载完（它在 app.js 之后执行）——同步调用时 KLib 必然
     还是 undefined，摘要会落进 '—' 分支且再无重渲染时机，所以用宏任务推迟 */
  setTimeout(renderKlibStatUI, 50);

  /* 我的：费率 */
  $('feeSaveBtn').addEventListener('click', saveFeeEditor);
  $('feeResetBtn').addEventListener('click', () => { S.settings.fee = null; delete S.settings.fee; renderFeeEditor(); toast('已恢复默认（记得保存生效）'); });
  $('calcBtn').addEventListener('click', () => {
    const amount = parseFloat($('calcAmount').value);
    if (!(amount >= 0)) { $('calcResult').innerHTML = ''; return; }
    const mk = $('calcMarket').value;
    const dir = $('calcType').value;
    const detail = f => `
      <span>佣金 <b>${fmt2(f.commission)}</b></span>
      <span>印花税 <b>${fmt2(f.stamp)}</b></span>
      <span>过户费 <b>${fmt2(f.transfer || 0)}</b></span>
      <span>经手费 <b>${fmt2(f.handling || 0)}</b></span>
      <span>证管费 <b>${fmt2(f.gov || 0)}</b></span>`;
    if (dir === 'both') {
      const buy = calcFees(amount, 'buy', mk), sell = calcFees(amount, 'sell', mk);
      $('calcResult').innerHTML = `
        <span>买入合计 <b>${fmt2(buy.total)}</b></span>${detail(buy)}
        <span>卖出合计 <b>${fmt2(sell.total)}</b></span>${detail(sell)}`;
    } else {
      const f = calcFees(amount, dir, mk);
      $('calcResult').innerHTML = `
        <span>${dir === 'buy' ? '买入' : '卖出'}费用合计 <b>${fmt2(f.total)}</b></span>${detail(f)}`;
    }
  });

  /* 我的：数据管理 */
  $('exportBtn').addEventListener('click', () => {
    const data = {
      version: 2, exported_at: new Date().toISOString(), mode: S.mode,
      trades: S.trades, watchlist: S.watchlist, quotes: S.quotes, settings: S.settings
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `操作日记备份-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出备份');
  });
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.trades) && !Array.isArray(data.watchlist)) { toast('备份文件格式不对', 'warn'); return; }
        confirmDlg('导入备份', `将清空当前全部数据并导入备份（交易 ${data.trades.length} 条、自选 ${data.watchlist.length} 条），确认继续？`, async () => {
          try {
            await store.clearData(['trades', 'watchlist', 'quotes', 'op_logs']);
            const strip = arr => (arr || []).map(({ id, owner_id, created_at, ...rest }) => rest);
            await store.bulkInsert('trades', strip(data.trades));
            await store.bulkInsert('watchlist', strip(data.watchlist));
            await store.bulkInsert('quotes', strip(data.quotes));
            if (data.settings) await saveSetting('fee', data.settings.fee || {});
            await store.log('import', `导入备份：交易 ${data.trades.length} 条、自选 ${data.watchlist.length} 条`);
            await loadAll(); renderAll();
            toast('导入完成');
          } catch (err) { toast(err.message || '导入失败', 'warn'); }
        }, '导入');
      } catch (err) { toast('备份文件解析失败', 'warn'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  });
  $('clearBtn').addEventListener('click', () => {
    $('clearArea').hidden = false;
    $('clearConfirmInput').focus();
  });
  $('clearConfirmInput').addEventListener('input', () => {
    $('clearConfirmBtn').disabled = $('clearConfirmInput').value.trim() !== '清空';
  });
  $('clearConfirmBtn').addEventListener('click', async () => {
    try {
      await store.clearData(['trades', 'watchlist', 'quotes', 'op_logs']);
      await store.log('clear', '清空全部数据（费率保留）');
      $('clearArea').hidden = true;
      $('clearConfirmInput').value = '';
      $('clearConfirmBtn').disabled = true;
      await loadAll(); renderAll();
      toast('已清空全部数据');
    } catch (err) { toast(err.message || '清空失败', 'warn'); }
  });
  $('feeRecalcBtn').addEventListener('click', () => {
    const initRows = S.trades.filter(isInitTrade);
    const normal = S.trades.filter(t => !isInitTrade(t));
    const tip = initRows.length
      ? `\n\n· ${initRows.length} 条初始持仓记录（费用 0、成本=建仓价）将跳过，成本保持不变`
      : '';
    confirmDlg('重算历史费用', `将按当前费率设置与券商式费用口径（各项先按分取整再汇总；最低佣金由佣金补足规费差额）重新计算 ${normal.length} 条交易的费用与发生金额，持仓成本/盈亏随之变化。${tip}\n\n确定执行？`, async () => {
      try {
        let n = 0;
        for (const t of normal) {
          const fee = calcFees(t.gross_amount, t.transaction_type, t.market, t.stock_code);
          const net = t.transaction_type === 'buy' ? t.gross_amount + fee.total : t.gross_amount - fee.total;
          if (JSON.stringify(t.fee) !== JSON.stringify(fee) || Number(t.net_amount) !== net) {
            await store.update('trades', t.id, { fee, net_amount: net });
            n++;
          }
        }
        await store.log('update', `按当前费率重算历史费用（${n} 条变更）`);
        await loadAll(); renderAll(); refreshQuotes();
        toast(initRows.length ? `已重算：${n} 条变更（跳过 ${initRows.length} 条初始持仓）` : `已重算：${n} 条费用有变更`);
      } catch (err) { toast(err.message || '重算失败', 'warn'); }
    }, '重算');
  });
  $('seedBtn').addEventListener('click', async () => {
    confirmDlg('载入演示数据', '将写入 2 只持仓、5 条交易记录、3 只自选股及其现价（不影响现有数据，可随时清空）。', async () => {
      try {
        const T = (time, type, code, name, market, qty, price) => buildTradeRow({ type, code, name, market, price, qty, time });
        const trades = [
          T('2026-09-10T10:00', 'buy', '000063', '中兴通讯', 'sz', 1000, 38.50),
          T('2026-09-18T14:30', 'sell', '000063', '中兴通讯', 'sz', 500, 41.20),
          T('2026-09-25T09:40', 'buy', '300750', '宁德时代', 'sz', 200, 255.00),
          T('2026-10-08T11:05', 'buy', '601318', '中国平安', 'sh', 300, 52.60),
          T('2026-10-09T13:50', 'sell', '300750', '宁德时代', 'sz', 100, 248.00)
        ];
        for (const t of trades) await store.insert('trades', t);
        for (const w of [
          { stock_code: '600519', stock_name: '贵州茅台', group_name: '消费', note: '高端白酒观察，等回调', cur_price: 1500, prev_close: 1490, starred: true },
          { stock_code: '002594', stock_name: '比亚迪', group_name: '科技', note: '智驾进展跟踪', cur_price: 248, prev_close: 252, starred: false },
          { stock_code: '688041', stock_name: '海光信息', group_name: '科技', note: '国产算力', cur_price: 98.5, prev_close: 96.2, starred: false }
        ]) await store.insert('watchlist', w);
        await store.log('seed', '载入演示数据（2 持仓 / 5 交易 / 3 自选）');
        await loadAll(); renderAll();
        toast('演示数据已载入');
      } catch (err) { toast(err.message || '载入失败', 'warn'); }
    }, '载入');
  });
  $('logReloadBtn').addEventListener('click', async () => { await loadAll(); renderMe(); });

  /* v3.8.49 普通用户自助改密（管理员改他人密码走下面「用户管理」的「重置密码」） */
  $('myPwdForm').addEventListener('submit', async e => {
    e.preventDefault();
    const oldP = $('mpOld').value, n1 = $('mpNew').value, n2 = $('mpNew2').value;
    if (n1 !== n2) { toast('两次输入的新密码不一致', 'warn'); return; }
    if (n1.length < 6) { toast('新密码至少 6 位', 'warn'); return; }
    if (n1 === oldP) { toast('新密码与当前密码相同，无需修改', 'warn'); return; }
    try {
      const r = await rpc('app_change_pwd', { p_token: S.token, p_old: oldP, p_new: n1 });
      if (!r.ok) { toast(r.msg || '修改失败', 'warn'); return; }
      ['mpOld', 'mpNew', 'mpNew2'].forEach(id => { $(id).value = ''; });
      if (S.user) { S.user.must_change_pwd = false; try { localStorage.setItem('sj_user', JSON.stringify(S.user)); } catch (err) { /* */ } }
      await store.log('user', '修改本账号登录密码');
      toast('密码已修改，下次登录请用新密码');
    } catch (err) { toast(err.message || '修改失败', 'warn'); }
  });

  /* 用户管理 */
  $('userCreateForm').addEventListener('submit', async e => {
    e.preventDefault();
    const uname = $('nuName').value.trim();
    try {
      const r = await rpc('app_create_user', { p_token: S.token, p_username: uname, p_password: $('nuPass').value, p_role: $('nuRole').value });
      if (!r.ok) { toast(r.msg || '创建失败', 'warn'); return; }
      $('nuName').value = ''; $('nuPass').value = '';
      await store.log('user', `创建账号 ${uname}`);
      await loadUsers();
      toast('账号已创建（首次登录需改密）');
    } catch (err) { toast(err.message || '创建失败', 'warn'); }
  });
  $('userTable').querySelector('tbody').addEventListener('click', async e => {
    const resetBtn = e.target.closest('.reset-user');
    const delBtn = e.target.closest('.del-user');
    if (resetBtn) {
      const u = resetBtn.dataset.u;
      /* v3.8.43 同样改用自定义输入弹窗（原为浏览器原生 prompt） */
      promptDlg('重置密码', `为「${u}」设置新密码，至少 6 位。`, async newP => {
        if (!newP) return;
        try {
          const r = await rpc('app_reset_pwd', { p_token: S.token, p_username: u, p_new: newP });
          if (!r.ok) { toast(r.msg || '重置失败', 'warn'); return; }
          toast('已重置，该用户下次登录需改密');
        } catch (err) { toast(err.message || '重置失败', 'warn'); }
      }, { okText: '重置', placeholder: '至少 6 位' });
      return;
    }
    if (delBtn) {
      const u = delBtn.dataset.u;
      confirmDlg('删除账号', `确认删除账号「${u}」？该用户的全部交易、自选、日志数据将一并删除，不可恢复。`, async () => {
        try {
          const r = await rpc('app_delete_user', { p_token: S.token, p_username: u });
          if (!r.ok) { toast(r.msg || '删除失败', 'warn'); return; }
          await loadUsers();
          toast('账号已删除');
        } catch (err) { toast(err.message || '删除失败', 'warn'); }
      }, '删除');
    }
  });
}
function fillFormFromParsed(res) {
  resetTradeForm();
  setManualOpen(true);
  $('tfType').value = res.type;
  syncTfTypeTabs();
  if (res.code) setTfStock(res.code, res.name || '');
  $('tfPrice').value = res.price;
  $('tfQty').value = res.qty;
  if (res.time) {
    const d = new Date(res.time);
    if (!isNaN(d)) {
      const p = n => String(n).padStart(2, '0');
      $('tfTime').value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }
  }
  updateFeePreview();
}
/* v3.8.65 行情悬浮条显隐判定。
   出现条件：① 当前在总览页（其他页没有行情条，出现即误导）；
   ② 大盘卡右上角的原刷新按钮已完全滚出视口上方（rect.bottom < 0）。
   不用 IntersectionObserver 的 isIntersecting：这里要的是「原位入口彻底看不见了」
   这一明确语义，而带阈值/比例的相交判定会让按钮刚露半个在屏顶时悬浮条就冒出来，
   同一功能两处入口同时可见。 */
function syncQuoteFab() {
  const fab = document.getElementById('quoteFab');
  if (!fab) return;
  const today = document.getElementById('view-today');
  const anchor = document.getElementById('tvRefreshBtn');
  const show = !!(today && today.classList.contains('active'))
    && (!anchor || anchor.getBoundingClientRect().bottom < 0);
  fab.classList.toggle('on', show);
}

/* ---------- v3.8.66 行情悬浮条：可上下拖动 + 高度记忆 ----------
   横向不动，永远贴着右边（避免条子被拖到屏幕中间挡内容）；只让纵向可调，
   纵向由内联 top 接管。用户拖过之后把 top 写进 localStorage，下次打开仍停在他放的高度。
   v3.8.76：没有存档时也由 JS 量算真实落位（不再依赖 CSS 常量），只是不写存档 ——
   这样首屏位置和拖动后的位置用的是同一套算法，不会再出现「先压顶栏、一会儿跳下去」。 */
const QF_POS_KEY = 'sj_qf_pos';
/* 纵向夹取：条子始终完整可见，且两头不让它压住顶栏 / 底部 Tab 栏 */
function setQuoteFabTop(fab, t) {
  const h = fab.offsetHeight || 44;
  /* 上界：视口底；手机端再避开底部 Tab（底部导航 z-index 50 > 条子 45，压进去就点不到了） */
  let hi = window.innerHeight - h - 8;
  const nav = document.querySelector('.bottom-nav');
  if (nav && getComputedStyle(nav).display !== 'none') {
    hi = Math.min(hi, nav.getBoundingClientRect().top - 8 - h);
  }
  hi = Math.max(8, hi);
  /* 下界：顶栏底部 + 8。顶栏是 sticky，贴着它下沿既是「最上面」的位置，
     也不会遮住顶栏里的退出等按钮。
     v3.8.76：sticky 顶栏滚出视口后 rect.bottom 会变成负数（顶栏已经缩上去），
     此时不能再拿它当基准，否则 lo 变负、条子被顶到视口外。故夹到 [8, hi] 区间。
     v3.8.87：导航栏 .tabs 也吸顶了（PC 端），只让开顶栏会让悬浮条压在导航上 ——
     基准取「顶栏底」与「导航底」的较大者，两层都吸顶时自然落在导航之下；
     手机端 .tabs 是 display:none（rect 全 0），取 topbar 即可，行为不变。 */
  const bar = document.querySelector('.topbar');
  const barBottom = bar ? bar.getBoundingClientRect().bottom : 8;
  const tabs = document.querySelector('.tabs');
  let base = barBottom;
  if (tabs && getComputedStyle(tabs).display !== 'none') {
    const tr = tabs.getBoundingClientRect();
    if (tr.height > 0) base = Math.max(base, tr.bottom);
  }
  let lo = (base > 0 ? base : 8) + 8;
  lo = Math.max(8, Math.min(lo, hi));
  const t2 = Math.min(Math.max(lo, t), hi);
  fab.style.top = t2 + 'px';
  return t2;
}
function saveQuoteFabPos(fab) {
  try {
    localStorage.setItem(QF_POS_KEY, JSON.stringify({ t: parseFloat(fab.style.top) || 0 }));
  } catch (e) { /* 隐私模式等写不进去，忽略：位置只是偏好，丢了不影响功能 */ }
}
function initQuoteFabDrag() {
  const fab = $('quoteFab');
  if (!fab) return;
  /* v3.8.76 首次落位修复：不管有没有拖动存档，都先用 JS 量算一次真实位置。
     旧写法只在「有存档」时才 setQuoteFabTop()，没存档就纯靠 CSS 常量猜顶栏高度；
     而 topbar 是 sticky + height:auto，字体/图标晚加载会让它比常量更高，
     于是首屏悬浮条会先压住顶栏的退出按钮，等某次 scroll/resize 才纠正 —— 这就是
     「先在上面、一会儿跑到下面」的根因。现在无条件量算，CSS 只当兜底。 */
  let saved = null;
  try {
    const p = JSON.parse(localStorage.getItem(QF_POS_KEY) || 'null');
    if (p && typeof p.t === 'number') saved = p.t;
  } catch (e) { /* 存档损坏则忽略，走默认落位 */ }
  /* 有存档就在存档高度处夹取；没存档传 0 —— setQuoteFabTop 里 Math.max(lo, 0) = lo，
     正好落到「顶栏底部 + 8」这一最低允许位置（传大值会被上界夹到视口底部，那就错了） */
  setQuoteFabTop(fab, saved == null ? 0 : saved);
  /* 二次校正：字体/图标（SVG 已内联，但字体可能晚到）会让顶栏高度变化，
     等字体就绪后按新高度重算一次，避免仍按首帧的旧高度定位 */
  const reflow = () => {
    if (!fab.style.top) return;
    setQuoteFabTop(fab, parseFloat(fab.style.top) || 0);
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(reflow).catch(() => { /* */ });
  /* 顶栏高度可能因窗口变化、模式徽章增减等变动：直接盯它，一变就跟着调，
     不再依赖「必须滚动一下才会纠正」。
     v3.8.87：导航栏 .tabs 也参与落位基准（吸顶后它压在顶栏之下），同样盯上 ——
     它可能因 flex-wrap 换行而改变高度，不跟就会让悬浮条压住第二行 Tab。 */
  if (window.ResizeObserver) {
    const watch = [document.querySelector('.topbar'), document.querySelector('.tabs')];
    for (const el0 of watch) {
      if (el0) { try { new ResizeObserver(() => { reflow(); }).observe(el0); } catch (e) { /* */ } }
    }
  }

  let dragging = false, moved = false, sy = 0, oy = 0, pid = null;
  fab.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    /* 下拉与按钮必须能被正常点开，按下它们时不进入拖动（只让条身与手柄拖动） */
    if (e.target.closest && e.target.closest('select, button, option')) return;
    dragging = true; moved = false; pid = e.pointerId;
    sy = e.clientY; oy = fab.getBoundingClientRect().top;
    try { fab.setPointerCapture(pid); } catch (err) { /* 老浏览器不支持捕获也不影响拖动 */ }
    e.preventDefault();   /* 顺带屏蔽拖动过程中的原生拖拽与文字选中 */
  });
  fab.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    /* 只认纵向位移：横向一概不理会，条子始终贴右边（3px 以内当手抖，不算拖动） */
    const dy = e.clientY - sy;
    if (!moved && Math.abs(dy) < 3) return;
    moved = true;
    fab.classList.add('dragging');
    setQuoteFabTop(fab, oy + dy);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    fab.classList.remove('dragging');
    try { fab.releasePointerCapture(pid); } catch (err) { /* */ }
    if (moved) saveQuoteFabPos(fab);   /* 只是点了一下没拖动，就不写存档 */
  };
  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);
  /* 窗口尺寸变化（含手机横竖屏）可能把条子挤出视口，按新高度重新夹取并存档 */
  window.addEventListener('resize', () => {
    if (!fab.style.top) return;
    setQuoteFabTop(fab, parseFloat(fab.style.top) || 0);
    saveQuoteFabPos(fab);
  });
}

function switchView(name) {
  /* v3.8.37 持仓页 / 自选页已下线：旧会话残留的 sj_view 或历史入口统一回落到总览 */
  if (!$('view-' + name)) name = 'today';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-' + name).classList.add('active');
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  try { localStorage.setItem('sj_view', name); } catch (e) { /* */ }
  /* v3.8.65 切页后总览页可能停在滚动中间位置，需立刻重算悬浮条显隐 */
  syncQuoteFab();
  if (name === 'analysis' && typeof switchAnalysisTab === 'function') {
    if (typeof renderAnalysisSelect === 'function') renderAnalysisSelect();
    if (typeof renderBtOptions === 'function') { try { renderBtOptions(); } catch (e) { /* */ } }
    switchAnalysisTab(typeof anTab !== 'undefined' ? anTab : 'diag');
  }
  /* v3.9.0 切到问答页：重绘一次（消息可能在本页外生成完，DOM 是重建的） */
  if (name === 'qa' && typeof renderQaMessages === 'function') {
    try { renderQaMessages(); renderQaHistory(); qaSyncSendState(); } catch (e) { /* */ }
  }
  /* v3.9.9 切到问答页时同步技能状态条（用户可能刚在设置里改了技能开关 / 妙想 Key） */
  if (name === 'qa' && typeof qaRefreshSkillHint === 'function') {
    try { qaRefreshSkillHint(); } catch (e) { /* */ }
  }
}

/* ============================================================
   分析中心 · 个股诊断（完整迁移自 trade-manager）
   技术面规则引擎（确定性、可复现）+ AI 综合解读（用户点按钮才生成）
   ============================================================ */
/* ---- K 线数据（腾讯为主——浏览器可跨域直连，东财兜底）---- */
function secidOf(code) {
  if (inferMarket(code) === 'bj') return '0.' + code;   // 东财北交所用 0 前缀
  return /^(6|5|9)/.test(code) ? '1.' + code : '0.' + code;
}
async function fetchKlineEast(code, klt, lmt) {
  /* v3.10.0 fields2 增加 f57（成交额，元）—— K 线库需要逐日成交额做流动性门槛；
     旧字段序列只有 OHLCV，K 线库的「成交额 ≥ 0.5 亿」只能用 收盘×量 近似 */
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secidOf(code)
    + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=' + klt + '&fqt=1&end=20500101&lmt=' + lmt;
  const t0 = Date.now();
  try {
    const res = await fetch(url);
    const j = await res.json();
    const bars = ((j.data && j.data.klines) || []).map(s => {
      const a = s.split(',');
      return { d: a[0], o: +a[1], c: +a[2], h: +a[3], l: +a[4], v: +a[5] || 0, a: +a[6] || 0 };
    });
    NetLog.push('kline', '东财 push2his', bars.length > 0, Date.now() - t0, `${code} klt=${klt} ${bars.length}根`,
      { url, resp: bars.length ? `${bars.length}根 末根 ${bars[bars.length - 1].d} 收${bars[bars.length - 1].c}` : '未获取到（0 根）', err: bars.length ? '' : '未获取到' });
    return { name: (j.data && j.data.name) || code, bars };
  } catch (e) {
    NetLog.push('kline', '东财 push2his', false, Date.now() - t0, `${code} klt=${klt} ${e.message || e}`, { url, err: e.message || String(e) });
    throw e;
  }
}
/* 腾讯日 / 周 K：3 个等价端点轮询（fqkline 路径在高频下可能被 WAF 拦截 501） */
const KL_URLS = [
  function (sym, period, lmt) { return 'https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + sym + ',' + period + ',,,' + lmt + ',qfq'; },
  function (sym, period, lmt) { return 'https://web.ifzq.gtimg.cn/appstock/app/newfqkline/get?param=' + sym + ',' + period + ',,,' + lmt + ',qfq'; },
  function (sym, period, lmt) { return 'https://ifzq.gtimg.cn/appstock/app/newfqkline/get?param=' + sym + ',' + period + ',,,' + lmt + ',qfq'; },
];
async function fetchKlineTxRaw(code, period, lmt) {
  const sym = inferMarket(code) === 'bj' ? 'bj' + code : inferMarket(code) + code;
  let sawBlock = false, last = { name: code, bars: [] };
  for (const mk of KL_URLS) {
    const t0 = Date.now();
    const url = mk(sym, period, lmt);
    try {
      const res = await fetch(url);
      if (!res.ok) { sawBlock = true; NetLog.push('kline', '腾讯K线', false, Date.now() - t0, `${sym} ${period} HTTP ${res.status}，换端点`, { url, err: 'HTTP ' + res.status }); continue; }
      const txt = await res.text();
      if (!txt || txt.charCodeAt(0) === 60) { sawBlock = true; NetLog.push('kline', '腾讯K线', false, Date.now() - t0, `${sym} ${period} 返回HTML(疑似WAF)，换端点`, { url, err: '返回 HTML（疑似 WAF 拦截）' }); continue; }
      const j = JSON.parse(txt);
      const d = (j.data && j.data[sym]) || {};
      const arr = d[period] || d['qfq' + period] || [];
      const name = (d.qt && d.qt.data && d.qt.data[1]) || last.name;
      if (arr.length) {
        /* v3.9.13 审计：返回摘要带末根日期与收盘价，方便核对 K 线数据准确性 */
        const lastBar = arr[arr.length - 1];
        NetLog.push('kline', '腾讯K线', true, Date.now() - t0, `${sym} ${period} ${arr.length}根`,
          { url, resp: `${arr.length}根 末根 ${lastBar[0]} 收${lastBar[2]}` });
        return {
          name: name, sawBlock: sawBlock,
          bars: arr.map(function (k) { return { d: k[0], o: +k[1], c: +k[2], h: +k[3], l: +k[4], v: +k[5] || 0 }; }),
        };
      }
      NetLog.push('kline', '腾讯K线', false, Date.now() - t0, `${sym} ${period} 空数据，换端点`, { url, err: '未获取到（空数据）' });
      last = { name: name, bars: [] };
    } catch (e) {
      sawBlock = true;
      NetLog.push('kline', '腾讯K线', false, Date.now() - t0, `${sym} ${period} ${e.message || e}，换端点`, { url, err: e.message || String(e) });
    }
  }
  return { name: last.name, bars: last.bars, sawBlock: sawBlock };
}
async function fetchKlineTx(code, period, lmt) {
  const r = await fetchKlineTxRaw(code, period, lmt);
  if (!r.bars.length && r.sawBlock) throw new Error('腾讯 K 线接口被临时限流，请稍后重试');
  return { name: r.name, bars: r.bars };
}
async function fetchKline(code, klt, lmt) { // klt: 101 日线 / 102 周线
  const period = klt === 102 ? 'week' : 'day';
  try {
    const r = await fetchKlineTx(code, period, lmt);
    if (r.bars.length > 30) return r;
  } catch (e) { /* 降级东财 */ }
  const r2 = await fetchKlineEast(code, klt, lmt);
  if (r2.bars.length < 30) throw new Error('K 线数据获取失败');
  return r2;
}
/* ---- 指标计算 ---- */
function calcMA(vals, n) {
  const out = new Array(vals.length).fill(null); let s = 0;
  for (let i = 0; i < vals.length; i++) { s += vals[i]; if (i >= n) s -= vals[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
}
function calcEMA(vals, n) {
  const k = 2 / (n + 1); const out = []; let e = vals[0];
  vals.forEach((v, i) => { e = i ? v * k + e * (1 - k) : v; out.push(e); });
  return out;
}
function calcMACD(closes) {
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const dea = calcEMA(dif, 9);
  const hist = dif.map((d, i) => (d - dea[i]) * 2);
  return { dif, dea, hist };
}
function calcRSI(closes, n = 14) {
  const out = new Array(closes.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1], up = Math.max(ch, 0), dn = Math.max(-ch, 0);
    if (i <= n) { g += up; l += dn; if (i === n) out[i] = 100 - 100 / (1 + (g / n) / ((l / n) || 1e-9)); }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = 100 - 100 / (1 + g / (l || 1e-9)); }
  }
  return out;
}
function calcKDJ(bars) {
  const K = [], D = [], J = []; let pk = 50, pd = 50;
  bars.forEach((b, i) => {
    const s = Math.max(0, i - 8); let hh = -Infinity, ll = Infinity;
    for (let k = s; k <= i; k++) { hh = Math.max(hh, bars[k].h); ll = Math.min(ll, bars[k].l); }
    const rsv = hh === ll ? 50 : (b.c - ll) / (hh - ll) * 100;
    const k = pk * 2 / 3 + rsv / 3, d = pd * 2 / 3 + k / 3;
    K.push(k); D.push(d); J.push(3 * k - 2 * d); pk = k; pd = d;
  });
  return { K, D, J };
}
function calcBOLL(closes, n = 20, k = 2) {
  const mid = calcMA(closes, n);
  const up = new Array(closes.length).fill(null), dn = new Array(closes.length).fill(null);
  let s = 0, s2 = 0;
  for (let i = 0; i < closes.length; i++) {
    s += closes[i]; s2 += closes[i] * closes[i];
    if (i >= n) { s -= closes[i - n]; s2 -= closes[i - n] * closes[i - n]; }
    if (i >= n - 1) {
      const m = s / n;
      const v = Math.max(0, s2 / n - m * m);
      const sd = Math.sqrt(v);
      up[i] = m + k * sd; dn[i] = m - k * sd;
    }
  }
  return { mid, up, dn };
}
function calcATR(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const tr = i === 0 ? (b.h - b.l)
      : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c));
    if (i < n) { sum += tr; out[i] = sum / (i + 1); }
    else out[i] = (out[i - 1] * (n - 1) + tr) / n;
  }
  return out;
}
function findLevels(bars, price) {
  const n = bars.length, w = 3, his = [], los = [];
  for (let i = w; i < n - w; i++) {
    let isH = true, isL = true;
    for (let k = i - w; k <= i + w; k++) {
      if (k === i) continue;
      if (bars[k].h >= bars[i].h) isH = false;
      if (bars[k].l <= bars[i].l) isL = false;
    }
    if (isH) his.push(bars[i].h);
    if (isL) los.push(bars[i].l);
  }
  const f2 = x => Math.round(x * 100) / 100;
  /* v3.8.5 支撑压力来源标注：聚类 0.6% 内的摆动点计数，多次触碰=密集区，证据更可信 */
  const cluster = arr => {
    const s = [...new Set(arr)].sort((a, b) => a - b);
    const groups = [];
    s.forEach(x => {
      const g = groups[groups.length - 1];
      if (g && Math.abs(x - g[0]) / g[0] < 0.006) g.push(x); else groups.push([x]);
    });
    return groups.map(g => ({ p: f2(g.reduce((s2, x) => s2 + x, 0) / g.length), touches: g.length }));
  };
  const supG = cluster(los.filter(x => x < price * 0.995)).sort((a, b) => b.p - a.p).slice(0, 2);
  const resG = cluster(his.filter(x => x > price * 1.005)).sort((a, b) => a.p - b.p).slice(0, 2);
  return { support: supG.map(g => g.p), resistance: resG.map(g => g.p), supMeta: supG, resMeta: resG };
}
/* ---- 单周期信号引擎（规则投票，每个判断给出理由）---- */
/* v3.8.4 打分引擎重构：按"维度"而非"指标"计数，避免共线性伪确认。
   四个维度：趋势(均线) / 动能(MACD) / 摆动(RSI+KDJ) / 位置(支撑压力)，各计一票。
   趋势维度与摆动维度方向矛盾时（空头趋势+极度超卖等），下调强度并提示技术性反弹。 */
function analyzeTimeframe(bars, label) {
  const closes = bars.map(b => b.c);
  const i = closes.length - 1, price = closes[i];
  const ma = { 5: calcMA(closes, 5), 10: calcMA(closes, 10), 20: calcMA(closes, 20), 60: calcMA(closes, 60) };
  const macd = calcMACD(closes), rsi = calcRSI(closes), kdj = calcKDJ(bars);
  const levels = findLevels(bars, price);
  const f2 = x => Math.round(x * 100) / 100;
  const ma20 = ma[20][i], ma60 = ma[60][i];
  const h = macd.hist[i], hp = macd.hist[i - 1];
  const r = rsi[i];
  const k = kdj.K[i], d = kdj.D[i], j = kdj.J[i];

  /* —— 维度1：趋势（均线系统，合并为一条证据）—— */
  let tPts = 0; const tParts = [];
  if (ma20 != null) { const p = price > ma20 ? 1 : -1; tPts += p; tParts.push(`收盘${p > 0 ? '站上' : '跌破'} MA20(${f2(ma20)})`); }
  if (ma20 != null && ma60 != null) { const p = ma20 > ma60 ? 1 : -1; tPts += p; tParts.push(`MA20 在 MA60(${f2(ma60)})${p > 0 ? '上' : '下'}方`); }
  if (ma[5][i] != null && ma[10][i] != null) { const p = ma[5][i] > ma[10][i] ? 1 : -1; tPts += p * 0.5; tParts.push(`MA5 ${p > 0 ? '>' : '<'} MA10`); }
  const trendDir = tPts > 0.5 ? 1 : tPts < -0.5 ? -1 : 0;
  const trendW = 3;
  const trendText = `${label}趋势维度：${tParts.join('，')}${trendDir === 1 ? '，中期趋势偏多' : trendDir === -1 ? '，中期趋势偏空' : '，均线纠缠、方向不明'}`;

  /* —— 维度2：动能（MACD，绿柱收敛=空头动能衰竭，不再计入看空；零轴附近设噪声阈值）—— */
  const macdNoise = price * 0.001; /* 柱线绝对值低于股价 0.1% 即视为零轴噪声（不论单日变化），防零轴附近反复横跳 */
  let momDir = 0, momW = 2, momText;
  if (Math.abs(h) < macdNoise) {
    momDir = 0; momW = 0; momText = `MACD 柱线（${f2(h)}）绝对值低于噪声阈值（股价的 0.1%），贴近零轴，动能信号不计分`;
  } else if (h > 0 && h > hp) { momDir = 1; momText = `MACD 红柱扩大（${f2(hp)}→${f2(h)}），多头动能增强`; }
  else if (h > 0) { momDir = 1; momW = 1; momText = `MACD 红柱 ${f2(h)}，多头动能维持但略有减弱`; }
  else if (h < 0 && h < hp) { momDir = -1; momText = `MACD 绿柱扩大（${f2(hp)}→${f2(h)}），空头动能增强`; }
  else if (h < 0 && h > hp && (hp - h) >= macdNoise) { momDir = 0; momW = 0; momText = `MACD 绿柱收敛（${f2(hp)}→${f2(h)}），空头动能衰竭，需警惕止跌反弹（中性观察）`; }
  else if (h < 0) { momDir = 0; momW = 0; momText = `MACD 绿柱 ${f2(h)}，变化幅度过小视为噪声，动能信号不计分`; }
  else { momDir = 0; momW = 1; momText = `MACD 柱线接近零轴，动能中性`; }
  if (macd.dif[i] > 0 && momDir >= 0) { momText += `；DIF(${f2(macd.dif[i])}) 在零轴上方`; }
  else if (macd.dif[i] < 0 && momDir <= 0) { momText += `；DIF(${f2(macd.dif[i])}) 在零轴下方`; }

  /* —— 维度3：摆动/超买超卖（RSI + KDJ 合并为一条证据，取最极端状态）—— */
  let oscDir = 0, oscW = 2, oscText;
  const oversold = (r != null && r < 30) || j < 15;
  const overbought = (r != null && r > 70) || j > 95;
  if (oversold) {
    oscDir = 1; oscW = (r != null && r < 25) || j < 5 ? 3 : 2;
    oscText = `摆动维度极度超卖：RSI=${r != null ? f2(r) : '--'}、J=${f2(j)}，历史上此区域反弹概率偏高`;
  } else if (overbought) {
    oscDir = -1; oscW = (r != null && r > 75) || j > 105 ? 3 : 2;
    oscText = `摆动维度极度超买：RSI=${r != null ? f2(r) : '--'}、J=${f2(j)}，谨防短线冲高回落`;
  } else if (k > d) {
    oscDir = r != null && r > 55 ? 1 : 0; oscW = 1;
    oscText = `KDJ 金叉状态（J=${f2(j)}）${r != null && r > 55 ? `，RSI=${f2(r)} 处于强势区` : '，RSI 中性区，摆动信号不强'}`;
  } else {
    oscDir = r != null && r < 45 ? -1 : 0; oscW = 1;
    oscText = `KDJ 死叉状态（J=${f2(j)}）${r != null && r < 45 ? `，RSI=${f2(r)} 处于弱势区` : '，RSI 中性区，摆动信号不强'}`;
  }

  /* —— 维度4：位置（支撑/压力，独立信息；标注来源与前低触碰次数，密集区证据更强）—— */
  const supMeta = (levels.supMeta || []).find(g => price / g.p < 1.03);
  const resMeta = (levels.resMeta || []).find(g => g.p / price < 1.03);
  const supSrc = supMeta ? `前低摆动点${supMeta.touches >= 2 ? `（${supMeta.touches} 次触碰，密集区）` : ''}` : '';
  const resSrc = resMeta ? `前高摆动点${resMeta.touches >= 2 ? `（${resMeta.touches} 次触碰，密集区）` : ''}` : '';
  let posDir = 0, posW = 0, posText = '';
  if (supMeta && resMeta) { posDir = 0; posW = 1; posText = `${label}现价位于支撑 ${f2(supMeta.p)}${supSrc ? '（' + supSrc + '）' : ''} 与压力 ${f2(resMeta.p)}${resSrc ? '（' + resSrc + '）' : ''} 之间，空间受限`; }
  else if (supMeta) { posDir = 1; posW = supMeta.touches >= 2 ? 2 : 1; posText = `${label}现价贴近支撑位 ${f2(supMeta.p)}，来源：${supSrc || '前低'}，下方抛压相对较小`; }
  else if (resMeta) { posDir = -1; posW = resMeta.touches >= 2 ? 2 : 1; posText = `${label}现价逼近压力位 ${f2(resMeta.p)}，来源：${resSrc || '前高'}，突破前上行空间受限`; }

  const dims = [
    { name: '趋势', dir: trendDir, w: trendDir === 0 ? 0 : trendW, text: trendText },
    { name: '动能', dir: momDir, w: momW, text: momText },
    { name: '摆动', dir: oscDir, w: oscW, text: oscText },
    { name: '位置', dir: posDir, w: posW, text: posText },
  ];
  const reasons = dims.filter(x => x.w > 0 || x.text);

  const raw = dims.reduce((s, x) => s + x.dir * x.w, 0);
  const maxW = dims.reduce((s, x) => s + x.w, 0) || 1;
  let pct = Math.round(raw / maxW * 100);
  /* v3.8.9 计算链全程可见：每一步乘数都记入 steps，明细区展示，输出值=公式值可复现 */
  const steps = [`Σ(方向×权重)=${raw}，Σ权重=${maxW}，基础强度 ${pct}`];
  let caveat = '';
  /* —— 矛盾权重：趋势与摆动维度方向相反时，下调强度并提示反弹/回落 —— */
  if (trendDir === -1 && oversold) {
    pct = Math.round(pct * 0.7);
    steps.push(`矛盾降权×0.7 → ${pct}`);
    caveat = Math.abs(raw / maxW * 100) < 10
      ? '注：趋势维度看空与摆动维度极度超卖方向相反，但基础净分已接近零，实为多空对冲，不构成任一方向的独立依据'
      : '注：空头趋势中摆动指标已达极度超卖，看空强度已下调，可能出现技术性反弹，不宜追空';
  } else if (trendDir === 1 && overbought) {
    pct = Math.round(pct * 0.7);
    steps.push(`矛盾降权×0.7 → ${pct}`);
    caveat = Math.abs(raw / maxW * 100) < 10
      ? '注：趋势维度看多与摆动维度极度超买方向相反，但基础净分已接近零，实为多空对冲，不构成任一方向的独立依据'
      : '注：多头趋势中摆动指标已达极度超买，看多强度已下调，谨防技术性回调，不宜追高';
  }
  if (caveat) reasons.push({ name: '矛盾提示', dir: 0, w: 0, text: caveat });

  /* —— v3.8.4 两段式：量能不直接计分，而是作为强度乘数 + 背离预警。
     防陷阱设计：①用 20 日均量的相对倍数而非单日绝对量；②分类阈值取自该股
     自身近 60 日量比分位数（不同市值/板块换手差异大，不用固定倍数套全市场）；
     ③涨跌停/极端单日波动时量能失真，乘数置 1 并标注；④量价关系是概率性
     修正，只调强度、不单独构成买卖依据。 —— */
  const vol = Number(bars[i].v) || 0;
  const vols = bars.map(b => Number(b.v) || 0);
  const volWin = vols.slice(-21, -1).filter(x => x > 0);
  const volMa = volWin.length ? volWin.reduce((s, x) => s + x, 0) / volWin.length : 0;
  const ratio = volMa > 0 ? vol / volMa : 1;
  /* 该股自身的量比分布（近 60 日：每日量 / 其前 20 日均量），取分位数做自适应阈值 */
  const histRatios = [];
  for (let p = 20; p < vols.length - 1 && p < vols.length; p++) {
    const win = vols.slice(Math.max(0, p - 20), p).filter(x => x > 0);
    if (win.length >= 10 && vols[p] > 0) histRatios.push(vols[p] / (win.reduce((s, x) => s + x, 0) / win.length));
  }
  const qsort = arr => { const a = [...arr].sort((x, y) => x - y); return q => a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : null; };
  const qOf = qsort(histRatios);
  const loThr = (qOf && qOf(0.25)) || 0.7;   /* 缩量线：自身分布 25 分位，缺数据退回 0.7 */
  const hiThr = (qOf && qOf(0.80)) || 1.5;   /* 放量线：自身分布 80 分位，缺数据退回 1.5 */
  const midLo = (loThr + 1) / 2, midHi = (1 + hiThr) / 2;
  const prevC = closes[i - 1] || price;
  const dayDir = price > prevC * 1.001 ? 1 : price < prevC * 0.999 ? -1 : 0;
  const dayChg = prevC > 0 ? (price / prevC - 1) : 0;
  /* 涨跌停/异动检测：单日涨跌幅达 ±9.5%（主板约涨停位）或 ±19%（20cm 品种）附近，量能失真 */
  const isLimitLike = Math.abs(dayChg) >= 0.19 || (Math.abs(dayChg) >= 0.095 && Math.abs(dayChg) < 0.11);
  let volState, mult;
  if (isLimitLike) { volState = dayChg > 0 ? '涨停板（量能失真）' : '跌停板（量能失真）'; mult = 1.0; }
  else if (ratio < loThr * 0.5) { volState = '地量'; mult = 0.5; }
  else if (ratio < loThr) { volState = '缩量'; mult = 0.7; }
  else if (ratio < midLo * 1.0 && ratio >= loThr) { volState = '偏缩量'; mult = 0.85; }
  else if (ratio <= midHi) { volState = '平量'; mult = 1.0; }
  else if (ratio <= hiThr) { volState = '温和放量'; mult = 1.1; }
  else { volState = '显著放量'; mult = 1.2; }
  if (dayDir === 0) mult = Math.min(mult, 1.0); /* 横盘时放量不加分 */
  pct = Math.max(-100, Math.min(100, Math.round(pct * mult)));
  if (mult !== 1) steps.push(`量能×${mult} → ${pct}`);
  /* 量价背离预警：创新低但缩量（抛压衰竭）或放量（恐慌出逃）；停牌复牌日跳过 */
  const recentLows = bars.slice(-20).map(b => Number(b.l) || price);
  const isNewLow = price <= Math.min(...recentLows) * 1.002;
  const prevVol = vols[i - 1] || 0;
  const isResumeDay = prevVol === 0; /* 前一日零量≈停牌复牌，量能不可比 */
  let volNote = `量能：${volState}（现量为 20 日均量的 ${f2(ratio)} 倍，阈值按该股自身近 60 日量比分位数自适应${histRatios.length < 20 ? '，历史不足、暂用通用阈值' : ''}）`;
  if (isResumeDay) volNote = `量能：近期有停牌复牌，单日量能不可比，本次不做量能修正`;
  else if (isLimitLike) volNote += '。涨跌停板附近量能失真（封板/砸板量不代表真实供需），本次不做量能加减分';
  else if (dayDir !== 0) volNote += `，${dayDir > 0 ? '上涨' : '下跌'}${mult > 1 ? '获量能确认' : mult < 1 ? '缺乏量能支撑' : ''}`;
  if (volState === '地量') volNote += '。地量：交投极度冷清，已削弱当前方向净分的信号强度，变盘方向待定';
  if (!isResumeDay && !isLimitLike && isNewLow && ratio < loThr) {
    volNote += '。量价背离：股价创新低但明显缩量，抛压趋于衰竭，历史统计上此处加速下跌概率下降、注意止跌信号（概率性修正，非买卖依据）';
    pct = Math.round(pct * 0.7);
    steps.push(`背离再降×0.7 → ${pct}`);
  } else if (!isResumeDay && !isLimitLike && isNewLow && ratio > hiThr) {
    volNote += '。放量破位创新低，恐慌性抛售特征，短期或有惯性下探（概率性提示，非买卖依据）';
  }
  reasons.push({ name: '量能', dir: 0, w: 0, text: volNote });

  const signal = pct >= 30 ? 'buy' : pct <= -30 ? 'sell' : 'hold';
  const summary = reasons.filter(x => x.dir !== 0).slice(0, 3).map(x => x.text).join('；');
  return { label, price, ma, macd, rsi: r, kdj: { K: k, D: d, J: j }, levels, reasons, raw, maxW, pct, signal, summary, caveat, dims, steps, volInfo: { state: volState, ratio, mult } };
}
/* v3.8.5 修复一致性判断 bug：原来按 buy/sell/hold 三档比较，+10 与 -10 都落 hold 档
   被误判为"方向一致"。现按强度符号比较；|综合|<5 强制输出观望；并披露合成公式。 */
function combineTechSignal(d, w) {
  const pct = Math.round(d.pct * 0.6 + w.pct * 0.4); /* 公开公式：日线×60% + 周线×40% */
  let signal = pct >= 30 ? 'buy' : pct <= -30 ? 'sell' : 'hold';
  const ds = Math.sign(d.pct), ws = Math.sign(w.pct);
  let agree;
  if (ds !== 0 && ds === ws) {
    agree = ds > 0 ? '日线与周线方向一致看多，信号可信度较高' : '日线与周线方向一致看空，信号可信度较高';
  } else if (ds !== 0 && ws !== 0 && ds !== ws) {
    agree = ds > 0
      ? '日线反弹信号与周线下跌趋势冲突，属于逆势反弹，可信度偏低，仓位需谨慎'
      : '日线回落与周线上涨趋势冲突，可能是周线上行中的回踩，注意日线企稳信号';
  } else {
    agree = '日线或周线一方强度接近零轴、方向不明，信号强度有限';
  }
  let note = agree;
  if (Math.abs(pct) < 5) {
    signal = 'hold';
    note = `多空胶着（综合强度 ${pct > 0 ? '+' : ''}${pct}，接近零轴），方向不明，建议观望，不宜据此建仓`;
  }
  return { pct, signal, agree, note };
}
function fmtVol(v) {
  const n = Number(v) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿手';
  if (n >= 1e4) return (n / 1e4).toFixed(2) + ' 万手';
  return Math.round(n) + ' 手';
}
/* ---- 蜡烛图绘制（红涨绿跌；主图 + 成交量副图 + 悬停十字光标）---- */
const KC_UP = '#e03131', KC_DOWN = '#12b76a';
function drawCandleChart(canvas, bars, count, an, hover) {
  const wrap = canvas.parentElement;
  const tip = wrap ? wrap.querySelector('.kchart-tip') : null;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 800, H = canvas.clientHeight || 340;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const data = bars.slice(-count);
  if (!data.length) { canvas._kc = null; if (tip) tip.hidden = true; return; }
  const vis = k => (an && an.ma && an.ma[k]) ? an.ma[k].slice(-count) : null;
  const maLines = [
    { k: 5, v: vis(5), c: '#f0a020', t: 'MA5' },
    { k: 10, v: vis(10), c: '#e0559a', t: 'MA10' },
    { k: 20, v: vis(20), c: '#3b82f6', t: 'MA20' },
    { k: 60, v: vis(60), c: '#10b981', t: 'MA60' },
  ];
  let min = Math.min(...data.map(b => b.l)), max = Math.max(...data.map(b => b.h));
  maLines.forEach(m => { if (!m.v) return; m.v.forEach(v => { if (v != null) { min = Math.min(min, v); max = Math.max(max, v); } }); });
  if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
  if (max - min < 1e-9) { max += 1; min -= 1; }
  const pad = (max - min) * 0.06; min -= pad; max += pad;
  const lvTags = [];
  an.levels.support.forEach((p, i) => { if (p >= min && p <= max) lvTags.push({ p, no: i + 1, kind: 'sup', line: 'rgba(224,48,48,.55)' }); });
  an.levels.resistance.forEach((p, i) => { if (p >= min && p <= max) lvTags.push({ p, no: i + 1, kind: 'res', line: 'rgba(10,157,78,.55)' }); });
  const supLs = lvTags.filter(t => t.kind === 'sup'), resLs = lvTags.filter(t => t.kind === 'res');
  const lgLines = [{ kind: 'ma' }];
  if (supLs.length) lgLines.push({ kind: 'lv', ls: supLs, color: 'rgba(224,48,48,.95)', label: '支撑' });
  if (resLs.length) lgLines.push({ kind: 'lv', ls: resLs, color: 'rgba(10,157,78,.95)', label: '压力' });
  const lgTop = 12, lgGap = 17;
  const padT = lgTop + lgGap * (lgLines.length - 1) + 12;
  const padL = 8, padR = 56, axisH = 20;
  const plotW = Math.max(40, W - padL - padR);
  const bodyH = Math.max(120, H - padT - axisH - 8);
  const volH = Math.max(44, Math.round(bodyH * 0.24));
  const gapH = 12;
  const priceH = Math.max(60, bodyH - volH - gapH);
  const priceTop = padT, priceBot = padT + priceH;
  const volTop = priceBot + gapH, volBot = volTop + volH;
  const y = p => priceTop + (max - p) / (max - min) * priceH;
  const maxVol = Math.max(1, ...data.map(b => Number(b.v) || 0));
  const vh = v => Math.max(1, (Number(v) || 0) / maxVol * volH);
  const step = plotW / data.length;
  const xc = i => padL + step * i + step / 2;
  ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textBaseline = 'middle';
  for (let g = 0; g <= 4; g++) {
    const p = max - (max - min) * g / 4, yy = y(p);
    ctx.strokeStyle = 'rgba(128,128,128,.15)'; ctx.beginPath();
    ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
    ctx.fillStyle = '#8a8f98'; ctx.textAlign = 'left';
    ctx.fillText(p.toFixed(2), padL + plotW + 6, yy);
  }
  ctx.strokeStyle = 'rgba(128,128,128,.22)'; ctx.beginPath();
  ctx.moveTo(padL, volBot); ctx.lineTo(padL + plotW, volBot); ctx.stroke();
  ctx.fillStyle = '#9aa0a8'; ctx.textAlign = 'left';
  ctx.fillText('成交量', padL + 2, volTop - 7);
  ctx.fillText(fmtVol(maxVol), padL + plotW + 6, volTop + 4);
  ctx.setLineDash([5, 4]);
  lvTags.forEach(t => {
    ctx.strokeStyle = t.line; ctx.beginPath();
    ctx.moveTo(padL, y(t.p)); ctx.lineTo(padL + plotW, y(t.p)); ctx.stroke();
  });
  ctx.setLineDash([]);
  data.forEach((b, i) => {
    const x = xc(i);
    const up = b.c >= b.o, col = up ? KC_UP : KC_DOWN;
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(x, y(b.h)); ctx.lineTo(x, y(b.l)); ctx.stroke();
    const bw = Math.max(1.5, step * 0.62);
    const yo = y(b.o), yc = y(b.c);
    if (up) ctx.fillRect(x - bw / 2, yc, bw, Math.max(1, yo - yc));
    else ctx.fillRect(x - bw / 2, yo, bw, Math.max(1, yc - yo));
  });
  data.forEach((b, i) => {
    const x = xc(i);
    const up = b.c >= b.o, col = up ? KC_UP : KC_DOWN;
    const h2 = vh(b.v);
    const bw = Math.max(1.5, step * 0.62);
    ctx.fillStyle = col; ctx.globalAlpha = 0.72;
    ctx.fillRect(x - bw / 2, volBot - h2, bw, h2);
    ctx.globalAlpha = 1;
  });
  maLines.forEach(m => {
    if (!m.v) return;
    ctx.strokeStyle = m.c; ctx.lineWidth = 1.2; ctx.beginPath();
    let started = false;
    m.v.forEach((v, i) => {
      if (v == null) return;
      const x = xc(i);
      if (!started) { ctx.moveTo(x, y(v)); started = true; } else ctx.lineTo(x, y(v));
    });
    ctx.stroke(); ctx.lineWidth = 1;
  });
  ctx.fillStyle = '#8a8f98'; ctx.textAlign = 'center';
  const tickN = Math.min(7, data.length);
  for (let g = 0; g < tickN; g++) {
    const idx = Math.floor(g * (data.length - 1) / Math.max(1, tickN - 1));
    ctx.fillText(data[idx].d.slice(5), xc(idx), volBot + 12);
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  lgLines.forEach((ln, i) => {
    const ly = lgTop + lgGap * i;
    if (ln.kind === 'ma') {
      let lx = padL + 2;
      maLines.forEach(m => { ctx.fillStyle = m.c; ctx.fillText(m.t, lx, ly); lx += 44; });
      return;
    }
    const items = ln.ls.map(t => ln.label + t.no + ': ' + t.p.toFixed(2));
    let txt = items.join('　');
    if (ctx.measureText(txt).width > plotW - 6 && items.length > 1) txt = items[0] + ' 等' + items.length + '档';
    ctx.fillStyle = ln.color;
    ctx.fillText(txt, padL + 2, ly);
  });
  const hoverIdx = (hover && hover.idx != null && hover.idx >= 0 && hover.idx < data.length) ? hover.idx : null;
  if (hoverIdx != null) {
    const hx = xc(hoverIdx), b = data[hoverIdx];
    ctx.strokeStyle = 'rgba(90,100,115,.55)'; ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(hx, priceTop); ctx.lineTo(hx, volBot); ctx.stroke();
    const cy = y(b.c);
    ctx.setLineDash([]);
    ctx.fillStyle = '#5a6473';
    const lab = b.c.toFixed(2);
    ctx.fillRect(padL + plotW + 2, cy - 8, Math.max(52, ctx.measureText(lab).width + 10), 16);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(lab, padL + plotW + 6, cy + 0.5);
    if (hover.y != null && hover.y >= priceTop && hover.y <= priceBot) {
      ctx.strokeStyle = 'rgba(90,100,115,.35)';
      ctx.beginPath(); ctx.moveTo(padL, hover.y); ctx.lineTo(padL + plotW, hover.y); ctx.stroke();
      const pv = max - (hover.y - priceTop) / priceH * (max - min);
      const t2 = pv.toFixed(2);
      ctx.fillStyle = 'rgba(90,100,115,.9)';
      ctx.fillRect(padL + plotW + 2, hover.y - 8, Math.max(52, ctx.measureText(t2).width + 10), 16);
      ctx.fillStyle = '#fff'; ctx.fillText(t2, padL + plotW + 6, hover.y + 0.5);
    }
    ctx.strokeStyle = 'rgba(37,99,235,.9)'; ctx.lineWidth = 1.2;
    ctx.strokeRect(hx - step * 0.45, priceTop, Math.max(2, step * 0.9), priceH);
    ctx.lineWidth = 1;
  }
  canvas._kc = { padL, step, n: data.length, data, priceTop, priceBot, volTop, volBot, W, H };
  if (tip) {
    if (hoverIdx == null) { tip.hidden = true; }
    else {
      const i = hoverIdx, b = data[i], iOff = bars.length - data.length;
      const prev = (iOff + i - 1 >= 0) ? bars[iOff + i - 1] : null;
      const pctChg = prev && prev.c ? (b.c - prev.c) / prev.c * 100 : null;
      const cls = b.c >= b.o ? 'up' : 'down';
      const chgCls = pctChg == null ? '' : (pctChg >= 0 ? 'up' : 'down');
      const amp = b.o ? (b.h - b.l) / b.o * 100 : 0;
      const r2 = n => (n == null ? '—' : Number(n).toFixed(2));
      tip.innerHTML =
        `<div class="kt-head">${esc(b.d)}${pctChg == null ? '' : `<span class="kt-chg ${chgCls}">${pctChg >= 0 ? '+' : ''}${pctChg.toFixed(2)}%</span>`}</div>`
        + `<div class="kt-grid">`
        + `<span>开</span><b>${r2(b.o)}</b><span>高</span><b>${r2(b.h)}</b>`
        + `<span>低</span><b>${r2(b.l)}</b><span>收</span><b class="${cls}">${r2(b.c)}</b>`
        + `<span>量</span><b>${fmtVol(b.v)}</b><span>振幅</span><b>${amp.toFixed(2)}%</b>`
        + `</div>`
        + `<div class="kt-ma">`
        + maLines.map(m => `<span style="color:${m.c}">${m.t}</span><b>${m.v && m.v[i] != null ? Number(m.v[i]).toFixed(2) : '—'}</b>`).join('')
        + `</div>`;
      tip.hidden = false;
      const tw = tip.offsetWidth || 242, th = tip.offsetHeight || 104;
      const axisX = padL + plotW;
      const cx = xc(i);
      let left = cx + 16;
      if (left + tw > axisX - 4) left = cx - 16 - tw;
      if (left + tw > axisX - 4) left = axisX - 4 - tw;
      if (left < 2) left = 2;
      let top = (hover && hover.y != null ? hover.y : priceTop) - th / 2;
      top = Math.max(2, Math.min(H - th - 2, top));
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    }
  }
}
function bindKchartHover(canvas, bars, count, an) {
  if (!canvas) return;
  let raf = 0, pending = null;
  const flush = () => {
    raf = 0;
    if (!pending) return;
    drawCandleChart(canvas, bars, count, an, pending);
    pending = null;
  };
  const onMove = (clientX, clientY) => {
    const st = canvas._kc;
    if (!st) return;
    const r = canvas.getBoundingClientRect();
    const x = clientX - r.left, y = clientY - r.top;
    let idx = Math.floor((x - st.padL) / st.step);
    idx = Math.max(0, Math.min(st.n - 1, idx));
    pending = { idx, y };
    if (!raf) raf = requestAnimationFrame(flush);
  };
  canvas.onpointermove = e => onMove(e.clientX, e.clientY);
  canvas.onpointerdown = e => onMove(e.clientX, e.clientY);
  canvas.onpointerleave = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    pending = null;
    drawCandleChart(canvas, bars, count, an, null);
  };
}
function redrawAnalysisCanvases() {
  const g = S.diag;
  if (g) {
    const gd = $('diagDailyCv'), gw = $('diagWeeklyCv');
    if (gd && gd.clientWidth) drawCandleChart(gd, g.daily.bars, 120, g.d);
    if (gw && gw.clientWidth) drawCandleChart(gw, g.weekly.bars, 60, g.w);
  }
}
let _techResizeTimer = 0;
function bindTechResize() {
  if (window._techResizeBound) return;
  window._techResizeBound = true;
  window.addEventListener('resize', () => {
    clearTimeout(_techResizeTimer);
    _techResizeTimer = setTimeout(redrawAnalysisCanvases, 180);
  });
}
/* ---- 股票下拉（自选 + 持仓，按代码去重）---- */
/* v3.8.6 个股诊断改为自绘下拉（原生 select 弹层受系统深色模式影响，深色下渲染成黑块） */
let diagPickCode = '';
function renderAnalysisSelect() {
  const list = $('stockPickList'), label = $('stockPickLabel');
  if (!list || !label) return;
  const mk = new Map();
  computeHoldings().forEach(h => { if (h.qty > 0 && h.code) mk.set(h.code, h.name || h.code); });
  S.watchlist.forEach(w => { if (w.stock_code && !mk.has(w.stock_code)) mk.set(w.stock_code, w.stock_name || w.stock_code); });
  const entries = [...mk.entries()];
  if (!entries.some(([c]) => c === diagPickCode)) diagPickCode = entries.length ? entries[0][0] : '';
  list.innerHTML = entries.map(([c, n]) =>
    `<div class="selpick-item${c === diagPickCode ? ' on' : ''}" data-code="${esc(c)}" data-name="${esc(n)}">${esc(n)}（${esc(c)}）</div>`
  ).join('') || '<div class="selpick-empty">请先在自选股或持仓中添加股票</div>';
  const cur = mk.get(diagPickCode);
  label.textContent = cur ? `${cur}（${diagPickCode}）` : '请先添加自选或持仓';
}
function bindStockPick() {
  const wrap = $('stockPick'), btn = $('stockPickBtn'), list = $('stockPickList');
  if (!wrap || !btn || !list) return;
  const close = () => { wrap.classList.remove('open'); list.hidden = true; };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const opening = list.hidden;
    if (opening) { wrap.classList.add('open'); list.hidden = false; }
    else close();
  });
  list.addEventListener('click', e => {
    const it = e.target.closest('.selpick-item');
    if (!it || !it.dataset.code) return;
    diagPickCode = it.dataset.code;
    const lb = $('stockPickLabel');
    lb.textContent = `${it.dataset.name}（${it.dataset.code}）`;
    list.querySelectorAll('.selpick-item').forEach(x => x.classList.toggle('on', x === it));
    close();
  });
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) close(); });
}
bindStockPick();
/* ---- 一键个股诊断 ---- */
async function diagnoseStock(forceCode) {
  const code = (typeof forceCode === 'string' ? forceCode : diagPickCode).trim();
  if (!code) return toast('请先在自选股或持仓中添加股票');
  const btn = $('stockAnalyzeBtn');
  const box = $('diagBox');
  if (!box) return;
  btn.disabled = true; btn.textContent = '诊断中…';
  box.hidden = false;
  box.innerHTML = '<p class="hint">正在获取 K 线与行情、计算技术指标…</p>';
  /* v3.9.13 审计：整段诊断里的网络调用都标上触发来源 */
  return NetLog.withCtx('个股诊断·' + code, async () => {
  try {
    const [daily, weekly] = await Promise.all([fetchKline(code, 101, 260), fetchKline(code, 102, 180)]);
    if (!daily.bars.length || !weekly.bars.length) throw new Error('K 线数据不足，无法诊断');
    const d = analyzeTimeframe(daily.bars, '日线');
    const w = analyzeTimeframe(weekly.bars, '周线');
    const comb = combineTechSignal(d, w);
    try { await NetQuote.refresh(); } catch (e) { /* 行情失败不阻断技术面 */ }
    const q = NetQuote.get(code);
    const h = computeHoldings().find(x => x.code === code) || null;
    const pos = h && h.qty > 0 ? { qty: h.qty, avgCost: h.costValue / h.qty } : null;
    const name = (daily.name && daily.name !== code && /[\u4e00-\u9fa5]/.test(daily.name) ? daily.name : null)
      || (h && h.name) || (q && q.name) || code;
    S.diag = { code, name, daily, weekly, d, w, comb, q, pos, ai: '', busy: false };
    renderDiagView();
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    S.diag = null;
    box.innerHTML = '<p class="hint">' + esc(e && e.message || '诊断失败，请重试') + '</p>';
  } finally {
    btn.disabled = false; btn.textContent = '开始诊断';
  }
  });
}
window.analyzeStockByCode = async function (code) {
  switchView('analysis');
  diagPickCode = code;
  renderAnalysisSelect();
  await diagnoseStock(code);
};
function renderDiagView() {
  const t = S.diag;
  const box = $('diagBox');
  if (!t || !box) return;
  box.hidden = false;
  box.innerHTML = diagHtml();
  const cvD = $('diagDailyCv'), cvW = $('diagWeeklyCv');
  drawCandleChart(cvD, t.daily.bars, 120, t.d);
  drawCandleChart(cvW, t.weekly.bars, 60, t.w);
  bindKchartHover(cvD, t.daily.bars, 120, t.d);
  bindKchartHover(cvW, t.weekly.bars, 60, t.w);
  bindTechResize();
  /* v3.8.11 K 线数据下载（CSV：日期,开,收,高,低,成交量） */
  const dlK = (bars, fname) => {
    const head = '日期,开盘,收盘,最高,最低,成交量\n';
    const body = bars.map(b => [b.d, b.o, b.c, b.h, b.l, b.v].join(',')).join('\n');
    const blob = new Blob(['\ufeff' + head + body], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  };
  const dDlD = $('kDlDaily'), dDlW = $('kDlWeekly');
  if (dDlD) dDlD.onclick = () => dlK(t.daily.bars, `${t.code}_${t.name || ''}_日线K.csv`);
  if (dDlW) dDlW.onclick = () => dlK(t.weekly.bars, `${t.code}_${t.name || ''}_周线K.csv`);
  $('diagCloseBtn').onclick = closeDiag;
  $('diagSaveBtn').onclick = saveDiagReport;
  $('diagAiBtn').onclick = () => runDiagAi();
  syncDiagAiBtn();
}
function syncDiagAiBtn() {
  const btn = $('diagAiBtn');
  const t = S.diag;
  if (!btn) return;
  btn.disabled = !!(t && t.busy);
  btn.textContent = t && t.busy ? '生成中…' : (t && t.ai ? '↻ 重新生成解读' : '🤖 生成 AI 综合解读');
}
function closeDiag() {
  const t = S.diag;
  const box = $('diagBox');
  if (!box || !t) return;
  const sig = t.comb.signal === 'buy' ? '买入' : t.comb.signal === 'sell' ? '卖出' : '持有';
  box.innerHTML = `
    <div class="diag-folded">
      <span class="diag-folded-txt">🩺 个股诊断：<b>${esc(t.name)}（${esc(t.code)}）</b> · 技术面 ${sig}（${t.comb.pct > 0 ? '+' : ''}${t.comb.pct}）${t.ai ? '' : ' · 尚未生成 AI 解读'}</span>
      <span class="diag-folded-act">
        <button id="diagReopenBtn" class="btn ghost sm">展开</button>
        <button id="diagDropBtn" class="btn ghost sm">关闭</button>
      </span>
    </div>`;
  $('diagReopenBtn').onclick = reopenDiag;
  $('diagDropBtn').onclick = dropDiag;
}
function reopenDiag() {
  if (!S.diag) return toast('请先开始诊断');
  renderDiagView();
  const box = $('diagBox');
  if (box) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function dropDiag() {
  const box = $('diagBox');
  if (box) { box.hidden = true; box.innerHTML = ''; }
  S.diag = null;
}
function diagHtml() {
  const t = S.diag;
  if (!t) return '';
  const { name, code, d, w, comb, q, pos } = t;
  const qLine = q && q.price != null
    ? `实时行情 最新 ${q.price}，涨跌幅 ${q.pct > 0 ? '+' : ''}${q.pct}%`
    : '实时行情获取失败（技术面仍基于历史 K 线）';
  const posLine = pos
    ? `你的持仓 ${fmt2(pos.qty)} 股，成本 ${fmt2(pos.avgCost)}`
    : '你当前未持仓这只股票';
  const reasonLi = (r) => r.dir === 0
    ? `<li class="r-neu">◦ 中性（${r.name}）：${esc(r.text)}</li>`
    : `<li class="${r.dir > 0 ? 'r-bull' : 'r-bear'}">${r.dir > 0 ? '▲ 看多' : '▼ 看空'}（${r.name} +${r.w}）：${esc(r.text)}</li>`;
  return `
    <div class="card-title-row">
      <span class="card-title">🩺 个股诊断：${esc(name)}（${esc(code)}）</span>
      <button id="diagCloseBtn" class="btn ghost sm">收起</button>
    </div>
    <div class="tech-signal">
      <div class="sig-badge sig-${comb.signal}">${comb.signal === 'buy' ? '买入' : comb.signal === 'sell' ? '卖出' : '持有'}</div>
      <div class="sig-score">
        <div><b>${esc(name)}（${esc(code)}）</b>　${esc(qLine)}</div>
        <div>技术面综合强度 <b>${comb.pct > 0 ? '+' : ''}${comb.pct}</b>（日线 ${d.pct > 0 ? '+' : ''}${d.pct} × 60% ＋ 周线 ${w.pct > 0 ? '+' : ''}${w.pct} × 40%）</div>
        <div class="dw-status">当前状态：日线${d.pct > 0 ? '偏多' : d.pct < 0 ? '偏空' : '多空对冲（净信号为零，非无信号）'} / 周线${w.pct > 0 ? '偏多' : w.pct < 0 ? '偏空' : '多空对冲（净信号为零，非无信号）'}${(() => { const ds = Math.sign(d.pct), ws = Math.sign(w.pct); return ds !== 0 && ds === ws ? '，两周期方向一致' : ds !== 0 && ws !== 0 ? '，两周期方向冲突' : '，一方方向不明'; })()}${Math.abs(comb.pct) < 5 ? '，落入观望区' : ''}${(() => { const cs = Math.sign(comb.pct), ds = Math.sign(d.pct), ws = Math.sign(w.pct); if (cs === 0) return ''; const dir = cs > 0 ? '偏多' : '偏空'; if (ds === 0 && ws === cs) return `；综合${dir}完全由周线贡献`; if (ws === 0 && ds === cs) return `；综合${dir}完全由日线贡献`; return ''; })()}</div>
        <div>${esc(posLine)}</div>
        <div>${esc(comb.note)}</div>
      </div>
    </div>
    <div class="tech-charts">
      <div class="tech-chart-block">
        <h4>日线 K 线（近 120 日）<span class="k-dl" id="kDlDaily" data-k="d" title="下载 CSV（含成交量）">⬇ 下载</span><span class="kc-hint">鼠标移到图上查看当日价格与成交量</span></h4>
        <div class="kchart-wrap"><canvas id="diagDailyCv"></canvas><div class="kchart-tip" hidden></div></div>
      </div>
      <div class="tech-chart-block">
        <h4>周线 K 线（近 60 周）<span class="k-dl" id="kDlWeekly" data-k="w" title="下载 CSV（含成交量）">⬇ 下载</span><span class="kc-hint">鼠标移到图上查看当周价格与成交量</span></h4>
        <div class="kchart-wrap"><canvas id="diagWeeklyCv"></canvas><div class="kchart-tip" hidden></div></div>
      </div>
    </div>
    <div class="levels-legend">关键价位：<b>支撑</b> ${d.levels.support.length ? d.levels.support.join(' / ') : '近 3 年低点下方'} ／ <b>压力</b> ${d.levels.resistance.length ? d.levels.resistance.join(' / ') : '近 3 年高点上方'}　<span class="lv-note">（K 线图左上角图例只标出落在当前可见区间内的档位，档号与这里一一对应）</span></div>
    <div class="tech-cols">
      <div class="tech-reason"><h4>📉 日线信号明细（强度 ${d.pct > 0 ? '+' : ''}${d.pct}）</h4>${d.steps && d.steps.length ? `<div class="calc-chain">计算链：${d.steps.join(' → ')}</div>` : ''}<ul>${d.reasons.map(reasonLi).join('')}</ul></div>
      <div class="tech-reason"><h4>📊 周线信号明细（强度 ${w.pct > 0 ? '+' : ''}${w.pct}）</h4>${w.steps && w.steps.length ? `<div class="calc-chain">计算链：${w.steps.join(' → ')}</div>` : ''}<ul>${w.reasons.map(reasonLi).join('')}</ul></div>
    </div>
    <div class="formula-note">强度合成公式（可复现，明细区附每一步计算链）：单周期强度 = Σ(维度方向×权重) ÷ Σ该周期实际计分权重 × 100。四维度权重表：趋势 3（均线三条件合成，方向由合计点数定）、动能 2（红/绿柱走弱降为 1，|柱线|&lt;股价0.1% 判噪声记 0）、摆动 2（深度极值 RSI&lt;25 或 J&lt;5 升为 3；金叉/死叉但 RSI 中性降为 1 且方向记 0；矛盾触发用较宽阈值 RSI&lt;30/J&lt;15，不影响权重）、位置 1（密集区支撑/压力升为 2；各周期统一计算，无贴近摆动点位时该维度不计入分母）。再乘量能系数（地量 0.5 / 缩量 0.7 / 偏缩量 0.85 / 平量 1.0 / 温和放量 1.1 / 显著放量 1.2，阈值取个股自身近 60 日量比分位数；涨跌停与停牌复牌不做修正；地量削弱的是当前净分方向）。矛盾降权触发条件（写死）：趋势维度与摆动维度符号相反，且摆动处于极端区（RSI&lt;30 或 J&lt;15；反向为 RSI&gt;70 或 J&gt;95）→ 强度 ×0.7。综合强度 = 日线 × 60% + 周线 × 40%（两周期同公式同量纲），|综合| &lt; 5 强制观望。</div>
    <div class="diag-ai">
      <div class="diag-ai-title">🤖 综合诊断 <span class="diag-ai-sub">技术面 ＋ 基本面 ＋ 你的持仓与交易行为，只给一个结论</span></div>
      <div id="diagAiOut" class="diag-ai-out">${t.ai ? esc(t.ai) : (t.busy ? '生成中…' : '<span class="diag-ai-idle">技术面已经出好了。点下面的按钮，再结合基本面、消息面与你的持仓 / 交易行为，生成一段可执行的操作建议。</span>')}</div>
      <div class="diag-ai-actions">
        <button id="diagAiBtn" class="btn primary">${t.ai ? '↻ 重新生成解读' : '🤖 生成 AI 综合解读'}</button>
        <button id="diagSaveBtn" class="btn ghost">💾 保存到报告历史</button>
      </div>
    </div>`;
}
async function runDiagAi() {
  const t = S.diag;
  if (!t) return;
  if (t.busy) return;
  const paint = (txt) => {
    if (S.diag !== t) return;
    const el = $('diagAiOut');
    if (el) el.textContent = txt;
  };
  t.busy = true;
  syncDiagAiBtn();
  paint('生成中…');
  const { d, w, comb, name, code, q, pos } = t;
  const last = (a) => (a && a.length ? Math.round(a[a.length - 1] * 100) / 100 : '-');
  const anDesc = (an) => `${an.label}：现价 ${an.price}，RSI=${an.rsi == null ? '-' : Math.round(an.rsi)}，KDJ K=${Math.round((an.kdj && an.kdj.K) || 0)}/D=${Math.round((an.kdj && an.kdj.D) || 0)}/J=${Math.round((an.kdj && an.kdj.J) || 0)}，MACD DIF=${last(an.macd && an.macd.dif)}/DEA=${last(an.macd && an.macd.dea)}，强度 ${an.pct}；信号要点（按维度归类）：${an.reasons.filter(r => r.dir !== 0).map(r => (r.dir > 0 ? '看多' : '看空') + '【' + r.name + '】' + r.text).join('；')}${an.caveat ? '。' + an.caveat : ''}`;
  const myTrades = S.trades.filter(x => x.stock_code === code).slice(0, 10)
    .map(x => `${String(x.transaction_time || '').slice(0, 16)} ${x.transaction_type === 'buy' ? '买入' : '卖出'} ${x.quantity}股 @${x.price}`);
  const sys = `你是资深证券分析师。用户已经在界面上看到了技术指标与 K 线图，你不需要复述原始数值。
请输出一份结构清晰的「个股诊断」，纯文本 Markdown，全文 600 字以内，严格分四节：
一、技术面小结（用一句话概括日线＋周线的位置关系，并说明关键支撑/压力对操作的实际意义）
二、基本面与消息面视角（基于你的知识，注明信息可能滞后）
三、结合该用户持仓与交易行为的个性化提醒
四、操作建议（给出可执行的分步动作：什么价位做什么、止损位、加减仓条件）
最后单独一行写：以上分析由 AI 生成，仅供参考，不构成投资建议。`;
  const user = `股票：${name}（${code}）
实时行情：${q && q.price != null ? `最新价 ${q.price}，涨跌幅 ${q.pct}%` : '（获取失败，请基于你的知识分析并说明数据可能滞后）'}
技术面规则信号：${comb.signal === 'buy' ? '买入' : comb.signal === 'sell' ? '卖出' : '持有'}（综合强度 ${comb.pct}）｜${comb.note}
关键价位：支撑 ${d.levels.support.join(' / ') || '近 3 年低点下方'}；压力 ${d.levels.resistance.join(' / ') || '近 3 年高点上方'}
${anDesc(d)}
${anDesc(w)}
用户持仓：${pos ? `${fmt2(pos.qty)} 股，成本价 ${fmt2(pos.avgCost)}` : '未持仓'}
用户近期交易：
${myTrades.join('\n') || '无记录'}`;
  try {
    let text = '';
    const ret = await llmComplete([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], {
      onDelta: (delta) => { text += delta; paint(text); },
    });
    t.ai = (typeof ret === 'string' && ret) ? ret : text;
    paint(t.ai || '（无输出）');
  } catch (e) {
    paint('综合诊断生成失败：' + (e && e.message || '请稍后重试'));
  } finally {
    t.busy = false;
    syncDiagAiBtn();
  }
}
/* ---- 报告历史（localStorage，本机保存最近 30 条）---- */
const DIAG_HIST_KEY = 'sj_diag_reports_v1';
function loadDiagHistory() { try { return JSON.parse(localStorage.getItem(DIAG_HIST_KEY) || '[]'); } catch (e) { return []; } }
function saveDiagHistoryItem(item) {
  const list = loadDiagHistory();
  list.unshift(item);
  try { localStorage.setItem(DIAG_HIST_KEY, JSON.stringify(list.slice(0, 30))); } catch (e) { /* */ }
  renderDiagHistory();
}
function renderDiagHistory() {
  const el = $('diagHistory');
  if (!el) return;
  const list = loadDiagHistory();
  if (!list.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="card-title-row" style="margin-top:4px"><span class="card-title" style="font-size:13px">诊断报告历史（本机保存）</span>'
    + '<button class="btn ghost sm" id="diagHistClear" type="button">清空</button></div>'
    + list.map((r, i) => `<div class="mini-item diag-hist-item" data-i="${i}"><div><b>${esc(r.title)}</b><span class="hint">${esc(r.time)}</span></div><span class="pct ${r.sig === '买入' ? 'pos' : r.sig === '卖出' ? 'neg' : 'neu'}">${esc(r.sig)} ${r.pct > 0 ? '+' : ''}${r.pct}</span></div>`).join('');
  $('diagHistClear').onclick = () => { localStorage.removeItem(DIAG_HIST_KEY); renderDiagHistory(); toast('报告历史已清空'); };
  el.querySelectorAll('.diag-hist-item').forEach(item => {
    item.onclick = () => {
      const r = loadDiagHistory()[+item.dataset.i];
      if (!r) return;
      const box = $('diagBox');
      box.hidden = false;
      box.innerHTML = `<div class="card-title-row"><span class="card-title">${esc(r.title)}</span><button class="btn ghost sm" onclick="document.getElementById('diagBox').hidden=true">关闭</button></div><div class="diag-ai-out" style="margin-top:10px">${esc(r.content)}</div>`;
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
  });
}
async function saveDiagReport() {
  const t = S.diag;
  if (!t) return;
  const sig = t.comb.signal === 'buy' ? '买入' : t.comb.signal === 'sell' ? '卖出' : '持有';
  const content = [
    `综合信号：${sig}（技术面强度 ${t.comb.pct}）`,
    t.comb.note,
    `关键价位：支撑 ${t.d.levels.support.join(' / ') || '近 3 年低点下方'}；压力 ${t.d.levels.resistance.join(' / ') || '近 3 年高点上方'}`,
    '',
    `【日线信号（${t.d.pct > 0 ? '+' : ''}${t.d.pct}）】`,
    ...t.d.reasons.map(r => (r.dir > 0 ? '▲ ' : '▼ ') + r.text),
    '',
    `【周线信号（${t.w.pct > 0 ? '+' : ''}${t.w.pct}）】`,
    ...t.w.reasons.map(r => (r.dir > 0 ? '▲ ' : '▼ ') + r.text),
    t.ai ? '\n【综合诊断】\n' + t.ai : '',
  ].join('\n');
  saveDiagHistoryItem({
    title: `个股诊断：${t.name}（${t.code}）`,
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
    sig, pct: t.comb.pct, content,
  });
  toast(t.ai ? '诊断已保存到报告历史' : '已保存技术面结论（AI 解读还没生成）');
}
/* ---- 模块初始化（DOM 就绪后直接绑定；boot() 在本文件末尾执行）---- */
(function initAnalysis() {
  $('stockAnalyzeBtn').onclick = () => diagnoseStock();
  renderDiagHistory();
})();


/* ============================================================
   v3.9.0 智能问答（核心对话）
   来源：trade-manager-97288。迁移「核心对话」这一层：
     多轮对话 / 流式输出 / 历史记录（云端 qa_history）/ 搜索 / 新对话 /
     附件上传 / 语音输入 / Markdown 渲染 / 基于持仓与交易的上下文注入。
   v3.9.7 起另补上「工具取数层」（独立文件 qa-tools.js，见该文件头注释）：
     条件选股 / 板块成分股 / 实时行情 / 财务估值 / 五维诊断 / 技术分析 / 组合风险 /
     操作复盘 / 策略回测 / K 线相似度 —— 全部走公开免费接口，无需任何 Key。
   仍未迁移（源站有、本项目按需摘除）：
     · 妙想（mx）技能中心、凭证管理与依赖 Key 的技能；问答范围设置与视觉模型选择
     · maybeRecordFromQa（从问答自动记一笔）
   适配点：命名沿用 stock-journal 习惯（sj_ 前缀）、复用 store/S/esc/toast，
          LLM 走现有 ModelMgr + llmComplete，仅额外补一个可中止的流式封装。
   ============================================================ */
const QA_HISTORY_LIMIT = 400;      // 单次拉取的历史记录上限（云端 app_query 无分页）
const QA_CTX_TRADES = 30;          // 注入上下文时带的近期交易条数

/* v3.9.2 快捷提问示例（数据源，逐字照搬 trade-manager 的 QA_EXAMPLES）。
   空对话时渲染成可点击卡片，点一下把 q 填进输入框；q 里的 {股票} 占位符
   在点击时替换成用户自己的股票（见 qaPickStock）。
   注意：源站这些示例里有一部分依赖它的「交易工具层」（选股 / 回测 / 自动记账）。
   v3.9.7 起工具层已迁到 qa-tools.js（选股 / 行情 / 财务 / 诊断 / 回测 / 风险 / 复盘 /
   K 线相似度），这些示例点下去能真的取到数；只有「自动记账」仍不在范围内。
   放在模块作用域顶部是为了避免 TDZ：qaExamplesHtml 在其之后才定义。 */
const QA_EXAMPLES = [
  { g: '🎯 智能选股', items: [
    { n: '多因子选股（深度）', q: '筛选A股人形机器人产业链中的公司，需同时满足：PE(TTM) 为正且低于80倍、最新可得ROE高于8%、具备公告或主营业务关联的明确证据。按业务关联证据强度和市值排序，输出完整筛选报告，需列出每只股票的代码、名称、所属环节及各项指标实际数值。随后对排名前3的A股进行综合诊断，分别说明原筛选条件中已被验证、被削弱以及仍待验证的部分。' },
    { n: '低估值高ROE', q: '帮我筛选沪深A股中市盈率低于20倍、ROE高于15%的公司，按ROE从高到低排序，列出前20只的代码、名称、PE、ROE和所属行业。' },
    { n: '板块成分股', q: '列出人形机器人概念的成分股，按总市值从高到低排序，给出前20只的名称、收盘价、涨跌幅、总市值和申万一级行业。' },
    { n: '创业板涨幅榜', q: '列出创业板今天涨幅前 10 的股票，给出代码、名称、涨跌幅和总市值。' },
    { n: '区间+形态选股', q: '在创业板里找近 20 个交易日累计涨幅超过 20%、且近 5 日均量较 20 日均量放量 50% 的股票，按累计涨幅降序给我前 20 只。' },
    { n: '均线形态选股', q: '找出站上 MA60、均线多头排列且不是 ST 的沪深主板股票，按近 20 日涨幅降序前 20 只。' },
    { n: '超跌回撤选股', q: '找出自近 60 日高点回撤超过 30%、市盈率为正的创业板股票，按回撤幅度降序前 20 只。' },
    { n: 'K 线相似度', q: '从我的自选股里找出 K 线形态最像 {股票} 的前 5 只，用近 60 个交易日比对。' },
  ] },
  { g: '🔬 个股诊断', items: [
    { n: '五维诊断（深度）', q: '对{股票}进行全面、深入的五维诊断，覆盖基本面与估值、技术趋势、资金行为、消息事件和机构观点，重点识别不同维度之间的共识、冲突、证据缺口、主要风险及后续验证指标。生成一份包含关键图表和统一综合判断的报告。' },
    { n: '估值贵不贵', q: '{股票}现在估值贵不贵？结合 PE/PB、营收与净利增速、机构目标价给一个明确判断。' },
    { n: '技术位置', q: '{股票}现在的技术面怎么样？支撑位和压力位在哪，这个位置适合买入还是继续观察？' },
    { n: '机构怎么看', q: '机构对{股票}的一致预期如何？评级分布、目标价区间和盈利预测说明了什么？' },
  ] },
  { g: '💼 持仓与风险', items: [
    { n: '持仓体检', q: '帮我做一次持仓体检：逐只给出成本、浮盈亏、仓位占比与风险提示，并指出最该处理的一只。' },
    { n: '组合风险', q: '对我的持仓组合做一次风险分析：集中度、相关性、Beta 与压力测试，并给出再平衡建议。' },
    { n: '该不该加仓', q: '结合我的持仓成本、当前仓位和最近的行情，说清楚我现在该加仓、持有还是减仓，给出触发条件。' },
  ] },
  { g: '🔁 复盘与回测', items: [
    { n: '操作复盘', q: '复盘我最近的操作，找出反复出现的错误与行为偏差，给我 3 条可执行的交易规则。' },
    { n: '策略回测', q: '回测{股票}最近一年的均线策略，看看胜率、盈亏比与最大回撤，并与买入持有做个对比。' },
    { n: '跌买涨卖测试', q: '用一个"跌 5% 买入、涨 5% 卖出"的网格策略回测{股票}最近一年，能赚钱吗？' },
    { n: '回测 + 风控', q: '用均线策略回测{股票}最近一年，叠加 ATR 3 倍跟踪止损和 20% 回撤熔断，看看风控把最大回撤压下去多少。' },
    { n: '策略横截面对比', q: '把唐奇安通道突破策略在我持仓股上跑一遍，按总收益排名看哪只最适合做突破。' },
  ] },
  /* v3.9.2 本组源站叫「记账与日常」，首条「快速记账」依赖源站的自动记账工具
     （maybeRecordFromQa），本项目没迁那层 —— 点了只会得到一段文字而不会真的
     写入交易记录，属于「承诺做不到的事」，故摘除该条与组名里的「记账」。
     仍需 22 条的观感？见 qaEmptyHtml 里 QA_EXAMPLES 的渲染结果（现 21 条）。 */
  { g: '✍️ 日常问答', items: [
    { n: '今日行情', q: '{股票}今天的行情和最新一期财务怎么样？和它的估值水平匹配吗？' },
    { n: '买卖点参考', q: '{股票}最近值得买入吗？如果买，止损位和第一目标位大概放在哪？' },
  ] },
];

/* 会话状态：state.qaAll 为云端全量记录（倒序），其余按会话 id 分桶缓存 */
const qaState = {
  conversationId: '',
  messages: [],
  all: [],
  msgs: {},          // cid -> 消息数组（切走再切回不丢）
  local: {},         // cid -> {title, at}：已新建但云端还没有占位行的会话
  busyConvs: {},     // cid -> true 正在生成
  controllers: {},   // cid -> AbortController
  stream: {},        // cid -> 已生成的文本
  files: [],         // 待发送附件 [{name, text, image}]
  loaded: false,
  unread: new Set(), // v3.15.0 手机抽屉角标：非当前会话生成完成、还没看过的
};

function qaNewId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function qaMsgsOf(cid) {
  if (!qaState.msgs[cid]) qaState.msgs[cid] = [];
  return qaState.msgs[cid];
}
function qaAttach(cid) {
  qaState.conversationId = cid;
  qaState.messages = qaMsgsOf(cid);
}

/* ---------- Markdown → HTML（来源同源站 qaMdToHtml，行内标记单独抽出便于复用） ---------- */
function qaMdInline(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}
/* 极简 Markdown 渲染：标题 / 列表 / 代码块 / 表格 / 引用 / 分隔线 / 段落。
   输入先 esc()，只放开白名单标签，避免模型输出里的 HTML 直接注入。 */
function qaMdToHtml(src) {
  const lines = esc(String(src == null ? '' : src)).split('\n');
  const out = [];
  let list = null;
  const flush = () => {
    if (list) { out.push('<' + list.tag + '>' + list.items.map(x => '<li>' + x + '</li>').join('') + '</' + list.tag + '>'); list = null; }
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (/^```/.test(t)) {                                    // 代码块
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      out.push('<pre class="qa-code">' + buf.join('\n') + '</pre>');
      continue;
    }
    if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {  // 表格
      flush();
      const cells = s => s.replace(/^\||\|$/g, '').split('|').map(x => qaMdInline(x.trim()));
      const head = cells(t);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows.push(cells(lines[i].trim())); i++; }
      i--;
      out.push('<div class="qa-table-wrap"><table class="qa-table"><thead><tr>' + head.map(x => '<th>' + x + '</th>').join('')
        + '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.map(x => '<td>' + x + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^#{1,6}\s+/.test(t)) { flush(); out.push('<h4 class="qa-h">' + qaMdInline(t.replace(/^#{1,6}\s+/, '')) + '</h4>'); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); out.push('<hr class="qa-hr">'); continue; }
    let m;
    if ((m = /^[-*+]\s+(.*)$/.exec(t))) {
      if (!list || list.tag !== 'ul') { flush(); list = { tag: 'ul', items: [] }; }
      list.items.push(qaMdInline(m[1]));
      continue;
    }
    if ((m = /^\d+[.)]\s+(.*)$/.exec(t))) {
      if (!list || list.tag !== 'ol') { flush(); list = { tag: 'ol', items: [] }; }
      list.items.push(qaMdInline(m[1]));
      continue;
    }
    if ((m = /^&gt;\s?(.*)$/.exec(t))) { flush(); out.push('<blockquote>' + qaMdInline(m[1]) + '</blockquote>'); continue; }
    if (!t) { flush(); out.push('<div class="qa-gap"></div>'); continue; }
    flush();
    out.push('<p>' + qaMdInline(raw) + '</p>');
  }
  flush();
  return out.join('');
}

/* ---------- 可中止的流式补全 ----------
   现有 llmComplete 不支持 AbortSignal（记一笔不需要中止），这里加一层包装：
   自定义模型走 fetch（原生支持 signal），云端模型走 SDK 的 for await，
   用 signal.aborted 在 chunk 之间跳出。 */
async function qaLlmStream(messages, { signal, onDelta } = {}) {
  const m = ModelMgr.cur;
  if (!m) throw new Error('尚未选择模型，请到「设置 → AI 模型」选择');
  if (m.custom) {
    let url = m.baseUrl.replace(/\/+$/, '');
    if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + m.apiKey },
      body: JSON.stringify({ model: m.model, messages, stream: true }),
      signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('自定义模型请求失败 HTTP ' + res.status + (t ? '：' + t.slice(0, 200) : ''));
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const d = j.choices && j.choices[0] && j.choices[0].delta;
          if (d && d.content) { text += d.content; if (onDelta) try { onDelta(d.content); } catch (e) { /* */ } }
        } catch (e) { /* 忽略无法解析的行 */ }
      }
    }
    return text;
  }
  if (!cloudLlm) throw new Error('云端模型服务不可用');
  const llm = cloudLlm.llm || cloudLlm;
  let text = '';
  for await (const chunk of llm.chat.completions.create({ model: m.id, messages, stream: true })) {
    if (signal && signal.aborted) break;
    const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    if (d && d.content) { text += d.content; if (onDelta) try { onDelta(d.content); } catch (e) { /* */ } }
  }
  return text;
}

/* ============================================================
   v3.11.1 Agentic 工具回路（模型自主决定调用哪个技能）
   ------------------------------------------------------------
   之前：规则路由命中才取数，没命中就让模型裸答 —— 模型没有"自己查"的能力
   （用户截图：「当我的持仓，截至目前的浮动盈亏」→ 只能说"没取到实时行情"）。
   现在：规则路由没命中时，走 OpenAI function calling 循环 —— 把技能清单以
   tools 发给模型，模型返回 tool_calls → 本地真实执行 → 结果回传 → 模型继续，
   最多 4 轮后强制作答。模型不支持 tools（HTTP 400/422）时自动回退纯流式。
   ============================================================ */
/* 工具清单（发给模型 的 tools 参数）。call_skill 是通用口子：一个工具覆盖全部内置技能。 */
function qaAgentTools() {
  const skillList = (typeof SKILL_CATALOG !== 'undefined')
    ? SKILL_CATALOG.filter(s => s.vendor !== 'mx').map(s => s.id).join('|') : '';
  const tools = [
    { type: 'function', function: {
      name: 'get_holdings_pnl',
      description: '获取用户当前持仓的实时浮动盈亏（逐股 + 合计：数量/成本/现价/市值/盈亏/盈亏%/今日涨跌）。凡用户问持仓赚亏、浮动盈亏、市值，优先用它。',
      parameters: { type: 'object', properties: {} },
    } },
    { type: 'function', function: {
      name: 'get_realtime_quotes',
      description: '批量获取股票实时行情（现价/涨跌幅/成交额）。用户问到具体股票的当前价格时用。',
      parameters: { type: 'object', properties: {
        codes: { type: 'array', items: { type: 'string' }, description: '6 位股票代码数组，如 ["000063","600519"]，最多 30 只' },
      }, required: ['codes'] },
    } },
    { type: 'function', function: {
      name: 'call_skill',
      description: '调用内置数据技能查公开数据（涨停板四池/涨停原因/限售解禁/分红/业绩预告/LPR/可转债/条件选股/板块成分/股东/行情财务/技术分析等）。可用 skill 值：' + skillList,
      parameters: { type: 'object', properties: {
        skill: { type: 'string', description: '技能 id，见描述中的清单' },
        question: { type: 'string', description: '具体化的取数指令（含股票名称/代码与条件，如「中兴通讯最新行情」「今日涨停池」）' },
      }, required: ['question'] },
    } },
  ];
  /* v3.12.0 已安装 SKILL.md 技能包 → 追加 askill 工具（Python 执行于自托管后端） */
  if (typeof skillPacks === 'function') {
    const packs = skillPacks().filter(p => p.enabled !== false && (p.functions || []).length);
    if (packs.length) {
      tools.push({ type: 'function', function: {
        name: 'askill',
        description: '调用已安装的 SKILL.md 技能包函数（Python 数据端点，a-stock-data 等）。'
          + packs.map(p => '技能包「' + p.packName + '」可用函数：' + p.functions.map(f => f.name || f).join('、')).join('；')
          + '。参数 args 按函数签名传（对象键值）。',
        parameters: { type: 'object', properties: {
          pack: { type: 'string', description: '技能包名，如 askill' },
          fn: { type: 'string', description: '要调用的函数名，如 em_zt_pool' },
          args: { type: 'object', description: '函数参数键值对，如 {"date":"20261015"}' },
        }, required: ['pack', 'fn'] },
      } });
    }
  }
  return tools;
}
/* 技能 id → 具体取数函数（call_skill 的分发表） */
function qaAgentSkillFn() {
  return {
    'em-screen': q => qaToolScreen(q),
    'em-board': q => qaToolBoard(q),
    'em-holder': q => qaToolHolder(q),
    'em-market': q => qaToolMarketAuto(q),
    'asd-zt': q => qaToolAsdZt(q),
    'asd-thszt': q => qaToolAsdThsZt(q),
    'asd-lockup': q => qaToolAsdLockup(q),
    'asd-dividend': q => qaToolAsdDividend(q),
    'asd-forecast': q => qaToolAsdForecast(q),
    'asd-lpr': () => qaToolAsdLpr(),
    'asd-cb': q => qaToolAsdCb(q),
  };
}
async function qaAgentExec(name, args, question) {
  if (name === 'get_holdings_pnl') return (await qaToolPnl(question)).block;
  if (name === 'get_realtime_quotes') {
    const codes = (args.codes || []).map(c => String(c).replace(/\D/g, '')).filter(c => /^\d{6}$/.test(c)).slice(0, 30);
    if (!codes.length) throw new Error('codes 必须是 6 位股票代码数组');
    const qs = await emQuotes(codes);
    if (!qs.length) throw new Error('行情接口未返回数据');
    return '实时行情（抓取时点快照）：\n' + qs.map(q =>
      q.code + ' ' + (q.name || '') + '：现价 ' + q.price + '，涨跌幅 ' + q.pct + '%'
      + (q.amount != null ? '，成交额 ' + (q.amount / 1e8).toFixed(2) + ' 亿' : '')).join('\n');
  }
  if (name === 'call_skill') {
    const q = String(args.question || question || '');
    const map = qaAgentSkillFn();
    const fn = map[args.skill];
    if (!fn) throw new Error('未知技能 ' + args.skill + '。可用：' + Object.keys(map).join('、'));
    const r = await fn(q);
    return (r && r.block) || '技能无返回';
  }
  /* v3.12.0 SKILL.md 技能包函数（Python 执行于自托管后端） */
  if (name === 'askill') {
    const out = await skillPackExec('pack-' + (args.pack || 'askill'), args.fn, args.args || {});
    return '技能包函数 ' + args.fn + ' 返回（JSON）：\n' + JSON.stringify(out).slice(0, 6000);
  }
  throw new Error('未知工具 ' + name);
}
/* 非流式对话（带 tools），返回 assistant message（含 content / tool_calls） */
async function qaLlmChat(messages, { tools, signal } = {}) {
  const m = ModelMgr.cur;
  if (!m) throw new Error('尚未选择模型');
  const body = { model: m.custom ? m.model : m.id, messages };
  if (tools && tools.length) body.tools = tools;
  /* v3.17.3 关键修复：本函数原先 stream:false —— 实测平台网关已拒绝一切非流式请求
     （"stream must be true; non-streaming chat completions are not supported"），
     agentic 回路第 1 轮就抛错 → sendQa 静默降级纯文本 baseMsgs：
     ① 带图提问的图片被丢掉（模型说「没收到图片」）；
     ② 所有未命中规则路由的提问，工具回路整体失效、模型再也不调技能。
     改为内部走流式、把增量拼回完整 message（content + tool_calls），对外形状不变。 */
  const mkAccum = () => {
    let content = '';
    const tcs = new Map(), order = [];
    return {
      feed(d) {
        if (d && d.content) content += d.content;
        if (d && d.tool_calls) for (const tc of d.tool_calls) {
          const i = tc.index == null ? 0 : tc.index;
          if (!tcs.has(i)) { tcs.set(i, { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } }); order.push(i); }
          const t = tcs.get(i);
          if (tc.id) t.id = tc.id;
          if (tc.function) {
            if (tc.function.name && !t.function.name) t.function.name = tc.function.name;   // name 通常整段到达
            if (tc.function.arguments) t.function.arguments += tc.function.arguments;       // arguments 逐段增量
          }
        }
      },
      done() {
        const out = { content };
        if (order.length) out.tool_calls = order.sort((a, b) => a - b).map(i => tcs.get(i));
        return out;
      },
    };
  };
  if (m.custom) {
    let url = m.baseUrl.replace(/\/+$/, '');
    if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + m.apiKey },
      body: JSON.stringify(Object.assign({ stream: true }, body)),
      signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('自定义模型请求失败 HTTP ' + res.status + (t ? '：' + t.slice(0, 160) : ''));
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    const acc = mkAccum();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          acc.feed(j.choices && j.choices[0] && j.choices[0].delta);
        } catch (e) { /* 忽略无法解析的行 */ }
      }
    }
    return acc.done();
  }
  if (!cloudLlm) throw new Error('云端模型服务不可用');
  const llm = cloudLlm.llm || cloudLlm;
  const acc = mkAccum();
  for await (const chunk of llm.chat.completions.create(Object.assign({ stream: true }, body))) {
    if (signal && signal.aborted) break;
    acc.feed(chunk.choices && chunk.choices[0] && chunk.choices[0].delta);
  }
  return acc.done();
}
async function qaAgentLoop(baseMsgs, { signal, onNote, onDelta } = {}) {
  /* v3.12.4 轮间 + 工具执行阶段的可中断性（此前取数阶段停止无效） */
  const chkStop = () => { if (signal && signal.aborted) throw Object.assign(new Error('已中断'), { name: 'AbortError' }); };
  const msgs = baseMsgs.slice();
  const lastUser = (() => { for (let i = baseMsgs.length - 1; i >= 0; i--) if (baseMsgs[i].role === 'user') return baseMsgs[i].content; return ''; })();
  for (let round = 0; round < 4; round++) {
    chkStop();
    const msg = await qaLlmChat(msgs, { tools: qaAgentTools(), signal });
    const tcs = msg.tool_calls || [];
    if (!tcs.length) {
      const c = msg.content || '';
      if (c) return c;
      /* 部分小模型 / 云网关会返回"空消息且无 tool_calls"（截图反馈的「本轮未生成回答」）。
         不能把空串当答案返回 → 追问一句，逼模型下一轮给出内容（受轮次上限保护）。 */
      msgs.push({ role: 'user', content: '（系统提示：你上一条回复是空的。请直接回答用户的问题；'
        + '需要数据就调用工具，取不到的如实说明，不要输出空回复。）' });
      continue;
    }
    msgs.push({ role: 'assistant', content: msg.content || '', tool_calls: tcs });
    for (const tc of tcs) {
      chkStop();
      let args = {};
      try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) { /* */ }
      const fnName = (tc.function && tc.function.name) || '';
      let out;
      try { out = await qaAgentExec(fnName, args, lastUser); }
      catch (e) { out = '工具执行失败：' + (e.message || e) + '。请如实告知用户该数据本次未能取到，不要编造。'; }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 8000) });
    }
    if (onNote) try { onNote(tcs.map(t => t.function && t.function.name).join('、')); } catch (e) { /* */ }
  }
  /* 轮次上限 → 强制作答（不带 tools，避免模型继续要调用） */
  msgs.push({ role: 'user', content: '（系统提示：工具调用轮次已达上限，请基于以上工具结果直接回答；取不到的数据如实说明。）' });
  return qaLlmStream(msgs, { signal, onDelta });
}

/* ---------- 问答上下文：把持仓 / 自选 / 近期交易喂给模型 ----------
   v3.9.8 持仓不再自己算，改走 computeHoldings() —— 那是「总览 / 持仓 / 复盘」页面显示的
   **同一个**引擎。旧写法有两条独立缺陷，叠在一起会让问答把「有仓位」说成「空仓」：
     ① 方向字段读的是 `t.action`，而云端 trades 表的真实列名是 `transaction_type`
        （表结构已核对）→ `t.action === 'buy'` 恒 false → **每一笔买入都被当成卖出**
        → 持股量恒 ≤ 0 → 永远输出「无持仓」；
     ② 排序用的是不存在的 `t.trade_date`（真列是 transaction_time）→ 顺序全乱，
        再加上只读 t.price、忽略手续费与 net_amount，成本口径也和页面不一致。
   现在与页面共用一套结果：加权成本、摊薄成本、浮动盈亏都能对上，问答与界面不会再各说各话。 */
function qaHoldingsSummary() {
  const qm = new Map(S.quotes.map(q => [q.stock_code, q]));
  const out = [];
  for (const h of computeHoldings()) {
    if (!(h.qty > 0)) continue;
    const q = qm.get(h.code);
    const px = q && q.price != null ? Number(q.price) : null;
    const costW = h.costValue / h.qty;      // 加权成本（含手续费）
    const costD = h.dilutedValue / h.qty;   // 摊薄成本（已实现盈亏滚入）
    const pnl = px != null ? h.qty * px - h.costValue : null;
    out.push(`${h.name || h.code}(${h.code})：${h.qty}股，加权成本 ${costW.toFixed(3)}，摊薄成本 ${costD.toFixed(3)}`
      + (px != null ? `，现价 ${px}` : '')
      + (pnl != null ? `，浮动盈亏 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}元` : ''));
  }
  return out.length ? out.join('；') : '无持仓';
}
function qaBuildContext() {
  const posStr = qaHoldingsSummary();
  /* v3.9.8 字段名修正：读 transaction_time / transaction_type / note（云端真实列），
     不再是 tm 那套 t.trade_date / t.action / t.comment —— 旧写法让日期列全空、
     方向恒显示「卖出」、备注丢失，模型照着说就成了「最近几笔都是卖出操作」。 */
  const sorted = S.trades.slice().sort((a, b) =>
    String(b.transaction_time || '').localeCompare(String(a.transaction_time || '')));
  const trades = sorted.slice(0, QA_CTX_TRADES).map(t =>
    `${String(t.transaction_time || '').replace('T', ' ').slice(0, 16)} ${t.transaction_type === 'buy' ? '买入' : '卖出'} `
    + `${t.stock_name || t.stock_code}(${t.stock_code}) ${t.quantity}股 @${t.price}`
    + (t.note ? `（${t.note}）` : '')).join('\n') || '无';
  const watch = S.watchlist.map(w => `${w.stock_name || w.stock_code}${w.note ? `（${w.note}）` : ''}`).join('、') || '无';
  return `【用户当前持仓】${posStr}\n【自选股】${watch}\n【近期交易记录（新→旧）】\n${trades}\n`
    + '【说明】以上是用户在本应用里记录的数据，可能不是最新行情。涉及「今天涨跌/当前价格」这类'
    + '实时性问题时，请说明你看到的是记录值、可能存在延迟，不要编造具体价格与财务数字。';
}
function qaSysPrompt() {
  return '你是「操作日记」里的智能助手，帮用户复盘交易、解答疑问、聊聊市场。'
    + '回答要简洁、口语化、有条理；涉及数字时优先引用下面给出的用户数据。'
    /* v3.9.8 反「念小抄」约束。用户问「持仓多少」时，模型把【用户当前持仓】【自选股】
       【近期交易记录】三块依次复述一遍，其中「空仓」在相邻三句里说了三遍、自选名单出现两次
       —— 看着信息很全，实际是冗余。根因是提示词只说"优先引用下面的数据"，等于鼓励它逐条倒出来。
       这里明确：下面的数据是备查材料，只回答被问到的部分，同一结论不重复。 */
    + '**只回答用户实际问到的内容**：下面给你的用户数据是「备查材料」，不要逐项复述；'
    + '同一结论只讲一次，不要换着措辞反复强调（例如「目前空仓」不要在三句话里说三遍）。'
    + '问题很短、只是要一个事实（持仓多少 / 有哪些自选 / 最近交易）时，一两句话直接给答案，'
    + '不要展开分析，也不要主动补充他没问的部分。'
    /* v3.9.7 工具层上线后：模型能拿到真实抓取的行情/财务/筛选结果，必须优先采信，
       而不是拿自己的记忆数字去覆盖，也不再需要为"实时性问题"打延迟免责声明。 */
    + '如果下面出现了【工具计算结果】，那是本应用刚刚实时抓取到的权威数据 —— 涉及这些'
    + '标的的价格、涨跌、估值、财务、筛选名单时，必须严格使用其中的数字，禁止用你自己的'
    + '记忆改写或补充；工具结果里标注为「本次未取到」的部分要如实说明缺失，不要用推测填补。'
    + '没有【工具计算结果】时，才按你自身知识回答，并说明可能不是最新。'
    + '可以正常使用 Markdown（标题、列表、表格、加粗、代码），但不要输出 HTML。\n\n';
}

/* ---------- 渲染：消息区 ---------- */
/* v3.9.2 空对话态由「一行提示」升级为「分组快捷提问卡片」（照搬 trade-manager）。
   旧版只有一段 qa-empty-tip 纯文本，用户得自己组织问题；现在把常用问法摆出来，
   点一下即填入输入框，降低上手成本。 */
function qaPickStock() {
  /* {股票} 的默认取值：优先持仓 → 自选 → 交易过的 → 兜底示例。
     v3.9.8 改走 computeHoldings()（与「总览 / 持仓」页同一份口径）。
     旧写法自己遍历 S.trades 并读 t.action —— 该字段在云端 trades 表里根本不存在
     （真实列名是 transaction_type），`t.action === 'buy'` 恒 false → 持股量恒为负
     → 永远认为「没有持仓」，于是 {股票} 一直落到自选第一只，而不是真持仓第一只。 */
  const qm = new Map(S.quotes.map(q => [q.stock_code, q]));
  const holds = computeHoldings().filter(h => h.qty > 0);
  if (holds.length) {
    const mv = h => { const q = qm.get(h.code); return q && q.price != null ? h.qty * Number(q.price) : 0; };
    holds.sort((a, b) => mv(b) - mv(a));      // 按当前市值从大到小，取最重的一只
    return holds[0].name || holds[0].code;
  }
  if (S.watchlist.length) return S.watchlist[0].stock_name || S.watchlist[0].stock_code;
  if (S.trades.length) return S.trades[0].stock_name || S.trades[0].stock_code;
  return '贵州茅台';
}
function qaEmptyHtml() {
  const intro = '<div class="qa-ex-intro">👋 我是你的操作日记，能结合你的持仓、自选与交易记录回答问题。'
    + '<br>下面是一些常用问法，点一下即可填入输入框（<b>{股票}</b> 已自动替换为你的股票，可自行修改）——</div>';
  const groups = QA_EXAMPLES.map(g =>
    '<div class="qa-ex-group"><div class="qa-ex-title">' + esc(g.g) + '</div><div class="qa-ex-grid">'
    + g.items.map(x => '<button type="button" class="qa-ex-card" data-q="' + esc(x.q) + '"><b>' + esc(x.n) + '</b><span>'
      + esc(x.q.replace(/\{股票\}/g, '某股').slice(0, 46)) + '…</span></button>').join('')
    + '</div></div>').join('');
  return '<div class="qa-examples">' + intro + groups
    + '<div class="qa-ex-foot">也可以直接聊别的，或「上传文件」（txt / csv / md / json）让我帮你看看。</div>'
    + '</div>';
}
/* 点击示例卡片 → 填入输入框（{股票} 就地替换）并聚焦，光标落到末尾 */
function qaUseExample(q) {
  const input = $('qaInput');
  if (!input || !q) return;
  const text = String(q).replace(/\{股票\}/g, qaPickStock());
  input.value = text;
  qaSyncSendState();
  input.focus();
  try { input.setSelectionRange(text.length, text.length); } catch (e) { /* 忽略 */ }
}
/* 示例卡片是随 renderQaMessages 重建的，故用事件委托绑在 #qaMessages 上，
   只绑一次（dataset 打标防重复绑定，登录多次不叠加监听）。 */
function bindQaExamples() {
  const box = $('qaMessages');
  if (!box || box.dataset.exBound) return;
  box.dataset.exBound = '1';
  box.addEventListener('click', e => {
    const btn = e.target.closest('.qa-ex-card');
    if (!btn) return;
    qaUseExample(btn.dataset.q);
  });
  /* v3.14.0 「＋」弹出菜单：文件 / 技能搜索列表（示例问题恢复独立 💡 按钮） */
  const plus = $('qaPlusBtn'), menu = $('qaPlusMenu'), skMenu = $('qaSkillMenu');
  if (!plus || !menu || plus.dataset.plusBound) return;
  plus.dataset.plusBound = '1';
  const closeAll = () => { menu.hidden = true; skMenu.hidden = true; };
  plus.addEventListener('click', e => {
    e.stopPropagation();
    const open = !menu.hidden;
    closeAll();
    if (open) return;
    menu.hidden = false;
  });
  menu.addEventListener('click', e => {
    const item = e.target.closest('.qa-plus-item');
    if (!item) return;
    e.stopPropagation();   /* v3.14.0 关键修复：阻止冒泡到 document 的「点外关闭」监听——
                              否则刚打开的技能面板会被同一次点击立刻关掉（面板闪一下即逝） */
    const act = item.dataset.act;
    if (act === 'attach') { closeAll(); $('qaFileInput').click(); }
    else if (act === 'skills') { menu.hidden = true; skMenu.hidden = false; $('qaSkillSearch').value = ''; renderQaSkillPick(''); setTimeout(() => $('qaSkillSearch').focus(), 30); }
  });
  skMenu.addEventListener('click', e => {
    const item = e.target.closest('.qa-plus-item');
    if (item) {
      const act = item.dataset.act;
      if (act === 'skillLocal' || act === 'skillManage') {
        closeAll();
        switchView('me'); switchSetPane('skill');
      }
      return;
    }
    const toggle = e.target.closest('.sk-toggle');
    if (toggle) {
      e.stopPropagation();
      const id = toggle.dataset.sid;
      const s = skillById(id);
      const on = !(s && s.enabled === false);
      skillSetEnabled(id, !on);          // 现在是开 → 点了变关
      renderQaSkillPick($('qaSkillSearch').value);
      return;
    }
    const row = e.target.closest('.qa-skill-row');
    if (row) {
      qaUseExample(row.dataset.q || row.dataset.name || '');
      closeAll();
    }
  });
  $('qaSkillSearch').addEventListener('input', e => renderQaSkillPick(e.target.value));
  /* v3.14.0 恢复独立 💡 按钮（用户要求示例问题独立出来，回到 v3.12.7 逻辑） */
  const exBtn = $('qaExBtn'), panel = $('qaExPanel');
  if (exBtn && panel && !exBtn.dataset.exBound) {
    exBtn.dataset.exBound = '1';
    exBtn.addEventListener('click', e => {
      e.stopPropagation();
      closeAll();
      if (!panel.innerHTML) panel.innerHTML = '<div class="qa-ex-head"><b>💡 示例问题</b><button type="button" class="qa-ex-close" title="收起">✕</button></div>' + qaEmptyHtml();
      panel.hidden = !panel.hidden;
    });
    panel.addEventListener('click', e => {
      if (e.target.closest('.qa-ex-close')) { panel.hidden = true; return; }
      const btn = e.target.closest('.qa-ex-card');
      if (!btn) return;
      qaUseExample(btn.dataset.q);
      panel.hidden = true;
    });
  }
  document.addEventListener('click', e => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== plus && !plus.contains(e.target)) menu.hidden = true;
    if (!skMenu.hidden && !skMenu.contains(e.target) && e.target !== plus && !plus.contains(e.target)) skMenu.hidden = true;
    /* 示例面板：点外部收起（面板内的卡片/关闭按钮不触发） */
    const p = $('qaExPanel');
    if (p && !p.hidden && !p.contains(e.target) && e.target !== exBtn && !exBtn.contains(e.target)) p.hidden = true;
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
  /* 示例面板内：✕ 收起 / 点卡片填入并收起（v3.13.0 重构时丢了面板的点击绑定，这里补回） */
  const exPanel = $('qaExPanel');
  exPanel.addEventListener('click', e => {
    if (e.target.closest('.qa-ex-close')) { exPanel.hidden = true; return; }
    const btn = e.target.closest('.qa-ex-card');
    if (!btn) return;
    qaUseExample(btn.dataset.q);
    exPanel.hidden = true;
  });
}
/* 技能选择列表：搜索过滤 + 点击填触发问句 + 右侧启停开关 */
function renderQaSkillPick(filter) {
  const box = $('qaSkillPick');
  if (!box) return;
  const f = String(filter || '').trim().toLowerCase();
  const list = skillListAll().filter(s => !f
    || (s.name || '').toLowerCase().indexOf(f) >= 0
    || (s.desc || '').toLowerCase().indexOf(f) >= 0
    || (s.id || '').toLowerCase().indexOf(f) >= 0);
  if (!list.length) { box.innerHTML = '<p class="hint" style="padding:8px 10px">没有匹配的技能</p>'; return; }
  box.innerHTML = list.map(s => {
    const on = s.enabled !== false && s.installed;
    const sample = s.isUser && s.keywords && s.keywords.length ? s.keywords[0]
      : (s.id === 'pnl' ? '持仓的票分析下' : (s.name || s.id));
    return `<button type="button" class="qa-skill-row${on ? '' : ' sk-off'}" data-q="${esc(sample)}" data-name="${esc(s.name)}">`
      + `<span class="sk-ic">${esc(s.icon || '🧩')}</span><span class="sk-name">${esc(s.name)}</span>`
      + `<span class="sk-desc">${esc((s.desc || '').slice(0, 40))}</span>`
      + `<span class="sk-toggle${on ? ' on' : ''}" data-sid="${esc(s.id)}" title="点击${on ? '停用' : '启用'}">${on ? '启用中' : '已停用'}</span></button>`;
  }).join('');
}
/* v3.17.1 修复：v3.13.3 图片提问时把用户消息 content 存成了多模态数组
   （text + image_url），但渲染层还在当纯字符串 esc(m.content) → 气泡显示
   「[object Object],[object Object]」，renderQaJump 的 m.content.split 更是直接
   TypeError。这里统一出口：文本取 text 段拼接，图片段转成 <img> 缩略图。 */
function qaUserMsgParts(m) {
  if (!Array.isArray(m.content)) return { text: String(m.content == null ? '' : m.content), imgs: [] };
  return {
    text: m.content.filter(p => p.type === 'text').map(p => p.text).join('\n'),
    imgs: m.content.filter(p => p.type === 'image_url' && p.image_url && p.image_url.url)
      .map(p => p.image_url.url),
  };
}
function qaUserMsgText(m) {
  return qaUserMsgParts(m).text;
}
function qaUserMsgHtml(m) {
  const { text, imgs } = qaUserMsgParts(m);
  const imgsHtml = imgs.map(u =>
    /* v3.17.1 不用 <a target=_blank>：浏览器禁止顶层导航到 data: URL，点了没反应 */
    `<img class="qa-user-img" src="${esc(u)}" alt="附件图片">`
  ).join('');
  return esc(text) + (imgsHtml ? `<div class="qa-user-imgs">${imgsHtml}</div>` : '');
}
function renderQaMessages() {
  const box = $('qaMessages');
  if (!box) return;
  const cid = qaState.conversationId;
  const busy = !!qaState.busyConvs[cid];
  if (!qaState.messages.length && !busy) { box.innerHTML = qaEmptyHtml(); return; }
  let uidx = 0;
  let html = qaState.messages.map(m => {
    /* v3.9.7 工具结果便签：qa-tools.js 的 qaRunTools 会往消息流里塞一条 role:'tool' 的
       记录（icon/title/lines/html/chart/skills），它不是对话内容而是「本轮取到了哪些数据」
       的凭证，所以单独走 toolNoteHtml 渲染，并用 .msg.note 的居中浅绿气泡样式区分开。 */
    if (m.role === 'tool') return `<div class="msg note">${toolNoteHtml(m)}</div>`;
    if (m.role === 'assistant') return `<div class="msg assistant">${qaMdToHtml(m.content)}</div>`;
    /* v3.17.1 用户气泡走 qaUserMsgHtml：数组 content 正确显示文本+图片缩略图 */
    if (m.role === 'user') { uidx += 1; return `<div class="msg ${m.role}" data-uidx="${uidx - 1}">${qaUserMsgHtml(m)}</div>`; }
    return `<div class="msg ${m.role}">${esc(m.content)}</div>`;
  }).join('');
  /* 正在生成的会话补一个流式气泡：切走再切回来，已生成的部分接着显示
     （内容存在 qaState.stream，DOM 用固定 id 定位，不依赖旧元素引用） */
  if (busy) {
    const s = qaState.stream[cid] || '';
    html += `<div class="msg assistant" id="qaStream-${esc(cid)}">${s ? qaMdToHtml(s) : '思考中…'}</div>`;
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
  renderQaJump();
}

/* ---------- v3.12.1 右侧「本会话提问」快速导航（类似 WorkBuddy 的历史问题列表） ---------- */
function qaJumpCollapsed() {
  try { return localStorage.getItem('sj_qa_jump') === '0'; } catch (e) { return false; }
}
function renderQaJump() {
  const list = $('qaJumpList'), panel = $('qaJumpPanel'), layout = document.querySelector('.qa-layout');
  if (!list) return;
  const collapsed = qaJumpCollapsed();
  if (layout) layout.classList.toggle('no-jump', collapsed);
  if (panel) panel.classList.toggle('collapsed', collapsed);
  const btn = $('qaJumpToggle');
  if (btn) btn.textContent = collapsed ? '«' : '»';
  const qs = (qaState.messages || []).filter(m => m.role === 'user');
  const shown = qs.slice(-80);
  list.innerHTML = shown.length
    ? shown.map((m, i) => {
        const idx = qs.length - shown.length + i;
        /* v3.17.1 数组 content（图片提问）不能直接 split —— 走统一文本出口 */
        const t = qaUserMsgText(m).split('\n')[0].replace(/📎.*$/, '').trim() || '（附件提问）';
        return `<button type="button" class="qa-jump-item" data-uidx="${idx}" title="${esc(t)}">${esc(t.length > 42 ? t.slice(0, 42) + '…' : t)}</button>`;
      }).join('')
      : '<div class="qa-jump-item" style="cursor:default">本会话还没有提问</div>';
}
function bindQaJump() {
  const list = $('qaJumpList'), toggle = $('qaJumpToggle');
  if (list) list.addEventListener('click', e => {
    const b = e.target.closest('.qa-jump-item[data-uidx]');
    if (!b) return;
    const el = document.querySelector(`#qaMessages .msg.user[data-uidx="${b.dataset.uidx}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  });
  if (toggle) toggle.addEventListener('click', () => {
    try { localStorage.setItem('sj_qa_jump', qaJumpCollapsed() ? '1' : '0'); } catch (e) { /* */ }
    renderQaJump();
  });
  renderQaJump();
}

/* ---------- 渲染：左侧历史列表 ---------- */
/* v3.15.0 手机抽屉未读角标（顶层：sendQa 与抽屉开关都要调） */
function qaRenderDrawerBadge() {
  const b = $('qaDrawerBadge');
  if (!b) return;
  const n = qaState.unread ? qaState.unread.size : 0;
  b.hidden = !n;
  b.textContent = n;
}
function renderQaHistory() {
  const list = $('qaHistoryList');
  if (!list) return;
  const kwEl = $('qaSearch');
  const kw = kwEl ? kwEl.value.trim().toLowerCase() : '';
  let rows = qaState.all;
  if (kw) rows = rows.filter(r => ((r.question || '') + (r.answer || '')).toLowerCase().includes(kw));
  /* 云端聚合：每个会话取最新一条问题做标题（all 已按 id 倒序 = 插入倒序） */
  const convs = [];
  const seen = new Set();
  for (const r of rows) {
    const cid = r.conversation_id;
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    convs.push({ id: cid, title: String(r.question || '').replace(/^📎.*$/m, '').slice(0, 30) || '新对话' });
  }
  /* 本地登记的会话（刚点「新对话」或占位行还在路上）顶到最前，
     这样左侧列表不用等落库往返就能看到 */
  const extra = Object.keys(qaState.local)
    .filter(id => !seen.has(id))
    .map(id => ({ id, title: qaState.local[id].title, at: qaState.local[id].at || 0 }))
    .filter(c => !kw || String(c.title).toLowerCase().includes(kw))
    .sort((a, b) => b.at - a.at)
    .map(c => ({ id: c.id, title: c.title }));
  const finalList = extra.concat(convs);
  const html = finalList.length
    ? finalList.map(c => `<div class="qa-hist-item${c.id === qaState.conversationId ? ' active' : ''}">`
        + `<span class="qa-hist-main" data-qa-open="${esc(c.id)}">💬 ${esc(c.title)}</span>`
        + `<span class="qa-hist-del" title="删除该会话" data-qa-del="${esc(c.id)}">✕</span></div>`).join('')
    : '<div class="qa-empty-tip" style="font-size:12.5px">暂无历史问答</div>';
  list.innerHTML = html;
  /* v3.15.0 手机抽屉里的会话列表同步渲染（桌面隐藏，≤720px 显示） */
  const listM = $('qaHistoryListM');
  if (listM) listM.innerHTML = html;
  qaRenderDrawerBadge();
}

/* ---------- 附件 ---------- */
function renderQaChips() {
  const box = $('qaAttachChips');
  if (!box) return;
  const fs = qaState.files;
  box.hidden = !fs.length;
  /* v3.13.3 图片附件显示缩略图（48px），文本附件显示字数 */
  box.innerHTML = fs.map((f, i) =>
    `<span class="qa-attach-chip">${f.image ? `<img class="qa-chip-img" src="${f.image}" alt="">` : ''}`
    + `<b>${esc(f.name)}</b><span>${f.image ? '图片' : (f.text ? Math.round(f.text.length / 100) / 10 + 'k 字' : '')}</span>`
    + `<button type="button" data-qa-rm="${i}" title="移除">✕</button></span>`).join('');
}
async function qaAddFile(f) {
  if (qaState.files.length >= 5) { toast('最多同时带 5 个附件', 'warn'); return; }
  const isImg = /^image\//.test(f.type);
  if (isImg) {
    const raw = await new Promise(res => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => res('');
      fr.readAsDataURL(f);
    });
    if (!raw) { toast('图片读取失败', 'warn'); return; }
    /* v3.13.3 压缩到 ≤1024px 再发模型（base64 太大会拖垮请求） */
    const dataUrl = await new Promise(res => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
          if (scale >= 1) return res(raw);
          const cv = document.createElement('canvas');
          cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          res(cv.toDataURL('image/jpeg', 0.85));
        } catch (e) { res(raw); }
      };
      img.onerror = () => res(raw);
      img.src = raw;
    });
    qaState.files.push({ name: f.name, image: dataUrl });
  } else {
    if (f.size > 512 * 1024) { toast('文件过大（限 500KB）', 'warn'); return; }
    const text = await f.text().catch(() => '');
    if (!text) { toast('文件读取失败', 'warn'); return; }
    qaState.files.push({ name: f.name, text });
  }
  renderQaChips();
}

/* ---------- 发送 / 中止 ---------- */
function qaSyncSendState() {
  const btn = $('qaSendBtn'), stop = $('qaStopBtn'), inp = $('qaInput');
  if (!btn) return;
  const busy = !!qaState.busyConvs[qaState.conversationId];
  const has = !!(inp && inp.value.trim()) || qaState.files.length > 0;
  btn.disabled = busy || !has;
  if (stop) stop.hidden = !busy;
  /* v3.15.0 「当前模型」行按需求删除：qa-src-bar 已从页面移除，这里不再填充 */
}
function qaLocalSet(cid, title) {
  /* 顺手清掉之前建过、但一直没用过的空会话，免得「新对话」项越堆越多 */
  Object.keys(qaState.local).forEach(id => {
    if (id === cid) return;
    const it = qaState.local[id];
    if (it && it.title === '新对话'
      && !(qaState.msgs[id] || []).length
      && !qaState.busyConvs[id]
      && !qaState.all.some(r => r.conversation_id === id)) delete qaState.local[id];
  });
  const cur = qaState.local[cid];
  const t = title === undefined ? '' : String(title || '').trim();
  qaState.local[cid] = {
    title: (t || (cur && cur.title) || '新对话').slice(0, 30),
    at: cur ? cur.at : Date.now(),
  };
}

async function sendQa() {
  /* v3.17.2 防重发守卫：当前会话还在生成时不允许再发。按钮在 qaSyncSendState
     里已禁用，但 Enter 键是直接调 sendQa()、绕过 disabled —— 旧代码能在上一个
     问题没答完时再发一条，两条回答会交错写进同一个会话流。按钮和键盘统一在
     这里拦下。 */
  if (qaState.busyConvs && qaState.busyConvs[qaState.conversationId]) {
    toast('上一个问题还在回答中，请等它完成，或点 ■ 停止后再发', 'warn');
    return;
  }
  const input = $('qaInput');
  const question = input.value.trim();
  const files = qaState.files || [];
  if (!question && !files.length) return;
  /* v3.9.8 记录类问题（持仓 / 自选 / 交易记录）本地直答：答案全在本机数据里，
     不需要模型也不需要联网。放在最前面有两个作用 ——
       ① 彻底避开模型把【持仓】【自选】【交易记录】三块小抄各念一遍的啰嗦
          （用户反馈：问「持仓多少」得到三句「目前处于空仓状态」）；
       ② 没配 AI 模型时也照样能查持仓（下面的模型校验对它放行）。
     带附件的提问一律不走本地直答 —— 附件内容可能重新定义问题，交给模型更稳。 */
  const localAns = files.length ? '' : qaLocalAnswer(question);
  if (!localAns && !ModelMgr.cur) { toast('请先到「设置 → AI 模型」选择一个模型', 'warn'); return; }
  /* 会话快照：本次生成全程绑定 convId。中途切走会话也不中断，回答会照常入库，
     切回来就能看到；只有「当前视图仍是本会话」时才回写界面。 */
  const convId = qaState.conversationId;
  qaState.messages = qaMsgsOf(convId);
  const myMsgs = qaState.messages;
  input.value = '';
  /* 附件内容拼进问题文本，展示层只带附件名单 */
  const attachNote = files.length ? '\n📎 附件：' + files.map(f => f.name).join('、') : '';
  let fullQuestion = question;
  for (const f of files) if (f.text) fullQuestion += `\n\n【附件：${f.name}】\n${f.text.slice(0, 8000)}`;
  qaState.files = [];
  renderQaChips();
  qaState.busyConvs[convId] = true;
  const controller = new AbortController();
  qaState.controllers[convId] = controller;
  /* v3.12.4 关键修复：signal 此前从未定义（v3.11.1 回路重构遗漏）——停止按钮 abort
     了没人监听的控制器，工具取数阶段完全停不了；且取数完成后走流式必抛
     ReferenceError → 全部显示「回答失败」。现在正确接线。 */
  const signal = controller.signal;
  /* v3.13.3 图片附件真正发给模型：content 用 multipart 数组（text + image_url），
     模型/网关不支持时顶层 catch 会自动降级为纯文本重试 */
  const imgFiles = files.filter(f => f.image);
  const asTextContent = m => Array.isArray(m.content)
    ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : m.content;
  myMsgs.push({
    role: 'user',
    content: imgFiles.length
      ? [{ type: 'text', text: fullQuestion }, ...imgFiles.map(f => ({ type: 'image_url', image_url: { url: f.image } }))]
      : question + attachNote,
  });
  qaState.stream[convId] = '';
  qaLocalSet(convId, question || (files.length ? '附件提问' : ''));
  renderQaMessages();
  renderQaHistory();
  qaSyncSendState();

  /* 落库占位：后台并行写，不阻塞提问；生成结束时要拿它的 id 做替换，所以留一个 promise */
  const phPromise = (async () => {
    try {
      const ph = await store.insert('qa_history', {
        conversation_id: convId, question: question + attachNote, answer: '',
      });
      const id = (ph && ph.id) || 0;
      await qaReloadAll();
      if (qaState.all.some(x => x.conversation_id === convId)) delete qaState.local[convId];
      renderQaHistory();
      return id;
    } catch (e) { return 0; }
  })();

  const box = $('qaMessages');
  const streamEl = () => document.getElementById('qaStream-' + convId);
  const onScreen = () => qaState.conversationId === convId;
  const holder = streamEl() || (() => {
    const d = document.createElement('div');
    d.className = 'msg assistant';
    d.id = 'qaStream-' + convId;
    d.textContent = '思考中…';
    if (box) box.appendChild(d);
    return d;
  })();
  if (box) box.scrollTop = box.scrollHeight;

  let answer = '', streamed = '', lastPaint = 0;
  /* 长回答首字较慢时给个明确提示，避免「卡死」观感 */
  const slowTip = setTimeout(() => {
    if (streamed) return;
    const h = streamEl();
    if (h) h.textContent = '正在生成较长内容，请稍候…（可点右侧 ■ 中断）';
  }, 20000);

  try {
    if (localAns) {
      /* v3.9.8 本地直答分支：直接落字，不跑工具、不请求模型。同步完成，
         holder 上那句「思考中…」在同一帧内就被替换掉，用户看不到中间态。 */
      answer = localAns;
      qaState.stream[convId] = localAns;
      const h0 = streamEl();
      if (h0) h0.innerHTML = qaMdToHtml(localAns);
      if (box) box.scrollTop = box.scrollHeight;
    } else {
    /* v3.9.7 先跑工具取数。命中意图（选股 / 行情 / 财务 / 诊断 / 回测 / 风险 / 复盘 / K线相似度）时，
       qaRunTools 会真实抓取公开数据、往消息流插一张结果便签，并返回一段【工具计算结果】文本；
       把它接到 system 末尾，模型就必须引用其中的真实数字，而不是凭记忆编造。
       工具层任何失败都不影响正常问答（异常吞掉，退化为原来的纯上下文问答）。 */
    let toolBlock = '';
    try { toolBlock = await qaRunTools(question, box, holder, signal); } catch (e) {
      /* 中断向上传递（不能当「工具失败」吞掉继续问模型） */
      if (e && e.name === 'AbortError') throw e;
      toolBlock = '';
    }
    const sys = qaSysPrompt() + qaBuildContext() + (toolBlock ? '\n\n' + toolBlock : '');
    /* v3.17.1 历史里的图片消息（数组 content）统一抽出纯文本：baseMsgs 走的是
       非多模态请求，原样塞数组会让不支持多模态的模型报错或看不懂 */
    const history = myMsgs
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-9, -1).map(m => ({ role: m.role, content: Array.isArray(m.content) ? qaUserMsgText(m) : m.content }));
    const baseMsgs = [{ role: 'system', content: sys }, ...history, { role: 'user', content: fullQuestion }];
    /* v3.13.3 带图版消息（多模态模型直接支持；不支持时顶层 catch 降级重试纯文本） */
    const withImgMsgs = imgFiles.length ? [{ role: 'system', content: sys }, ...history, {
      role: 'user',
      content: [{ type: 'text', text: fullQuestion }, ...imgFiles.map(f => ({ type: 'image_url', image_url: { url: f.image } }))],
    }] : baseMsgs;
    if (toolBlock) {
      /* 规则路由命中 → 原单轮流式（快路径，不受模型能力影响） */
      answer = await qaLlmStream(baseMsgs, {
        signal,
        onDelta: (d) => {
          streamed += d;
          qaState.stream[convId] = streamed;
          const h = streamEl();
          if (!h) return;
          const now = Date.now();
          if (!lastPaint || now - lastPaint > 90) {
            lastPaint = now;
            h.innerHTML = qaMdToHtml(streamed);
            if (box) box.scrollTop = box.scrollHeight;
          }
        },
      });
      answer = answer || streamed;
    } else {
      /* v3.11.1 规则路由没命中 → Agentic 回路：模型自己决定调用哪个技能，
         本地真实执行后回传，最多 4 轮，再流式/直接作答。
         模型不支持 function calling（HTTP 400/422）→ 自动回退纯上下文流式。 */
      const onDeltaAg = (d) => {
        streamed += d;
        qaState.stream[convId] = streamed;
        const h = streamEl();
        if (!h) return;
        const now = Date.now();
        if (!lastPaint || now - lastPaint > 90) {
          lastPaint = now;
          h.innerHTML = qaMdToHtml(streamed);
          if (box) box.scrollTop = box.scrollHeight;
        }
      };
      try {
        answer = await qaAgentLoop(withImgMsgs, {
          signal,
          onDelta: onDeltaAg,
          onNote: nm => {
            const h = streamEl();
            if (h && onScreen()) {
              h.innerHTML = '<span class="hint">🔧 模型自主调用技能：' + esc(nm) + ' …</span>';
              if (box) box.scrollTop = box.scrollHeight;
            }
          },
        });
        /* 模型坚持回空串 → 不带 tools 的纯流式兜底（保证用户总能拿到一句回复） */
        if (!answer) {
          answer = await qaLlmStream(baseMsgs, { signal, onDelta: onDeltaAg });
          answer = answer || streamed;
        }
      } catch (eAg) {
        if (eAg && eAg.name === 'AbortError') throw eAg;
        NetLog.push('llm', 'agentic 回路回退', false, 0, eAg.message || String(eAg));
        answer = await qaLlmStream(baseMsgs, { signal, onDelta: onDeltaAg });
        answer = answer || streamed;
      }
    }
    const h = streamEl();
    if (h) h.innerHTML = qaMdToHtml(answer);
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      answer = streamed;
      const h = streamEl();
      if (h) h.innerHTML = qaMdToHtml(streamed || '（已停止生成）');
    } else if (imgFiles.length) {
      /* v3.13.3 图片请求被模型/网关拒绝 → 自动降级纯文本重试一次 */
      try {
        const h0 = streamEl();
        if (h0) h0.textContent = '当前模型可能不支持图片，改用纯文本重试…';
        answer = await qaLlmStream(baseMsgs, {
          signal,
          onDelta: (d) => {
            streamed += d;
            qaState.stream[convId] = streamed;
            const h = streamEl();
            if (h && onScreen()) h.innerHTML = qaMdToHtml(streamed);
          },
        });
        answer = answer || streamed;
        const h = streamEl();
        if (h) h.innerHTML = qaMdToHtml(answer);
        if (onScreen()) toast('模型不支持图片，已按纯文本回答');
      } catch (e2) {
        if (e2 && e2.name === 'AbortError') { answer = streamed; }
        else {
          const h = streamEl();
          if (h) h.textContent = '回答失败：' + (e2 && e2.message ? e2.message : '请稍后重试');
          if (onScreen()) toast('问答请求失败', 'warn');
        }
      }
    } else {
      const h = streamEl();
      if (h) h.textContent = '回答失败：' + (e && e.message ? e.message : '请稍后重试');
      if (onScreen()) toast('问答请求失败', 'warn');
    }
  } finally {
    clearTimeout(slowTip);
    delete qaState.busyConvs[convId];
    delete qaState.controllers[convId];
    delete qaState.stream[convId];
    /* v3.15.0 非当前会话生成完成 → 计入抽屉未读角标 */
    if (qaState.conversationId !== convId && answer) {
      qaState.unread = qaState.unread || new Set();
      qaState.unread.add(convId);
      qaRenderDrawerBadge();
    }
    qaSyncSendState();
  }

  myMsgs.push({ role: 'assistant', content: answer || streamed || '（本轮未生成回答）' });
  if (onScreen()) renderQaMessages();

  /* 落库收尾：首问时已写入占位行，这里把它换成完整记录；
     若最终没生成出回答，就保留占位行 —— 左侧列表里这条会话与提问仍然看得到。 */
  let phId = 0;
  try { phId = await phPromise; } catch (e) { phId = 0; }
  try {
    if (answer) {
      if (phId) { try { await store.remove('qa_history', phId); } catch (e) { /* 占位删不掉不影响最终记录 */ } }
      await store.insert('qa_history', {
        conversation_id: convId, question: question + attachNote, answer,
      });
    }
    await qaReloadAll();
    if (qaState.all.some(x => x.conversation_id === convId)) delete qaState.local[convId];
    renderQaHistory();
  } catch (e) { /* 保存失败不影响使用 */ }
}
function qaStop() {
  const c = qaState.controllers[qaState.conversationId];
  if (c) { try { c.abort(); } catch (e) { /* */ } }
}

/* ---------- 历史加载 / 会话切换 / 删除 ---------- */
async function qaReloadAll() {
  try {
    const rows = await store.query('qa_history');
    qaState.all = (rows || []).slice(0, QA_HISTORY_LIMIT);
    qaState.loaded = true;
  } catch (e) { qaState.all = []; }
}
function qaLoadConversation(cid) {
  const rows = qaState.all.filter(r => r.conversation_id === cid)
    .sort((a, b) => (a.id > b.id ? 1 : -1));
  const cloudMsgs = [];
  for (const r of rows) {
    cloudMsgs.push({ role: 'user', content: r.question });
    /* 占位行（answer 为空，生成失败/被中止时留下的）→ 给个明确提示，别让用户以为丢了 */
    cloudMsgs.push({ role: 'assistant', content: r.answer || '（这轮没有生成出回答，可以重新提问）' });
  }
  const mem = qaState.msgs[cid] || [];
  /* 正在生成、或内存里比云端还新（刚答完、正在落库）→ 用内存缓存，避免内容闪失；
     否则以云端记录为准重建（保证与落库内容一致）。 */
  if (qaState.busyConvs[cid] || mem.length > cloudMsgs.length) qaAttach(cid);
  else { qaState.msgs[cid] = cloudMsgs; qaAttach(cid); }
  renderQaMessages();
  renderQaHistory();
  qaSyncSendState();
}
async function qaDeleteConversation(cid) {
  if (!window.confirm('删除该会话的全部问答记录？删除后不可恢复。')) return;
  try {
    const ids = qaState.all.filter(r => r.conversation_id === cid).map(r => r.id);
    for (const id of ids) await store.remove('qa_history', id);
    delete qaState.local[cid];
    delete qaState.msgs[cid];
    delete qaState.stream[cid];
    if (qaState.conversationId === cid) qaAttach(qaNewId());
    await qaReloadAll();
    renderQaMessages();
    renderQaHistory();
    qaSyncSendState();
    toast('会话已删除');
  } catch (e) {
    toast('删除失败：' + (e && e.message || e), 'warn');
  }
}

/* ---------- 初始化（DOM 就绪后调用） ---------- */
function initQa() {
  if (!$('view-qa')) return;
  qaAttach(qaNewId());
  renderQaMessages();
  renderQaHistory();
  renderQaChips();
  qaSyncSendState();
  /* v3.9.9 技能状态条：输入框上方一行小字，标明本轮可用的取数技能与妙想 Key 状态 */
  qaRefreshSkillHint();
  /* v3.9.2 快捷提问卡片：事件委托绑在 #qaMessages（卡片本身随渲染重建） */
  bindQaExamples();
  /* v3.12.1 右侧「本会话提问」快速导航：一次性绑定（委托在容器上，列表随渲染重建） */
  bindQaJump();

  $('newChatBtn').addEventListener('click', () => {
    qaAttach(qaNewId());
    renderQaMessages();
    renderQaHistory();
    qaSyncSendState();
    const inp = $('qaInput');
    if (inp) inp.focus();
  });
  /* v3.15.0 手机抽屉：☰ 开关 / 遮罩关闭 / 新对话（角标渲染函数在顶层，sendQa 也要用） */
  const drawer = $('qaDrawer'), mask = $('qaDrawerMask');
  function qaOpenDrawer() {
    if (!drawer) return;
    drawer.hidden = false;
    if (mask) mask.hidden = false;
    qaState.unread.clear();
    qaRenderDrawerBadge();
    renderQaHistory();
  }
  function qaCloseDrawer() {
    if (drawer) drawer.hidden = true;
    if (mask) mask.hidden = true;
  }
  $('qaDrawerBtn').addEventListener('click', () => { drawer.hidden ? qaOpenDrawer() : qaCloseDrawer(); });
  if (mask) mask.addEventListener('click', qaCloseDrawer);
  $('qaDrawerClose').addEventListener('click', qaCloseDrawer);
  $('qaNewBtnM').addEventListener('click', () => {
    qaAttach(qaNewId());
    renderQaMessages();
    renderQaHistory();
    qaSyncSendState();
    qaCloseDrawer();
    const inp = $('qaInput');
    if (inp) { inp.focus(); }
  });
  $('qaSearch').addEventListener('input', renderQaHistory);
  $('qaSendBtn').addEventListener('click', sendQa);
  const stopBtn = $('qaStopBtn');
  if (stopBtn) stopBtn.addEventListener('click', qaStop);
  $('qaInput').addEventListener('input', qaSyncSendState);
  $('qaInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQa(); }
  });
  /* 历史列表：事件委托（内容随渲染重建）—— 桌面列表与手机抽屉列表共用同一委托 */
  const histHandler = e => {
    const open = e.target.closest('[data-qa-open]');
    if (open) { qaLoadConversation(open.dataset.qaOpen); qaCloseDrawer(); return; }
    const del = e.target.closest('[data-qa-del]');
    if (del) { qaDeleteConversation(del.dataset.qaDel); }
  };
  $('qaHistoryList').addEventListener('click', histHandler);
  const listM = $('qaHistoryListM');
  if (listM) listM.addEventListener('click', histHandler);
  /* 附件（v3.13.1 起入口在「＋」菜单里，独立 📎 按钮已移除） */
  $('qaFileInput').addEventListener('change', async e => {
    for (const f of Array.from(e.target.files || [])) await qaAddFile(f);
    e.target.value = '';
    qaSyncSendState();
  });
  $('qaAttachChips').addEventListener('click', e => {
    const rm = e.target.closest('[data-qa-rm]');
    if (!rm) return;
    qaState.files.splice(Number(rm.dataset.qaRm), 1);
    renderQaChips();
    qaSyncSendState();
  });
  /* 语音输入（v3.17.0 起抽为全局工厂 sjCreateMic：问答输入框与「记一笔」弹窗共用
     同一套按住说话状态机，行为逐字保留）。SR 必须按下时才取 —— 部分浏览器的
     兼容层是页面加载完成后才注入的，提前取会拿到 undefined。 */
  if ($('qaMicBtn')) sjCreateMic({
    btn: $('qaMicBtn'), hintId: 'qaRecHint', hintHostSel: '.qa-composer',
    input: () => $('qaInput'), onInput: qaSyncSendState,
    onDone: () => toast('语音已转文字，可修改后发送'),
  });
  /* v3.17.0 「记一笔」语音入口按用户要求暂不启用（工厂已就绪，后续接手只需
     给 recModal 的自然语言行加一个按钮并调 sjCreateMic 即可，见 sjCreateMic 注释） */
}
/* ============================================================
   v3.17.0 按住说话 · 全局工厂（原 v3.16.0/3.16.1 问答页内联实现抽出复用）
   引擎A 浏览器原生 SR（实时上屏）；引擎B 录音 → 16k WAV → sjAsrTranscribe。
   v3.16.1 四道保险逐字保留：松手复查 / 无条件硬停 / 指针捕获 / 60s 保险丝。
   ============================================================ */
function sjCreateMic(cfg) {
  const btn = cfg.btn;
  if (!btn || btn.dataset.micBound) return;
  btn.dataset.micBound = '1';
  const getSR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, mediaRec = null, mediaChunks = [], mediaStream = null;
  let holding = false, srBroken = false, mediaTimer = null;
  const hint = t => {
    let h = document.getElementById(cfg.hintId);
    if (!h) {
      h = document.createElement('div'); h.id = cfg.hintId; h.className = 'qa-rec-hint';
      const host = document.querySelector(cfg.hintHostSel || '.qa-composer');
      if (host) host.appendChild(h);
    }
    h.textContent = t; return h;
  };
  const stopUi = () => { btn.classList.remove('rec'); const h = document.getElementById(cfg.hintId); if (h) h.remove(); };
  const stopSr = () => { if (rec) { try { rec.stop(); } catch (e) { } rec = null; } };
  const stopMedia = () => {
    if (mediaTimer) { clearTimeout(mediaTimer); mediaTimer = null; }
    if (mediaRec) { try { if (mediaRec.state !== 'inactive') mediaRec.stop(); } catch (e) { } mediaRec = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  };
  const allStop = () => { stopSr(); stopMedia(); stopUi(); holding = false; };
  const setInp = txt => {
    const inp = cfg.input(); if (!inp) return;
    inp.value = txt.slice(0, 2000);
    if (cfg.onInput) cfg.onInput();
  };

  async function mediaStart() {
    if (!navigator.mediaDevices || !window.MediaRecorder) { allStop(); toast('此浏览器既不支持语音识别也不支持录音，请用 Edge / Chrome', 'warn'); return; }
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    /* v3.16.1 松手复查：getUserMedia 等待授权期间用户可能已松手 ——
       旧代码不复查 holding，回来后照样开录 → 录音永远停不下来。已松手立即弃流。 */
    if (!holding) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; return; }
    mediaChunks = [];
    const mime = MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    mediaRec = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
    mediaRec.ondataavailable = e => { if (e.data && e.data.size) mediaChunks.push(e.data); };
    mediaRec.onstop = async () => {
      const blob = new Blob(mediaChunks, { type: (mediaRec && mediaRec.mimeType) || 'audio/webm' });
      stopMedia(); stopUi();
      if (blob.size < 2000) { toast('没录到声音，请重试', 'warn'); return; }
      try {
        const text = await sjAsrTranscribe(blob, hint);
        const inp = cfg.input();
        if (inp && text) {
          setInp(inp.value ? inp.value + ' ' + text : text);
          if (cfg.onDone) cfg.onDone(text);
        } else if (!text) toast('未识别到内容，请重试', 'warn');
      } catch (e) { toast('服务器转写失败：' + (e.message || e), 'warn'); }
    };
    mediaRec.start();
    /* v3.16.1 保险丝：单次录音最长 60s（腾讯云一句话识别同为 60s 上限），绝不挂死 */
    mediaTimer = setTimeout(() => {
      if (mediaRec && mediaRec.state !== 'inactive') { try { mediaRec.stop(); } catch (e) { } }
    }, 60000);
    btn.classList.add('rec');
    hint('🎙 录音中（服务器转写）… 松开结束');
  }

  btn.addEventListener('contextmenu', e => e.preventDefault());
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    /* v3.16.1 指针捕获：按住后移出按钮/窗口再松开，pointerup 也能派发到本按钮 */
    try { btn.setPointerCapture(e.pointerId); } catch (e0) { }
    if (rec || mediaRec || holding) return;
    holding = true;
    const SR = getSR();
    if (SR && !srBroken) {
      const inp = cfg.input();
      const base = inp ? inp.value : '';
      try { rec = new SR(); } catch (e2) { rec = null; srBroken = true; mediaStart().catch(err => { allStop(); toast('录音启动失败：' + err.message, 'warn'); }); return; }
      rec.lang = 'zh-CN';
      rec.interimResults = true;
      rec.continuous = true;   /* v3.16.1：false 时停顿几秒 SR 会自动 end，按住却没在听 */
      rec.onresult = ev => {
        let txt = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
        setInp(base + txt);
      };
      rec.onerror = ev => {
        const err = ev && ev.error || '';
        /* 权限拒绝任何引擎都一样，直接终止；服务性错误且仍按住 → 无缝切引擎B */
        if (err === 'not-allowed' || err === 'audio-capture') { allStop(); toast('麦克风权限被拒绝', 'warn'); return; }
        if (holding) {
          stopSr(); srBroken = true;
          hint('⏳ 切换服务器转写…');
          mediaStart().catch(err2 => { allStop(); toast('录音启动失败：' + err2.message, 'warn'); });
        } else {
          allStop();
          toast('语音识别失败：' + err, 'warn');
        }
      };
      rec.onend = () => {
        rec = null;
        /* v3.16.1：按住期间 SR 自己断了（网络抖动/超时）→ 无缝切引擎B，松手才停 */
        if (holding && !srBroken && !mediaRec) {
          hint('⏳ 切换服务器转写…');
          mediaStart().catch(err2 => { allStop(); toast('录音启动失败：' + err2.message, 'warn'); });
        } else if (!holding && !mediaRec) stopUi();
      };
      try {
        rec.start();
        btn.classList.add('rec');
        hint('🎙 正在听…松开结束');
      } catch (e3) { rec = null; srBroken = true; mediaStart().catch(err2 => { allStop(); toast('录音启动失败：' + err2.message, 'warn'); }); }
    } else {
      mediaStart().catch(err => { allStop(); toast('录音启动失败：' + err.message, 'warn'); });
    }
  });
  const endHandler = e => {
    e.preventDefault();
    /* v3.16.1：不以 holding 为前置条件 —— 先把所有还活着的引擎停干净，防竞态漏停 */
    if (rec) { try { rec.stop(); } catch (e2) { } rec = null; }
    if (mediaRec && mediaRec.state !== 'inactive') {
      try { mediaRec.stop(); } catch (e3) { }   // onstop 里转写+清UI
      holding = false;
      return;
    }
    /* getUserMedia 还挂着：先清 UI，mediaStart 内部复查 !holding 后自行放弃 */
    if (mediaStream) stopMedia();
    stopUi();
    holding = false;
  };
  btn.addEventListener('pointerup', endHandler);
  btn.addEventListener('pointercancel', endHandler);
  btn.addEventListener('pointerleave', () => { if (holding) endHandler({ preventDefault() { } }); });
}

/* ============================================================
   v3.17.0 引擎B 转写：后端可选（本机 localStorage sj_asr_v1，不上云）
   - 腾讯云一句话识别：不收 webm、不允许浏览器直连（无 CORS）→ 只能经
     自托管 /api/asr/tencent（服务端 TC3 签名）；录音先统一转 16k 单声道 WAV
   - 硅基流动：CORS 开放 → 自托管 /api/asr 代理 或 云端版浏览器直连
   - backend auto = 硅基服务端 → 硅基直连 → 腾讯云代理 依次降级
   ============================================================ */
function sjAsrCfgGet() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem('sj_asr_v1') || '{}') || {}; } catch (e) { }
  return { backend: c.backend || 'auto', sfKey: c.sfKey || '', txId: c.txId || '', txKey: c.txKey || '' };
}
function sjAsrCfgSet(patch) {
  const c = Object.assign(sjAsrCfgGet(), patch);
  localStorage.setItem('sj_asr_v1', JSON.stringify(c));
  return c;
}

/* 任意浏览器可解码音频 → 16k 单声道 WAV（零依赖：AudioContext 解码 +
   OfflineAudioContext 重采样 + 手写 WAV 头）。腾讯云只收 wav 等格式，不收 webm */
async function sjBlobToWav16k(blob) {
  const ab = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const tmp = new AC();
  let buf;
  try { buf = await tmp.decodeAudioData(ab); } finally { try { tmp.close(); } catch (e) { } }
  const rate = 16000;
  const off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, Math.max(1, Math.ceil(buf.duration * rate)), rate);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);
  const n = pcm.length;
  const out = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(out);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE'); wr(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wr(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
  }
  return new Blob([out], { type: 'audio/wav' });
}

async function sjBlobB64(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/* 引擎B 主入口：按设置选后端、逐级降级；hint(t) 更新「⏳ 转写中」提示 */
async function sjAsrTranscribe(rawBlob, hint) {
  const cfg = sjAsrCfgGet();
  const wav = await sjBlobToWav16k(rawBlob);
  const auth = typeof sjTokenHeaders === 'function' ? sjTokenHeaders() : {};
  const tryTx = async () => {
    if (hint) hint('⏳ 转写中（腾讯云）…');
    const r = await fetch('/api/asr/tencent', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth),
      body: JSON.stringify({ audio: await sjBlobB64(wav), len: wav.size, keys: (cfg.txId && cfg.txKey) ? { id: cfg.txId, key: cfg.txKey } : null }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.msg || ('HTTP ' + r.status));
    return j.text || '';
  };
  const trySfProxy = async () => {
    if (hint) hint('⏳ 转写中（硅基流动·服务端）…');
    const fd = new FormData();
    fd.append('audio', wav, 'speech.wav');
    const r = await fetch('/api/asr', { method: 'POST', headers: auth, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.msg || ('HTTP ' + r.status));
    return j.text || '';
  };
  const trySfDirect = async () => {
    if (!cfg.sfKey) throw new Error('未配置硅基流动 Key：设置→语音转写 里粘贴 sfr- 开头的 Key（存本机）');
    if (hint) hint('⏳ 转写中（硅基流动·直连）…');
    const fd = new FormData();
    fd.append('file', wav, 'speech.wav');
    fd.append('model', 'FunAudioLLM/SenseVoiceSmall');
    const r = await fetch('https://api.siliconflow.cn/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + cfg.sfKey }, body: fd,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || j.error ? String(j.message || j.error || ('HTTP ' + r.status)) : 'HTTP ' + r.status);
    return j.text || '';
  };
  const chain = cfg.backend === 'tx' ? [tryTx, trySfProxy, trySfDirect]
    : cfg.backend === 'sf' ? [trySfProxy, trySfDirect]
      : [trySfProxy, trySfDirect, tryTx];
  let lastErr = null;
  for (const fn of chain) {
    try { const t = await fn(); if (t) return t; lastErr = new Error('未识别到内容'); }
    catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      /* 只有「未配置/路由不存在」才降级到下一个后端；额度耗尽等业务错误直接抛给用户 */
      if (!/未配置|HTTP 40[14]|没有收到/.test(msg) && msg.indexOf('HTTP ') !== 0) throw e;
    }
  }
  throw lastErr || new Error('转写失败');
}
/* 问答历史首载：登录后拉一次（放在 boot 之后，失败不影响其它模块） */
async function qaBoot() {
  try { await qaReloadAll(); } catch (e) { /* 未登录等情况忽略 */ }
  renderQaHistory();
}

boot();

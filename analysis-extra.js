/* ============================================================
   分析中心扩展（完整迁移自 trade-manager）：
   批量诊断 / 市场热度 / 持仓画像 / 风险分析 / 操作复盘 / 策略回测
   依赖主 app.js：S、$、esc、toast、fmt2、NetQuote、StockDict、
   computeHoldings、fetchKline、analyzeTimeframe、combineTechSignal、
   secidOf、inferMarket、llmComplete、renderAnalysisSelect、diagnoseStock
   ============================================================ */
'use strict';

/* ---------------- 状态 shim（tm 的 state → 本应用数据层） ---------------- */
const AX = {
  boardDict: [], boardRev: {}, boardVer: '',
  snap: null, heatSort: 'avg',
  batch: null, risk: null, review: null, bt: null,
};
/* v3.9.8 tm 口径适配 —— 一处修掉一整批「字段名对不上」的静默错误。
   已核对的云端 trades 表真实列：transaction_time / transaction_type / note
   （另有 stock_code / stock_name / market / quantity / price / gross_amount /
   fee / net_amount / source）。**没有** action / trade_date / comment / tags ——
   那是被整块搬过来的 trade-manager 那套字段名。
   而 analysis-extra.js 通篇读的是 t.action / t.trade_date / t.comment / t.tags，
   旧 shim 却直接 `return S.trades`，于是：
     · t.action 恒 undefined → `t.action === 'buy'` 恒 false → **每一笔买入都被当成卖出**；
     · t.trade_date 恒 undefined → 行为评分/阶段总结的日期列全空、`近30天交易` 恒为 0、
       操作复盘的 FIFO 配对排序错乱（lots 永远建不起来 → closed 恒空 → 复盘无数据）；
     · t.comment 恒 undefined → 备注丢失。
   在数据出口映射一次，下游 6 处一行都不用改，也不会再漏。
   返回浅拷贝（不动 S.trades 里的原对象），避免多出来的字段被写回云端。 */
function axTrade(t) {
  if (!t) return t;
  return Object.assign({}, t, {
    action: t.transaction_type === 'buy' ? 'buy' : 'sell',
    trade_date: String(t.transaction_time || '').replace('T', ' ').slice(0, 19),
    comment: t.note || '',
    tags: [],
  });
}
const state = {
  get trades() { return S.trades.map(axTrade); },
  get watch() { return S.watchlist; },
  get stockDict() { return StockDict.d; },
  get boardDict() { return AX.boardDict; },
  set boardDict(v) { AX.boardDict = v; },
  get boardRev() { return AX.boardRev; },
  set boardRev(v) { AX.boardRev = v; },
  get boardVer() { return AX.boardVer; },
  set boardVer(v) { AX.boardVer = v; },
  get snap() { return AX.snap; },
  set snap(v) { AX.snap = v; },
  /* v3.9.12 这次快照的元信息（时间/覆盖数/批次/耗时/是否缓存）—— 卡片时间戳与「下载源数据」都要用 */
  get snapMeta() { return AX.snapMeta; },
  set snapMeta(v) { AX.snapMeta = v; },
  get heatSort() { return AX.heatSort; },
  set heatSort(v) { AX.heatSort = v; },
  get batch() { return AX.batch; },
  set batch(v) { AX.batch = v; },
  get risk() { return AX.risk; },
  set risk(v) { AX.risk = v; },
  get review() { return AX.review; },
  set review(v) { AX.review = v; },
  get bt() { return AX.bt; },
  set bt(v) { AX.bt = v; },
  get diag() { return S.diag; },
  set diag(v) { S.diag = v; },
  get analyses() { return loadDiagHistory(); },
};

/* ---------------- 小工具 shim ---------------- */
function marketOf(code) { return inferMarket(code); }
function fmtTs(s) { return s ? String(s).replace('T', ' ').slice(0, 19) : ''; }
function nowTs() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function isFullStockName(s) { return /股份|有限|集团|控股/.test(String(s || '')); }
function shortenStockName(s) { return String(s || '').replace(/股份有限公司|有限公司$/g, ''); }
function dispStockName(code, fallback) {
  const c = String(code || '').trim();
  const d = StockDict.d[c] || null;
  const seedName = d && d.name && !isFullStockName(d.name) ? d.name : '';
  if (seedName) return seedName;
  const f = String(fallback || '').trim();
  if (!f || f === c) return (d && d.name) || f || c;
  return isFullStockName(f) ? shortenStockName(f) : f;
}
function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch (e) { /* fallthrough */ }
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) { /* fallthrough */ } }
  throw new Error('AI 返回格式异常，请重试');
}
/* 高精度十进制（BigInt 固定 8 位小数）——仅展示与统计口径用 */
const D_SCALE = 100000000n;
function toD(v) {
  if (v === null || v === undefined || v === '') return 0n;
  const s = String(v).trim().replace(/[,，\s]/g, '');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return 0n;
  const neg = s[0] === '-';
  const b = s.replace(/^[+-]/, '');
  const [i, f = ''] = b.split('.');
  const r = BigInt(i || '0') * D_SCALE + BigInt((f + '00000000').slice(0, 8));
  return neg ? -r : r;
}
function dMul(a, b) {
  const p = a * b; const neg = p < 0n; const ap = neg ? -p : p;
  const q = (ap + D_SCALE / 2n) / D_SCALE;
  return neg ? -q : q;
}
function dDiv(a, b) {
  if (b === 0n) return 0n;
  const neg = (a < 0n) !== (b < 0n);
  const aa = a < 0n ? -a : a, ab = b < 0n ? -b : b;
  let q = aa * D_SCALE / ab;
  if ((aa * D_SCALE % ab) * 2n >= ab) q += 1n;
  return neg ? -q : q;
}
const dAdd = (a, b) => a + b;
const dSub = (a, b) => a - b;
function dToStr(x, minDp = 2, maxDp = 8, sep = true) {
  if (x === null || x === undefined) return '--';
  const v = typeof x === 'bigint' ? x : toD(x);
  const neg = v < 0n; const ax = neg ? -v : v;
  const i = ax / D_SCALE;
  let fs = (ax % D_SCALE).toString().padStart(8, '0').slice(0, Math.max(0, maxDp)).replace(/0+$/, '');
  while (fs.length < minDp) fs += '0';
  const is = sep ? i.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : i.toString();
  return (neg ? '-' : '') + is + (fs ? '.' + fs : '');
}
const fmtD = (x, minDp = 2) => dToStr(x, minDp, 8);
function dToFixed(x, dp = 2) {
  if (x === null || x === undefined) return '--';
  const v = typeof x === 'bigint' ? x : toD(x);
  const neg = v < 0n; const ax = neg ? -v : v;
  const cut = 10n ** BigInt(8 - dp);
  const r = (ax + cut / 2n) / cut * cut;
  return dToStr(neg ? -r : r, dp, dp);
}
/* 持仓 shim：computeHoldings → tm 口径（qty/avgCost 为 BigInt） */
function computePositions() {
  return computeHoldings().filter(h => h.qty > 0).map(h => ({
    code: h.code, name: h.name || h.code, market: h.market,
    qty: toD(h.qty), avgCost: toD(h.costValue / h.qty), cost: toD(h.costValue),
  }));
}
/* 行情 shim：腾讯批量（GBK），返回 {code:{price,prevClose,pct,…}} */
/* v3.9.10 修复：inferMarket 对北交所返回 'bj'，但这里查表只写了 'bse' 键 →
   前缀变成 'undefined920002'，349 只北交所股票全部静默拉不到（快照 5573 只只回
   5224 只，热度页的北证小字永远是 0/0）。补齐两个键 + 兜底，缺市场映射不再静默。 */
function txQuotePrefix(c) {
  const p = ({ sh: 'sh', sz: 'sz', bse: 'bj', bj: 'bj' })[inferMarket(c)];
  return (p || 'sz') + c;
}
async function fetchQuotesTencent(codes) {
  const t0 = Date.now();
  try {
    const q = codes.map(txQuotePrefix).join(',');
    const res = await fetch('https://qt.gtimg.cn/q=' + q);
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    const out = {};
    for (const m of text.matchAll(/v_[a-z]{2}(\d{6})="([^"]*)"/g)) {
      const p = m[2].split('~');
      if (p.length < 40) continue;
      const amtWan = num(p[37]);
      out[m[1]] = {
        code: m[1], name: p[1],
        price: num(p[3]), prevClose: num(p[4]), open: num(p[5]),
        chg: num(p[31]), pct: num(p[32]),
        high: num(p[33]), low: num(p[34]),
        turnover: num(p[38]), volRatio: num(p[49]),
        pe: num(p[39]), pb: num(p[46]), amp: num(p[43]),
        amount: amtWan == null ? null : amtWan / 1e4,
        floatCap: num(p[44]), totalCap: num(p[45]),
      };
    }
    /* v3.9.10 失败只记一条日志（成功不打 —— 全市场快照一次 70 批，全记会刷屏）。
       此前该函数静默吞掉所有异常，市场热度的数据取不到时日志页毫无线索。
       v3.9.13 审计：失败条目带上实际请求的 URL（截断）与参数，可核对。 */
    if (!Object.keys(out).length) NetLog.push('quote', '腾讯 qt.gtimg.cn(快照分批)', false, Date.now() - t0, `${codes.length} 只全部未返回`,
      { url: 'https://qt.gtimg.cn/q=' + q.slice(0, 200) + '…', req: `${codes.length} 只/批`, err: '整批未返回' });
    return out;
  } catch (e) {
    NetLog.push('quote', '腾讯 qt.gtimg.cn(快照分批)', false, Date.now() - t0, e.message || String(e), { err: e.message || String(e) });
    return {};
  }
}
async function fetchQuotes(codes) {
  codes = [...new Set((codes || []).filter(Boolean))];
  if (!codes.length) return {};
  return fetchQuotesTencent(codes);
}
async function fetchQuotesForAll() {
  try { await NetQuote.refresh(true); } catch (e) { /* */ }
}
function reloadTrades() { return Promise.resolve(); }   // 数据层由主 app.js 负责
/* 全市场实时快照：代码清单来自 stock-dict.json（与主应用同源），60s 缓存 */
const Q_TTL = 60 * 1000;
let _qCache = null, _qPending = null;
/* v3.9.12 快照除了行情 map 还要带上「这次取数的元信息」（时间/覆盖数/总代码数/批次/耗时/是否命中缓存）。
   旧写法 refreshHeat 里只存了 snap.map，snap.at 被丢掉 → 卡片上「快照 时间」永远是「—」，
   用户既看不到这份数据是几点取的，也没法把它当凭证核对。 */
async function qSnapshot() {
  const now = Date.now();
  if (_qCache && now - _qCache.at < Q_TTL) return Object.assign({}, _qCache, { cached: true });
  if (_qPending) return _qPending;
  _qPending = (async function () {
    const t0 = Date.now();
    const codes = Object.keys(StockDict.d).filter(c => /^(60|68|00|30|43|83|87|92)/.test(c));
    if (!codes.length) {
      NetLog.push('quote', '腾讯 全市场快照(qt.gtimg.cn)', false, 0, '股票字典未加载，无法拉取');
      throw new Error('拿不到全市场代码清单（股票字典未加载），无法拉取实时行情');
    }
    const parts = [];
    for (let i = 0; i < codes.length; i += 80) parts.push(codes.slice(i, i + 80));
    const map = {};
    let idx = 0, emptyBatches = 0;
    const worker = async function () {
      while (idx < parts.length) {
        const one = await fetchQuotesTencent(parts[idx++]).catch(function () { return {}; });
        if (!Object.keys(one).length) emptyBatches++;
        Object.assign(map, one);
      }
    };
    await Promise.all([0, 1, 2, 3, 4, 5].map(worker));
    const got = Object.keys(map).length;
    /* v3.9.10 快照此前完全不进网络日志（一次 70 批请求静默完成）→ 记一条汇总：
       覆盖数 / 总数 / 失败批次数，日志页可直接核对市场热度的数据来源与完整性。 */
    if (!got) {
      NetLog.push('quote', '腾讯 全市场快照(qt.gtimg.cn)', false, Date.now() - t0, `0/${codes.length} 只 · ${parts.length} 批全部失败（未获取到）`,
        { url: 'https://qt.gtimg.cn/q=<' + parts.length + '批×80只>', req: `字典 ${codes.length} 只 · 并发 6`, err: '未获取到' });
      throw new Error('实时行情接口没有返回数据（可能是网络波动或临时限流），请稍后重试');
    }
    const snap = {
      map: map, at: Date.now(), n: got, cached: false,
      total: codes.length, parts: parts.length, emptyBatches: emptyBatches,
      ms: Date.now() - t0, dictSize: Object.keys(StockDict.d).length,
      /* 请求 URL 示例（整条 URL 5000+ 只票太长，取第一批前 8 只做样本 + 省略号） */
      url: 'https://qt.gtimg.cn/q=' + parts[0].map(txQuotePrefix).slice(0, 8).join(',') + ',…',
      batchSize: 80, concurrency: 6,
    };
    _qCache = snap;
    NetLog.push('quote', '腾讯 全市场快照(qt.gtimg.cn)', true, Date.now() - t0,
      `${got}/${codes.length} 只 · ${parts.length} 批` + (emptyBatches ? ` · ${emptyBatches} 批失败(该批个股缺失)` : ''),
      { url: snap.url, req: `字典 ${codes.length} 只 · ${parts.length} 批×80 · 并发 6`, resp: `${got}/${codes.length} 只` });
    return snap;
  })();
  try { return await _qPending; } finally { _qPending = null; }
}
/* 板块字典加载（board-dict.json 随应用发布，30 天 localStorage 缓存） */
const BOARD_DICT_FILE = 'board-dict.json';
const BOARD_DICT_KEY = 'sj_board_dict_v1';
const BOARD_DICT_AT_KEY = 'sj_board_dict_at_v1';
const BOARD_DICT_TTL = 30 * 24 * 3600 * 1000;
let _boardDictLoading = null;
function applyBoardDict(raw) {
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { return 0; }
  const arr = (j && j.b) || [];
  const list = [], rev = {};
  for (let i = 0; i < arr.length; i++) {
    const row = arr[i] || [];
    const nm = String(row[0] || '').trim();
    const cs = row[1] || [];
    if (!nm || !cs.length) continue;
    const codes = [];
    for (let k = 0; k < cs.length; k++) {
      const c = String(cs[k]).padStart(6, '0');
      if (!/^\d{6}$/.test(c)) continue;
      codes.push(c);
      const bucket = rev[c] || (rev[c] = []);
      if (bucket.indexOf(nm) < 0) bucket.push(nm);
    }
    if (codes.length) list.push([nm, codes]);
  }
  if (list.length < 100) return 0;
  state.boardDict = list;
  state.boardRev = rev;
  state.boardVer = String(j.v || '');
  return list.length;
}
function loadBoardDict() {
  try {
    const raw = localStorage.getItem(BOARD_DICT_KEY);
    if (raw) { const n = applyBoardDict(raw); if (n) return n; }
  } catch (e) { /* */ }
  return 0;
}
function boardDictAge() {
  let at = 0;
  try { at = Number(localStorage.getItem(BOARD_DICT_AT_KEY) || 0) || 0; } catch (e) { at = 0; }
  return at ? Date.now() - at : Infinity;
}
async function fetchBoardDictFile() {
  const t0 = Date.now();
  try {
    const res = await fetch(BOARD_DICT_FILE + '?v=' + Date.now(), { cache: 'no-cache' });
    if (!res.ok) throw new Error('board-dict.json HTTP ' + res.status);
    const raw = await res.text();
    const n = applyBoardDict(raw);
    if (!n) throw new Error('board-dict.json 解析出的板块过少');
    NetLog.push('dict', '板块字典 board-dict.json', true, Date.now() - t0, `${n} 个板块`);
    try {
    localStorage.setItem(BOARD_DICT_KEY, raw);
    localStorage.setItem(BOARD_DICT_AT_KEY, String(Date.now()));
  } catch (e) { /* 配额满：内存已生效 */ }
  return { boards: n };
  } catch (e) {
    NetLog.push('dict', '板块字典 board-dict.json', false, Date.now() - t0, e.message || String(e));
    throw e;
  }
}
async function ensureBoardDict(force) {
  if (!force && state.boardDict.length && boardDictAge() < BOARD_DICT_TTL) return { skipped: true, boards: state.boardDict.length };
  if (!state.boardDict.length) loadBoardDict();
  if (!force && state.boardDict.length && boardDictAge() < BOARD_DICT_TTL) return { skipped: true, boards: state.boardDict.length };
  if (_boardDictLoading) return _boardDictLoading;
  _boardDictLoading = (async function () {
    try { return await fetchBoardDictFile(); }
    finally { _boardDictLoading = null; }
  })();
  return _boardDictLoading;
}
function stockBoards(code) {
  const r = state.boardRev && state.boardRev[String(code || '').trim()];
  return r || [];
}
function boardMembers(name) {
  const hit = state.boardDict.find(function (b) { return b[0] === name; });
  return hit ? hit[1] : [];
}
/* 分析中心内部页签 */
let anTab = 'diag';
function switchAnalysisTab(name) {
  const tabs = document.querySelectorAll('#anTabs .an-tab');
  const panes = document.querySelectorAll('.an-pane');
  const hit = [...tabs].some(t => t.dataset.an === name);
  anTab = hit ? name : 'diag';
  tabs.forEach(t => t.classList.toggle('active', t.dataset.an === anTab));
  panes.forEach(p => { p.hidden = p.dataset.anpane !== anTab; });
  if (anTab === 'diag') setTimeout(() => { try { redrawAnalysisCanvases(); } catch (e) { /* */ } }, 0);
  if (anTab === 'diag' && state.batch) setTimeout(() => { try { renderBatchView(); } catch (e) { /* */ } }, 0);
  if (anTab === 'heat' && !state.snap) setTimeout(() => { try { refreshHeat(false); } catch (e) { /* */ } }, 0);
  if (anTab === 'profile') setTimeout(() => { try { renderProfileView(); } catch (e) { /* */ } }, 0);
  /* v3.8.74 切到动量筛选时：没结果就把上次的扫描状态画出来（不自动重扫，避免白耗流量） */
  if (anTab === 'mom') setTimeout(() => { try { renderMomView(); } catch (e) { /* */ } }, 0);
}
/* 报告保存 shim：写入主应用报告历史（localStorage） */
async function api(op, args) {
  if (op === 'app_insert' && args && args.p_table === 'analyses') {
    const d = args.p_data || {};
    saveDiagHistoryItem({
      kind: d.kind || 'stock',
      title: d.title || '分析报告',
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      sig: String(d.summary || '').split('·')[0].trim() || '—',
      pct: d.score != null ? Math.round(Number(d.score) * 100) / 100 : 0,
      content: d.content || '',
    });
    return { ok: true };
  }
  throw new Error('不支持的操作：' + op);
}
function reloadAnalyses() { return Promise.resolve(); }
function renderAnalyses() { try { renderDiagHistory(); } catch (e) { /* */ } }
/* 弹窗 shim：复用诊断结果卡展示 */
function openModal(title, meta, body) {
  const box = $('diagBox');
  if (!box) { toast(title); return; }
  box.hidden = false;
  box.innerHTML = `<div class="card-title-row"><span class="card-title">${esc(title)}</span><span class="hint">${esc(meta || '')}</span></div><div class="diag-ai-out" style="margin-top:10px">${esc(body)}</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
/* ============================================================
 * 批量技术诊断：一次性给「自选 + 持仓」全部打分
 * 复用单股诊断那套规则引擎（analyzeTimeframe 日/周 + combineTechSignal），
 * 口径与「个股诊断」完全一致 —— 差别只是把「一只」换成「一批」。
 * 规则引擎免费、可复现、不消耗大模型额度；只有 K 线是网络请求（每只 2 个）。
 * 并发 4 路、边跑边出，先出先看；点表头可换排序。
 * ============================================================ */
const BATCH_BTN_TEXT = '📊 批量诊断（自选 + 持仓）';
const BATCH_CONCURRENCY = 4;   // 腾讯 K 线接口较宽容，4 路并发实测稳定

/* 批量对象：持仓在前、自选在后，按代码去重；名称统一走 dispStockName（交易所简称）
   v3.8.74 追加 extra：动量筛选结果要「全部批量诊断」时，把命中的代码临时并进来
   （不写库、不动自选，只在本次批量里参与），避免为了诊断而污染用户的自选列表。 */
function batchTargets(extra) {
  const seen = new Set(), out = [];
  const push = (code, name, held) => {
    const c = String(code || '').trim();
    if (!/^\d{6}$/.test(c) || seen.has(c)) return;
    seen.add(c);
    out.push({ code: c, name: dispStockName(c, name), held: !!held });
  };
  computePositions().forEach(p => push(p.code, p.name, true));
  state.watch.forEach(w => push(w.stock_code, w.stock_name, false));
  if (Array.isArray(extra)) {
    extra.forEach(x => push(typeof x === 'string' ? x : (x && x.code), x && x.name, false));
  }
  return out;
}

/* 单只：日线 260 根 + 周线 180 根 → 与个股诊断同一套口径 */
async function batchDiagOne(code) {
  const [daily, weekly] = await Promise.all([fetchKline(code, 101, 260), fetchKline(code, 102, 180)]);
  if (!daily.bars.length || !weekly.bars.length) throw new Error('K 线数据不足');
  const d = analyzeTimeframe(daily.bars, '日线');
  const w = analyzeTimeframe(weekly.bars, '周线');
  return { d, w, comb: combineTechSignal(d, w) };
}

const batchSigTxt = s => (s === 'buy' ? '偏多' : s === 'sell' ? '偏空' : '中性');
const batchSigCls = s => (s === 'buy' ? 'up' : s === 'sell' ? 'down' : 'flat');
const batchSigned = v => (v > 0 ? '+' : '') + v;
const batchNumCls = v => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const batchPct = v => (v === null || v === undefined ? '--' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%');

/* 表头可点排序：默认综合强度降序（强的在上面） */
const BATCH_COLS = [['name', '名称'], ['price', '现价'], ['chg', '涨跌幅'], ['d', '日线'], ['w', '周线'], ['pct', '综合'], ['sig', '结论']];
function batchSortVal(it, key) {
  const q = (state.quotes && state.quotes[it.code]) || null;
  if (it.err) return key === 'name' ? it.name : -Infinity;   // 取数失败的排最后
  switch (key) {
    case 'name': return it.name;
    case 'price': return q && q.price != null ? q.price : -Infinity;
    case 'chg': return q && q.pct != null ? q.pct : -Infinity;
    case 'd': return it.d.pct;
    case 'w': return it.w.pct;
    default: return it.comb.pct;
  }
}
function batchSorted() {
  const b = state.batch;
  if (!b) return [];
  const dir = b.sortDir < 0 ? -1 : 1;
  return b.items.slice().sort((x, y) => {
    const a = batchSortVal(x, b.sortKey), c = batchSortVal(y, b.sortKey);
    if (typeof a === 'string' || typeof c === 'string') return dir * String(a).localeCompare(String(c), 'zh');
    return a === c ? 0 : (a > c ? 1 : -1) * dir;
  });
}

function renderBatchView() {
  const box = document.getElementById('batchBox');
  const b = state.batch;
  if (!box) return;
  if (!b || (!b.items.length && !b.running)) { box.hidden = true; box.innerHTML = ''; return; }
  const list = batchSorted();
  const done = b.items.filter(x => !x.err);
  const cnt = s => done.filter(x => x.comb.signal === s).length;
  const barPct = b.total ? Math.round(b.items.length / b.total * 100) : 0;
  const rowHtml = it => {
    if (it.err) {
      return `<tr>
        <td><b>${esc(it.name)}</b><br><small>${esc(it.code)}</small></td>
        <td colspan="5" class="batch-err">⚠️ ${esc(it.err)}</td>
        <td><span class="bd-badge flat">失败</span></td>
        <td><button class="btn ghost sm" data-bcode="${esc(it.code)}">重试</button></td>
      </tr>`;
    }
    const q = (state.quotes && state.quotes[it.code]) || null;
    return `<tr>
      <td><b>${esc(it.name)}</b>${it.held ? '<span class="batch-held">持仓</span>' : ''}<br><small>${esc(it.code)}</small></td>
      <td class="num">${q && q.price != null ? fmtD(q.price) : '--'}</td>
      <td class="num ${batchNumCls(q && q.pct)}">${q && q.pct != null ? batchPct(q.pct) : '--'}</td>
      <td class="num ${batchNumCls(it.d.pct)}">${batchSigned(it.d.pct)}</td>
      <td class="num ${batchNumCls(it.w.pct)}">${batchSigned(it.w.pct)}</td>
      <td class="num ${batchNumCls(it.comb.pct)}"><b>${batchSigned(it.comb.pct)}</b></td>
      <td><span class="bd-badge ${batchSigCls(it.comb.signal)}">${batchSigTxt(it.comb.signal)}</span></td>
      <td><button class="btn ghost sm" data-bcode="${esc(it.code)}">详情</button></td>
    </tr>`;
  };
  box.hidden = false;
  /* v3.8.74 标题可覆盖：动量筛选「全部批量诊断」时显示来源，避免和自选+持仓的批量诊断混淆 */
  const headTitle = (b.titleOverride ? '📊 ' + b.titleOverride : '📊 批量技术诊断');
  const headTip = b.titleOverride
    ? `对<b>动量筛选命中的 ${b.total} 只</b>逐只跑同一套技术面规则（日线 260 根 × 60% ＋ 周线 180 根 × 40%），口径与「个股诊断」完全一致。<b>本次调用不会改动自选列表</b>。`
    : '对<b>自选股 + 持仓股</b>逐只跑同一套技术面规则（日线 260 根 × 60% ＋ 周线 180 根 × 40%），结论口径与「个股诊断」完全一致。规则引擎免费、可复现，不消耗大模型额度。点「详情」跳到该股完整诊断（含 K 线图与 AI 解读）。';
  box.innerHTML = `
    <div class="card-head">
      <h3>${esc(headTitle)}</h3>
      <div class="head-right">
        <button id="batchSaveBtn" class="btn ghost sm">💾 存为报告</button>
        <button id="batchCloseBtn" class="btn ghost sm">关闭</button>
      </div>
    </div>
    <div class="form-tip">${headTip}</div>
    <div class="batch-head">
      ${b.running
        ? `<span>分析中… <b>${b.items.length}/${b.total}</b></span><span class="batch-bar"><i style="width:${barPct}%"></i></span>`
        : `<span>共 <b>${b.total}</b> 只</span><span class="up">偏多 ${cnt('buy')}</span><span class="flat">中性 ${cnt('hold')}</span><span class="down">偏空 ${cnt('sell')}</span><span class="batch-at">更新于 ${esc(b.at)}</span>`}
    </div>
    <div class="table-wrap"><table class="batch-table"><thead><tr>
      ${BATCH_COLS.map(([k, t]) => `<th data-bk="${k}" class="bsort${b.sortKey === k ? ' active' : ''}">${t}${b.sortKey === k ? (b.sortDir < 0 ? ' ▼' : ' ▲') : ''}</th>`).join('')}
      <th></th>
    </tr></thead><tbody>${list.map(rowHtml).join('')}</tbody></table></div>`;
  box.querySelectorAll('th[data-bk]').forEach(th => {
    th.onclick = () => {
      const k = th.dataset.bk;
      if (b.sortKey === k) b.sortDir = -b.sortDir; else { b.sortKey = k; b.sortDir = k === 'name' ? 1 : -1; }
      renderBatchView();
    };
  });
  box.querySelectorAll('button[data-bcode]').forEach(el => {
    el.onclick = () => analyzeStockByCode(el.dataset.bcode);
  });
  const sv = document.getElementById('batchSaveBtn');
  if (sv) sv.onclick = saveBatchReport;
  const cl = document.getElementById('batchCloseBtn');
  if (cl) cl.onclick = () => { state.batch = null; box.hidden = true; box.innerHTML = ''; };
}

async function runBatchDiagnose(extraTargets, titleOverride) {
  const btn = document.getElementById('batchDiagBtn');
  const box = document.getElementById('batchBox');
  if (!btn || !box) return;
  if (state.batch && state.batch.running) return toast('正在批量诊断中，请稍候…');
  const list = batchTargets(extraTargets);
  if (!list.length) return toast('自选和持仓都还没有股票，先添加几只再试');
  btn.disabled = true;
  btn.textContent = '⏳ 批量诊断中…';
  try {
    state.batch = { items: [], total: list.length, done: 0, running: true, sortKey: 'pct', sortDir: -1, at: nowTs(), titleOverride: titleOverride || '' };
    renderBatchView();
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // 现价/涨跌幅并行拉（失败不影响技术面，界面显示 --）
    const quotesP = fetchQuotes(list.map(x => x.code)).catch(() => {});
    const items = new Array(list.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= list.length) return;
        const tgt = list[i];
        try {
          items[i] = Object.assign({ code: tgt.code, name: tgt.name, held: tgt.held }, await batchDiagOne(tgt.code));
        } catch (e) {
          items[i] = { code: tgt.code, name: tgt.name, held: tgt.held, err: (e && e.message) || '分析失败' };
        }
        state.batch.items = items.filter(Boolean);   // 边跑边出，滚动可见
        renderBatchView();                            // 顺带把已到达的行情（现价/涨跌幅）也画上
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, list.length) }, worker));
    await quotesP;
    state.batch.running = false;
    state.batch.at = nowTs();
    renderBatchView();   // 行情齐了重画一次，补齐现价/涨跌幅列
    const okN = state.batch.items.filter(x => !x.err).length;
    toast(okN === list.length ? `批量诊断完成：${okN} 只` : `批量诊断完成：成功 ${okN} / 共 ${list.length} 只`);
  } catch (e) {
    if (state.batch) { state.batch.running = false; renderBatchView(); }
    toast((e && e.message) || '批量诊断失败');
  } finally {
    btn.disabled = false;
    btn.textContent = BATCH_BTN_TEXT;
  }
}

async function saveBatchReport() {
  const b = state.batch;
  if (!b || !b.items.length) return toast('还没有批量诊断结果');
  const list = batchSorted().filter(x => !x.err);
  if (!list.length) return toast('没有可保存的结果');
  const cnt = s => list.filter(x => x.comb.signal === s).length;
  const avg = Math.round(list.reduce((s, x) => s + x.comb.pct, 0) / list.length);
  const content = [
    `共 ${list.length} 只：偏多 ${cnt('buy')} / 中性 ${cnt('hold')} / 偏空 ${cnt('sell')}（日线 60% ＋ 周线 40%）`,
    `平均技术面强度 ${avg}`,
    '',
    ...list.map(x => `${x.name}（${x.code}）：综合 ${batchSigned(x.comb.pct)}（日线 ${batchSigned(x.d.pct)} / 周线 ${batchSigned(x.w.pct)}）→ ${batchSigTxt(x.comb.signal)}`),
  ].join('\n');
  try {
    await api('app_insert', {
      p_table: 'analyses',
      p_data: {
        kind: 'batch', stock_code: 'BATCH', stock_name: '自选+持仓',
        title: `批量技术诊断：${list.length} 只（偏多 ${cnt('buy')} / 偏空 ${cnt('sell')}）`,
        content, score: avg,
        summary: `平均强度 ${avg} · 偏多 ${cnt('buy')} / 中性 ${cnt('hold')} / 偏空 ${cnt('sell')}`,
      },
    });
    await reloadAnalyses(); renderAnalyses();
    toast('批量诊断已保存到分析报告历史');
  } catch (e) { toast(e.message || '保存失败'); }
}

/* ============================================================
 * 市场热度 / 板块热度 / 涨停复盘 / 持仓画像
 * ------------------------------------------------------------
 * 全部数据来自「一次全市场实时快照」（腾讯 qt.gtimg.cn，5573 只约 2.5~3 秒，复用 qSnapshot 60s 缓存）
 * ＋「随应用发布的板块映射」board-dict.json。**不发任何额外请求、不消耗任何额度。**
 *
 * 涨停判定的口径（比「涨幅≥9.9%」精确）：
 *   涨停价 = round(昨收 × (1 + 涨跌幅上限), 2)，与快照里的现价比较。
 *   上限按板块：北交所 30% / 创业科创 20% / 主板 10%；主板 ST 5%。
 *   这样 9.94%、10.03% 这类四舍五入差异不会被漏判或误判。
 * ============================================================ */

// 涨跌幅上限（%）：用于还原涨停价
/* v3.9.10 北交所判定抽成独立函数：热度统计要按「沪深 / 北证」拆分口径（同花顺大盘页的
   涨跌家数不含北交所，不拆开就没法对照），原来只写在 limitPctOf 的正则里没法复用。 */
function isBSE(code) { return /^(43|83|87|88|92)/.test(String(code || '')); }
function limitPctOf(code, name) {
  const c = String(code || '');
  if (isBSE(c)) return 30;                              // 北交所
  if (/^(30|68)/.test(c)) return 20;                    // 创业板 / 科创板
  return /ST/.test(String(name || '')) ? 5 : 10;        // 主板（ST 5%）
}
function limitPriceOf(prevClose, lim, dir) {
  const raw = prevClose * (1 + dir * lim / 100);
  return Math.round(raw * 100) / 100;                   // A 股报价统一 2 位小数
}
function isLimitUp(q) {
  if (!q || q.price == null || q.prevClose == null || q.prevClose <= 0) return false;
  return q.price >= limitPriceOf(q.prevClose, limitPctOf(q.code, q.name), 1) - 0.005;
}
function isLimitDown(q) {
  if (!q || q.price == null || q.prevClose == null || q.prevClose <= 0) return false;
  return q.price <= limitPriceOf(q.prevClose, limitPctOf(q.code, q.name), -1) + 0.005;
}

/* 全市场热度：入参 = 快照 map（code → quote），纯函数、无 DOM、可单测
 * v3.9.10 新增 bse 拆分：同花顺等行情软件大盘页的「涨跌家数」只统计沪深两市、
 * 不含北交所，且停牌股直接剔除；我们这边停牌股腾讯返回 pct=0 会被算进「平盘」。
 * 不拆出口径，用户对照时永远对不上、还以为是数据错了。 */
function computeMarketHeat(snapMap) {
  const out = {
    n: 0, up: 0, down: 0, flat: 0, zt: 0, dt: 0,
    avgPct: null, medPct: null, amount: 0,
    b: { hi: 0, mid: 0, low: 0, flat: 0, dlow: 0, dmid: 0 },   // ≥9.5 / 5~9.5 / 0~5 / 平 / 0~-5 / ≤-5
    bse: { n: 0, up: 0, down: 0, flat: 0, zt: 0, dt: 0 },      // 北交所拆分（对照同花顺请用 n-bse.n 那套）
    suspended: 0,                                              // 疑似停牌（成交额=0 且现价=昨收）
  };
  const pcts = [];
  for (const code in (snapMap || {})) {
    const q = snapMap[code];
    if (!q || q.pct == null || !isFinite(q.pct)) continue;
    out.n++;
    pcts.push(q.pct);
    if (q.amount) out.amount += q.amount;
    if (q.pct > 0.005) out.up++; else if (q.pct < -0.005) out.down++; else out.flat++;
    if (isBSE(code)) {
      const bse = out.bse;
      bse.n++;
      if (q.pct > 0.005) bse.up++; else if (q.pct < -0.005) bse.down++; else bse.flat++;
      if (isLimitUp(q)) bse.zt++;
      if (isLimitDown(q)) bse.dt++;
    }
    /* 疑似停牌：腾讯对停牌股返回昨收价、零成交 → pct=0 且无成交额。同花顺口径里这类直接剔除，
       是「平盘家数」对不上的主要来源之一（盘后对账时尤其明显）。 */
    if (!q.amount && q.price != null && q.prevClose != null && q.price === q.prevClose) out.suspended++;
    if (isLimitUp(q)) out.zt++;
    if (isLimitDown(q)) out.dt++;
    const p = q.pct;
    if (p >= 9.5) out.b.hi++;
    else if (p >= 5) out.b.mid++;
    else if (p > 0.005) out.b.low++;
    else if (p >= -0.005) out.b.flat++;
    else if (p > -5) out.b.dmid++;
    else out.b.dlow++;
  }
  if (pcts.length) {
    pcts.sort((a, b) => a - b);
    out.avgPct = pcts.reduce((s, x) => s + x, 0) / pcts.length;
    const m = Math.floor(pcts.length / 2);
    out.medPct = pcts.length % 2 ? pcts[m] : (pcts[m - 1] + pcts[m]) / 2;
  }
  return out;
}

/* 板块热度：把板块成分股在快照里的行情聚合起来。纯函数。
 * boardList = state.boardDict（[[板块名,[代码…]]…]）
 * opts.minMembers 有效成分不足则丢弃（默认 5，避免小样本噪音） */
function computeBoardHeat(snapMap, boardList, opts) {
  const o = opts || {};
  const minN = o.minMembers == null ? 5 : o.minMembers;
  const res = [];
  const list = boardList || [];
  for (let i = 0; i < list.length; i++) {
    const name = list[i][0], codes = list[i][1];
    let n = 0, sum = 0, up = 0, down = 0, zt = 0, amount = 0;
    const members = [];
    for (let k = 0; k < codes.length; k++) {
      const q = snapMap[codes[k]];
      if (!q || q.pct == null || !isFinite(q.pct)) continue;
      n++; sum += q.pct;
      if (q.pct > 0.005) up++; else if (q.pct < -0.005) down++;
      if (isLimitUp(q)) zt++;
      if (q.amount) amount += q.amount;
      members.push(q);
    }
    if (n < minN) continue;
    members.sort((a, b) => b.pct - a.pct);
    res.push({
      name: name, n: n, avgPct: sum / n, up: up, down: down, zt: zt,
      amount: amount, leaders: members.slice(0, 3), members: members,
    });
  }
  // 默认按平均涨幅降序返回（调用方要别的口径再用 heatBoardSorted 重排）
  res.sort((a, b) => b.avgPct - a.avgPct);
  return res;
}

/* 涨停复盘：把涨停股按所属板块归类，找「涨停最集中的板块」= 当日主线 */
function computeLimitRank(snapMap, revIndex) {
  const ztList = [];
  for (const code in (snapMap || {})) {
    const q = snapMap[code];
    if (q && isLimitUp(q)) ztList.push(q);
  }
  ztList.sort((a, b) => (b.amount || 0) - (a.amount || 0));
  const byBoard = new Map();
  for (const q of ztList) {
    const boards = (revIndex && revIndex[q.code]) || [];
    for (const bn of boards) {
      if (!byBoard.has(bn)) byBoard.set(bn, []);
      byBoard.get(bn).push(q);
    }
  }
  const rank = [...byBoard.entries()]
    .map(([name, list]) => ({ name: name, zt: list.length, list: list }))
    .sort((a, b) => b.zt - a.zt || (a.name < b.name ? -1 : 1));
  return { list: ztList, rank: rank };
}

/* 持仓画像：每只持仓 → 所属板块/概念；再按板块汇总仓位占比。纯函数。
 * positions = computePositions() 结果（含 code/name/qty/cost） */
function computeHoldingsProfile(positions, revIndex) {
  const items = [];
  let total = 0;
  for (const p of positions || []) {
    const cost = p.cost ? Number(p.cost) / 100 : 0;   // cost 是 BigInt(分) → 元
    if (cost <= 0) continue;
    total += cost;
    items.push({ code: p.code, name: p.name, cost: cost, boards: (revIndex && revIndex[p.code]) || [] });
  }
  items.sort((a, b) => b.cost - a.cost);
  items.forEach(x => { x.weight = total > 0 ? x.cost / total : 0; });
  const map = new Map();
  for (const it of items) {
    for (const bn of it.boards) {
      if (!map.has(bn)) map.set(bn, { name: bn, cost: 0, codes: [] });
      const e = map.get(bn);
      e.cost += it.cost; e.codes.push(it.code);
    }
  }
  const byBoard = [...map.values()]
    .map(e => ({ name: e.name, cost: e.cost, codes: e.codes, weight: total > 0 ? e.cost / total : 0, count: e.codes.length }))
    .sort((a, b) => b.cost - a.cost);
  return { items: items, byBoard: byBoard, total: total, untagged: items.filter(x => !x.boards.length).length };
}

/* ---- 市场温度评分（0~100）：中位涨幅 + 赚钱效应 + 涨跌停差 ---- */
function heatScore(h) {
  if (!h || !h.n) return { score: null, label: '—', tone: 'flat' };
  const upRatio = h.up / h.n;
  const med = h.medPct == null ? 0 : h.medPct;
  let s = 50 + med * 18 + (upRatio - 0.5) * 60 + (h.zt - h.dt) * 0.10;
  s = Math.max(0, Math.min(100, s));
  const score = Math.round(s);
  const label = score >= 75 ? '火热' : score >= 62 ? '偏热' : score >= 45 ? '中性' : score >= 32 ? '偏冷' : '冰点';
  const tone = score >= 62 ? 'up' : score >= 45 ? 'flat' : 'down';
  return { score: score, label: label, tone: tone };
}
function heatPctTxt(v) { return v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }
function heatCls(v) { return v > 0.005 ? 'hh-up' : v < -0.005 ? 'hh-down' : 'hh-flat'; }
function heatAmtTxt(v) { return v >= 10000 ? (v / 10000).toFixed(2) + ' 万亿' : (v || 0).toFixed(0) + ' 亿'; }
function heatTimeTxt() {
  /* v3.9.12 旧实现读 state.snap.at —— 但 state.snap 是行情 map，.at 一直是 undefined，
     卡片上「快照 —」。改读 snapMeta（refreshHeat 存的本次取数元信息）。 */
  const at = (state.snapMeta && state.snapMeta.at) || 0;
  if (!at) return '—';
  const d = new Date(at);
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function heatBoardSorted(boards, key) {
  const arr = boards.slice();
  if (key === 'zt') arr.sort((a, b) => b.zt - a.zt || b.avgPct - a.avgPct);
  else if (key === 'amount') arr.sort((a, b) => b.amount - a.amount);
  else arr.sort((a, b) => b.avgPct - a.avgPct);
  return arr;
}

/* ---- 渲染：市场热度 ---- */
const HEAT_TOP = 15;
function renderHeatView() {
  const box = document.getElementById('heatBox');
  if (!box) return;
  if (!state.snap) { box.innerHTML = '<div class="empty-tip">点右上角「刷新行情」拉取全市场实时快照</div>'; return; }
  const h = computeMarketHeat(state.snap);
  const sc = heatScore(h);
  const boards = computeBoardHeat(state.snap, state.boardDict, { minMembers: 5 });
  const lim = computeLimitRank(state.snap, state.boardRev);
  const sortKey = state.heatSort || 'avg';
  const top = heatBoardSorted(boards, sortKey).slice(0, HEAT_TOP);
  const bdTotal = h.b.hi + h.b.mid + h.b.low + h.b.flat + h.b.dmid + h.b.dlow || 1;
  const w = v => (v / bdTotal * 100).toFixed(2) + '%';
  const upRatio = h.n ? (h.up / h.n * 100) : 0;
  const noBoard = state.boardDict.length ? '' : '<div class="hh-warn">板块数据未就绪（board-dict.json 未加载成功），板块热度与持仓画像暂不可用。</div>';
  /* v3.9.10 涨跌家数按「沪深 / 北证」拆分展示：同花顺等行情软件大盘页的涨跌家数
     不含北交所（且停牌股剔除），只给总数用户对照时永远差一截、还以为数据错了。
     卡片主数字改成沪深口径（与同花顺可直接对），北交所单独用小字标注。 */
  const upSH = h.up - h.bse.up, downSH = h.down - h.bse.down;
  const suspTxt = h.suspended ? ` · 疑似停牌 ${h.suspended}` : '';

  box.innerHTML = `
    <div class="hh-cards">
      <div class="hh-card"><div class="hh-k">市场温度</div><div class="hh-v ${sc.tone === 'up' ? 'hh-up' : sc.tone === 'down' ? 'hh-down' : ''}">${sc.score == null ? '—' : sc.score}<span class="hh-unit">${sc.label}</span></div></div>
      <div class="hh-card" title="主数字为沪深两市（与同花顺大盘页同口径，不含北交所）；北证为北交所单独统计。本页全市场统计含北交所。"><div class="hh-k">上涨 / 下跌</div><div class="hh-v"><span class="hh-up">${upSH}</span><span class="hh-slash">/</span><span class="hh-down">${downSH}</span><span class="hh-bse">北证 <span class="hh-up">${h.bse.up}</span>/<span class="hh-down">${h.bse.down}</span></span></div></div>
      <div class="hh-card"><div class="hh-k">涨停 / 跌停</div><div class="hh-v"><span class="hh-up">${h.zt}</span><span class="hh-slash">/</span><span class="hh-down">${h.dt}</span></div></div>
      <div class="hh-card"><div class="hh-k">中位涨幅</div><div class="hh-v ${heatCls(h.medPct || 0)}">${heatPctTxt(h.medPct)}</div></div>
      <div class="hh-card"><div class="hh-k">赚钱效应</div><div class="hh-v">${upRatio.toFixed(0)}%</div></div>
      <div class="hh-card"><div class="hh-k">两市成交</div><div class="hh-v">${heatAmtTxt(h.amount)}</div></div>
    </div>

    <div class="hh-head">
      <div class="hh-sub">涨跌分布（${h.n} 只${suspTxt} · 快照 ${heatTimeTxt()}）</div>
      <div class="hh-sorts">
        <button class="hh-sort" data-hexport="detail" type="button">⬇ 全市场明细</button>
        <button class="hh-sort" data-hexport="board" type="button">⬇ 板块汇总</button>
      </div>
    </div>
    <div class="hh-bar">
      <div style="width:${w(h.b.hi)};background:#A32D2D"></div>
      <div style="width:${w(h.b.mid)};background:#E24B4A"></div>
      <div style="width:${w(h.b.low)};background:#F7C1C1"></div>
      <div style="width:${w(h.b.flat)};background:#D3D1C7"></div>
      <div style="width:${w(h.b.dmid)};background:#C0DD97"></div>
      <div style="width:${w(h.b.dlow)};background:#1D9E75"></div>
    </div>
    <div class="hh-legend">
      <span>涨超 9.5%：<b class="hh-up">${h.b.hi}</b></span>
      <span>涨 5~9.5%：<b class="hh-up">${h.b.mid}</b></span>
      <span>涨 0~5%：<b class="hh-up">${h.b.low}</b></span>
      <span>平盘：<b>${h.b.flat}</b></span>
      <span>跌 0~5%：<b class="hh-down">${h.b.dmid}</b></span>
      <span>跌超 5%：<b class="hh-down">${h.b.dlow}</b></span>
    </div>
    ${noBoard}

    <div class="hh-head">
      <div class="hh-sub">板块热度（${boards.length} 个板块，成分股平均涨幅）</div>
      <div class="hh-sorts">
        <button class="hh-sort ${sortKey === 'avg' ? 'on' : ''}" data-hsort="avg">涨幅</button>
        <button class="hh-sort ${sortKey === 'zt' ? 'on' : ''}" data-hsort="zt">涨停</button>
        <button class="hh-sort ${sortKey === 'amount' ? 'on' : ''}" data-hsort="amount">成交额</button>
      </div>
    </div>
    <div class="hh-wrap">
      <table class="hh-tbl">
        <thead><tr><th>板块</th><th class="num">平均涨幅</th><th class="num">涨/跌</th><th class="num">涨停</th><th class="num">成交额</th></tr></thead>
        <tbody>
        ${top.map(b => `
          <tr class="hh-row" data-board="${esc(b.name)}">
            <td><span class="hh-caret">▸</span>${esc(b.name)}<span class="hh-cnt">${b.n}</span></td>
            <td class="num ${heatCls(b.avgPct)}">${heatPctTxt(b.avgPct)}</td>
            <td class="num"><span class="hh-up">${b.up}</span>/<span class="hh-down">${b.down}</span></td>
            <td class="num">${b.zt ? '<b class="hh-up">' + b.zt + '</b>' : '—'}</td>
            <td class="num">${b.amount.toFixed(0)} 亿</td>
          </tr>
          <tr class="hh-detail" data-board-detail="${esc(b.name)}" hidden><td colspan="5">
            ${b.leaders.map(q => `<span class="hh-chip">${esc(q.name)} ${heatPctTxt(q.pct)}</span>`).join('')}
          </td></tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="hh-sub">涨停复盘 · ${lim.list.length} 家涨停 ｜ 主线板块</div>
    <div class="hh-rank">
      ${lim.rank.slice(0, 8).map((r, i) => `<div class="hh-rank-item"><span class="hh-rank-no">${i + 1}</span><span class="hh-rank-nm">${esc(r.name)}</span><b class="hh-up">${r.zt} 家</b></div>`).join('') || '<div class="empty-tip">今日无涨停</div>'}
    </div>
    ${lim.list.length ? `<details class="hh-more"><summary>查看全部 ${lim.list.length} 只涨停股</summary>
      <div class="hh-wrap"><table class="hh-tbl"><thead><tr><th>名称</th><th class="num">涨幅</th><th class="num">成交额</th><th>所属板块</th></tr></thead><tbody>
      ${lim.list.slice(0, 60).map(q => `<tr><td>${esc(q.name)}<span class="hh-cnt">${q.code}</span></td><td class="num hh-up">${heatPctTxt(q.pct)}</td><td class="num">${q.amount ? q.amount.toFixed(1) + ' 亿' : '—'}</td><td class="hh-tags">${(state.boardRev[q.code] || []).slice(0, 3).map(b => esc(b)).join(' · ') || '—'}</td></tr>`).join('')}
      </tbody></table></div></details>` : ''}
    <div class="hh-foot">数据来源：腾讯行情 qt.gtimg.cn 全市场直连快照（沪深主板 + 创业板 + 科创板 + 北交所，代码清单来自随应用发布的股票字典；约 60 秒缓存复用，每次取数都会记入「设置 → 日志」）。涨停按「昨收×涨幅上限」还原涨停价精确判定。<br>口径提示：上方「上涨/下跌」主数字为<b>沪深两市</b>（与同花顺等行情软件大盘页可直接对照）；北交所单独一行小字。其余统计（涨跌分布 / 涨停复盘 / 成交额）为全市场口径；疑似停牌（零成交且现价=昨收）会计入平盘，同花顺口径里这类被剔除，这是平盘家数对不上的主要原因。点标题行「⬇ 下载源数据」导出<b>本次分析的完整源数据</b>（取数凭证 + 评分构成 + 三套口径家数 + 逐股明细 + 板块汇总 + 涨停复盘），拿它和同花顺逐股对账。</div>
  `;
  box.querySelectorAll('.hh-sort[data-hsort]').forEach(btn => {
    btn.onclick = () => { state.heatSort = btn.dataset.hsort; renderHeatView(); };
  });
  /* v3.9.10 数据下载：把这次快照真实拿到的逐股数据导出成 CSV（Excel 可直接打开），
     用户拿它和同花顺逐股对照，涨跌家数对不上时能自己找出是哪几只票口径不同。 */
  box.querySelectorAll('.hh-sort[data-hexport]').forEach(btn => {
    btn.onclick = () => {
      if (!state.snap) return;
      try {
        if (btn.dataset.hexport === 'detail') heatExportDetailCsv();
        else heatExportBoardCsv();
      } catch (e) { toast('导出失败：' + (e && e.message || e), 'warn'); }
    };
  });
  /* v3.9.12 标题行主按钮「⬇ 下载源数据」：导出本次分析的完整源数据包（与个股诊断的
     「⬇ 下载」同一交互习惯）。快照没拉到之前隐藏。 */
  const dlBtn = document.getElementById('heatDlBtn');
  if (dlBtn) {
    dlBtn.hidden = !state.snap;
    dlBtn.onclick = () => {
      try { heatExportSourceCsv(); } catch (e) { toast('导出失败：' + (e && e.message || e), 'warn'); }
    };
  }
  box.querySelectorAll('.hh-row').forEach(tr => {
    tr.onclick = () => {
      const d = box.querySelector('.hh-detail[data-board-detail="' + CSS.escape(tr.dataset.board) + '"]');
      if (d) { d.hidden = !d.hidden; const c = tr.querySelector('.hh-caret'); if (c) c.textContent = d.hidden ? '▸' : '▾'; }
    };
  });
}

/* ---- v3.9.10 CSV 导出（零依赖：Blob + a.download；BOM 让 Excel 正确识别 UTF-8） ---- */
function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function csvDownload(name, rows) {
  const text = '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function csvStamp() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function marketLabelOf(code) {
  if (isBSE(code)) return '北交所';
  if (/^68/.test(code)) return '科创板';
  if (/^30/.test(code)) return '创业板';
  if (/^60/.test(code)) return '沪主板';
  if (/^00/.test(code)) return '深主板';
  return '其他';
}
/* 全市场明细行（逐股一行，按涨跌幅降序，含涨停/跌停/停牌判定列）——
   v3.9.12 抽成独立函数：「⬇ 全市场明细」和「⬇ 下载源数据」共用，避免两份逻辑漂移 */
function heatDetailRows() {
  const h = computeMarketHeat(state.snap);
  const rows = [['代码', '名称', '市场', '现价', '昨收', '涨跌幅%', '涨跌额', '成交额(亿)', '换手率%', '振幅%', '涨停', '跌停', '疑似停牌']];
  const list = Object.values(state.snap).filter(q => q && q.pct != null && isFinite(q.pct)).sort((a, b) => b.pct - a.pct);
  for (const q of list) {
    rows.push([
      q.code, q.name, marketLabelOf(q.code), q.price, q.prevClose, q.pct, q.chg,
      q.amount, q.turnover, q.amp,
      isLimitUp(q) ? '是' : '', isLimitDown(q) ? '是' : '',
      (!q.amount && q.price != null && q.prevClose != null && q.price === q.prevClose) ? '是' : '',
    ]);
  }
  rows.push([]);
  rows.push(['# 汇总', `共${h.n}只`, `涨${h.up}`, `跌${h.down}`, `平${h.flat}`, `涨停${h.zt}`, `跌停${h.dt}`, `沪深涨${h.up - h.bse.up}跌${h.down - h.bse.down}`, `北证涨${h.bse.up}跌${h.bse.down}`, `疑似停牌${h.suspended}`]);
  rows.push(['# 数据来源', `腾讯行情 qt.gtimg.cn 全市场快照 ${heatTimeTxt()}`, `快照共 ${h.n} 只`, '涨停=昨收×涨幅上限还原判定']);
  return rows;
}
function heatExportDetailCsv() {
  csvDownload('market-snapshot-' + csvStamp() + '.csv', heatDetailRows());
}
/* 板块汇总行（全部板块，不只 TOP15）—— v3.9.12 同样抽出共用 */
function heatBoardRows() {
  const rows = [['板块', '成分数', '平均涨幅%', '上涨', '下跌', '涨停', '成交额(亿)']];
  for (const b of computeBoardHeat(state.snap, state.boardDict, { minMembers: 1 })) {
    rows.push([b.name, b.n, Number(b.avgPct.toFixed(3)), b.up, b.down, b.zt, Number(b.amount.toFixed(2))]);
  }
  return rows;
}
function heatExportBoardCsv() {
  if (!state.boardDict.length) { toast('板块字典未加载，板块汇总暂不可用', 'warn'); return; }
  csvDownload('board-heat-' + csvStamp() + '.csv', heatBoardRows());
}
/* v3.9.12 「⬇ 下载源数据」：市场热度的完整源数据包（一份多段式 CSV，Excel 直接打开）。
   为什么加：个股诊断给每张 K 线配了「⬇ 下载」，市场热度却只有两个藏在涨跌分布
   排序按钮旁边的散按钮，用户 perception 就是「没提供源数据，没法核对」。
   现在把「这次分析用到的一切」摊进一个文件：取数凭证（时间/覆盖数/批次/耗时/URL）+
   温度评分每个分项的贡献分 + 三套口径的涨跌家数 + 涨跌分布 + 逐股明细 + 板块汇总 + 涨停复盘。
   对账思路：先看「1 元信息」确认数据新鲜度，再看「2/3/4」逐个数字核对，有出入去「5 逐股明细」找差在哪几只票。 */
function heatFullTime(d) {
  if (!d || !d.getTime()) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function heatExportSourceCsv() {
  if (!state.snap) { toast('还没有快照数据，先点「刷新行情」拉一次', 'warn'); return; }
  const h = computeMarketHeat(state.snap);
  const m = state.snapMeta || {};
  const sc = heatScore(h);
  const upRatio = h.n ? h.up / h.n : 0;
  const med = h.medPct == null ? 0 : h.medPct;
  const rawScore = 50 + med * 18 + (upRatio - 0.5) * 60 + (h.zt - h.dt) * 0.10;
  const bdTotal = h.b.hi + h.b.mid + h.b.low + h.b.flat + h.b.dmid + h.b.dlow || 1;
  const rows = [];
  const sec = t => { rows.push([]); rows.push(['# ' + t]); };

  /* 1 元信息：这份数据几点取的、从哪来、覆盖多全 —— 拿去对账的「凭证」 */
  sec('1 本次取数凭证（元信息）');
  rows.push(['导出时间', heatFullTime(new Date())]);
  rows.push(['快照时间', heatFullTime(new Date(m.at || 0)), m.cached ? '60 秒缓存复用（非本次新拉）' : '本次实拉']);
  rows.push(['数据源', '腾讯行情 qt.gtimg.cn 全市场直连快照（GBK 解码，本地计算）']);
  rows.push(['请求 URL 样例', m.url || '—']);
  rows.push(['覆盖 / 应取', `${m.n != null ? m.n : h.n} / ${m.total != null ? m.total : '—'} 只`, `股票字典共 ${m.dictSize != null ? m.dictSize : '—'} 条，热度只取 A 股前缀(60|68|00|30|43|83|87|92)`]);
  rows.push(['请求批次', `${m.parts != null ? m.parts : '—'} 批（每批 ${m.batchSize || 80} 只 · 并发 ${m.concurrency || 6}）` + (m.emptyBatches ? `，其中 ${m.emptyBatches} 批失败(该批个股缺失)` : '')]);
  rows.push(['取数耗时', m.ms != null ? (m.ms / 1000).toFixed(1) + ' 秒' : '—']);
  rows.push(['板块字典版本', state.boardVer || '—']);

  /* 2 温度评分构成：卡片上那个 0~100 的分数是怎么算出来的 */
  sec('2 市场温度评分构成（0~100）');
  rows.push(['公式', '50 + 中位涨幅×18 + (上涨占比-0.5)×60 + (涨停数-跌停数)×0.10，结果裁剪到 0~100']);
  rows.push(['分项', '原始值', '贡献分']);
  rows.push(['中位涨幅%', Number(med.toFixed(3)), Number((med * 18).toFixed(2))]);
  rows.push(['上涨占比', (upRatio * 100).toFixed(2) + '%', Number(((upRatio - 0.5) * 60).toFixed(2))]);
  rows.push(['涨停-跌停', `${h.zt}-${h.dt}=${h.zt - h.dt}`, Number(((h.zt - h.dt) * 0.10).toFixed(2))]);
  rows.push(['裁剪前得分', Number(rawScore.toFixed(2))]);
  rows.push(['最终得分', sc.score, sc.label]);

  /* 3 涨跌家数三套口径：和同花顺对数前先选对行 */
  sec('3 涨跌家数（三套口径，对照同花顺用第 2 行）');
  rows.push(['口径', '上涨', '下跌', '平盘', '涨停', '跌停']);
  rows.push(['全市场（含北交所）', h.up, h.down, h.flat, h.zt, h.dt]);
  rows.push(['沪深两市（同花顺大盘页口径，不含北交所）', h.up - h.bse.up, h.down - h.bse.down, h.flat - h.bse.flat, h.zt - h.bse.zt, h.dt - h.bse.dt]);
  rows.push(['北交所单独', h.bse.up, h.bse.down, h.bse.flat, h.bse.zt, h.bse.dt]);
  rows.push(['疑似停牌（零成交且现价=昨收，同花顺口径里这类被剔除）', h.suspended, '计入平盘', '', '', '']);

  /* 4 涨跌分布：分段条形图背后那 6 个数 */
  sec('4 涨跌分布（全市场）');
  rows.push(['区间', '家数', '占比']);
  rows.push(['涨超 9.5%', h.b.hi, (h.b.hi / bdTotal * 100).toFixed(2) + '%']);
  rows.push(['涨 5~9.5%', h.b.mid, (h.b.mid / bdTotal * 100).toFixed(2) + '%']);
  rows.push(['涨 0~5%', h.b.low, (h.b.low / bdTotal * 100).toFixed(2) + '%']);
  rows.push(['平盘', h.b.flat, (h.b.flat / bdTotal * 100).toFixed(2) + '%']);
  rows.push(['跌 0~5%', h.b.dmid, (h.b.dmid / bdTotal * 100).toFixed(2) + '%']);
  rows.push(['跌超 5%', h.b.dlow, (h.b.dlow / bdTotal * 100).toFixed(2) + '%']);
  rows.push(['中位涨幅%', h.medPct == null ? '—' : Number(h.medPct.toFixed(3))]);
  rows.push(['全市场成交额(亿)', Number(h.amount.toFixed(1))]);

  /* 5 逐股明细：涨跌家数有出入时，在这里逐股找出差在哪几只票 */
  sec('5 逐股明细（全市场，按涨跌幅降序）');
  for (const r of heatDetailRows()) rows.push(r);

  /* 6 板块汇总 */
  sec('6 板块热度汇总（全部板块）');
  if (state.boardDict.length) for (const r of heatBoardRows()) rows.push(r);
  else rows.push(['板块字典未加载，本段为空']);

  /* 7 涨停复盘 */
  sec('7 涨停复盘（当日涨停股，按成交额降序）');
  const lim = computeLimitRank(state.snap, state.boardRev);
  rows.push(['代码', '名称', '涨幅%', '成交额(亿)', '所属板块(前3)']);
  for (const q of lim.list) {
    rows.push([q.code, q.name, q.pct, q.amount != null ? Number(q.amount.toFixed(2)) : '', (state.boardRev[q.code] || []).slice(0, 3).join(' · ')]);
  }

  /* 8 口径备注 */
  sec('8 口径备注');
  rows.push(['1', '「上涨/下跌」卡片主数字 = 沪深两市（第 3 段第 2 行），可与同花顺大盘页直接对照；北交所单独一行小字。']);
  rows.push(['2', '疑似停牌（零成交且现价=昨收）会计入我们的「平盘」，同花顺口径里这类被剔除 —— 平盘家数对不上的主因。']);
  rows.push(['3', '涨停/跌停 = 昨收 × 涨幅上限还原涨停价精确判定（含 ST 5%、主板 10%、创业/科创 20%、北交所 30%）。']);
  rows.push(['4', '板块热度 = 板块成分股在本次快照里的平均涨幅；一只股票可归属多个板块/概念。']);
  csvDownload('market-heat-source-' + csvStamp() + '.csv', rows);
}

/* ---- 刷新：拉全市场快照并重绘 ---- */
async function refreshHeat(force) {
  const box = document.getElementById('heatBox');
  if (!box) return;
  const btn = document.getElementById('heatRefreshBtn');
  if (btn) { btn.disabled = true; btn.textContent = '拉取中…'; }
  box.innerHTML = '<div class="empty-tip">正在拉取全市场实时快照（约 3 秒）…</div>';
  /* v3.9.13 审计：本次快照取数标上触发来源 */
  return NetLog.withCtx('分析页·市场热度' + (force ? '(强刷)' : ''), async () => {
  try {
    if (!state.boardDict.length) { try { await ensureBoardDict(false); } catch (e) { /* 板块不可用不影响热度 */ } }
    if (force) _qCache = null;
    const snap = await qSnapshot();
    state.snap = snap.map;
    /* v3.9.12 把这次快照的元信息一并留下：卡片时间戳、下载源数据都要用 */
    state.snapMeta = {
      at: snap.at, n: snap.n, total: snap.total, parts: snap.parts,
      emptyBatches: snap.emptyBatches, ms: snap.ms, cached: !!snap.cached,
      url: snap.url || '', batchSize: snap.batchSize || 80, concurrency: snap.concurrency || 6,
      dictSize: snap.dictSize || 0,
    };
    renderHeatView();
  } catch (e) {
    box.innerHTML = '<div class="empty-tip">行情拉取失败：' + esc(e && e.message || '未知错误') + '</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '刷新行情'; }
  }
  });
}

/* ---- 渲染：持仓画像 ---- */
function renderProfileView() {
  const box = document.getElementById('profileBox');
  if (!box) return;
  const pos = computePositions().filter(p => p.qty > 0n);
  if (!pos.length) { box.innerHTML = '<div class="empty-tip">还没有持仓（当前持仓由交易记录实时推算）</div>'; return; }
  if (!state.boardDict.length) {
    box.innerHTML = '<div class="hh-warn">板块数据还没就绪（board-dict.json 未加载成功），暂时无法归类。'
      + '请检查网络后<b>重新打开一次页面</b>。</div>';
    return;
  }
  const pf = computeHoldingsProfile(pos, state.boardRev);
  const warn = pf.byBoard.filter(b => b.weight >= 0.3 && b.count >= 2);
  box.innerHTML = `
    <div class="hh-cards">
      <div class="hh-card"><div class="hh-k">持仓只数</div><div class="hh-v">${pf.items.length}</div></div>
      <div class="hh-card"><div class="hh-k">涉及板块/概念</div><div class="hh-v">${pf.byBoard.length}</div></div>
      <div class="hh-card"><div class="hh-k">最大单一板块</div><div class="hh-v">${pf.byBoard[0] ? (pf.byBoard[0].weight * 100).toFixed(0) + '%' : '—'}</div></div>
      <div class="hh-card"><div class="hh-k">未识别标的</div><div class="hh-v">${pf.untagged}</div></div>
    </div>
    ${warn.length ? `<div class="hh-warn">集中度提示：${warn.slice(0, 3).map(b => `<b>${esc(b.name)}</b> 占 ${(b.weight * 100).toFixed(0)}%（${b.count} 只）`).join('、')}——同一个板块内多只股票涨跌高度同向，实际风险接近「一只票」。</div>` : ''}

    <div class="hh-sub">仓位分布（按成本占比 · 每只股票会同时计入其所有归属板块）</div>
    <div class="hh-wrap">
      <table class="hh-tbl">
        <thead><tr><th>板块 / 概念</th><th class="num">占比</th><th class="num">持仓数</th><th>涉及标的</th></tr></thead>
        <tbody>
        ${pf.byBoard.filter(b => b.weight >= 0.05).slice(0, 20).map(b => `
          <tr><td>${esc(b.name)}</td><td class="num">${(b.weight * 100).toFixed(1)}%</td><td class="num">${b.count}</td>
          <td class="hh-tags">${b.codes.slice(0, 6).map(c => esc(dispStockName(c))).join(' · ')}${b.codes.length > 6 ? ' …' : ''}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="hh-sub">逐只持仓标签</div>
    ${pf.items.map(it => `
      <div class="hh-stock">
        <div class="hh-stock-head"><b>${esc(it.name)}</b><span class="hh-cnt">${it.code}</span><span class="hh-w">${(it.weight * 100).toFixed(1)}%</span></div>
        <div class="hh-tags">${it.boards.length ? it.boards.map(b => `<span class="hh-chip">${esc(b)}</span>`).join('') : '<span class="hh-cnt">未收录（新股 / 退市 / 港股等）</span>'}</div>
      </div>`).join('')}
    <div class="hh-foot">归属数据来自东财板块成分表（${state.boardVer || '—'}），平均每只股票 8 个板块 / 概念标签；占比按持仓成本计算。</div>
  `;
}

async function analyzeBehavior() {
  const btn = document.getElementById('behaviorBtn');
  btn.disabled = true; btn.textContent = 'AI 评分中…';
  try {
    if (!state.trades.length) return toast('还没有交易记录，先去「记一笔」记录交易');
    const list = state.trades.slice(0, 100).map(t =>
      `${fmtTs(t.trade_date)}|${t.stock_name || t.stock_code}(${t.stock_code})|${t.action === 'buy' ? '买' : '卖'}|${t.quantity}股@${t.price}${t.tags && t.tags.length ? '|' + t.tags.join('/') : ''}`);
    const positions = computePositions().map(p => `${p.name}: ${dToStr(p.qty, 0, 0)}股 成本${fmtD(p.avgCost)}`).join('；');
    const sys = `你是资深投资交易教练，借鉴专业交易复盘方法（仓位管理、止盈止损纪律、交易频率、盈亏比、情绪化交易、风险集中度），对用户的交易行为评分。只输出 JSON：
{"score":0-100整数,"grade":"S/A/B/C/D","title":"简短评语标题","strengths":["优点1","优点2"],"weaknesses":["问题1","问题2"],"suggestions":["改进建议1","改进建议2"],"summary":"2-3句总体点评"}`;
    const text = await llmComplete([
      { role: 'system', content: sys },
      { role: 'user', content: `当前持仓：${positions || '无'}\n交易记录（新→旧）：\n<<<\n${list.join('\n')}\n>>>` },
    ], { json: true });
    const j = parseJsonLoose(text);
    const content = `综合评分：${j.score}（${j.grade} 级）\n\n【优点】\n${(j.strengths || []).map(s => '· ' + s).join('\n')}\n\n【不足】\n${(j.weaknesses || []).map(s => '· ' + s).join('\n')}\n\n【改进建议】\n${(j.suggestions || []).map(s => '· ' + s).join('\n')}\n\n【总体点评】\n${j.summary || ''}`;
    await api('app_insert', {
      p_table: 'analyses',
      p_data: { kind: 'behavior', title: j.title || '交易行为评分', content, score: j.score, summary: j.summary || '' },
    });
    await reloadAnalyses();
    renderAnalyses();
    openModal(`交易行为评分：${j.score} 分（${j.grade}）`, new Date().toLocaleString('zh-CN'), content);
    toast('行为评分已生成');
  } catch (e) {
    toast(e.message || '评分失败，请重试');
  } finally {
    btn.disabled = false; btn.textContent = '开始行为评分';
  }
}

async function analyzeStage() {
  const btn = document.getElementById('stageBtn');
  btn.disabled = true; btn.textContent = 'AI 总结中…';
  try {
    if (!state.trades.length) return toast('还没有交易记录');
    const trades = state.trades.slice(0, 80).map(t =>
      `${fmtTs(t.trade_date)}|${t.stock_name || t.stock_code}|${t.action === 'buy' ? '买' : '卖'}|${t.quantity}股@${t.price}${t.comment ? '|' + t.comment : ''}`);
    const past = state.analyses.slice(0, 8).map(a => `[${a.kind}] ${a.title}：${(a.summary || '').slice(0, 60)}`);
    const sys = `你是投资复盘助手。根据用户一段时间内的交易记录与既有分析报告，生成本阶段总结与后续行动建议。只输出 JSON：
{"title":"阶段标题","summary":"3-5句阶段总结","highlights":["关键发现1","关键发现2"],"action_items":["后续行动建议1","后续行动建议2","后续行动建议3"]}`;
    const text = await llmComplete([
      { role: 'system', content: sys },
      { role: 'user', content: `交易记录：\n<<<\n${trades.join('\n')}\n>>>\n\n历史分析摘要：\n${past.join('\n') || '无'}` },
    ], { json: true });
    const j = parseJsonLoose(text);
    const content = `${j.summary || ''}\n\n【关键发现】\n${(j.highlights || []).map(s => '· ' + s).join('\n')}\n\n【后续行动建议】\n${(j.action_items || []).map(s => '· ' + s).join('\n')}`;
    await api('app_insert', {
      p_table: 'analyses',
      p_data: { kind: 'stage', title: j.title || '阶段总结', content, summary: j.summary || '' },
    });
    await reloadAnalyses();
    renderAnalyses();
    openModal(j.title || '阶段总结', new Date().toLocaleString('zh-CN'), content);
    toast('阶段总结已生成');
  } catch (e) {
    toast(e.message || '生成失败，请重试');
  } finally {
    btn.disabled = false; btn.textContent = '生成阶段总结';
  }
}
// ---- 页面渲染 ----
// 策略回测的股票下拉（原「技术分析」页已并入诊断，这里只填回测）
function renderBtOptions() {
  const map = new Map();
  computePositions().forEach(p => map.set(p.code, p.name));
  state.watch.forEach(w => { if (!map.has(w.stock_code)) map.set(w.stock_code, w.stock_name || w.stock_code); });
  const opts = [...map.entries()];
  for (const id of ['btStock']) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = opts.length
      ? opts.map(([c, n]) => `<option value="${esc(c)}">${esc(n)}（${esc(c)}）</option>`).join('')
      : '<option value="">-- 请先在持仓/自选股中添加股票 --</option>';
    if (prev && opts.some(([c]) => c === prev)) sel.value = prev;
  }
}

/* ============================================================
 * 投资组合风险分析（集中度 / 波动率 / Beta / 相关性 / VaR / 压力测试）
 * ============================================================ */
async function fetchIndexKline() { // 上证指数日 K（对齐 Beta / 相关性基准）
  const t0 = Date.now();
  try {
    const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001'
      + '&fields1=f1,f2,f3&fields2=f51,f52,f53&klt=101&fqt=0&end=20500101&lmt=260';
    const res = await fetch(url);
    const j = await res.json();
    const bars = ((j.data && j.data.klines) || []).map(s => { const a = s.split(','); return { d: a[0], c: +a[2] }; });
    if (bars.length > 60) { NetLog.push('kline', '东财 上证指数日K', true, Date.now() - t0, `${bars.length}根`); return bars; }
  } catch (e) { /* 降级 */ NetLog.push('kline', '东财 上证指数日K', false, Date.now() - t0, e.message || String(e)); }
  const t1 = Date.now();
  try {
    const res2 = await fetch('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,260,');
    const j2 = await res2.json();
    const d2 = (j2.data && j2.data.sh000001) || {};
    const bars2 = (d2.day || []).map(k => ({ d: k[0], c: +k[2] }));
    NetLog.push('kline', '腾讯 上证指数日K(降级)', bars2.length > 0, Date.now() - t1, `${bars2.length}根`);
    return bars2;
  } catch (e) {
    NetLog.push('kline', '腾讯 上证指数日K(降级)', false, Date.now() - t1, e.message || String(e));
    throw e;
  }
}
// 统计工具
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
function std(a) { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1 || 1)); }
function pearson(a, b) {
  const n = Math.min(a.length, b.length); if (n < 30) return null;
  const ma = mean(a.slice(-n)), mb = mean(b.slice(-n));
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const x = a[a.length - n + i] - ma, y = b[b.length - n + i] - mb; cov += x * y; va += x * x; vb += y * y; }
  return (va && vb) ? cov / Math.sqrt(va * vb) : null;
}
// 按日期对齐个股与指数收益率（停牌日自动剔除）
function alignedReturns(bars, idxCloseMap) {
  const rs = [], rm = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = idxCloseMap.get(bars[i - 1].d), cur = idxCloseMap.get(bars[i].d);
    if (prev && cur) { rs.push(bars[i].c / bars[i - 1].c - 1); rm.push(cur / prev - 1); }
  }
  return { rs, rm };
}
function maxDrawdown(closes) {
  let peak = closes[0], mdd = 0;
  closes.forEach(c => { peak = Math.max(peak, c); mdd = Math.max(mdd, (peak - c) / peak); });
  return mdd;
}
const fmtWan = v => v >= 1e4 ? (v / 1e4).toFixed(2) + ' 万' : v.toFixed(0) + ' 元';

// 风险分析纯计算核心（UI 与智能问答共用）
async function computeRiskCore() {
  const positions = computePositions().filter(p => p.qty > 0n);
  if (!positions.length) throw new Error('当前没有持仓，先去「记一笔」记录交易吧');
  await reloadTrades(); await fetchQuotesForAll();
  const ps = computePositions();
  // 市值与权重
  const items = ps.map(p => {
    const q = state.quotes[p.code];
    const price = (q && q.price) || parseFloat(dToStr(p.avgCost, 2, 8, false)) || 0;
    return { code: p.code, name: q && q.name ? q.name : p.name, qty: parseFloat(dToStr(p.qty, 2, 8, false)), price, mv: parseFloat(dToStr(dMul(p.qty, toD(price)), 2, 8, false)) };
  }).filter(x => x.mv > 0);
  const total = items.reduce((s, x) => s + x.mv, 0);
  items.forEach(x => x.w = x.mv / total);
  // K 线与指标
  const idxBars = await fetchIndexKline();
  const idxClose = new Map(idxBars.map(b => [b.d, b.c]));
  await Promise.all(items.map(async x => {
    try {
      const { bars } = await fetchKline(x.code, 101, 260);
      const closes = bars.map(b => b.c);
      const rets = []; for (let i = 1; i < closes.length; i++) rets.push(closes[i] / closes[i - 1] - 1);
      x.annVol = std(rets) * Math.sqrt(244);
      x.mdd = maxDrawdown(closes.slice(-250));
      x.w52 = Math.max(...closes.slice(-250)); x.offHigh = 1 - closes[closes.length - 1] / x.w52;
      const { rs, rm } = alignedReturns(bars, idxClose);
      if (rm.length > 60) {
        const m = mean(rm), cov = mean(rs.map((r, i) => (r - mean(rs)) * (rm[i] - m))), vr = mean(rm.map(r => (r - m) * (r - m)));
        x.beta = vr ? cov / vr : 1;
      }
      x.rets = rets;
    } catch (e) { x.annVol = null; }
  }));
  // 相关性矩阵
  const pairs = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (a.rets && b.rets) {
      const n = Math.min(a.rets.length, b.rets.length);
      const r = pearson(a.rets.slice(-n), b.rets.slice(-n));
      if (r != null) pairs.push({ a: a.name, b: b.name, r });
    }
  }
  pairs.sort((x, y) => y.r - x.r);
  // 组合指标（日频）
  let portVar = 0; const dv = x => (x.annVol != null ? x.annVol : 0.3) / Math.sqrt(244);
  for (let i = 0; i < items.length; i++) for (let j = 0; j < items.length; j++) {
    const wi = items[i].w, wj = items[j].w;
    let rho = 1;
    if (i !== j) {
      const p = pairs.find(p => (p.a === items[i].name && p.b === items[j].name) || (p.a === items[j].name && p.b === items[i].name));
      rho = p ? p.r : 0.5; // 缺失时按 A 股平均共动 0.5 估算
    }
    portVar += wi * wj * dv(items[i]) * dv(items[j]) * rho;
  }
  const portVolD = Math.sqrt(portVar), portVolA = portVolD * Math.sqrt(244);
  const var95 = 1.645 * portVolD * total;
  const betaP = items.reduce((s, x) => s + x.w * (x.beta != null ? x.beta : 1), 0);
  const stressLoss = 0.2 * betaP * total; // 市场 -20% 线性估算
  const hedgeNotional = total * betaP;

  // ---- 问题清单 ----
  const issues = [];
  items.filter(x => x.w > 0.25).forEach(x => issues.push({ lv: 'bad', t: `过度暴露：${x.name} 占比 ${(x.w * 100).toFixed(1)}%，单一股票超过 25% 安全线，个股黑天鹅冲击显著` }));
  items.filter(x => x.w > 0.2 && x.w <= 0.25).forEach(x => issues.push({ lv: 'warn', t: `权重偏高：${x.name} 占比 ${(x.w * 100).toFixed(1)}%，接近 25% 上限` }));
  if (items.length < 3) issues.push({ lv: 'warn', t: `仅持有 ${items.length} 只股票，分散度不足，单一事件冲击大` });
  items.filter(x => x.beta != null && x.beta > 1.3).forEach(x => issues.push({ lv: 'warn', t: `高 Beta：${x.name} β=${x.beta.toFixed(2)}，市场波动被放大约 ${(x.beta * 100).toFixed(0)}%` }));
  items.filter(x => x.annVol != null && x.annVol > 0.45).forEach(x => issues.push({ lv: 'warn', t: `高波动：${x.name} 年化波动率 ${(x.annVol * 100).toFixed(0)}%，显著高于市场` }));
  pairs.filter(p => p.r >= 0.7).forEach(p => issues.push({ lv: 'bad', t: `隐藏相关性：${p.a} 与 ${p.b} 相关系数 ${p.r.toFixed(2)}，涨跌高度同向，实为"一只股票"的风险` }));
  pairs.filter(p => p.r >= 0.55 && p.r < 0.7).forEach(p => issues.push({ lv: 'warn', t: `中度相关：${p.a} 与 ${p.b} 相关系数 ${p.r.toFixed(2)}` }));
  items.filter(x => x.offHigh > 0.25).forEach(x => issues.push({ lv: 'info', t: `${x.name} 距 52 周高点回撤 ${(x.offHigh * 100).toFixed(0)}%（最大回撤 ${(x.mdd * 100).toFixed(0)}%），注意趋势磨损` }));
  const boards = { star: items.filter(x => /^688/.test(x.code)).length, chinext: items.filter(x => /^300|^301/.test(x.code)).length };
  if (boards.star >= 2) issues.push({ lv: 'warn', t: `科创板集中：持有 ${boards.star} 只 688 股票，20cm 波动放大组合回撤` });
  if (boards.chinext >= 2) issues.push({ lv: 'warn', t: `创业板集中：持有 ${boards.chinext} 只 300/301 股票，20cm 波动放大组合回撤` });
  if (!issues.length) issues.push({ lv: 'info', t: '各项指标均在合理区间，组合结构健康' });

  // ---- 再平衡建议 ----
  const reb = [];
  items.filter(x => x.w > 0.25).forEach(x => {
    const cut = x.mv - 0.2 * total;
    reb.push(`【减仓】${x.name} 从 ${(x.w * 100).toFixed(1)}% 降至 20%：卖出约 ${fmtWan(cut)}（≈${Math.ceil(cut / x.price / 100) * 100} 股）`);
  });
  if (betaP > 1.15) {
    const hi = [...items].filter(x => x.beta != null).sort((a, b) => b.beta - a.beta)[0];
    if (hi) reb.push(`【降贝塔】组合 β=${betaP.toFixed(2)} 偏高，优先减仓 ${hi.name}（β=${hi.beta.toFixed(2)}），换入低 β 防御品种（公用事业 / 高股息 / 货币基金）`);
  }
  pairs.filter(p => p.r >= 0.7).forEach(p => {
    const wa = items.find(x => x.name === p.a), wb = items.find(x => x.name === p.b);
    const keep = wa && wb ? (wa.w >= wb.w ? p.a : p.b) : p.a;
    reb.push(`【去重叠】${p.a} 与 ${p.b} 高度相关，二者合计 ${(items.filter(x => x.name === p.a || x.name === p.b).reduce((s, x) => s + x.w, 0) * 100).toFixed(1)}%，建议只保留 ${keep}，另一只换成低相关行业`);
  });
  reb.push(`【现金缓冲】建议保留 10%~20% 现金 / 货基（≈${fmtWan(total * 0.15)}），既降波动也留补仓弹药`);
  if (portVolA > 0.35) reb.push(`【控波动】组合年化波动率 ${(portVolA * 100).toFixed(0)}% 偏高，可将部分高波动仓位（年化 >45%）置换为宽基 ETF 平滑净值`);

  // ---- 对冲策略（防市场 -20%）----
  const hedgeAmount = hedgeNotional * 0.5;
  const idxPoint = idxBars.length ? idxBars[idxBars.length - 1].c : 3000;
  const lots = Math.max(1, Math.round(hedgeAmount / (idxPoint * 300)));
  return { items, total, pairs, portVolA, var95, betaP, stressLoss, hedgeNotional, hedgeAmount, idxPoint, lots, issues, reb };
}

async function runRiskAnalysis() {
  const btn = document.getElementById('riskRunBtn');
  const box = document.getElementById('riskBox');
  if (!computePositions().some(p => p.qty > 0n)) return toast('当前没有持仓，先去「记一笔」记录交易吧');
  btn.disabled = true; btn.textContent = '分析中…';
  box.innerHTML = '<div class="empty-tip">⏳ 正在获取行情与 K 线，计算组合风险…</div>';
  try {
    const R = await computeRiskCore();
    const { items, total, portVolA, betaP, var95, stressLoss, hedgeNotional, hedgeAmount, idxPoint, lots } = R;
    state.risk = { ...R, ai: null };

    box.innerHTML = `
      <div class="risk-stats">
        <div class="risk-stat"><div class="v">${fmtWan(total)}</div><div class="k">持仓总市值</div></div>
        <div class="risk-stat"><div class="v ${portVolA > 0.35 ? 'warn' : 'ok'}">${(portVolA * 100).toFixed(1)}%</div><div class="k">组合年化波动率</div></div>
        <div class="risk-stat"><div class="v ${betaP > 1.2 ? 'warn' : 'ok'}">${betaP.toFixed(2)}</div><div class="k">组合 Beta（对上证）</div></div>
        <div class="risk-stat"><div class="v warn">${fmtWan(var95)}</div><div class="k">日 VaR(95%)：单日最大可能亏损</div></div>
        <div class="risk-stat"><div class="v warn">-${fmtWan(stressLoss)}</div><div class="k">压力测试：市场 -20% 时预估亏损</div></div>
      </div>
      <div class="risk-weight">
        <h4>持仓权重分布（金线 = 25% 单票上限）</h4>
        ${items.sort((a, b) => b.w - a.w).map(x => `
          <div class="w-row">
            <div class="w-name">${esc(x.name)}</div>
            <div class="w-track"><div class="w-fill ${x.w > 0.25 ? 'over' : ''}" style="width:${Math.min(100, x.w * 100 * 2)}%"></div><div class="w-cap" style="left:50%"></div></div>
            <div class="w-val">${(x.w * 100).toFixed(1)}%</div>
          </div>`).join('')}
        <div class="levels-legend">个股指标：${items.map(x => `${esc(x.name)} β=${x.beta != null ? x.beta.toFixed(2) : '-'} / 波动率 ${x.annVol != null ? (x.annVol * 100).toFixed(0) + '%' : '-'}`).join(' ／ ')}</div>
      </div>
      <div class="risk-cols">
        <div class="tech-reason risk-issue"><h4>⚠️ 弱点与过度暴露</h4><ul>${R.issues.map(i => `<li class="li-${i.lv}">${i.lv === 'bad' ? '🔴 ' : i.lv === 'warn' ? '🟡 ' : '⚪ '}${esc(i.t)}</li>`).join('')}</ul></div>
        <div class="tech-reason risk-issue"><h4>⚖️ 风险调整再平衡建议</h4><ul>${R.reb.map(r => `<li class="li-info">${esc(r)}</li>`).join('')}</ul></div>
      </div>
      <div class="risk-hedge risk-issue">
        <h4>🛡️ 对冲策略：防范市场下跌 20%</h4>
        <div>组合市值 ${fmtWan(total)} × Beta ${betaP.toFixed(2)} = 市场敞口 <b>${fmtWan(hedgeNotional)}</b>；建议对冲 50% 敞口（≈<b>${fmtWan(hedgeAmount)}</b> 名义）：</div>
        <ul>
          <li class="li-info">① <b>股指期货空头</b>：做空约 ${lots} 手 IF/IM（按上证 ${idxPoint.toFixed(0)} 点、每点 300 元估算），保证金约 ${fmtWan(hedgeAmount * 0.12)}，对冲精度最高</li>
          <li class="li-info">② <b>指数认沽期权</b>：买入 5%~10% 虚值认沽（300ETF/50ETF 期权），名义 ${fmtWan(hedgeAmount)}，权利金成本约为名义的 1%~2%，亏损封底、保留上涨空间</li>
          <li class="li-info">③ <b>直接降仓</b>：减仓 20%~30% 换成货基 / 短债 ETF（≈${fmtWan(total * 0.25)}），无对冲成本，最简单有效</li>
          <li class="li-info">④ <b>防御置换</b>：高 β 仓位部分换成红利低波 ETF / 黄金 ETF，天然低 β 资产可把组合 β 拉向 1 以下</li>
        </ul>
        <div class="levels-legend">若不对冲，市场 -20% → 组合预估亏损 ${fmtWan(stressLoss)}；若对冲 50% 敞口 → 预估亏损降至约 ${fmtWan(stressLoss * 0.5)}（线性估算，仅供参考，不构成投资建议）</div>
      </div>
      <div class="tech-ai">
        <button id="riskAiBtn" class="btn primary">🤖 AI 综合解读</button>
        <button id="riskSaveBtn" class="btn ghost">💾 保存报告</button>
        <div id="riskAiOut" class="tech-ai-out" hidden></div>
      </div>`;
    document.getElementById('riskAiBtn').onclick = runRiskAi;
    document.getElementById('riskSaveBtn').onclick = saveRiskReport;
    toast('组合风险分析完成');
  } catch (e) {
    box.innerHTML = `<div class="empty-tip">${esc(e && e.message || '分析失败，请重试')}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '开始分析';
  }
}

async function runRiskAi() {
  const t = state.risk;
  if (!t) return;
  const btn = document.getElementById('riskAiBtn'), out = document.getElementById('riskAiOut');
  btn.disabled = true; btn.textContent = 'AI 解读中…'; out.hidden = false; out.textContent = '生成中…';
  const itemsDesc = t.items.map(x => `${x.name} 权重${(x.w * 100).toFixed(1)}% β=${x.beta != null ? x.beta.toFixed(2) : '-'} 波动率${x.annVol != null ? (x.annVol * 100).toFixed(0) + '%' : '-'}`).join('；');
  const corrDesc = t.pairs.slice(0, 4).map(p => `${p.a}~${p.b}: ${p.r.toFixed(2)}`).join('；') || '样本不足';
  try {
    let text = '';
    await llmComplete([
      { role: 'system', content: '你是投资组合风险分析师。用简体中文、纯文本分步输出（一、二、三…）：1) 组合体检总结 2) 主要弱点与过度暴露 3) 隐藏相关性风险 4) 风险调整再平衡建议 5) 防范市场下跌20%的对冲策略。控制在 400 字内，直接给结论和操作，不复读数据。' },
      { role: 'user', content: `持仓：${itemsDesc}\n组合：总市值${fmtWan(t.total)}，年化波动率${(t.portVolA * 100).toFixed(1)}%，β=${t.betaP.toFixed(2)}，日VaR95=${fmtWan(t.var95)}，市场-20%预估亏损${fmtWan(t.stressLoss)}\n相关性：${corrDesc}\n规则引擎已给出：${t.issues.slice(0, 4).map(i => i.t).join('；')}\n请给出综合解读与操作建议。` },
    ], { onDelta: (delta) => { text += delta; out.textContent = text; } });
    t.ai = text;
    out.textContent = text || '（无输出）';
  } catch (e) {
    out.textContent = 'AI 解读失败：' + (e && e.message || e);
  } finally {
    btn.disabled = false; btn.textContent = '🤖 AI 综合解读';
  }
}

async function saveRiskReport() {
  const t = state.risk;
  if (!t) return;
  const content = [
    `总市值 ${fmtWan(t.total)}｜年化波动率 ${(t.portVolA * 100).toFixed(1)}%｜β=${t.betaP.toFixed(2)}｜日VaR95 ${fmtWan(t.var95)}｜市场-20%预估亏损 ${fmtWan(t.stressLoss)}`,
    '',
    '【弱点与过度暴露】', ...t.issues.map(i => (i.lv === 'bad' ? '🔴 ' : i.lv === 'warn' ? '🟡 ' : '⚪ ') + i.t),
    '', '【再平衡建议】', ...t.reb,
    t.ai ? '\n【AI 综合解读】\n' + t.ai : '',
  ].join('\n');
  try {
    await api('app_insert', {
      p_table: 'analyses',
      p_data: {
        kind: 'risk', stock_code: 'PORTFOLIO', stock_name: '投资组合',
        title: `组合风险分析（${new Date().toLocaleDateString('zh-CN')}）`, content,
        score: Math.round(t.betaP * 100) / 100, summary: `β=${t.betaP.toFixed(2)}，市场-20%预估亏损 ${fmtWan(t.stressLoss)}`,
      },
    });
    await reloadAnalyses(); renderAnalyses();
    toast('报告已保存到分析历史');
  } catch (e) { toast(e.message || '保存失败'); }
}

/* ============================================================
 * 交易操作复盘（最近 20 笔进出场配对 + 行为偏差 + 3 条个性化规则）
 * ============================================================ */
// FIFO 配对买入/卖出 → 已平仓交易记录（按出场时间取最近 20 笔）
function buildClosedTrades() {
  const sorted = [...state.trades].sort((a, b) =>
    a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : a.id - b.id);
  const lots = {};
  const closed = [];
  for (const t of sorted) {
    const code = t.stock_code, qty = toD(t.quantity), price = toD(t.price);
    if (qty === 0n || price === 0n) continue;
    if (t.action === 'buy') {
      (lots[code] || (lots[code] = [])).push({ date: t.trade_date, price, qty });
    } else {
      let rem = qty, matchedQty = 0n, entryCost = 0n, minDate = null;
      const L = lots[code] || [];
      while (rem > 0n && L.length) {
        const lot = L[0];
        const m = lot.qty <= rem ? lot.qty : rem;
        entryCost = dAdd(entryCost, dMul(lot.price, m));
        matchedQty = dAdd(matchedQty, m);
        if (!minDate || lot.date < minDate) minDate = lot.date;
        lot.qty = dSub(lot.qty, m); rem = dSub(rem, m);
        if (lot.qty <= 0n) L.shift();
      }
      if (matchedQty > 0n) {
        const avgEntry = dDiv(entryCost, matchedQty);
        closed.push({
          code, name: t.stock_name || code,
          entryDate: minDate, exitDate: t.trade_date,
          entryPrice: parseFloat(dToStr(avgEntry, 2, 8, false)),
          exitPrice: parseFloat(dToStr(price, 2, 8, false)),
          qty: parseFloat(dToStr(matchedQty, 0, 8, false)),
          pnl: parseFloat(dToStr(dMul(dSub(price, avgEntry), matchedQty), 2, 8, false)),
          cost: parseFloat(dToStr(entryCost, 2, 8, false)),
        });
      }
      // rem>0 的部分是未记录的历史买入，跳过
    }
  }
  return closed.slice(-20);
}

const daysBetween = (a, b) => Math.max(1, Math.round((new Date(b) - new Date(a)) / 86400000));

// 操作复盘纯计算核心（UI 与智能问答共用）；无已平仓交易时返回 null
async function computeReviewCore() {
  await reloadTrades();
  const closed = buildClosedTrades();
  const openCount = computePositions().filter(p => p.qty > 0n).length;
  if (!closed.length) return null;
  // K 线增强：卖出后走势（错失机会）、持有期最大浮亏
  const kcache = {};
  for (const c of closed) {
    if (!kcache[c.code]) { try { kcache[c.code] = (await fetchKline(c.code, 101, 260)).bars; } catch (e) { kcache[c.code] = []; } }
    const bars = kcache[c.code] || [];
    c.afterHigh = null; c.afterNow = null; c.maxAdverse = null;
    const ei = bars.findIndex(b => b.d > c.exitDate);
    if (ei >= 0) {
      const after = bars.slice(ei, ei + 20);
      if (after.length) { c.afterHigh = Math.max(...after.map(b => b.h)); c.afterNow = bars[bars.length - 1].c; }
    }
    const seg = bars.filter(b => b.d >= c.entryDate && b.d <= c.exitDate);
    if (seg.length) c.maxAdverse = Math.min(...seg.map(b => b.l));
  }
  closed.forEach(c => {
    c.holdDays = daysBetween(c.entryDate, c.exitDate);
    c.pnlPct = c.cost ? c.pnl / c.cost * 100 : 0;
    c.miss = c.afterHigh != null ? (c.afterHigh / c.exitPrice - 1) * 100 : null;
    c.adverse = (c.maxAdverse != null && c.entryPrice) ? (c.maxAdverse / c.entryPrice - 1) * 100 : null;
  });
  const wins = closed.filter(c => c.pnl > 0), losses = closed.filter(c => c.pnl <= 0);
  const avg = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
  const avgHoldWin = avg(wins.map(c => c.holdDays)), avgHoldLoss = avg(losses.map(c => c.holdDays));
  const avgWinPct = avg(wins.map(c => c.pnlPct)), avgLossPct = avg(losses.map(c => c.pnlPct));
  const winRate = wins.length / closed.length * 100;
  const plRatio = (avgLossPct != null && avgLossPct !== 0) ? Math.abs(avgWinPct / avgLossPct) : null;
  const date30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const recent30 = state.trades.filter(t => t.trade_date >= date30).length;
  const missCount = closed.filter(c => c.miss != null && c.miss > 8).length;
  const deepLoss = closed.filter(c => c.pnlPct < -8).length;

  // ---- 行为偏差规则检测 ----
  const flags = [];
  if (avgHoldWin != null && avgHoldLoss != null && avgHoldWin < avgHoldLoss * 0.7)
    flags.push(['warn', `处置效应：盈利单平均只拿 ${avgHoldWin.toFixed(1)} 天，亏损单却扛 ${avgHoldLoss.toFixed(1)} 天——赚小亏大典型特征`]);
  if (plRatio != null && plRatio < 1)
    flags.push(['bad', `盈亏比失衡：平均盈利 ${avgWinPct.toFixed(1)}% vs 平均亏损 ${Math.abs(avgLossPct).toFixed(1)}%，盈亏比 ${plRatio.toFixed(2)}（<1 意味着胜率必须非常高才保本）`]);
  if (deepLoss >= 2) flags.push(['bad', `止损缺失：${deepLoss} 笔亏损超过 8% 未截断，单笔风险敞口过大`]);
  if (recent30 > 8) flags.push(['warn', `交易过度频繁：最近 30 天 ${recent30} 笔操作，摩擦成本与情绪化概率上升`]);
  if (missCount >= 2) flags.push(['warn', `卖出即错过：${missCount} 笔卖出后 20 日内最大涨幅超 8%，出场策略偏急`]);
  const sizes = closed.map(c => c.cost); const mSize = avg(sizes), sSize = std(sizes);
  if (mSize && sSize / mSize > 0.8) flags.push(['warn', `仓位不稳定：单笔金额标准差达均值 ${(sSize / mSize * 100).toFixed(0)}%，高低仓位差距悬殊`]);
  if (!flags.length) flags.push(['info', '未检测到明显行为偏差，继续保持纪律']);
  return { closed, openCount, winRate, avgWinPct, avgLossPct, plRatio, avgHoldWin, avgHoldLoss, recent30, missCount, deepLoss, winsN: wins.length, lossesN: losses.length, flags };
}

async function runTradeReview() {
  const btn = document.getElementById('reviewRunBtn');
  const box = document.getElementById('reviewBox');
  btn.disabled = true; btn.textContent = '复盘分析中…';
  box.innerHTML = '<div class="empty-tip">⏳ 正在配对进出场并获取 K 线…</div>';
  try {
    const core = await computeReviewCore();
    if (!core) {
      box.innerHTML = '<div class="empty-tip">还没有完整的买卖配对（已平仓交易），先去「记一笔」记录交易吧</div>';
      return;
    }
    const { closed, openCount, winRate, avgWinPct, avgLossPct, plRatio, avgHoldWin, avgHoldLoss, recent30, missCount, deepLoss, winsN, lossesN, flags } = core;
    state.review = { ...core, ai: null };
    const fmt = (v, suf = '%') => v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(1) + suf;
    box.innerHTML = `
      <div class="risk-stats">
        <div class="risk-stat"><div class="v">${closed.length}</div><div class="k">复盘笔数（已平仓）</div></div>
        <div class="risk-stat"><div class="v ${winRate >= 50 ? 'ok' : 'warn'}">${winRate.toFixed(0)}%</div><div class="k">胜率（${winsN} 胜 ${lossesN} 负）</div></div>
        <div class="risk-stat"><div class="v ${plRatio != null && plRatio >= 1.5 ? 'ok' : 'warn'}">${plRatio != null ? plRatio.toFixed(2) : '--'}</div><div class="k">盈亏比</div></div>
        <div class="risk-stat"><div class="v">${fmt(avgWinPct)} / ${fmt(avgLossPct)}</div><div class="k">平均盈利 / 平均亏损</div></div>
        <div class="risk-stat"><div class="v">${avgHoldWin != null ? avgHoldWin.toFixed(1) : '--'} 天 / ${avgHoldLoss != null ? avgHoldLoss.toFixed(1) : '--'} 天</div><div class="k">盈利单 / 亏损单 平均持有</div></div>
      </div>
      <div class="table-wrap" style="margin-top:14px"><table><thead><tr>
        <th>名称</th><th>进场日</th><th>进场价</th><th>出场日</th><th>出场价</th><th>数量</th><th>盈亏</th><th>收益率</th><th>持有</th><th>持有期最大浮亏</th><th>卖出后 20 日</th></tr></thead><tbody>
        ${closed.slice().reverse().map(c => `<tr>
          <td><b>${esc(c.name)}</b></td><td>${c.entryDate}</td><td>${c.entryPrice.toFixed(2)}</td><td>${c.exitDate}</td><td>${c.exitPrice.toFixed(2)}</td><td>${c.qty}</td>
          <td style="color:${c.pnl >= 0 ? '#d03030' : '#0a9d4e'}">${c.pnl >= 0 ? '+' : ''}${c.pnl.toFixed(0)}</td>
          <td style="color:${c.pnl >= 0 ? '#d03030' : '#0a9d4e'}">${fmt(c.pnlPct)}</td>
          <td>${c.holdDays} 天</td>
          <td>${c.adverse != null && c.adverse < 0 ? fmt(c.adverse) : '<span style="color:#0a9d4e">未破</span>'}</td>
          <td>${c.miss != null ? (c.miss > 0 ? '<span style="color:#b8860b">又涨 ' + fmt(c.miss) + '</span>' : '<span style="color:#0a9d4e">卖对了 ' + fmt(c.miss) + '</span>') : '--'}</td>
        </tr>`).join('')}
      </tbody></table></div>
      <div class="tech-cols" style="margin-top:14px">
        <div class="tech-reason risk-issue"><h4>🧠 行为偏差检测</h4><ul>${flags.map(f => `<li class="li-${f[0]}">${f[0] === 'bad' ? '🔴 ' : f[0] === 'warn' ? '🟡 ' : '🟢 '}${esc(f[1])}</li>`).join('')}</ul></div>
        <div class="tech-reason risk-issue"><h4>📌 快照</h4><ul>
          <li class="li-info">最近 30 天操作 ${recent30} 笔；当前未平仓 ${openCount} 只</li>
          <li class="li-info">卖出后 20 日最大涨幅超 8% 的"卖飞"共 ${missCount} 笔</li>
          <li class="li-info">亏损超 8% 的未截断交易 ${deepLoss} 笔</li>
        </ul></div>
      </div>
      <div class="tech-ai">
        <button id="reviewAiBtn" class="btn primary">🤖 AI 深度复盘（错误 / 错失 / 偏差 / 3 条规则）</button>
        <button id="reviewSaveBtn" class="btn ghost">💾 保存报告</button>
        <div id="reviewAiOut" class="tech-ai-out" hidden></div>
      </div>`;
    document.getElementById('reviewAiBtn').onclick = runReviewAi;
    document.getElementById('reviewSaveBtn').onclick = saveReviewReport;
    toast('操作复盘完成');
  } catch (e) {
    box.innerHTML = `<div class="empty-tip">${esc(e && e.message || '复盘失败，请重试')}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '开始复盘';
  }
}

async function runReviewAi() {
  const t = state.review;
  if (!t) return;
  const btn = document.getElementById('reviewAiBtn'), out = document.getElementById('reviewAiOut');
  btn.disabled = true; btn.textContent = 'AI 复盘中…'; out.hidden = false; out.textContent = '生成中…';
  const lines = t.closed.map(c =>
    `${c.name} 买入@${c.entryPrice.toFixed(2)}(${c.entryDate.slice(5)}) → 卖出@${c.exitPrice.toFixed(2)}(${c.exitDate.slice(5)}) 持有${c.holdDays}天 收益${c.pnlPct.toFixed(1)}%`
    + (c.adverse != null ? ` 期间最大浮亏${c.adverse.toFixed(1)}%` : '')
    + (c.miss != null ? ` 卖出后20日${c.miss > 0 ? '最高涨' + c.miss.toFixed(1) + '%' : '跌' + Math.abs(c.miss).toFixed(1) + '%'}` : ''));
  try {
    let text = '';
    await llmComplete([
      { role: 'system', content: '你是交易心理与行为金融教练。基于用户的交易明细与统计，用简体中文纯文本分四部分输出：一、反复出现的错误（点名具体交易佐证）二、错失的机会 三、行为偏差（结合处置效应/损失厌恶/过度交易等）四、最后给出【3 条个性化规则】，每条格式为「规则名：具体执行标准（含数字）→ 针对的问题」，必须可立即执行。总共 500 字内，不复读数据。' },
      { role: 'user', content: `最近 ${t.closed.length} 笔已平仓交易：\n${lines.join('\n')}\n\n统计：胜率${t.winRate.toFixed(0)}%，盈亏比${t.plRatio != null ? t.plRatio.toFixed(2) : '--'}，平均盈利${t.avgWinPct != null ? t.avgWinPct.toFixed(1) + '%' : '--'}/平均亏损${t.avgLossPct != null ? t.avgLossPct.toFixed(1) + '%' : '--'}，盈利单平均持有${t.avgHoldWin != null ? t.avgHoldWin.toFixed(1) + '天' : '--'}/亏损单${t.avgHoldLoss != null ? t.avgHoldLoss.toFixed(1) + '天' : '--'}，最近30天${t.recent30}笔\n\n规则引擎检测到的偏差：\n${t.flags.map(f => f[1]).join('\n')}\n\n请输出深度复盘。` },
    ], { onDelta: (delta) => { text += delta; out.textContent = text; } });
    t.ai = text;
    out.textContent = text || '（无输出）';
  } catch (e) {
    out.textContent = 'AI 复盘失败：' + (e && e.message || e);
  } finally {
    btn.disabled = false; btn.textContent = '🤖 AI 深度复盘（错误 / 错失 / 偏差 / 3 条规则）';
  }
}

async function saveReviewReport() {
  const t = state.review;
  if (!t) return;
  const content = [
    `复盘 ${t.closed.length} 笔：胜率 ${t.winRate.toFixed(0)}%，盈亏比 ${t.plRatio != null ? t.plRatio.toFixed(2) : '--'}，平均盈利 ${t.avgWinPct != null ? t.avgWinPct.toFixed(1) + '%' : '--'} / 平均亏损 ${t.avgLossPct != null ? t.avgLossPct.toFixed(1) + '%' : '--'}`,
    '', '【行为偏差】', ...t.flags.map(f => (f[0] === 'bad' ? '🔴 ' : f[0] === 'warn' ? '🟡 ' : '🟢 ') + f[1]),
    t.ai ? '\n【AI 深度复盘】\n' + t.ai : '',
  ].join('\n');
  try {
    await api('app_insert', {
      p_table: 'analyses',
      p_data: {
        kind: 'review', stock_code: 'REVIEW', stock_name: '交易复盘',
        title: `交易操作复盘（${new Date().toLocaleDateString('zh-CN')}）`, content,
        score: Math.round(t.winRate), summary: `胜率 ${t.winRate.toFixed(0)}%，复盘 ${t.closed.length} 笔`,
      },
    });
    await reloadAnalyses(); renderAnalyses();
    toast('复盘报告已保存到分析历史');
  } catch (e) { toast(e.message || '保存失败'); }
}

/* ============================================================
 * 策略回测（均线交叉 / MACD / RSI 背离 → 历史模拟 → 胜率/盈亏比/回撤）
 * ============================================================ */
// ---- 信号生成：返回 sig 数组（1=持仓，0=空仓），信号次日开盘成交 ----
function btSignalsMA(bars) {
  const c = bars.map(b => b.c);
  const m1 = calcMA(c, 5), m2 = calcMA(c, 20);
  return bars.map((_, i) => (m1[i] != null && m2[i] != null ? (m1[i] > m2[i] ? 1 : 0) : 0));
}
function btSignalsMACD(bars) {
  const { hist } = calcMACD(bars.map(b => b.c));
  return bars.map((_, i) => (i >= 26 && hist[i] != null ? (hist[i] > 0 ? 1 : 0) : 0));
}
// RSI 背离：价格创新低而 RSI 低点抬高 → 看多背离（买入）；价格创新高而 RSI 高点降低 → 看空背离（卖出）；持仓中跌破 MA20 也离场
function btSignalsRSI(bars) {
  const c = bars.map(b => b.c);
  const rsi = calcRSI(c, 14);
  const ma20 = calcMA(c, 20);
  const sig = new Array(bars.length).fill(0);
  const events = []; // {i: 生效bar, enter: bool}
  const pivots = [];
  for (let i = 3; i < bars.length - 3; i++) {
    const w = [i - 3, i - 2, i - 1, i + 1, i + 2, i + 3];
    if (w.every(k => c[i] <= c[k])) pivots.push({ i, low: true });
    else if (w.every(k => c[i] >= c[k])) pivots.push({ i, low: false });
  }
  let prevLow = null, prevHigh = null;
  for (const p of pivots) {
    const ci = p.i + 3; // 摆动点需 3 根 K 线确认
    if (p.low) {
      if (prevLow != null && ci - (prevLow.i + 3) <= 80
        && bars[p.i].l < bars[prevLow.i].l * 0.995
        && rsi[p.i] != null && rsi[prevLow.i] != null && rsi[p.i] > rsi[prevLow.i]) {
        events.push({ i: ci, enter: true });
      }
      prevLow = p;
    } else {
      if (prevHigh != null && ci - (prevHigh.i + 3) <= 80
        && bars[p.i].h > bars[prevHigh.i].h * 1.005
        && rsi[p.i] != null && rsi[prevHigh.i] != null && rsi[p.i] < rsi[prevHigh.i]) {
        events.push({ i: ci, enter: false });
      }
      prevHigh = p;
    }
  }
  const evMap = new Map(events.map(e => [e.i, e.enter]));
  let inPos = 0;
  for (let i = 0; i < bars.length; i++) {
    if (evMap.has(i)) { sig[i] = evMap.get(i) ? 1 : 0; inPos = evMap.get(i) ? 1 : 0; continue; }
    if (inPos && ma20[i] != null && c[i] < ma20[i]) { sig[i] = 0; inPos = 0; } // 趋势出场
    else sig[i] = inPos;
  }
  return sig;
}
// 布林带：跌破下轨买入（超跌均值回归），回升到中轨上方卖出
function btSignalsBoll(bars) {
  const c = bars.map(b => b.c);
  const { mid, dn } = calcBOLL(c, 20, 2);
  const sig = new Array(bars.length).fill(0);
  let pos = 0;
  for (let i = 0; i < bars.length; i++) {
    if (dn[i] == null || mid[i] == null) { sig[i] = pos; continue; }
    if (pos === 0 && c[i] < dn[i]) pos = 1;          // 跌破下轨 → 买
    else if (pos === 1 && c[i] > mid[i]) pos = 0;    // 回到中轨上方 → 卖
    sig[i] = pos;
  }
  return sig;
}
// 唐奇安通道：突破前 20 日最高价买入，跌破前 10 日最低价卖出（只用到「昨天为止」的通道，避免自证）
function btSignalsDonchian(bars) {
  const n = bars.length;
  const sig = new Array(n).fill(0);
  let pos = 0;
  const hiN = 20, loN = 10;
  for (let i = 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let k = Math.max(0, i - hiN); k < i; k++) hh = Math.max(hh, bars[k].h);
    for (let k = Math.max(0, i - loN); k < i; k++) ll = Math.min(ll, bars[k].l);
    if (pos === 0 && i > hiN && bars[i].c > hh) pos = 1;
    else if (pos === 1 && i > loN && bars[i].c < ll) pos = 0;
    sig[i] = pos;
  }
  return sig;
}
// 双均线 + 趋势过滤：MA5 > MA20 且 MA60 向上 才持有
function btSignalsMaTrend(bars) {
  const c = bars.map(b => b.c);
  const m5 = calcMA(c, 5), m20 = calcMA(c, 20), m60 = calcMA(c, 60);
  return bars.map(function (_, i) {
    if (m5[i] == null || m20[i] == null || m60[i] == null || m60[i - 5] == null) return 0;
    return (m5[i] > m20[i] && m60[i] > m60[i - 5]) ? 1 : 0;
  });
}
const BT_STRATS = {
  ma:   { label: '均线交叉（MA5×MA20）', gen: btSignalsMA, desc: 'MA5 上穿 MA20 持有，下穿空仓' },
  macd: { label: 'MACD 金叉死叉', gen: btSignalsMACD, desc: 'MACD 柱 >0 持有，<0 空仓' },
  rsi:  { label: 'RSI 背离', gen: btSignalsRSI, desc: '价格新低 RSI 不新低买入，价格新高 RSI 不新高卖出' },
  drop: { label: '跌买涨卖（网格）', gen: null, desc: '自锚价回落达设定幅度买入，自买入价反弹达设定幅度卖出，每轮重新锚定、循环滚动做 T', param: true },
  boll: { label: '布林带（下轨买 / 中轨卖）', gen: btSignalsBoll, desc: '收盘价跌破布林下轨（MA20−2σ）买入，回升到中轨（MA20）之上卖出 —— 震荡市均值回归型' },
  donchian: { label: '唐奇安通道突破', gen: btSignalsDonchian, desc: '收盘价突破前 20 日最高价买入，跌破前 10 日最低价卖出 —— 趋势突破型（海龟雏形）' },
  matrend: { label: '双均线 + 趋势过滤', gen: btSignalsMaTrend, desc: 'MA5 > MA20 且 MA60 向上时才持有 —— 用中期趋势过滤掉下跌市里的假金叉' },
};

// ---- 信号生成：跌 X% 买入 / 涨 Y% 卖出（网格滚动做 T） ----
// 维护一个「锚价」anchor：
//   · 空仓时：收盘价自 anchor 回落达 dropPct → 买入，anchor 更新为买入价，并记录该笔成本
//   · 持仓时：收盘价自 anchor（=最近一次买入价）回升达 risePct → 卖出，anchor 更新为卖出价，回到空仓
//   · 空仓等买点时，若价格持续下跌但未达跌幅，anchor **不下移**（否则阈值永远追不上）；
//     但若价格反向涨过 anchor，则把 anchor 上移到新高——这样"回落"始终相对最近高点计量，
//     既能在下跌中买入、又能在反弹后重新拿到合理基准，避免长期僵死不成交。
// 这样每完成一轮买卖就重新锚定，形成可反复触发的网格节奏。
function btSignalsDrop(bars, dropPct, risePct) {
  const drop = Math.max(0.1, +dropPct || 5) / 100;
  const rise = Math.max(0.1, +risePct || 5) / 100;
  const n = bars.length;
  const sig = new Array(n).fill(0);
  let pos = 0;
  let anchor = bars[0] ? bars[0].c : 0; // 空仓：参照高点；持仓：最近买入价
  for (let i = 0; i < n; i++) {
    const c = bars[i].c;
    if (!(c > 0)) { sig[i] = pos; continue; }
    if (pos === 0) {
      if (c <= anchor * (1 - drop)) {   // 自锚价回落达标 → 买入，锚价切为买入价
        pos = 1; anchor = c;
      } else if (c > anchor) {          // 未触发但创出新高 → 锚价跟随上移（只在上涨方向跟随）
        anchor = c;
      }
      sig[i] = pos;
    } else {
      if (c >= anchor * (1 + rise)) {   // 自买入价反弹达标 → 卖出，锚价切为卖出价
        pos = 0; anchor = c;
      }
      sig[i] = pos;
    }
  }
  return sig;
}

// ---- 模拟：现金 10 万，权益逐日盯市 ----
// fillAt='nextOpen'（默认，指标型策略）：信号次日开盘成交，避免用当日收盘价预知当日信号
// fillAt='close'（阈值型策略）：信号当日收盘成交，因其触发条件定义的正是收盘价
// risk（可选，任意策略都能叠加，用来把"策略信号"和"风控纪律"分开评估）：
//   stopPct    固定止损 %（自入场价跌破即离场，盘中触发，按止损价与开盘价中较差者成交）
//   atrK       ATR 倍数跟踪止损（自持仓期最高价回撤 K 倍 ATR 离场，移动止盈/止损一体）
//   trailPct   移动止盈 %（自持仓期最高价回撤该比例离场，只赚浮盈之后才生效）
//   circuitPct 回撤熔断 %（策略净值自峰值回撤该比例 → 清仓并停止后续开仓）
function btSimulate(bars, sig, startIdx, fillAt, risk) {
  const CASH0 = 100000, FEE = 0.0013; // 佣金+印花税近似
  const atClose = fillAt === 'close';
  risk = risk || {};
  const stopPct = Math.max(0, +risk.stopPct || 0);
  const atrK = Math.max(0, +risk.atrK || 0);
  const trailPct = Math.max(0, +risk.trailPct || 0);
  const circuitPct = Math.max(0, +risk.circuitPct || 0);
  const atr = atrK > 0 ? calcATR(bars, 14) : null;
  let cash = CASH0, shares = 0, pos = 0, entry = null, hiSince = 0;
  let peakEq = CASH0, halted = false, reBlock = false;
  const trades = [], equity = [];
  const triggers = { stop: 0, atr: 0, trail: 0, circuit: 0, signal: 0 };

  const sell = function (b, px, why, key) {
    const fill = px * (1 - FEE);
    const pnl = shares * (fill - entry.p);
    trades.push({
      inD: entry.d, inP: entry.p, outD: b.d, outP: fill, qty: shares, pnl,
      pnlPct: (fill / entry.p - 1) * 100, why: why || '',
      days: Math.round((new Date(b.d) - new Date(entry.d)) / 86400000),
    });
    if (key) triggers[key]++;
    // 风控强制离场后不允许"第二天原价再买回来"（否则止损等于白做，只是多付一次手续费）。
    // 必须等策略信号先回到空仓、再次给出买入时才重新入场 —— 这就是纪律的含义。
    if (key && key !== 'signal') reBlock = true;
    cash += shares * fill; shares = 0; pos = 0; entry = null; hiSince = 0;
  };

  for (let i = startIdx; i < bars.length; i++) {
    const b = bars[i];
    if (!halted) {
      const want = atClose ? sig[i] : (sig[i - 1] != null ? sig[i - 1] : 0);
      const fillPx = atClose ? b.c : b.o;
      if (pos === 0 && want === 0) reBlock = false;      // 信号已空仓 → 解除风控冷却
      if (pos === 0 && want === 1 && !reBlock) {
        const px = fillPx * (1 + FEE);
        shares = Math.floor(cash / px / 100) * 100;
        if (shares > 0) { cash -= shares * px; pos = 1; entry = { d: b.d, p: fillPx, i }; hiSince = b.h; }
      } else if (pos === 1) {
        hiSince = Math.max(hiSince, b.h);
        // ① 硬止损 / ATR 跟踪止损：盘中用最低价判断，成交价取「止损价」与「当日开盘价」中更差的
        let lv = 0, why = '', key = '';
        if (stopPct > 0) { const s = entry.p * (1 - stopPct / 100); if (s > lv) { lv = s; why = '止损 −' + stopPct + '%'; key = 'stop'; } }
        if (atr && atr[i] != null) {
          const s = hiSince - atrK * atr[i];
          if (s > lv) { lv = s; why = 'ATR ' + atrK + '倍跟踪止损'; key = 'atr'; }
        }
        if (lv > 0 && b.l <= lv) {
          sell(b, Math.min(b.o, lv), why, key);
        } else if (trailPct > 0 && hiSince > entry.p && (hiSince - b.c) / hiSince * 100 >= trailPct) {
          // ② 移动止盈：自持仓期最高价回撤 trailPct% 即离场（收盘价确认）
          sell(b, b.c, '浮盈回撤 ' + trailPct + '% 止盈', 'trail');
        } else if (want === 0) {
          sell(b, fillPx, '策略信号', 'signal');
        }
      }
    }
    const eq = cash + shares * b.c;
    peakEq = Math.max(peakEq, eq);
    if (circuitPct > 0 && !halted && peakEq > 0 && (eq - peakEq) / peakEq * 100 <= -circuitPct) {
      // ③ 回撤熔断：清仓并停止后续开仓（记录"触发日"，让用户看到它到底救了还是拖累了收益）
      if (pos === 1) sell(b, b.c, '回撤熔断 −' + circuitPct + '%', 'circuit');
      else triggers.circuit++;
      halted = true;
    }
    equity.push({ d: b.d, v: cash + shares * b.c, ref: CASH0 * (b.c / bars[startIdx].c) });
  }
  // 期末仍持仓 → 按最后收盘强平计入（未实现，仅统计口径）
  let open = null;
  if (pos === 1) {
    const last = bars[bars.length - 1];
    open = { inD: entry.d, inP: entry.p, outD: null, outP: last.c, qty: shares,
      pnl: shares * (last.c - entry.p), pnlPct: (last.c / entry.p - 1) * 100,
      days: Math.round((new Date(last.d) - new Date(entry.d)) / 86400000), open: true, why: '' };
  }
  return { trades, equity, open, final: cash + shares * bars[bars.length - 1].c, CASH0,
    triggers: triggers, halted: halted, risk: { stopPct, atrK, trailPct, circuitPct } };
}
function btMaxDrawdown(equity) {
  let peak = -Infinity, mdd = 0, mddPct = 0;
  for (const e of equity) {
    peak = Math.max(peak, e.v);
    const dd = (e.v - peak) / peak;
    if (dd < mddPct) { mddPct = dd; }
    mdd = Math.min(mdd, e.v - peak);
  }
  return { mdd, mddPct: mddPct * 100 };
}
function fmtPf(pf) { return pf == null ? '--' : (isFinite(pf) ? pf.toFixed(2) : '∞（无亏损单）'); }
function btMetrics(sim) {
  const closed = sim.trades;
  const wins = closed.filter(t => t.pnl > 0), losses = closed.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const { mdd, mddPct } = btMaxDrawdown(sim.equity);
  const ret = (sim.final - sim.CASH0) / sim.CASH0 * 100;
  const refRet = (sim.equity[sim.equity.length - 1].ref / sim.CASH0 - 1) * 100;
  const refMdd = btMaxDrawdown(sim.equity.map(e => ({ v: e.ref })));
  const avgWin = wins.length ? grossWin / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;
  return {
    n: closed.length + (sim.open ? 1 : 0), closedN: closed.length, open: sim.open,
    winRate: closed.length ? wins.length / closed.length * 100 : null,
    pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    avgWin, avgLoss, pl: avgWin != null && avgLoss ? avgWin / avgLoss : null,
    totalPnl: sim.final - sim.CASH0, ret, refRet,
    mdd, mddPct, refMddPct: refMdd.mddPct,
    avgDays: closed.length ? closed.reduce((s, t) => s + t.days, 0) / closed.length : null,
    grossWin, grossLoss,
  };
}
// ---- 改进建议（规则引擎） ----
function btSuggestions(m, stratKey, opt) {
  const out = [];
  opt = opt || {};
  const isDrop = stratKey === 'drop';
  const dP = opt.dropPct, rP = opt.risePct;
  if (m.n < 5) out.push(['info', `样本太少（仅 ${m.n} 笔），统计意义不足。${isDrop ? '建议把跌/涨阈值设小一点（如 3%/3%）或多回测几只股票，让触发次数上来再评估。' : '建议回测更长周期，或放宽入场条件增加交易次数后再评估。'}`]);
  if (m.pf == null) out.push(['bad', '没有任何一笔盈利，策略与该股当前走势完全不匹配，建议直接换策略或用于反向参考。']);
  else if (m.pf < 1) out.push(['bad', `盈利因子 ${m.pf.toFixed(2)} < 1（亏 ${fmtD(toD(m.grossLoss - m.grossWin), 0)}），核心问题是盈亏结构失衡。${m.winRate != null && m.winRate < 45 ? (isDrop ? `胜率 ${m.winRate.toFixed(0)}% 偏低：说明该股的日常波动经常打不到 +${rP}% 就反向跌破 -${dP}%，可把止盈阈值调小、止损阈值调大试试（如跌 ${dP}% 买、涨 ${Math.max(1, Math.round(rP / 2 * 10) / 10)}% 卖）` : '胜率偏低，应先收紧入场过滤（如只在 MA20 上方做多）') : (isDrop ? `每次只赚 +${rP}% 而亏就亏到 -${dP}% 以上，应把止盈幅度调大或加止损（如跌破成本 -${Math.max(3, Math.round(dP * 1.2))}% 强制离场）` : '盈利单平均太小，应让利润奔跑：改用移动止盈而非固定目标价')}。`]);
  else if (m.pf < 1.5) out.push(['warn', `盈利因子 ${m.pf.toFixed(2)} 勉强及格，扣掉滑点后优势可能消失。${isDrop ? `可尝试：①把买入阈值从跌 ${dP}% 放宽到跌 ${Math.round(dP * 1.4 * 10) / 10}%（买得更便宜）；②只在日线 MA20 上方做（趋势向上时做 T 成功率更高）。` : '可尝试：①只在指数/个股趋势向上时启用；②加成交量确认（放量金叉才入场）。'}`]);
  else out.push(['ok', `盈利因子 ${fmtPf(m.pf)} 表现不错，注意样本外验证：用未参与回测的时间段复核，避免过拟合。`]);
  if (m.mddPct < -20) out.push(['bad', `最大回撤 ${m.mddPct.toFixed(1)}% 过深。给策略加硬性止损（如入场价 -${Math.max(6, Math.round(Math.abs(m.mddPct) / 3))}%）或减半仓位，回撤可显著收窄。`]);
  if (stratKey === 'ma' && m.avgDays != null && m.avgDays < 8) out.push(['warn', `平均持仓仅 ${m.avgDays.toFixed(0)} 天，MA5×MA20 在震荡市会被反复打脸。改用 MA10×MA30 或加价格过滤（仅收盘价站上 MA60 时开仓）可减少假信号。`]);
  if (stratKey === 'rsi' && m.n < 4) out.push(['info', 'RSI 背离信号天然稀少。可将摆动点确认窗口从 3 根放宽到 2 根，或同时回测多只股累积样本。']);
  if (isDrop) {
    const roundTrip = (dP || 0) + (rP || 0);
    out.push(['info', `阈值拆解：每轮涨跌需覆盖约 ${roundTrip.toFixed(1)}% 的波动才成立，叠加双边费率约 0.26%，实际约 ${(roundTrip + 0.26).toFixed(2)}%。阈值得越密（幅度越小）交易越频繁、被手续费吃掉越多；越疏则单笔盈亏大但机会少。当前平均持仓 ${m.avgDays == null ? '--' : m.avgDays.toFixed(0) + ' 天'}，可用于判断是"高频薅小钱"还是"低频吃波段"。`]);
    if (m.avgDays != null && m.avgDays <= 3) out.push(['warn', `平均持仓仅 ${m.avgDays.toFixed(0)} 天，属于高频做 T：每次买卖双边成本约 0.26%，若单轮目标收益只有 ${roundTrip.toFixed(1)}%，手续费要吃掉约 1 成利润。阈值建议至少 4%~5% 起。`]);
  }
  if (m.ret != null && m.refRet != null && m.ret < m.refRet - 5) out.push(['warn', `策略收益 ${m.ret.toFixed(1)}% 跑输买入持有（${m.refRet.toFixed(1)}%）${Math.abs(m.ret - m.refRet).toFixed(1)} 个百分点——单边上涨市里择时策略常跑不过躺平，它的价值在熊市避险，可改为“趋势向上满仓、走弱半仓”而非全进全出。`]);
  if (isDrop && m.ret != null && m.refRet != null && m.refRet > 20 && m.ret > 0 && m.ret < m.refRet) out.push(['info', '该股回测区间是明显上涨行情：涨势中「跌买涨卖」会过早卖飞，收益天然弱于买入持有。这类策略更适合震荡市/宽幅整理股，可换一只横盘股再对比。']);
  if (m.pl != null && m.pl < 1) out.push(['bad', `盈亏比 ${m.pl.toFixed(2)} < 1：赚的比亏的单笔还小。建议止损设小（-5%）、止盈拉大（跟踪止盈），把盈亏比做到 1.5 以上。`]);
  if (m.winRate != null && m.winRate > 65 && m.pf != null && m.pf < 1.2) out.push(['warn', `胜率 ${m.winRate.toFixed(0)}% 很高但只赚小钱，典型的“捡钢镚”结构——一旦碰上大亏单会吐光利润，必须配大止损保护。`]);
  // 风控触发复盘：把"信号离场"和"风控离场"分开看，才知道加的纪律是帮忙还是添乱
  const sim = opt.sim;
  if (sim && sim.risk) {
    const tg = sim.triggers, rz = sim.risk;
    const total = tg.stop + tg.atr + tg.trail + tg.circuit;
    if (total === 0) {
      if (rz.stopPct || rz.atrK || rz.trailPct || rz.circuitPct) {
        out.push(['info', '设了风控但一次都没触发：说明回测区间里策略自己的离场信号总是先于风控生效。可以收紧阈值（如 ATR 倍数 3→2）再看最大回撤能否压得更小。']);
      }
    } else {
      if (tg.atr) out.push(['info', `ATR 跟踪止损触发 ${tg.atr} 次 —— 它把"趋势走坏"变成可执行纪律：亏单砍得快、赢单让它跑。这是最推荐先加的一项风控。`]);
      if (tg.stop) out.push(['warn', `固定止损触发 ${tg.stop} 次：固定幅度止损在震荡市里最容易被"扫损"（刚砍完就反弹）。对比一下换成 ATR 跟踪止损后的收益与回撤差异。`]);
      if (tg.trail) out.push(['info', `浮盈回撤止盈触发 ${tg.trail} 次：保住了利润，但也可能过早卖飞 —— 若总收益明显低于买入持有，说明阈值设得太紧。`]);
      if (tg.circuit) out.push(['info', `净值回撤熔断触发 ${tg.circuit} 次：熔断后剩余区间不再开仓，是"宁可少赚也不深亏"的取舍，用最大回撤有没有真收窄来判断值不值。`]);
    }
  }
  return out;
}

const BT_PERIOD_LABEL = { 22: '近1个月', 66: '近3个月', 120: '近半年', 250: '近一年', 500: '近两年', 750: '近三年' };
function btMonthsToLmt(months) { // 月数 → 交易日数
  const m = Math.max(1, Math.round(+months || 12));
  if (m <= 1) return 22;
  if (m <= 3) return 66;
  if (m <= 6) return 120;
  if (m <= 12) return 250;
  if (m <= 24) return 500;
  return 750;
}
function stockDisplayName(kname, code, optText) {
  return (kname && kname !== code && /[\u4e00-\u9fa5]/.test(kname) ? kname : null)
    || (optText ? String(optText).replace(/（.*）$/, '') : null)
    || (state.quotes[code] && state.quotes[code].name) || code;
}
// 回测纯计算核心（UI 与智能问答共用）
// opt: { dropPct, risePct, stopPct, atrK, trailPct, circuitPct }
async function computeBacktestCore(code, stratKey, lmt, opt) {
  opt = opt || {};
  const strat = BT_STRATS[stratKey] || BT_STRATS.ma;
  const isDrop = stratKey === 'drop' && strat.param;
  const dropPct = isDrop ? Math.min(50, Math.max(0.5, +opt.dropPct || 5)) : null;
  const risePct = isDrop ? Math.min(50, Math.max(0.5, +opt.risePct || 5)) : null;
  const risk = {
    stopPct: Math.max(0, Math.min(50, +opt.stopPct || 0)),
    atrK: Math.max(0, Math.min(10, +opt.atrK || 0)),
    trailPct: Math.max(0, Math.min(50, +opt.trailPct || 0)),
    circuitPct: Math.max(0, Math.min(80, +opt.circuitPct || 0)),
  };
  const riskParts = [];
  if (risk.stopPct > 0) riskParts.push('固定止损 −' + risk.stopPct + '%');
  if (risk.atrK > 0) riskParts.push('ATR ' + risk.atrK + ' 倍跟踪止损');
  if (risk.trailPct > 0) riskParts.push('浮盈回撤 ' + risk.trailPct + '% 止盈');
  if (risk.circuitPct > 0) riskParts.push('净值回撤 ' + risk.circuitPct + '% 熔断');
  const riskDesc = riskParts.length ? riskParts.join(' ＋ ') : '无（纯策略信号，不加风控）';
  const stratLabel = isDrop ? `跌买涨卖：跌 ${dropPct}% 买入 / 涨 ${risePct}% 卖出` : strat.label;
  const stratDesc = isDrop
    ? `空仓时以锚价为参照（锚价只在上涨方向跟随、不随下跌下移），收盘价自锚价回落达 ${dropPct}% 买入；持仓后自买入价上涨达 ${risePct}% 卖出，每轮完成后重新锚定（信号当日收盘成交）`
    : strat.desc;
  const periodLabel = BT_PERIOD_LABEL[lmt] || (lmt + '日');
  const { bars, name: kname } = await fetchKline(code, 101, lmt + 160);
  if (bars.length < 60) throw new Error('历史 K 线不足，无法回测');
  const startIdx = Math.max(60, bars.length - lmt);
  const sig = isDrop ? btSignalsDrop(bars, dropPct, risePct) : strat.gen(bars);
  const sim = btSimulate(bars, sig, startIdx, isDrop ? 'close' : 'nextOpen', risk);
  const m = btMetrics(sim);
  const sugg = btSuggestions(m, stratKey, { dropPct, risePct, sim: sim });
  return { code, stratKey, stratLabel, stratDesc, riskDesc, risk, periodLabel, m, sim, sugg, kname,
    btBars: bars.slice(startIdx), dropPct, risePct };
}

function btReadOpts() {
  const v = function (id) { const el = document.getElementById(id); return el ? el.value : ''; };
  return {
    dropPct: v('btDropPct') || 5, risePct: v('btRisePct') || 5,
    stopPct: v('btStopPct') || 0, atrK: v('btAtrK') || 0,
    trailPct: v('btTrailPct') || 0, circuitPct: v('btCircuitPct') || 0,
  };
}

async function runBacktest() {
  const sel = document.getElementById('btStock');
  const code = sel.value;
  const box = document.getElementById('btBox');
  const btn = document.getElementById('btRunBtn');
  if (!code) return toast('请先在持仓或自选股中添加股票');
  const stratKey = document.getElementById('btStrat').value;
  const lmt = +document.getElementById('btPeriod').value;
  const opt = btReadOpts();
  btn.disabled = true; btn.textContent = '回测中…';
  box.innerHTML = '<div class="empty-tip">⏳ 正在拉取历史 K 线并模拟交易…</div>';
  try {
    const t = await computeBacktestCore(code, stratKey, lmt, opt);
    const selOpt = sel.selectedOptions && sel.selectedOptions[0];
    const name = stockDisplayName(t.kname, code, selOpt ? selOpt.textContent : null);
    const m = t.m;
    const fmtPct = v => v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(1) + '%';
    const fmtMoney = v => (v > 0 ? '+' : '') + v.toFixed(0);
    state.bt = { code, name, stratKey, stratLabel: t.stratLabel, periodLabel: t.periodLabel, m, sim: t.sim, sugg: t.sugg, ai: null };
    const tg = t.sim.triggers;
    const trigLine = '<div class="bt-trig">🛡️ 风控：<b>' + esc(t.riskDesc) + '</b>　'
      + '止损 ' + tg.stop + ' 次 · ATR ' + tg.atr + ' 次 · 移动止盈 ' + tg.trail + ' 次 · 熔断 ' + tg.circuit + ' 次 · 策略信号 ' + tg.signal + ' 次'
      + (t.sim.halted ? '　<span class="li-warn">已触发熔断：剩余区间空仓</span>' : '') + '</div>';
    box.innerHTML = `
      <div class="risk-stats">
        <div class="risk-stat"><div class="v ${m.ret > 0 ? 'ok' : m.ret < 0 ? 'warn' : ''}">${fmtPct(m.ret)}</div><div class="k">策略总收益</div></div>
        <div class="risk-stat"><div class="v">${fmtPct(m.refRet)}</div><div class="k">买入持有对比</div></div>
        <div class="risk-stat"><div class="v">${m.winRate == null ? '--' : m.winRate.toFixed(0) + '%'}</div><div class="k">成功率（${m.n} 笔）</div></div>
        <div class="risk-stat"><div class="v ${m.pf != null && m.pf >= 1.5 ? 'ok' : m.pf != null && m.pf < 1 ? 'warn' : ''}">${fmtPf(m.pf)}</div><div class="k">盈利因子</div></div>
        <div class="risk-stat"><div class="v ${m.mddPct < -20 ? 'warn' : ''}">${m.mddPct.toFixed(1)}%</div><div class="k">最大回撤（持有 ${m.refMddPct.toFixed(1)}%）</div></div>
        <div class="risk-stat"><div class="v">${m.avgDays == null ? '--' : m.avgDays.toFixed(0) + ' 天'}</div><div class="k">平均持仓</div></div>
      </div>
      <div class="bt-eq-block"><h4>策略净值 vs 买入持有（起始 10 万） + 日 K 买卖点（<span style="color:#d03030">B 进场</span> / <span style="color:#0a9d4e">S 出场</span>）· 左轴价格 / 右轴净值</h4><canvas id="btCombCv" style="height:340px"></canvas></div>
      ${trigLine}
      ${t.sim.trades.length || t.sim.open ? `
      <div class="tbl-wrap" style="margin-top:14px"><table>
        <thead><tr><th>进场日</th><th>进场价</th><th>出场日</th><th>出场价</th><th>股数</th><th>盈亏</th><th>收益率</th><th>持有</th><th>离场原因</th></tr></thead>
        <tbody>${[...t.sim.trades, ...(t.sim.open ? [t.sim.open] : [])].map(x => `
          <tr><td>${x.inD}</td><td>${x.inP.toFixed(2)}</td><td>${x.open ? '<span class="li-warn">持仓中</span>' : x.outD}</td><td>${x.outP.toFixed(2)}</td><td>${x.qty}</td>
          <td class="${x.pnl > 0 ? 'r-bull' : 'r-bear'}">${fmtMoney(x.pnl)}</td>
          <td class="${x.pnl > 0 ? 'r-bull' : 'r-bear'}">${fmtPct(x.pnlPct)}</td><td>${x.days}天</td>
          <td>${esc(x.why || (x.open ? '持仓中' : '策略信号'))}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty-tip" style="margin-top:12px">该周期内策略没有产生任何交易信号</div>'}
      <div class="tech-reason" style="margin-top:14px"><h4>🔧 改进建议（规则引擎）</h4><ul>${t.sugg.map(s => `<li class="${s[0] === 'bad' ? 'li-bad' : s[0] === 'warn' ? 'li-warn' : 'li-info'}">${s[0] === 'bad' ? '🔴' : s[0] === 'warn' ? '🟡' : '🟢'} ${esc(s[1])}</li>`).join('')}</ul></div>
      <div class="tech-ai">
        <button id="btAiBtn" class="btn primary">🤖 AI 优化建议</button>
        <button id="btSaveBtn" class="btn ghost">💾 保存报告</button>
        <div id="btAiOut" class="tech-ai-out" hidden></div>
      </div>`;
    drawBtCombinedChart(document.getElementById('btCombCv'), t.btBars, t.sim.equity, [...t.sim.trades, ...(t.sim.open ? [t.sim.open] : [])]);
    document.getElementById('btAiBtn').onclick = runBtAi;
    document.getElementById('btSaveBtn').onclick = saveBtReport;
  } catch (e) {
    box.innerHTML = `<div class="empty-tip">${esc(e && e.message || '回测失败，请重试')}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '开始回测';
  }
}

/* ---- 多股横截面排名：同一策略 + 同一风控，跑一遍自选 + 持仓再排序对比 ---- */
async function runBtBasket() {
  const box = document.getElementById('btBox');
  const btn = document.getElementById('btBasketBtn');
  const codes = [...new Set([
    ...computePositions().map(function (p) { return p.code; }),
    ...state.watch.map(function (w) { return w.stock_code; }),
  ].filter(function (c) { return /^\d{6}$/.test(String(c)); }))];
  if (!codes.length) return toast('自选股和持仓都是空的，先加几只股票');
  if (codes.length > 40) return toast('一次最多对比 40 只（当前 ' + codes.length + ' 只），请先精简自选股');
  const stratKey = document.getElementById('btStrat').value;
  const lmt = +document.getElementById('btPeriod').value;
  const opt = btReadOpts();
  const key = (document.getElementById('btBasketKey') || {}).value || 'ret';
  const strat = BT_STRATS[stratKey] || BT_STRATS.ma;
  if (btn) { btn.disabled = true; btn.textContent = '对比中…'; }
  box.innerHTML = '<div class="empty-tip">⏳ 正在逐只回测 ' + codes.length + ' 只…</div>';
  try {
    const rows = [];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      box.innerHTML = '<div class="empty-tip">⏳ 正在逐只回测 ' + (i + 1) + ' / ' + codes.length + ' …</div>';
      let t = null;
      try { t = await computeBacktestCore(c, stratKey, lmt, opt); } catch (e) { /* 单只失败不影响整批 */ }
      if (!t) { rows.push({ code: c, name: stockDisplayName(null, c, null), fail: true }); continue; }
      rows.push({ code: c, name: stockDisplayName(t.kname, c, null), fail: false, m: t.m, t: t });
    }
    const sortVal = function (r) {
      if (r.fail || !r.m) return null;
      const m = r.m;
      if (key === 'pf') return m.pf == null ? -1 : m.pf;
      if (key === 'mdd') return m.mddPct;                 // 回撤：越接近 0 越好（降序=最浅的在前）
      if (key === 'wr') return m.winRate == null ? -1 : m.winRate;
      return m.ret;
    };
    rows.sort(function (a, b) {
      const av = sortVal(a), bv = sortVal(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return bv - av;
    });
    const okN = rows.filter(function (r) { return !r.fail; }).length;
    const fmtPct = function (v) { return v == null ? '--' : (v > 0 ? '+' : '') + v.toFixed(1) + '%'; };
    const body = rows.map(function (r, i) {
      if (r.fail) return '<tr><td>' + (i + 1) + '</td><td>' + r.code + '</td><td>' + esc(r.name) + '</td><td colspan="8">K 线取数失败，已跳过</td></tr>';
      const m = r.m, tg = r.t.sim.triggers;
      return '<tr data-btcode="' + r.code + '" style="cursor:pointer">'
        + '<td>' + (i + 1) + '</td><td>' + r.code + '</td><td>' + esc(dispStockName(r.code, r.name)) + '</td>'
        + '<td class="' + (m.ret > 0 ? 'r-bull' : 'r-bear') + '">' + fmtPct(m.ret) + '</td>'
        + '<td>' + fmtPct(m.refRet) + '</td>'
        + '<td>' + (m.winRate == null ? '--' : m.winRate.toFixed(0) + '%') + '</td>'
        + '<td>' + fmtPf(m.pf) + '</td>'
        + '<td>' + m.mddPct.toFixed(1) + '%</td>'
        + '<td>' + m.n + '</td>'
        + '<td>' + (m.avgDays == null ? '--' : m.avgDays.toFixed(0) + ' 天') + '</td>'
        + '<td>' + tg.stop + '/' + tg.atr + '/' + tg.trail + '/' + tg.circuit + '</td>'
        + '</tr>';
    }).join('');
    const keyLabel = { ret: '策略总收益', pf: '盈利因子', mdd: '最大回撤（越浅越好）', wr: '成功率' }[key];
    box.innerHTML = '<div class="form-tip">策略：<b>' + esc(strat.label) + '</b>　周期：' + BT_PERIOD_LABEL[lmt]
      + '　风控：<b>' + esc(rows.find(function (r) { return !r.fail; }) ? rows.find(function (r) { return !r.fail; }).t.riskDesc : '无') + '</b>'
      + '　共 ' + okN + ' / ' + codes.length + ' 只回测成功，按「' + keyLabel + '」降序 | 点任意一行看单只详情</div>'
      + '<div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th>#</th><th>代码</th><th>名称</th><th>策略收益</th><th>买入持有</th><th>成功率</th><th>盈利因子</th><th>最大回撤</th><th>笔数</th><th>平均持仓</th><th>止损/ATR/止盈/熔断</th></tr></thead><tbody>'
      + body + '</tbody></table></div>';
    box.querySelectorAll('tr[data-btcode]').forEach(function (tr) {
      tr.onclick = function () {
        const sel = document.getElementById('btStock');
        if (sel) { sel.value = tr.getAttribute('data-btcode'); }
        runBacktest();
      };
    });
  } catch (e) {
    box.innerHTML = '<div class="empty-tip">' + esc(e && e.message || '批量回测失败') + '</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📊 批量对比自选 + 持仓'; }
  }
}

// 合并图：日 K + 买卖点（左轴价格） 叠加 策略净值/买入持有（右轴净值），横轴同一批交易日
function drawBtCombinedChart(cv, bars, equity, trades) {
  if (!cv || !bars || !bars.length || !equity || !equity.length) return;
  cv.__bt = { bars, equity, trades };
  paintBtComb(cv, -1);
  if (!cv.__btHoverInit) {
    cv.__btHoverInit = true;
    cv.style.cursor = 'crosshair';
    cv.addEventListener('mousemove', e => {
      const d = cv.__bt; if (!d || !d.bars.length) return;
      const rect = cv.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (cv.clientWidth / rect.width);
      const i = Math.floor((mx - 50) / ((cv.clientWidth - 50 - 48) / d.bars.length));
      if (i >= 0 && i < d.bars.length && i !== cv.__btHoverI) { cv.__btHoverI = i; paintBtComb(cv, i); }
    });
    cv.addEventListener('mouseleave', () => { cv.__btHoverI = -1; paintBtComb(cv, -1); });
  }
}

// 重绘合并图（hoverI>=0 时叠加十字光标与数据提示框）
function paintBtComb(cv, hoverI) {
  const { bars, equity, trades } = cv.__bt;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 600, H = cv.clientHeight || 340;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 50, r: 48, t: 22, b: 22 };
  const markerH = 18; // 价格区上下留给 B/S 标记
  // 左轴：价格范围
  let plo = Infinity, phi = -Infinity;
  for (const b of bars) { plo = Math.min(plo, b.l); phi = Math.max(phi, b.h); }
  const pspan = (phi - plo) || 1; plo -= pspan * 0.04; phi += pspan * 0.04;
  // 右轴：净值范围
  const evals = equity.flatMap(e => [e.v, e.ref]);
  let elo = Math.min(...evals), ehi = Math.max(...evals);
  const espan = (ehi - elo) || 1; elo -= espan * 0.06; ehi += espan * 0.06;
  const cw = (W - pad.l - pad.r) / bars.length;
  const xc = i => pad.l + cw * (i + 0.5);
  const py = v => pad.t + markerH + (H - pad.t - pad.b - 2 * markerH) * (1 - (v - plo) / (phi - plo));
  const ey = v => pad.t + (H - pad.t - pad.b) * (1 - (v - elo) / (ehi - elo));
  // 网格 + 双轴刻度
  ctx.font = '10px sans-serif';
  for (let g = 0; g <= 4; g++) {
    const yy = pad.t + (H - pad.t - pad.b) * g / 4;
    ctx.strokeStyle = '#eef1f5'; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    const pv = phi - (phi - plo) * g / 4, ev = ehi - (ehi - elo) * g / 4;
    ctx.textAlign = 'right'; ctx.fillStyle = '#8a94a6'; ctx.fillText(pv.toFixed(2), pad.l - 6, yy + 3); // 左轴：价格
    ctx.textAlign = 'left'; ctx.fillStyle = '#5b6b85'; ctx.fillText((ev / 10000).toFixed(1) + '万', W - pad.r + 5, yy + 3); // 右轴：净值
  }
  // 蜡烛：阳线红（浅红填充）、阴线绿
  const bodyW = Math.max(1, Math.min(10, cw * 0.7));
  bars.forEach((b, i) => {
    const up = b.c >= b.o, col = up ? '#d03030' : '#0a9d4e';
    ctx.strokeStyle = col; ctx.fillStyle = up ? '#fdecec' : '#e5f5ec'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xc(i), py(b.h)); ctx.lineTo(xc(i), py(b.l)); ctx.stroke();
    const yO = py(b.o), yC = py(b.c);
    const top = Math.min(yO, yC), hgt = Math.max(1, Math.abs(yC - yO));
    ctx.fillRect(xc(i) - bodyW / 2, top, bodyW, hgt);
    ctx.strokeRect(xc(i) - bodyW / 2, top, bodyW, hgt);
  });
  // 净值线：买入持有（灰）+ 策略净值（蓝），x 与蜡烛中心对齐
  const line = (key, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
    equity.forEach((e, i) => i ? ctx.lineTo(xc(i), ey(e[key])) : ctx.moveTo(xc(0), ey(e[key])));
    ctx.stroke();
  };
  line('ref', 'rgba(176,184,196,0.9)');
  line('v', '#1a66ff');
  // B/S 标记：B 在 K 线下方▲红，S 在上方▼绿
  const idxOf = d => bars.findIndex(b => b.d === d);
  ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
  for (const t of trades || []) {
    const bi = idxOf(t.inD);
    if (bi >= 0) {
      const bx = xc(bi), by = py(bars[bi].l) + 12;
      ctx.fillStyle = '#d03030';
      ctx.beginPath(); ctx.moveTo(bx, by - 7); ctx.lineTo(bx - 4, by); ctx.lineTo(bx + 4, by); ctx.closePath(); ctx.fill();
      ctx.fillText('B', bx, by + 9);
    }
    if (!t.open && t.outD) {
      const si = idxOf(t.outD);
      if (si >= 0) {
        const sx = xc(si), sy = py(bars[si].h) - 5;
        ctx.fillStyle = '#0a9d4e';
        ctx.beginPath(); ctx.moveTo(sx, sy + 7); ctx.lineTo(sx - 4, sy); ctx.lineTo(sx + 4, sy); ctx.closePath(); ctx.fill();
        ctx.fillText('S', sx, sy - 3);
      }
    }
  }
  // 图例（顶部一行）
  ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
  const legY = pad.t - 8;
  ctx.strokeStyle = '#1a66ff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(pad.l + 6, legY - 3); ctx.lineTo(pad.l + 24, legY - 3); ctx.stroke();
  ctx.fillStyle = '#444'; ctx.fillText('策略净值(右轴)', pad.l + 28, legY);
  ctx.strokeStyle = '#b0b8c4'; ctx.beginPath(); ctx.moveTo(pad.l + 112, legY - 3); ctx.lineTo(pad.l + 130, legY - 3); ctx.stroke();
  ctx.fillStyle = '#444'; ctx.fillText('买入持有(右轴)', pad.l + 134, legY);
  ctx.fillStyle = '#d03030'; ctx.fillText('▲B', pad.l + 218, legY);
  ctx.fillStyle = '#0a9d4e'; ctx.fillText('▼S', pad.l + 244, legY);
  // 日期刻度
  ctx.fillStyle = '#8a94a6'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
  const step = Math.max(1, Math.floor(bars.length / 6));
  for (let i = 0; i < bars.length; i += step) ctx.fillText(bars[i].d.slice(2), xc(i), H - 6);
  // 悬停：十字光标 + 数据提示框
  if (hoverI >= 0 && hoverI < bars.length) {
    const cx = xc(hoverI), ev = equity[hoverI] || {}, b = bars[hoverI];
    ctx.save();
    ctx.strokeStyle = '#9aa7ba'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(cx, pad.t); ctx.lineTo(cx, H - pad.b); ctx.stroke();
    ctx.setLineDash([]);
    // 收盘价与双净值点标记
    [[py(b.c), '#d03030'], [ey(ev.v), '#1a66ff'], [ey(ev.ref), '#8a94a6']].forEach(([yy, col]) => {
      if (yy == null || isNaN(yy)) return;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, yy, 3, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
    });
    // 提示框（跟随光标，靠近右缘时左翻）
    const v0 = equity[0].v || 1, r0 = equity[0].ref || 1;
    const rows = [
      ['日期', b.d],
      ['收盘', fmtD(b.c)],
      ['策略净值', (ev.v / 10000).toFixed(2) + '万（' + (ev.v / v0 - 1 > 0 ? '+' : '') + ((ev.v / v0 - 1) * 100).toFixed(1) + '%）'],
      ['买入持有', (ev.ref / 10000).toFixed(2) + '万（' + (ev.ref / r0 - 1 > 0 ? '+' : '') + ((ev.ref / r0 - 1) * 100).toFixed(1) + '%）'],
    ];
    ctx.font = '11px sans-serif';
    const bw = 168, bh = rows.length * 16 + 8;
    let bx2 = cx + 12; if (bx2 + bw > W - 4) bx2 = cx - bw - 12;
    bx2 = Math.max(4, Math.min(bx2, W - bw - 4)); // 左右都钳制在画布内
    const by2 = pad.t + 2;
    ctx.fillStyle = 'rgba(255,255,255,0.96)'; ctx.strokeStyle = '#c9d2de'; ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx2, by2, bw, bh, 6); else ctx.rect(bx2, by2, bw, bh);
    ctx.fill(); ctx.stroke();
    rows.forEach((r, k) => {
      const yy = by2 + 18 + k * 16;
      ctx.fillStyle = '#8a94a6'; ctx.textAlign = 'left'; ctx.fillText(r[0], bx2 + 8, yy);
      ctx.fillStyle = '#333'; ctx.textAlign = 'right'; ctx.fillText(r[1], bx2 + bw - 8, yy);
    });
    ctx.restore();
  }
}

async function runBtAi() {
  const t = state.bt;
  if (!t) return;
  const btn = document.getElementById('btAiBtn'), out = document.getElementById('btAiOut');
  btn.disabled = true; btn.textContent = 'AI 分析中…'; out.hidden = false; out.textContent = '生成中…';
  const m = t.m;
  const trades = t.sim.trades.slice(-15).map(x =>
    `${x.inD} 买@${x.inP.toFixed(2)} → ${x.outD} 卖@${x.outP.toFixed(2)} 持有${x.days}天 ${x.pnlPct > 0 ? '+' : ''}${x.pnlPct.toFixed(1)}%`).join('\n');
  try {
    let text = '';
    await llmComplete([
      { role: 'system', content: '你是量化策略教练。基于回测结果用简体中文纯文本输出改进建议：先一句话评价策略与该股的匹配度，再给 3-4 条具体可执行的优化方案（每条含具体参数，如止损幅度、均线周期、过滤条件），最后提醒一个该策略最常见的失效场景。350 字内，不复读数据。' },
      { role: 'user', content: `股票：${t.name}（${t.code}），策略：${t.stratLabel}（${t.stratLabel ? BT_STRATS[t.stratKey].desc : ''}），区间：${t.periodLabel}\n统计：交易 ${m.n} 笔，成功率 ${m.winRate == null ? '--' : m.winRate.toFixed(0) + '%'}，盈利因子 ${fmtPf(m.pf)}，盈亏比 ${m.pl == null ? '--' : m.pl.toFixed(2)}，总收益 ${(m.ret > 0 ? '+' : '') + m.ret.toFixed(1) + '%'}（买入持有 ${(m.refRet > 0 ? '+' : '') + m.refRet.toFixed(1) + '%'}），最大回撤 ${m.mddPct.toFixed(1)}%（买入持有 ${m.refMddPct.toFixed(1)}%），平均持仓 ${m.avgDays == null ? '--' : m.avgDays.toFixed(0) + ' 天'}\n规则引擎建议：\n${t.sugg.map(s => s[1]).join('\n')}\n\n最近交易明细：\n${trades || '（无平仓交易）'}\n\n请输出优化建议。` },
    ], { onDelta: (delta) => { text += delta; out.textContent = text; } });
    t.ai = text;
    out.textContent = text || '（无输出）';
  } catch (e) {
    out.textContent = 'AI 分析失败：' + (e && e.message || e);
  } finally {
    btn.disabled = false; btn.textContent = '🤖 AI 优化建议';
  }
}

async function saveBtReport() {
  const t = state.bt;
  if (!t) return;
  const m = t.m;
  const content = [
    `策略：${t.stratLabel}，区间：${t.periodLabel}`,
    `交易 ${m.n} 笔，成功率 ${m.winRate == null ? '--' : m.winRate.toFixed(0) + '%'}，盈利因子 ${fmtPf(m.pf)}，盈亏比 ${m.pl == null ? '--' : m.pl.toFixed(2)}`,
    `总收益 ${(m.ret > 0 ? '+' : '') + m.ret.toFixed(1) + '%'}（买入持有 ${(m.refRet > 0 ? '+' : '') + m.refRet.toFixed(1) + '%'}），最大回撤 ${m.mddPct.toFixed(1)}%`,
    '', '【改进建议】', ...t.sugg.map(s => (s[0] === 'bad' ? '🔴 ' : s[0] === 'warn' ? '🟡 ' : '🟢 ') + s[1]),
    t.ai ? '\n【AI 优化建议】\n' + t.ai : '',
  ].join('\n');
  try {
    await api('app_insert', {
      p_table: 'analyses',
      p_data: {
        kind: 'bt', stock_code: t.code, stock_name: t.name,
        title: `策略回测：${t.stratLabel} · ${t.name}（${t.periodLabel}）`, content,
        score: m.pf != null && isFinite(m.pf) ? Math.round(m.pf * 100) : 0,
        summary: `成功率 ${m.winRate == null ? '--' : m.winRate.toFixed(0) + '%'} · 盈利因子 ${fmtPf(m.pf)} · 收益 ${(m.ret > 0 ? '+' : '') + m.ret.toFixed(1) + '%'}`,
      },
    });
    await reloadAnalyses(); renderAnalyses();
    toast('回测报告已保存到分析历史');
  } catch (e) { toast(e.message || '保存失败'); }
}

const KIND_LABEL = { stock: ['个股诊断', 'k-diag'], batch: ['批量诊断', 'k-diag'], behavior: ['行为评分', 'k-behavior'], stage: ['阶段总结', 'k-stage'], tech: ['技术分析', 'k-stock'], risk: ['风险分析', 'k-behavior'], review: ['操作复盘', 'k-behavior'], bt: ['策略回测', 'k-stock'] };

/* ---------------- 模块初始化（事件绑定） ---------------- */
(function initAnalysisExtra() {
  document.querySelectorAll('#anTabs .an-tab').forEach(b => b.onclick = () => switchAnalysisTab(b.dataset.an));
  try { renderBtOptions(); } catch (e) { /* */ }
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('riskRunBtn', runRiskAnalysis);
  on('reviewRunBtn', runTradeReview);
  on('behaviorBtn', analyzeBehavior);
  on('stageBtn', analyzeStage);
  on('btRunBtn', runBacktest);
  on('btBasketBtn', runBtBasket);
  on('batchDiagBtn', () => runBatchDiagnose());
  on('momRunBtn', runMomentumScan);   // v3.8.74 动量筛选（手动触发，不自动跑）
  /* v3.12.3 快捷预设：一键填条件（volK=0 表示不检查量能，纯排名） */
  [
    ['momPreset1', { n: 3, topN: 1000, volK: 1.1, amt: 0.5 }],
    ['momPreset2', { n: 5, topN: 1000, volK: 0, amt: 0 }],
    ['momPreset3', { n: 5, topN: 2000, volK: 0, amt: 0 }],
  ].forEach(([id, p]) => {
    on(id, () => {
      document.getElementById('momN').value = p.n;
      document.getElementById('momTopN').value = p.topN;
      document.getElementById('momVolK').value = p.volK;
      document.getElementById('momAmt').value = p.amt;
    });
  });
  /* v3.10.0 K 线库状态行 + 手动同步按钮（进场时显示缓存状态，不自动联网） */
  (function initMomKlib() {
    const el = document.getElementById('momKlibStatus');
    if (el && typeof KLib !== 'undefined') {
      KLib.statusLine().then(s => { el.textContent = '💾 ' + s.txt; }).catch(() => { el.textContent = '💾 K 线库状态未知（IndexedDB 不可用？）'; });
    }
    on('momSyncBtn', async () => {
      if (typeof KLib === 'undefined') return toast('K 线库模块未加载');
      const btn = document.getElementById('momSyncBtn'), st2 = document.getElementById('momKlibStatus');
      btn.disabled = true; btn.textContent = '⏳ 同步中…';
      try {
        const r = await KLib.ensure(p => { if (st2) st2.textContent = '💾 ' + p.stage; });
        if (st2) st2.textContent = '💾 本机 ' + r.n + ' 只 · 最新 ' + r.targetDate + (r.failed ? ' · 失败 ' + r.failed + ' 只' : '');
        toast('K 线库已同步：' + r.n + ' 只');
      } catch (e) {
        if (st2) st2.textContent = '💾 同步失败：' + (e && e.message || e);
        toast('K 线库同步失败：' + (e && e.message || e));
      }
      btn.disabled = false; btn.textContent = '🔄 同步K线库';
    });
  })();
  on('heatRefreshBtn', () => refreshHeat(true));
  on('profileRunBtn', () => { renderProfileView(true); });
  const btStrat = document.getElementById('btStrat');
  if (btStrat) btStrat.onchange = () => {
    const w = document.getElementById('btDropWrap');
    if (w) w.hidden = btStrat.value !== 'drop';
  };
  window.addEventListener('resize', () => {
    clearTimeout(_axResizeTimer);
    _axResizeTimer = setTimeout(() => {
      try { if (anTab === 'bt' && state.bt && state.bt.bars) paintBtComb(document.getElementById('btCombCv'), null); } catch (e) { /* */ }
    }, 180);
  });
})();
let _axResizeTimer = 0;

/* ============================================================
   v3.8.74 动量筛选：连续强势 + 量能递增（候选池生成器）
   用户需求：统计两市「涨幅连续 N 天都排在前 M 名、且成交量连续放大」的票。

   ⚠ 数据口径与局限（实测确认，界面上也要如实标注）
     · 腾讯的「涨幅榜」接口只提供**当日**快照，拿不到历史日的全市场名次。
     · 因此：**当日名次 = 榜单真实名次**（准确）；前 N-1 日名次 =
       用日K算出的当日涨幅在候选池内排序、再按池子规模折算到全市场（**近似值**）。
       界面会标注「历史名次为估算」，不让人误以为是精确的全市场排名。
     · 数据源（2026-10-14 实测）：
        榜单 proxy.finance.qq.com .../getBoardRankList  sort_type=priceChange
             → 每页最多 200 条，按涨跌额排序（涨幅榜）；count>200 报「count too large」
        行情 qt.gtimg.cn 批量（fetchQuotesTencent，每批 80 只）→ 全市场快照（qSnapshot）
        日K  web.ifzq.gtimg.cn .../newfqkline  → 逐日涨幅 + 逐日成交量（fetchKline）

   筛选条件（MOM 里可调）
     · 连续 N 日（默认 3）每日涨幅 > 0  ← 绝对门槛，必须有
     · 这 N 日名次都在前 M 名（默认 1000）
     · 成交量逐日递增且后一日 ≥ 前一日 × K（默认 1.1）
     · 排除 ST / *ST、北交所、停牌；成交额 ≥ 下限（默认 0.5 亿）
   为什么必须有「涨幅 > 0」：实测 2026-10-14 普跌日，涨幅榜第 1000 名是 0.00%，
   若只按名次筛，会捞出一堆平盘/微跌的票，没有动量意义。加绝对门槛后，
   普跌日命中数自然收缩 —— 这本身就是「普跌中还连涨放量」的有效信号。

   耗时：全市场快照约 10-15s（命中 60s 缓存后为 0）；候选池逐只取日K约 3-6s。
   ============================================================ */
const MOM = {
  n: 3,             // 连续天数
  topN: 1000,       // 名次门槛
  volK: 1.1,        // 量能倍数门槛
  minAmount: 0.5,   // 成交额下限（单位：亿元，与 fetchQuotesTencent 的 amount 同一口径）
  concurrency: 8,   // 日K并发
};
const momState = { running: false, stage: '', done: 0, total: 0, items: [], at: '', err: '', approx: false };

/* ST / 退市整理 / 北交所：波动规则与流动性和沪深主板差异大，统一排除 */
function momExcluded(code, name) {
  if (/^(4|8|9)/.test(code)) return true;              // 北交所（4xx/8xx/9xx 开头，与 inferMarket 同口径）
  return /ST|退/.test(String(name || ''));
}
function momCapTxt(v) {
  if (v == null || !isFinite(v)) return '--';
  return v >= 1e4 ? (v / 1e4).toFixed(2) + '万亿' : v.toFixed(0) + '亿';
}
/* 成交额：入参单位是「亿元」（fetchQuotesTencent 里 amtWan/1e4 的结果，与热度页同一口径）。
   注意别写成「万」—— v3.8.74 初版就踩过这个坑，导致门槛值 5000 实际等于 5000 亿，全军覆没。 */
function momAmtTxt(yi) {
  if (yi == null || !isFinite(yi)) return '--';
  return yi >= 1 ? yi.toFixed(yi >= 100 ? 0 : 1) + '亿' : (yi * 1e4).toFixed(0) + '万';
}

/* 第 1 步：涨幅榜前 topN 名（真实当日名次）。
   返回 Map(code -> rank)。
   ⚠ 该接口只给当日快照，所以只有最后一日能拿到「精确名次」，历史日只能估算。 */
async function momTopRanked(topN) {
  const out = new Map();
  const page = 200;                              // 接口上限（超过报 count too large）
  for (let off = 0; off < topN; off += page) {
    const cnt = Math.min(page, topN - off);
    const url = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList'
      + '?_appver=11.17.0&board_code=aStock&sort_type=priceChange&direct=down'
      + '&offset=' + off + '&count=' + cnt;
    let j;
    try { j = await (await fetch(url)).json(); }
    catch (e) { NetLog.push('quote', '腾讯涨幅榜', false, 0, 'offset=' + off + ' ' + (e.message || e)); break; }
    const list = (j && j.data && j.data.rank_list) || [];
    if (!list.length) break;
    list.forEach((it, i) => {
      const c = String(it.code || '').replace(/^(sh|sz|bj)/, '');
      if (/^\d{6}$/.test(c)) out.set(c, off + i + 1);
    });
    if (list.length < cnt) break;
  }
  return out;
}

/* 第 2 步：候选池（涨幅榜前 topN 里的沪深非 ST 票）→ 用全市场快照补市值/成交额/名称 */
async function momPool(rankMap) {
  const snap = await qSnapshot();               // 全市场快照（60s 缓存，复用热度页那次拉取）
  const rows = [];
  for (const c of rankMap.keys()) {
    const q = snap.map[c];
    if (!q || !(q.price > 0)) continue;
    if (momExcluded(c, q.name)) continue;
    if (!(q.amount > 0)) continue;              // 停牌 / 无成交
    if (q.amount < MOM.minAmount) continue;     // 流动性下限
    rows.push(q);
  }
  return { rows: rows, snapTotal: Object.keys(snap.map).length };
}

/* 第 3 步：逐只取日K，算逐日涨幅与成交量 */
async function momOne(q) {
  const need = MOM.n + 2;
  const k = await fetchKline(q.code, 101, need);
  const bars = (k && k.bars) || [];
  if (bars.length < MOM.n + 1) throw new Error('K线不足');
  const b = bars.slice(-(MOM.n + 1));           // b[0] 是 N 日前的收盘（基准）
  const days = [];
  for (let i = 1; i <= MOM.n; i++) {
    const prev = b[i - 1].c, cur = b[i].c;
    days.push({ d: b[i].d, pct: prev > 0 ? (cur / prev - 1) * 100 : 0, v: b[i].v });
  }
  const base = b[0].c, last = b[b.length - 1].c;
  return {
    code: q.code, name: q.name, price: q.price, amount: q.amount, totalCap: q.totalCap,
    days: days, cum: base > 0 ? (last / base - 1) * 100 : 0,
  };
}

/* 第 4 步：判定 + 折算历史名次 */
function momJudge(it, pool, rankMap) {
  const n = it.days.length;
  /* ① 每日绝对涨幅 > 0（没有这条，普跌日会把「跌得少」的票当强势票捞出来） */
  for (let i = 0; i < n; i++) if (!(it.days[i].pct > 0)) return null;
  /* ② 名次：当日用榜单真实名次；历史日按「池内排名 × 全市场/池子 规模」折算近似 */
  const totalMkt = 5574;                        // 全市场股票数（榜单 total 实测值）
  const scale = totalMkt / Math.max(pool.length, 1);
  for (let i = 0; i < n; i++) {
    const d = it.days[i];
    const isToday = (i === n - 1);
    if (isToday && rankMap.has(it.code)) {
      d.rank = rankMap.get(it.code);
      d.rankExact = true;
    } else {
      let better = 0;
      for (const x of pool) {
        const xd = x.days && x.days[i];
        if (xd && xd.pct > d.pct) better++;
      }
      d.rank = Math.max(1, Math.round((better + 1) * scale));
      d.rankExact = false;
    }
    if (d.rank > MOM.topN) return null;
  }
  /* ③ 量能：逐日递增且后一日 ≥ 前一日 × volK */
  for (let i = 1; i < n; i++) if (!(it.days[i].v >= it.days[i - 1].v * MOM.volK)) return null;
  const v0 = it.days[0].v, vz = it.days[n - 1].v;
  it.volRatio = v0 > 0 ? vz / v0 : 0;
  return it;
}

/* ============================================================
   v3.10.0 本地全市场精确计算 —— K 线库（KLib）就绪后走这条路径
   ------------------------------------------------------------
   与旧在线流程的本质区别：历史名次不再估算。每天对全市场逐日排序，
   「连续 N 日都在前 M 名」是 100% 精确的复算结果（旧流程只有当日是真实的）。
   纯函数、不吃 IO，方便测试台直接验。
   ============================================================ */
/* 默认条件：新条件（RPS/新高/均线）默认关闭，默认行为 = 旧版严格化（名次变精确） */
const momOpts = { n: 3, topN: 1000, volK: 1.1, minAmountYi: 0.5, rpsMin: 0, nearHighPct: 0, maBull: false };

/* data: Map(code -> {name, bars})，bars 紧凑数组 [d,o,c,h,l,v,a]
   返回 {hits, stats:{universe, targetDate}}，hits 按 N 日累计涨幅降序 */
function momComputeLocal(data, o) {
  /* ① 确定目标交易日 = 全库最晚末根日期；只统计「当天有交易」的票（停牌票名次无法对齐） */
  let targetDate = '';
  for (const rec of data.values()) {
    const b = rec.bars;
    if (b.length && b[b.length - 1][0] > targetDate) targetDate = b[b.length - 1][0];
  }
  if (!targetDate) return { hits: [], stats: { universe: 0, targetDate: '' } };
  const minLen = Math.max(o.n + 2, o.rpsMin > 0 ? 121 : 0, o.nearHighPct < 0 ? 61 : 0, o.maBull ? 61 : 0);
  const uni = [];
  for (const [code, rec] of data) {
    const b = rec.bars;
    if (!b.length || b[b.length - 1][0] !== targetDate || b.length < minLen) continue;
    uni.push({ code, name: rec.name || '', bars: b });
  }
  const uniN = uni.length;
  if (!uniN) return { hits: [], stats: { universe: 0, targetDate } };

  /* ② 每日全市场名次（精确）：对最近 N 天逐日排序。名次覆盖全部有数据的票（含 ST/北交所），
        与同花顺「全 A 涨幅榜」同一口径；排除条件只做过滤、不影响名次分母 */
  const dayRank = [];
  for (let k = 0; k < o.n; k++) {
    const arr = [];
    for (const s of uni) {
      const i = s.bars.length - o.n + k;
      const prev = s.bars[i - 1][2], cur = s.bars[i][2];
      arr.push([s.code, prev > 0 ? (cur / prev - 1) * 100 : -1e9]);
    }
    arr.sort((a, b) => b[1] - a[1]);
    const m = new Map();
    for (let i = 0; i < arr.length; i++) m.set(arr[i][0], i + 1);
    dayRank.push(m);
  }

  /* ③ RPS120：120 日累计收益的全市场百分位（0~100，越高越强） */
  const rpsMap = new Map();
  if (o.rpsMin > 0) {
    const rets = [];
    for (const s of uni) {
      const b = s.bars, L = b.length;
      if (L >= 121 && b[L - 121][2] > 0) rets.push([s.code, (b[L - 1][2] / b[L - 121][2] - 1) * 100]);
    }
    rets.sort((a, b) => b[1] - a[1]);
    rets.forEach((e, i) => rpsMap.set(e[0], Math.round((1 - i / rets.length) * 1000) / 10));
  }

  /* ④ 逐票判定 */
  const hits = [];
  for (const s of uni) {
    if (o.excludeBJ !== false && /^(4|8|9)/.test(s.code)) continue;
    if (o.excludeST !== false && /ST|退/.test(s.name)) continue;
    const b = s.bars, L = b.length, last = b[L - 1];
    const amtYi = (last[6] || 0) / 1e8;
    if (!(amtYi >= o.minAmountYi)) continue;

    /* 连涨 + 名次（精确） */
    const days = [];
    let pass = true;
    for (let k = 0; k < o.n; k++) {
      const i = L - o.n + k;
      const pct = b[i - 1][2] > 0 ? (b[i][2] / b[i - 1][2] - 1) * 100 : -1e9;
      const rank = dayRank[k].get(s.code);
      if (!(pct > 0) || !(rank <= o.topN)) { pass = false; break; }
      days.push({ d: b[i][0], pct, rank, rankExact: true });
    }
    if (!pass) continue;
    /* 量能递增 */
    for (let k = 1; k < o.n; k++) {
      const i = L - o.n + k;
      if (o.volK > 0 && !(b[i][5] >= b[i - 1][5] * o.volK)) { pass = false; break; }
    }
    if (!pass) continue;
    /* RPS 门槛 */
    let rps = null;
    if (o.rpsMin > 0) { rps = rpsMap.get(s.code) || 0; if (rps < o.rpsMin) continue; }
    /* 距 250 日新高：distHigh = (收/区间最高 - 1)%；nearHighPct<0 才启用（如 -10 = 回撤 10% 以内） */
    let distHigh = null;
    if (o.nearHighPct < 0) {
      let hi = 0;
      for (let i = Math.max(0, L - 250); i < L; i++) if (b[i][3] > hi) hi = b[i][3];
      distHigh = hi > 0 ? (last[2] / hi - 1) * 100 : null;
      if (distHigh == null || distHigh < o.nearHighPct) continue;
    }
    /* 均线多头：收 > MA5 > MA10 > MA20 > MA60 */
    if (o.maBull) {
      const ma = w => { let s2 = 0; for (let i = L - w; i < L; i++) s2 += b[i][2]; return s2 / w; };
      const c = last[2];
      if (!(c > ma(5) && ma(5) > ma(10) && ma(10) > ma(20) && ma(20) > ma(60))) continue;
    }

    const base = b[L - o.n - 1][2];
    hits.push({
      code: s.code, name: s.name, price: last[2], amount: amtYi, targetDate,
      days, cum: base > 0 ? (last[2] / base - 1) * 100 : 0,
      volRatio: b[L - o.n][5] > 0 ? last[5] / b[L - o.n][5] : 0,
      rps, distHigh,
    });
  }
  hits.sort((a, b) => b.cum - a.cum);
  return { hits, stats: { universe: uniN, targetDate } };
}

/* 从面板输入读条件（非法值回落默认，绝不因输入抛错中断筛选） */
function readMomOpts() {
  const num = (id, def, min, max) => {
    const el = document.getElementById(id);
    if (!el) return def;
    const v = parseFloat(el.value);
    return isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  };
  momOpts.n = Math.round(num('momN', 3, 1, 10));
  momOpts.topN = Math.round(num('momTopN', 1000, 10, 6000));
  /* v3.12.3 量能系数：留空或 0 = 不检查量能（纯排名模式）；min 放宽到 0 */
  momOpts.volK = num('momVolK', 1.1, 0, 10);
  momOpts.minAmountYi = num('momAmt', 0.5, 0, 1e4);
  momOpts.rpsMin = num('momRps', 0, 0, 100);
  momOpts.nearHighPct = num('momHigh', 0, -100, 0);
  const maEl = document.getElementById('momMa');
  momOpts.maBull = !!(maEl && maEl.checked);
  /* 旧在线回退流程共用这组条件 */
  MOM.n = momOpts.n; MOM.topN = momOpts.topN; MOM.volK = momOpts.volK; MOM.minAmount = momOpts.minAmountYi;
}

/* v3.10.0 入口：首选本地 K 线库精确计算；库不可用才回退在线近似流程 */
async function runMomentumScan() {
  const btn = document.getElementById('momRunBtn');
  if (!btn) return;
  if (momState.running) return toast('正在筛选，请稍候…');
  readMomOpts();
  momState.running = true; momState.err = ''; momState.items = []; momState.approx = false; momState.src = '';
  momState.stage = '准备 K 线库…'; momState.done = 0; momState.total = 0;
  renderMomView();
  btn.disabled = true; btn.textContent = '⏳ 筛选中…';
  try {
    try {
      /* 首次运行会自动回补全市场 12 个月日K（约 3-5 分钟，带进度）；之后每天增量只差当日一根 */
      const r = await KLib.ensure(p => {
        momState.stage = p.stage; momState.done = p.done || 0; momState.total = p.total || 0; renderMomView();
      });
      const data = await KLib.all();
      if (data.size < 1000) throw new Error('K 线库不足 1000 只（' + data.size + '），无法做全市场排名');
      momState.src = 'local';
      momState.stage = '全市场精确计算（' + data.size + ' 只）…';
      momState.done = 0; momState.total = 0;
      renderMomView();
      const res = momComputeLocal(data, momOpts);
      momState.items = res.hits;
      momState.approx = false;
      momState.stage = 'K线库 ' + res.stats.universe + ' 只 · 交易日 ' + res.stats.targetDate
        + ' → 命中 ' + res.hits.length + '（历史名次 100% 精确）';
      momState.at = nowTs();
    } catch (eLocal) {
      /* K 线库不可用（IndexedDB 被禁 / 参考票失败等）→ 旧在线流程兜底，名次含估算 */
      NetLog.push('kline', 'K线库不可用，回退在线流程', false, 0, eLocal.message || String(eLocal));
      momState.src = 'online';
      await runMomentumOnline();
      momState.approx = true;
    }
  } catch (e) {
    momState.err = (e && e.message) || '筛选失败';
  }
  momState.running = false;
  btn.disabled = false; btn.textContent = '🔍 开始筛选';
  renderMomView();
}

/* 旧在线流程（v3.8.74 原样保留，仅作 K 线库不可用时的兜底；历史名次为估算） */
async function runMomentumOnline() {
  momState.stage = '① 取涨幅榜前 ' + MOM.topN + ' 名…'; momState.done = 0; momState.total = 0;
  renderMomView();
  const rankMap = await momTopRanked(MOM.topN);
  if (!rankMap.size) throw new Error('涨幅榜没有返回数据（接口可能临时不可用，请稍后重试）');
  momState.stage = '② 拉取全市场快照并粗筛…';
  renderMomView();
  const poolRes = await momPool(rankMap);
  const pool = poolRes.rows;
  if (!pool.length) throw new Error('粗筛后没有候选（可能是全市场普跌，或成交额门槛过严）');
  momState.total = pool.length;
  momState.stage = '③ 读取日K（' + pool.length + ' 只）…';
  renderMomView();
  const items = new Array(pool.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= pool.length) return;
      try { items[i] = await momOne(pool[i]); } catch (e) { items[i] = null; }
      momState.done++;
      if (momState.done % 5 === 0 || momState.done === pool.length) renderMomView();
    }
  };
  await Promise.all(Array.from({ length: Math.min(MOM.concurrency, pool.length) }, worker));
  const valid = items.filter(Boolean);
  const passed = [];
  for (const it of valid) { const r = momJudge(it, valid, rankMap); if (r) passed.push(r); }
  passed.sort((a, b) => b.cum - a.cum);
  momState.items = passed;
  momState.approx = passed.some(r => r.days.some(d => !d.rankExact));
  momState.stage = '涨幅榜前 ' + MOM.topN + ' → 粗筛 ' + pool.length
    + ' → 日K可用 ' + valid.length + ' → 命中 ' + passed.length;
  momState.at = nowTs();
}

function renderMomView() {
  const box = document.getElementById('momBox');
  if (!box) return;
  const st = momState;
  if (st.err) { box.innerHTML = '<div class="hint down">筛选失败：' + esc(st.err) + '</div>'; return; }
  const pct = st.total ? Math.round(st.done / st.total * 100) : 0;
  const prog = (st.running || st.stage)
    ? '<div class="mom-prog"><div class="mom-prog-bar" style="width:' + (st.running ? pct : 100) + '%"></div></div>'
      + '<div class="hint">' + esc(st.stage) + (st.running && st.total ? '（' + st.done + '/' + st.total + '）' : '') + '</div>'
    : '';
  if (!st.items.length) {
    box.innerHTML = prog + '<div class="hint">'
      + (st.running ? '正在扫描…' : '还没有结果。点「开始筛选」扫描全市场（首次约 20 秒）。') + '</div>';
    return;
  }
  const rows = st.items.map((r, i) => {
    const dayCells = r.days.map(d => {
      const cls = d.rankExact ? 'mom-d exact' : 'mom-d';
      const t = d.rankExact ? '全市场精确名次（本地K线库复算）' : '估算名次（无历史榜单，按候选池折算）';
      return '<span class="' + cls + '" title="' + t + '">+' + d.pct.toFixed(1) + '%<i>' + d.rank + '</i></span>';
    }).join('');
    return '<tr>'
      + '<td class="mom-i">' + (i + 1) + '</td>'
      + '<td><div class="stock-cell"><span class="sc-name">' + esc(r.name || '') + '</span>'
        + '<span class="sc-code">' + esc(r.code) + '</span></div></td>'
      + '<td class="num up">+' + r.cum.toFixed(2) + '%</td>'
      + '<td class="num">' + dayCells + '</td>'
      + '<td class="num">' + r.volRatio.toFixed(2) + '×</td>'
      + '<td class="num">' + momAmtTxt(r.amount) + '</td>'
      + '<td class="num">' + (r.rps == null ? '--' : r.rps.toFixed(1)) + '</td>'
      + '<td class="num">' + (r.distHigh == null ? '--' : r.distHigh.toFixed(1) + '%') + '</td>'
      + '<td><button class="icon-btn" data-momcode="' + esc(r.code) + '">诊断</button></td>'
      + '</tr>';
  }).join('');
  box.innerHTML = prog
    + '<div class="mom-sum">命中 <b>' + st.items.length + '</b> 只'
      + (st.src === 'local' ? '<span class="mom-exact" title="本地K线库逐日全市场复算">名次精确</span>'
        : '<span class="mom-warn" title="历史日没有榜单快照，名次由当日涨幅在候选池内排序后折算得到，非精确全市场排名">名次含估算</span>')
      + '<span class="batch-at">更新于 ' + esc(st.at || '') + '</span></div>'
    + '<div class="table-wrap"><table class="batch-table mom-table"><thead><tr>'
      + '<th>#</th><th>股票</th><th class="num">' + momOpts.n + '日累计</th><th class="num">逐日涨幅<i>名次</i></th>'
      + '<th class="num">量能</th><th class="num">成交额</th><th class="num" title="120日累计收益的全市场百分位">RPS120</th>'
      + '<th class="num" title="现价距250日最高价的幅度">距新高</th><th></th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="diag-form-row">'
      + '<button class="btn block" id="momDiagAllBtn" type="button">📊 全部批量诊断（' + st.items.length + ' 只）</button>'
      + '<button class="btn block" id="momExportBtn" type="button">⬇ 导出结果 CSV（含逐日名次）</button>'
      + '</div>';
  box.querySelectorAll('button[data-momcode]').forEach(el => {
    el.onclick = () => analyzeStockByCode(el.dataset.momcode);
  });
  const all = document.getElementById('momDiagAllBtn');
  if (all) all.onclick = () => {
    const extra = momState.items.map(r => ({ code: r.code, name: r.name }));
    if (!extra.length) return toast('没有可诊断的股票');
    switchAnalysisTab('diag');                       // 先切到诊断页，结果才看得见
    runBatchDiagnose(extra, MOM.n + '日强势' + (MOM.volK > 0 ? ' · 量能递增' : ' · 纯排名') + '（' + extra.length + ' 只）');
    const pane = document.getElementById('batchBox');
    if (pane) pane.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  /* v3.10.0 结果导出：逐日涨幅+精确名次全带上下文，方便离线核对 */
  const exp = document.getElementById('momExportBtn');
  if (exp) exp.onclick = () => {
    if (!st.items.length) return toast('没有可导出的结果');
    const rows = [['#', '代码', '名称', momOpts.n + '日累计%', '量能倍数', '成交额(亿)', 'RPS120', '距250日新高%', '目标交易日']];
    for (let k = 0; k < momOpts.n; k++) rows[0].push('D-' + (momOpts.n - 1 - k) + '涨幅%', 'D-' + (momOpts.n - 1 - k) + '名次');
    for (let i = 0; i < st.items.length; i++) {
      const r = st.items[i];
      const row = [i + 1, r.code, r.name, Number(r.cum.toFixed(3)), Number(r.volRatio.toFixed(3)),
        Number(r.amount.toFixed(3)), r.rps == null ? '' : r.rps, r.distHigh == null ? '' : Number(r.distHigh.toFixed(2)), r.targetDate || st.at || ''];
      for (const d of r.days) row.push(Number(d.pct.toFixed(3)), d.rank + (d.rankExact ? '' : '(估)'));
      rows.push(row);
    }
    rows.push([]);
    rows.push(['# 条件', `连续${momOpts.n}日涨幅>0且名次≤${momOpts.topN}`, `量能≥前日×${momOpts.volK}`,
      `成交额≥${momOpts.minAmountYi}亿`, momOpts.rpsMin > 0 ? `RPS120≥${momOpts.rpsMin}` : 'RPS未启用',
      momOpts.nearHighPct < 0 ? `距新高≥${momOpts.nearHighPct}%` : '新高未启用', momOpts.maBull ? '要求均线多头' : '均线未启用']);
    rows.push(['# 数据来源', st.src === 'local' ? '本地K线库（12个月日K，历史名次100%精确）' : '腾讯涨幅榜+快照（历史名次为估算）', '', '', '', '', '', '', '']);
    csvDownload('momentum-' + csvStamp() + '.csv', rows);
  };
}

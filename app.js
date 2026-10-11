/* ============================================================
   操作日记 · 重构版 app.js
   架构：存储适配层（云端 RPC / 本地 localStorage）+ 费用引擎
        + 持仓引擎（移动加权平均）+ 自然语言解析 + 五视图渲染
   ============================================================ */
'use strict';

/* ---------------- 云端配置 ----------------
   云端访问 key 与应用域名绑定（服务端校验 Origin）；
   云端运行走相对路径，本地打开走云端绝对地址，均指向同一后端 */
const CLOUD_HOST = 'https://stock-journal-84311.app.workbuddy.host';
const RPC_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'file:')
  ? CLOUD_HOST + '/.cloud/database/rest/rpc'
  : '/.cloud/database/rest/rpc';
const ACCESS_KEY = 'wbpk_CwUOa3QUCTJDNRwFYHCDQ6_F8oKu5xRL79KamRYPWuUJZl4TZ4wfukP';
/* 云端 LLM（免密钥）：模型目录 + 对话调用，与旧版 trade-manager 同一通道 */
let cloudLlm = null;
function initCloudLlm() {
  if (!window.WorkBuddyCloud) return null;
  try { return WorkBuddyCloud.createWorkBuddyCloud({ endpoint: CLOUD_HOST, publishableKey: ACCESS_KEY }); }
  catch (e) { return null; }
}
const TABLES = ['trades', 'watchlist', 'quotes', 'settings', 'op_logs'];

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
function fmtP(n) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 3 }); }
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
const MKT_NAME = { sh: '沪市', sz: '深市', bj: '北交所' };
const APP_VER = '3.3.0';

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
      try {
        const res = await fetch('stock-dict.json?v=' + APP_VER, { cache: 'no-cache' });
        const raw = await res.text();
        if (this.apply(raw) >= 1000) {
          try { localStorage.setItem(SEED_KEY, raw); localStorage.setItem(AT_KEY, String(Date.now())); } catch (e) { /* 配额满 */ }
        }
      } catch (e) { /* 拉取失败：仅用已学到的条目 */ }
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
  learn(code, name) {
    code = String(code || '').trim(); name = String(name || '').trim();
    if (!/^\d{6}$/.test(code) || !name) return;
    const old = this.d[code];
    if (old && old.name === name) return;
    this.d[code] = { name, py: (old && old.py) || '', mkt: inferMarket(code) };
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
  /* 「600519 贵州茅台」/「600519」/「gzmt」/「贵州茅台」统一解析 */
  resolve(txt) {
    txt = String(txt || '').trim();
    const m = txt.match(/^(\d{5,6})(?:[\s·、,，]+(.*))?$/);
    if (m) {
      const code = m[1];
      const name = (m[2] && m[2].trim()) || (this.d[code] && this.d[code].name) || '';
      return { code, name, mkt: inferMarket(code) };
    }
    const hits = this.search(txt, 1);
    return hits.length ? hits[0] : null;
  }
};

/* ---------- 通用联想下拉（自选 / 交易表单共用） ---------- */
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
    requestAnimationFrame(() => box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
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

/* 确认模态 */
let confirmCb = null;
function confirmDlg(title, desc, onOk, okText) {
  $('confirmTitle').textContent = title;
  $('confirmDesc').textContent = desc;
  $('confirmOk').textContent = okText || '确认';
  confirmCb = onOk;
  $('confirmModal').hidden = false;
}
function closeConfirm() { $('confirmModal').hidden = true; confirmCb = null; }

/* ============================================================
   费用引擎（口径与 trade-manager 一致，‰，三市独立）
   ============================================================ */
const DEFAULT_FEES = {
  sh:  { rate: 0.06, min: 5, stamp: 0.5, transfer: 0.01, handling: 0.034, gov: 0.02 },
  sz:  { rate: 0.06, min: 5, stamp: 0.5, transfer: 0.01, handling: 0.034, gov: 0.02 },
  bse: { rate: 0.06, min: 5, stamp: 0.5, transfer: 0.01, handling: 0.125, gov: 0 }
};
function feeCfg(market) {
  const cfg = S.settings.fee || {};
  return Object.assign({}, DEFAULT_FEES[market] || DEFAULT_FEES.sz, cfg[market] || {});
}
function calcFees(amount, type, market) {
  /* 口径与 trade-manager calcAshareCost 一致：
     最低费用 min 针对规费(过户+经手+证管)+佣金 合计，不足时由佣金补足；印花税不参与 */
  const f = feeCfg(market);
  const r4 = x => Math.round(x * 10000) / 10000;
  const stamp = type === 'sell' ? amount * f.stamp / 1000 : 0;
  const transfer = amount * f.transfer / 1000;
  const gov = amount * (f.gov || 0) / 1000;
  const handling = amount * f.handling / 1000;
  const rawComm = amount * f.rate / 1000;
  const fixTotal = transfer + gov + handling;
  const minFee = Number(f.min) || 0;
  const comm = amount > 0 && (fixTotal + rawComm) < minFee ? Math.max(minFee - fixTotal, 0) : rawComm;
  return { commission: r4(comm), stamp: r4(stamp), transfer: r4(transfer), handling: r4(handling), gov: r4(gov), total: r4(stamp + fixTotal + comm) };
}
function buildTradeRow({ type, code, name, market, price, qty, time, note }) {
  const gross = Math.round(price * qty * 10000) / 10000;
  const fee = calcFees(gross, type, market);
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
  for (const t of sorted) {
    const k = t.stock_code;
    if (!map.has(k)) map.set(k, { code: k, name: t.stock_name || '', market: t.market, qty: 0, costValue: 0, dilutedValue: 0, realized: 0, timeline: [] });
    const h = map.get(k);
    if (t.stock_name) h.name = t.stock_name;
    if (t.market) h.market = t.market;
    const feeTotal = (t.fee && t.fee.total) || 0;
    const net = t.net_amount != null ? Number(t.net_amount) : t.gross_amount - feeTotal;
    if (t.transaction_type === 'buy') {
      h.qty += t.quantity;
      h.costValue += t.gross_amount + feeTotal;      // 加权：费用计入成本
      h.dilutedValue += t.gross_amount + feeTotal;
      h.timeline.push({ t, avg: h.qty ? h.costValue / h.qty : 0, realized: null });
    } else {
      const avg = h.qty ? h.costValue / h.qty : 0;
      const pnl = net - t.quantity * avg;            // 按当时加权成本算已实现盈亏
      h.realized += pnl;
      h.costValue -= t.quantity * avg;
      h.dilutedValue -= net;                          // 摊薄：盈亏滚入
      h.qty -= t.quantity;
      if (h.qty <= 0.0001) { h.qty = 0; h.costValue = 0; h.dilutedValue = 0; }
      h.timeline.push({ t, avg, realized: pnl });
    }
  }
  return [...map.values()];
}
function quoteMap() {
  return NetQuote.map;   // 统一走网络行情（腾讯公开接口），不再读手填价格表
}

/* ============================================================
   网络行情（腾讯公开接口，浏览器可直连；参考 trade-manager）
   map: code -> { price, name, pct }；获取失败的代码不在 map 中
   ============================================================ */
const NetQuote = {
  map: new Map(),
  fetchedAt: 0,
  pending: null,
  ttl: 60 * 1000,
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
  async refresh(force = false) {
    const { codes, mk } = this.allCodes();
    if (!codes.length) return this.map;
    const fresh = Date.now() - this.fetchedAt < this.ttl;
    if (this.pending) return this.pending;
    if (!force && fresh && codes.every(c => this.map.has(c))) return this.map;
    this.pending = (async () => {
      const out = new Map();
      for (let i = 0; i < codes.length; i += 50) {
        const batch = codes.slice(i, i + 50);
        try {
          const q = batch.map(c => this.prefix(mk[c], c)).join(',');
          const res = await fetch('https://qt.gtimg.cn/q=' + q);
          const buf = await res.arrayBuffer();
          const text = new TextDecoder('gbk').decode(buf);
          for (const m of text.matchAll(/v_[a-z]{2}(\d{6})="([^"]*)"/g)) {
            const p = m[2].split('~');
            if (p.length < 40) continue;
            const price = parseFloat(p[3]);
            if (!(price > 0)) continue;          // 停牌/无数据
            const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
            out.set(m[1], { price, name: p[1], pct: parseFloat(p[32]),
              prevClose: num(p[4]), open: num(p[5]), high: num(p[33]), low: num(p[34]) });
          }
        } catch (e) { /* 网络失败：保持空，页面显示「未获取」 */ }
      }
      this.map = out;
      this.fetchedAt = Date.now();
      this.pending = null;
      return out;
    })();
    return this.pending;
  },
  get(code) { return this.map.get(code) || null; }
};
/* 拉一次行情并刷新相关页面（登录后 / 手动刷新时调用） */
async function refreshQuotes(force = false) {
  await NetQuote.refresh(force);
  renderAll();
}

/* ============================================================
   存储适配层
   ============================================================ */
async function rpc(fn, params) {
  const r = await fetch(`${RPC_BASE}/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-wb-webapp-access-key': ACCESS_KEY },
    body: JSON.stringify(params || {})
  });
  if (r.status === 404 || r.status >= 500) throw new Error('服务不可用(' + r.status + ')');
  return r.json();
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
  saveCustom() { localStorage.setItem('sj_custom_models', JSON.stringify(this.custom)); },
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
      this.cur = all[0] || null;
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
    }
    for (const selId of ['modelCurSel']) {
      const sel = $(selId); if (!sel) continue;
      sel.innerHTML = inner;
      if (this.cur) sel.value = this.modelId(this.cur);
      sel.disabled = !all.length;
    }
    /* 顶栏：只读展示当前模型，未配置时提示 */
    const badge = $('modelBadge');
    if (badge) badge.textContent = this.cur ? this.shortLabel(this.cur) : '未配置';
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
async function customLlmStream(m, messages) {
  let url = m.baseUrl.replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
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
        if (d && d.content) text += d.content;
      } catch (e) { /* 忽略无法解析的行 */ }
    }
  }
  return text;
}
async function llmComplete(messages) {
  const m = ModelMgr.cur;
  if (!m) throw new Error('尚未选择模型，请到「应用设置 → AI 模型」选择');
  if (m.custom) return customLlmStream(m, messages);
  if (!cloudLlm) throw new Error('云端模型服务不可用');
  const llm = cloudLlm.llm || cloudLlm;   // SDK 命名空间：cloud.llm.chat
  let text = '';
  const params = { model: m.id, messages, stream: true };
  for await (const chunk of llm.chat.completions.create(params)) {
    const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    if (d && d.content) text += d.content;
  }
  return text;
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
3. 根据股票名称给出股票代码：A股为 6 位数字。对代码有把握就填，没把握填空字符串，但 stock_name 必填。
   stock_name 一律用交易所简称（如「中兴通讯」），不要写工商全称。
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
  return list;
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
      el.innerHTML = esc(model ? '本地规则未能识别出交易信息。' : '尚未选择模型（应用设置 → AI 模型），本地规则也未能识别。')
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
        <span class="p-desc">${esc(t.name || t.code)} ${t.qty} 股 @${esc(t.price)} · ${esc(String(t.time).replace('T', ' ').slice(0, 16))}</span>
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
  /* 模型初始化：先同步云端配置 → 缓存渲染 → 后台刷新目录（云端为权威，同 trade-manager） */
  if (!cloudLlm) cloudLlm = initCloudLlm();
  ModelMgr.loadCache(); ModelMgr.loadCustom();
  ModelMgr.applyCloudConfig();
  ModelMgr.loadCur(); ModelMgr.render();
  if (cloudLlm) {
    ModelMgr.reload().catch(e => {
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
}

/* ---------- 今日 ---------- */
function renderToday() {
  const holds = computeHoldings().filter(h => h.qty > 0);
  const qm = quoteMap();
  let totalMV = 0, totalFloat = 0, totalCost = 0, missing = 0;
  for (const h of holds) {
    const q = qm.get(h.code);
    const price = q ? Number(q.price) : null;
    const costPrice = h.costValue / h.qty;
    if (price != null) { totalMV += h.qty * price; totalFloat += h.qty * (price - costPrice); totalCost += h.costValue; }
    else missing++;
  }
  // 今日已实现（来自各持仓 timeline 的卖出事件）
  const todayStr = new Date().toDateString();
  let todayPnl = 0;
  for (const h of computeHoldings()) {
    for (const ev of h.timeline) {
      if (ev.realized != null && new Date(ev.t.transaction_time).toDateString() === todayStr) todayPnl += ev.realized;
    }
  }
  const floatPct = totalCost ? totalFloat / totalCost : 0;
  $('sumCards').innerHTML = `
    <div class="sum-card"><div class="s-label">总市值</div><div class="s-value">¥${fmt2(totalMV)}</div>${missing ? `<div class="s-sub">${missing} 只现价未获取，未计入</div>` : ''}</div>
    <div class="sum-card"><div class="s-label">浮动盈亏</div><div class="s-value ${pnlCls(totalFloat)}">${totalFloat >= 0 ? '+' : ''}${fmt2(totalFloat)}</div><div class="s-sub">${fmtPct(floatPct)}</div></div>
    <div class="sum-card"><div class="s-label">今日已实现</div><div class="s-value ${pnlCls(todayPnl)}">${todayPnl >= 0 ? '+' : ''}${fmt2(todayPnl)}</div></div>
    <div class="sum-card"><div class="s-label">持仓只数</div><div class="s-value">${holds.length}</div><div class="s-sub">在途 ${holds.length} 只</div></div>`;

  // 自选关注：星标优先 + 有涨跌幅的
  const ws = [...S.watchlist].sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0)).slice(0, 6);
  $('todayWatch').innerHTML = ws.length ? ws.map(w => {
    const q = quoteMap().get(w.stock_code);
    const chg = q && q.pct != null && !isNaN(q.pct) ? q.pct / 100 : null;
    return `<div class="mini-item">
      <div class="mini-main">
        <div class="mini-title">${w.starred ? '<span class="tag star">关注</span>' : ''}${esc(w.stock_name || w.stock_code)}</div>
        <div class="mini-sub">${esc(w.stock_code)}${w.note ? ' · ' + esc(w.note) : ''}</div>
      </div>
      <div class="mini-right">
        <div class="m-val">${q ? fmt2(q.price) : '—'}</div>
        ${chg != null ? `<div class="m-sub ${pnlCls(chg)}">${fmtPct(chg)}</div>` : ''}
      </div>
    </div>`;
  }).join('') : '<div class="empty">暂无自选，去「自选」页添加</div>';

  // 近期操作
  const rt = S.trades.slice(0, 5);
  $('recentTrades').innerHTML = rt.length ? rt.map(t => {
    const amt = t.gross_amount;
    return `<div class="mini-item">
      <div class="mini-main">
        <div class="mini-title"><span class="tag ${t.transaction_type}">${t.transaction_type === 'buy' ? '买入' : '卖出'}</span>${esc(t.stock_name || t.stock_code)}</div>
        <div class="mini-sub">${fmtTime(t.transaction_time, true)} · ${t.quantity}股 @${fmtP(t.price)}</div>
      </div>
      <div class="mini-right"><div class="m-val">¥${fmt2(amt)}</div></div>
    </div>`;
  }).join('') : '<div class="empty">还没有操作记录，试试右上角「快捷记一笔」</div>';

  // 演示数据提示
  $('seedHint').hidden = S.trades.length > 0;
}

/* ---------- 持仓 ---------- */
const WB_COLORS = ['#3468D6', '#D93A2B', '#0E9463', '#B7791F', '#7C5CBF', '#2E9AA8', '#C2557A', '#6B7280'];
function renderHoldings() {
  const all = computeHoldings();
  const holds = all.filter(h => h.qty > 0);
  const qm = quoteMap();
  const NA = '<span class="na-tag">未获取</span>';

  /* 持仓总览（现价来自网络行情；未获取的股票不计入，并单独提示） */
  let totalMV = 0, totalCost = 0, missing = 0, totalDayPnl = 0;
  for (const h of holds) {
    const q = qm.get(h.code);
    if (q && q.price != null) {
      totalMV += h.qty * q.price; totalCost += h.costValue;
      if (q.prevClose > 0) totalDayPnl += h.qty * (q.price - q.prevClose);
    }
    else missing++;
  }
  const totalFloat = totalMV - totalCost;
  const hs = $('holdSummary');
  if (hs) hs.innerHTML = holds.length ? `
    <div class="sum-card"><div class="s-label">总市值</div><div class="s-value">¥${fmt2(totalMV)}</div></div>
    <div class="sum-card"><div class="s-label">浮动盈亏</div><div class="s-value ${pnlCls(totalFloat)}">${totalFloat >= 0 ? '+' : ''}${fmt2(totalFloat)}</div></div>
    <div class="sum-card"><div class="s-label">当日参考盈亏</div><div class="s-value ${pnlCls(totalDayPnl)}">${totalDayPnl >= 0 ? '+' : ''}${fmt2(totalDayPnl)}</div>
      ${missing ? `<div class="s-sub">${missing} 只现价未获取，未计入</div>` : ''}</div>` : '';

  $('holdEmpty').hidden = holds.length > 0;
  const todayStr = nowLocalInput().slice(0, 10);
  /* 行数据一次算好，PC / 手机两张表共用 */
  const rows = holds.map((h, i) => {
    const q = qm.get(h.code);
    const price = q ? q.price : null;
    const prevClose = q ? q.prevClose : null;
    const costPrice = h.costValue / h.qty;
    const mv = price != null ? h.qty * price : null;
    const float = price != null ? h.qty * (price - costPrice) : null;
    const floatPct = price != null && costPrice ? (price - costPrice) / costPrice : null;
    /* T+1 可用 = 持仓 − 当日买入 */
    const boughtToday = S.trades.reduce((s, t) =>
      s + ((t.stock_code === h.code && t.transaction_type === 'buy' && t.transaction_time.slice(0, 10) === todayStr) ? t.quantity : 0), 0);
    const avail = Math.max(0, h.qty - boughtToday);
    /* 当日盈亏：按现价与昨收计算 */
    const dayPnl = price != null && prevClose > 0 ? h.qty * (price - prevClose) : null;
    const dayPct = price != null && prevClose > 0 ? (price - prevClose) / prevClose : null;
    return { h, price, prevClose, costPrice, mv, float, floatPct, avail, dayPnl, dayPct, color: WB_COLORS[i % WB_COLORS.length] };
  });

  /* PC 全列表格：股票/市值/盈亏/盈亏%/持仓可用/成本价/现价/当日盈亏/当日盈亏%/仓位/明细 */
  $('holdTable').querySelector('tbody').innerHTML = rows.map(r => {
    const { h, price, costPrice, mv, float, floatPct, avail, dayPnl, dayPct } = r;
    return `<tr data-code="${esc(h.code)}">
      <td><div class="stock-cell"><span class="sc-name">${esc(h.name || h.code)}</span><span class="sc-code">${esc(h.code)}</span></div></td>
      <td class="num">${mv != null ? fmt2(mv) : NA}</td>
      <td class="num ${float != null ? pnlCls(float) : ''}">${float != null ? (float >= 0 ? '+' : '') + fmt2(float) : NA}</td>
      <td class="num ${floatPct != null ? pnlCls(floatPct) : ''}">${floatPct != null ? fmtPct(floatPct) : NA}</td>
      <td class="num"><div class="two-line"><span title="可用 = 持仓 − 当日买入（T+1）">${h.qty}</span><span class="sub">${avail}</span></div></td>
      <td class="num">${fmtP(costPrice)}</td>
      <td class="num price-cell">${price != null ? fmt2(price) : NA}</td>
      <td class="num ${dayPnl != null ? pnlCls(dayPnl) : ''}">${dayPnl != null ? (dayPnl >= 0 ? '+' : '') + fmt2(dayPnl) : NA}</td>
      <td class="num ${dayPct != null ? pnlCls(dayPct) : ''}">${dayPct != null ? fmtPct(dayPct) : NA}</td>
      <td class="num">${mv != null && totalMV ? (mv / totalMV * 100).toFixed(2) + '%' : NA}</td>
      <td><div class="row-actions">
        <button class="icon-btn show-detail" data-code="${esc(h.code)}">明细</button>
      </div></td>
    </tr>`;
  }).join('');

  /* 手机端合并列表格：市值 / 盈亏 / 持仓可用 / 成本现价 / 当日盈亏 / 仓位 / 明细 */
  $('holdTableM').querySelector('tbody').innerHTML = rows.map(r => {
    const { h, price, costPrice, mv, float, floatPct, avail, dayPnl, dayPct } = r;
    const sgn = v => (v >= 0 ? '+' : '');
    return `<tr data-code="${esc(h.code)}">
      <td><div class="stock-cell"><span class="sc-name">${esc(h.name || h.code)}</span><span class="sc-code">${mv != null ? fmt2(mv) : NA}</span></div></td>
      <td class="num"><div class="two-line"><b class="${float != null ? pnlCls(float) : ''}">${float != null ? sgn(float) + fmt2(float) : NA}</b><span class="sub ${floatPct != null ? pnlCls(floatPct) : ''}">${floatPct != null ? fmtPct(floatPct) : ''}</span></div></td>
      <td class="num"><div class="two-line"><span title="可用 = 持仓 − 当日买入（T+1）">${h.qty}</span><span class="sub">${avail}</span></div></td>
      <td class="num"><div class="two-line"><span>${fmtP(costPrice)}</span><span class="sub">${price != null ? fmt2(price) : '未获取'}</span></div></td>
      <td class="num"><div class="two-line"><b class="${dayPnl != null ? pnlCls(dayPnl) : ''}">${dayPnl != null ? sgn(dayPnl) + fmt2(dayPnl) : NA}</b><span class="sub ${dayPct != null ? pnlCls(dayPct) : ''}">${dayPct != null ? fmtPct(dayPct) : ''}</span></div></td>
      <td class="num">${mv != null && totalMV ? (mv / totalMV * 100).toFixed(2) + '%' : NA}</td>
      <td><div class="stock-cell"><span class="sc-code">${esc(h.code)}</span></div></td>
      <td><button class="icon-btn show-detail" data-code="${esc(h.code)}">明细</button></td>
    </tr>`;
  }).join('');
}

function showHoldDetail(code) {
  const all = computeHoldings();
  const h = all.find(x => x.code === code);
  if (!h) return;
  const q = quoteMap().get(code);
  const price = q ? Number(q.price) : null;
  const costPrice = h.qty ? h.costValue / h.qty : 0;
  const diluted = h.qty ? h.dilutedValue / h.qty : 0;
  $('holdDetail').hidden = false;
  $('holdDetailTitle').textContent = `${h.name || h.code} · 买卖记录`;
  $('holdDetailStats').innerHTML = `
    <div class="sum-card"><div class="s-label">当前持仓</div><div class="s-value">${h.qty ? h.qty + ' 股' : '已清仓'}</div></div>
    <div class="sum-card"><div class="s-label">加权成本价</div><div class="s-value">${h.qty ? fmtP(costPrice) : '—'}</div></div>
    <div class="sum-card"><div class="s-label">摊薄成本价</div><div class="s-value">${h.qty ? fmtP(diluted) : '—'}</div><div class="s-sub">盈亏滚入口径</div></div>
    <div class="sum-card"><div class="s-label">累计已实现</div><div class="s-value ${pnlCls(h.realized)}">${h.realized >= 0 ? '+' : ''}${fmt2(h.realized)}</div></div>
    <div class="sum-card"><div class="s-label">浮动盈亏</div><div class="s-value ${pnlCls(price != null ? h.qty * (price - costPrice) : 0)}">${price != null && h.qty ? (h.qty * (price - costPrice) >= 0 ? '+' : '') + fmt2(h.qty * (price - costPrice)) : '—'}</div></div>
    <div class="sum-card"><div class="s-label">现价</div><div class="s-value">${price != null ? fmt2(price) : '未获取'}</div></div>`;
  const sorted = [...h.timeline].sort((a, b) => new Date(b.t.transaction_time) - new Date(a.t.transaction_time));
  $('holdTimeline').innerHTML = sorted.map(ev => {
    const t = ev.t;
    return `<div class="tl-item">
      <div class="tl-time">${fmtTime(t.transaction_time, true)}</div>
      <div class="tl-body">
        <div class="tl-main">
          <span class="tag ${t.transaction_type}">${t.transaction_type === 'buy' ? '买入' : '卖出'}</span>
          <span class="tl-sub"> ${t.quantity} 股 @${fmtP(t.price)} · 费用 ${fmt2((t.fee && t.fee.total) || 0)}</span>
        </div>
        <div class="tl-num">
          <div class="t-val">¥${fmt2(t.gross_amount)}</div>
          ${ev.realized != null ? `<div class="m-sub ${pnlCls(ev.realized)}">已实现 ${ev.realized >= 0 ? '+' : ''}${fmt2(ev.realized)}</div>` : `<div class="m-sub">成本价 → ${fmtP(ev.avg)}</div>`}
        </div>
      </div>
    </div>`;
  }).join('');
  $('holdDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- 操作（交易） ---------- */
function tradeRowFiltered() {
  const from = $('ftFrom').value, to = $('ftTo').value;
  const type = $('ftType').value;
  const kw = $('ftStock').value.trim().toLowerCase();
  const allKw = $('ftKw').value.trim().toLowerCase();   // 全字段搜索：代码/名称/备注/原始语句/金额数量
  /* 快捷时间段 */
  const quick = $('ftQuick').value;
  let qFrom = '', qTo = '';
  if (quick) {
    const now = new Date();
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    qTo = iso(now);
    if (quick === 'today') qFrom = qTo;
    else if (quick === '7d') { const d = new Date(now); d.setDate(d.getDate() - 6); qFrom = iso(d); }
    else if (quick === '30d') { const d = new Date(now); d.setDate(d.getDate() - 29); qFrom = iso(d); }
    else if (quick === 'month') qFrom = iso(new Date(now.getFullYear(), now.getMonth(), 1));
    else if (quick === 'year') qFrom = `${now.getFullYear()}-01-01`;
  }
  const effFrom = qFrom || from, effTo = qTo || to;
  return S.trades.filter(t => {
    if (type && t.transaction_type !== type) return false;
    const d = t.transaction_time.slice(0, 10);
    if (effFrom && d < effFrom) return false;
    if (effTo && d > effTo) return false;
    if (kw && !(`${t.stock_code} ${t.stock_name || ''}`.toLowerCase().includes(kw))) return false;
    if (allKw) {
      const hay = `${t.stock_code} ${t.stock_name || ''} ${t.note || ''} ${t.raw_text || ''} ${t.transaction_type === 'buy' ? '买入 卖' : '卖出 买'} ${t.quantity} ${t.price} ${t.gross_amount}`.toLowerCase();
      if (!hay.includes(allKw)) return false;
    }
    return true;
  });
}
/* 交易视图模式：list=按笔（默认），stock=按股票汇总 */
let tradeMode = (() => { try { return localStorage.getItem('sj_tradeMode') || 'list'; } catch (e) { return 'list'; } })();
const TRADE_HEAD_LIST = '<th>时间</th><th>方向</th><th>股票</th><th class="num">价格</th><th class="num">数量</th>'
  + '<th class="num">成交金额</th><th class="num">费用</th><th class="num">发生金额</th><th>操作</th>';
const TRADE_HEAD_STOCK = '<th>股票</th><th class="num">笔数</th><th class="num">成交量</th><th class="num">成交均价</th>'
  + '<th class="num">成交额</th><th class="num">买/卖笔数</th><th class="num">费用</th>';
function renderTrades() {
  const rows = tradeRowFiltered();
  $('tradeEmpty').hidden = rows.length > 0;
  $('tradeTheadRow').innerHTML = tradeMode === 'stock' ? TRADE_HEAD_STOCK : TRADE_HEAD_LIST;
  /* 按股票：时间范围内按代码汇总 */
  if (tradeMode === 'stock') {
    const m = new Map();
    for (const t of rows) {
      const k = t.stock_code;
      if (!m.has(k)) m.set(k, { code: k, name: t.stock_name || k, qty: 0, amt: 0, fee: 0, buys: 0, sells: 0, cnt: 0 });
      const g = m.get(k);
      g.qty += t.quantity || 0;
      g.amt += t.gross_amount || 0;
      g.fee += (t.fee && t.fee.total) || 0;
      g.cnt++;
      if (t.transaction_type === 'buy') g.buys++; else g.sells++;
    }
    const list = [...m.values()].sort((a, b) => b.amt - a.amt);
    $('tradeTable').querySelector('tbody').innerHTML = list.map(g => `
      <tr data-code="${esc(g.code)}">
        <td><div class="stock-cell"><span class="sc-name">${esc(g.name)}</span><span class="sc-code">${esc(g.code)}</span></div></td>
        <td class="num">${g.cnt}</td>
        <td class="num">${g.qty}</td>
        <td class="num">${g.qty ? fmt2(g.amt / g.qty) : '—'}</td>
        <td class="num">${fmt2(g.amt)}</td>
        <td class="num">${g.buys} / ${g.sells}</td>
        <td class="num">${fmt2(g.fee)}</td>
      </tr>`).join('');
    const stats = $('ftStats');
    if (stats) stats.innerHTML = `<span>${list.length} 只股票</span><span>共 <b>${rows.length}</b> 笔</span>`;
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
  setManualOpen(true);
  updateFeePreview();
  openRecModal(false);
}
function resetTradeForm() {
  S.editingTradeId = null;
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
function setManualOpen(open) {
  const w = $('tfManualWrap'), t = $('tfManualToggle');
  if (w) w.hidden = !open;
  if (t) t.textContent = open ? '收起手动录入 ▴' : '手动录入 ▸';
  if (open) scrollRecBottom();   // 展开后滚到底，保存按钮可见
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
  if (!(code && txt.startsWith(code)) && txt) {
    const hit = StockDict.resolve(txt);
    if (hit && hit.code) { code = hit.code; name = hit.name || name; }
    else if (/^\d{5,6}$/.test(txt)) { code = txt; name = ''; }
    else { code = ''; name = ''; }
  }
  if (code && !name) { const hit = StockDict.resolve(code); if (hit && hit.name) name = hit.name; }
  return { code, name, market: code ? inferMarket(code) : 'sh' };
}
function updateFeePreview() {
  const price = parseFloat($('tfPrice').value), qty = parseInt($('tfQty').value, 10);
  const type = $('tfType').value, market = resolveTfStock().market;
  if (!(price > 0) || !(qty > 0)) { $('feePreview').innerHTML = ''; return; }
  const gross = price * qty;
  const f = calcFees(gross, type, market);
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
/* 买入自动加自选（不在自选时才加，归入「默认」分组） */
async function autoWatchOnBuy(code, name) {
  try {
    if (!code || S.watchlist.some(w => w.stock_code === code)) return;
    let anchor = NetQuote.get(code);
    if (!anchor) { try { await refreshQuotes(true); } catch (e) { /* */ } anchor = NetQuote.get(code); }
    const row = { stock_code: code, stock_name: name || code, group_name: '默认', note: '买入自动加入', cur_price: anchor ? anchor.price : null, prev_close: null };
    await store.insert('watchlist', row);
    await store.log('watch', `买入自动加入自选 ${row.stock_name}（${code}）`);
    toast(`已自动加入自选 ${row.stock_name}`);
  } catch (e) { /* 失败不影响交易保存主流程 */ }
}
let watchTab = (() => { try { return localStorage.getItem('sj_watchTab') || '默认'; } catch (e) { return '默认'; } })();   // 当前分组 Tab（记住上次所在分组）
function renderWatch() {
  const groups = [...new Set(['默认', ...S.watchlist.map(w => w.group_name || '默认')])];
  const tabGroups = groups.includes(watchTab) ? groups : [...groups, watchTab].filter(Boolean);
  /* 分组 Tab：各分组（默认不可删） + 新建（＋） */
  const tabs = $('watchTabs');
  tabs.innerHTML = tabGroups.map(g => `<button class="wtab${watchTab === g ? ' on' : ''}" data-g="${esc(g)}">${esc(g)}<i>${S.watchlist.filter(w => (w.group_name || '默认') === g).length}</i></button>`).join('')
    + `<button class="wtab wtab-add" data-g="+" title="新建分组">＋</button>`;
  const list = S.watchlist.filter(w => !watchTab || (w.group_name || '默认') === watchTab);
  $('watchEmpty').hidden = list.length > 0;
  const qm = quoteMap();
  const FAIL = '<span class="na-tag">获取失败</span>';
  const backfilled = new Set();   // 本轮渲染中已触发锚点回填的自选 id
  $('watchTable').querySelector('tbody').innerHTML = list.map(w => {
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
  // 分组 datalist 由 syncGroupList() 统一维护
  syncGroupList();
  $('watchEmpty').textContent = watchTab ? `分组「${watchTab}」暂无自选，在上方添加会自动归入此分组` : '暂无自选股';
  /* 当前在具体分组 Tab（「默认」除外）时显示「删除该分组」 */
  const dgb = $('delGroupBtn');
  if (dgb) dgb.style.visibility = (watchTab && watchTab !== '默认') ? 'visible' : 'hidden';
}
/* 分组下拉数据源：所有已用分组 + 默认（数据加载完即同步，供添加/高级选项联想） */
function syncGroupList() {
  const groups = [...new Set(['默认', ...S.watchlist.map(w => w.group_name || '默认'), watchTab])].filter(Boolean);
  const dl = $('groupList');
  if (dl) dl.innerHTML = groups.map(g => `<option value="${esc(g)}">`).join('');
}
function fillWatchForm(w) {
  S.editingWatchId = w.id;
  const inp = $('wfInput');
  inp.value = `${w.stock_code} ${w.stock_name || ''}`;
  delete inp.dataset.picked;
  inp.readOnly = true;                       // 编辑时票不可改，只能改分组/理由
  inp.placeholder = '编辑中：股票不可修改';
  inp.classList.add('ro');
  $('wfGroupQuick').value = w.group_name || '默认';
  $('wfNoteQuick').value = w.note || '';
  $('wfSubmit').textContent = '保存修改';
  $('wfCancel').hidden = false;
}
function resetWatchForm() {
  S.editingWatchId = null;
  $('watchForm').reset();
  const inp = $('wfInput'); inp.value = ''; delete inp.dataset.picked;
  inp.readOnly = false;
  inp.placeholder = '代码 / 名称 / 拼音首字母，如 600519、贵州茅台、gzmt';
  inp.classList.remove('ro');
  $('wfGroupQuick').value = '';
  $('wfNoteQuick').value = '';
  $('wfSubmit').textContent = '保存';
  $('wfCancel').hidden = true;
}

/* ---------- 我的 ---------- */
function renderFeeEditor() {
  const mkts = ['sh', 'sz', 'bse'];
  $('feeEditor').innerHTML = mkts.map(mk => {
    const f = feeCfg(mk);
    const fields = [
      ['rate', '佣金费率 ‰'], ['min', '最低佣金 元'],
      ['stamp', '印花税 ‰ (卖出)'], ['transfer', '过户费 ‰'],
      ['handling', '经手费 ‰'], ['gov', '证管费 ‰']
    ];
    return `<div class="fee-mkt">
      <div class="fee-mkt-head">${MKT_NAME[mk] || mk}</div>
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
function renderMe() {
  renderFeeEditor();
  renderLogs();
  if (S.mode === 'cloud' && S.user && S.user.role === 'admin') {
    $('userMgmtCard').hidden = false;
    loadUsers();
  } else {
    $('userMgmtCard').hidden = true;
  }
}
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

  /* 导航 */
  document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  document.querySelectorAll('[data-goto]').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.goto)));
  $('logoutBtn').addEventListener('click', () => doLogout(false));

  /* 模态 */
  $('confirmCancel').addEventListener('click', closeConfirm);
  $('confirmOk').addEventListener('click', () => { const cb = confirmCb; closeConfirm(); if (cb) cb(); });

  /* 今日 / 交易页：AI 解析入口 + 待确认列表 */
  $('quickParseBtn').addEventListener('click', () => aiParseEntry('quickNl', 'quickHint'));
  $('quickNl').addEventListener('keydown', e => { if (e.key === 'Enter') aiParseEntry('quickNl', 'quickHint'); });
  $('tradeParseBtn').addEventListener('click', () => aiParseEntry('tradeNl', 'tradeHint'));
  ['quickHint', 'tradeHint'].forEach(hid => $(hid).addEventListener('click', e => {
    const openM = e.target.closest('.p-open-manual');
    if (openM) { setManualOpen(true); if (hid !== 'tradeHint') { openRecModal(true); setManualOpen(true); $('tradeNl').value = ''; } return; }
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
  $('openFormBtn').addEventListener('click', () => { switchView('trades'); openRecModal(); });
  /* 记一笔弹窗：开关与关闭 */
  $('recModalBtn').addEventListener('click', () => openRecModal());
  $('recModalClose').addEventListener('click', closeRecModal);
  $('recModal').addEventListener('mousedown', e => { if (e.target === $('recModal')) closeRecModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('recModal').hidden) closeRecModal(); });

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
    if (!ModelMgr.cur) ModelMgr.setCur(ModelMgr.modelId(m)); else ModelMgr.render();
    $('cmName').value = $('cmBaseUrl').value = $('cmModel').value = $('cmApiKey').value = '';
    toast('自定义模型已添加');
  });
  $('customModelList').addEventListener('click', e => {
    const b = e.target.closest('.cm-del');
    if (!b) return;
    ModelMgr.custom = ModelMgr.custom.filter(c => c.key !== b.dataset.key);
    ModelMgr.saveCustom();
    ModelMgr.loadCur(); ModelMgr.render();
  });

  /* 应用设置：分类页签切换 */
  $('setTabs').addEventListener('click', e => {
    const b = e.target.closest('.set-tab');
    if (!b) return;
    document.querySelectorAll('#setTabs .set-tab').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('#view-me .set-pane').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.set; });
  });

  /* NL 示例词条：点击填入输入框 */
  $('quickChips').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (c) { $('quickNl').value = c.dataset.nl; $('quickNl').focus(); }
  });
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
  ['ftFrom', 'ftTo', 'ftType', 'ftQuick'].forEach(id => $(id).addEventListener('change', () => {
    if (id === 'ftQuick' && !$('ftQuick').value) return;   // 清空快捷时间段时不回填
    if (id === 'ftQuick') {   // 选快捷时间段后同步回填日期框，可微调
      const now = new Date();
      const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const q = $('ftQuick').value;
      $('ftTo').value = iso(now);
      if (q === 'today') $('ftFrom').value = $('ftTo').value;
      else if (q === '7d') { const d = new Date(now); d.setDate(d.getDate() - 6); $('ftFrom').value = iso(d); }
      else if (q === '30d') { const d = new Date(now); d.setDate(d.getDate() - 29); $('ftFrom').value = iso(d); }
      else if (q === 'month') $('ftFrom').value = iso(new Date(now.getFullYear(), now.getMonth(), 1));
      else if (q === 'year') $('ftFrom').value = `${now.getFullYear()}-01-01`;
    }
    renderTrades();
  }));
  $('ftStock').addEventListener('input', renderTrades);
  $('ftKw').addEventListener('input', renderTrades);
  $('ftClear').addEventListener('click', () => { $('ftFrom').value = ''; $('ftTo').value = ''; $('ftType').value = ''; $('ftStock').value = ''; $('ftKw').value = ''; $('ftQuick').value = ''; renderTrades(); });
  $('tradeTable').querySelector('tbody').addEventListener('click', async e => {
    const editBtn = e.target.closest('.edit-trade');
    const delBtn = e.target.closest('.del-trade');
    const feeCell = e.target.closest('.fee-cell');
    if (editBtn) {
      const t = S.trades.find(x => x.id == editBtn.dataset.id);
      if (t) fillTradeForm(t);
      return;
    }
    if (delBtn) {
      const t = S.trades.find(x => x.id == delBtn.dataset.id);
      confirmDlg('删除交易记录', `确认删除 ${t.stock_name || t.stock_code} ${t.transaction_type === 'buy' ? '买入' : '卖出'} ${t.quantity}股 @${fmtP(t.price)} 的记录？删除后持仓将重新计算。`, async () => {
        try {
          await store.remove('trades', t.id);
          await store.log('delete', `删除交易 ${t.stock_name || t.stock_code} ${fmtP(t.price)}x${t.quantity}`);
          await loadAll(); renderAll();
          toast('已删除');
        } catch (err) { toast(err.message || '删除失败', 'warn'); }
      });
      return;
    }
    if (feeCell) {
      const tr = feeCell.closest('tr');
      const next = tr.nextElementSibling;
      if (next && next.classList.contains('fee-detail-row')) next.remove();
      else {
        const t = S.trades.find(x => x.id == feeCell.dataset.id);
        if (t) tr.insertAdjacentHTML('afterend', feeDetailRow(t));
      }
    }
  });

  /* 持仓：刷新 / 改价 / 明细 */
  $('refreshHoldBtn').addEventListener('click', async () => { await loadAll(); await refreshQuotes(true); toast('已刷新行情'); });
  $('holdRecBtn').addEventListener('click', () => openRecModal());
  /* 持仓页自动刷新行情 */
  let holdTimer = null;
  function setHoldAuto() {
    if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
    const sec = parseInt($('holdAuto').value, 10) || 0;
    if (sec > 0) holdTimer = setInterval(() => { refreshQuotes(true).catch(() => { /* */ }); }, sec * 1000);
  }
  $('holdAuto').addEventListener('change', setHoldAuto);
  setHoldAuto();
  $('holdDetailClose').addEventListener('click', () => { $('holdDetail').hidden = true; });
  $('holdTable').querySelector('tbody').addEventListener('click', e => {
    const sp = e.target.closest('.set-price');
    if (sp) { startPriceEdit(sp.closest('tr'), sp.dataset.code, sp.dataset.name); return; }
    const sd = e.target.closest('.show-detail');
    if (sd) showHoldDetail(sd.dataset.code);
  });
  /* 手机端合并列表格：明细按钮 */
  $('holdTableM').querySelector('tbody').addEventListener('click', e => {
    const sd = e.target.closest('.show-detail');
    if (sd) showHoldDetail(sd.dataset.code);
  });
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

  /* 自选：添加 / 编辑 同一表单（输入联想 + 理由 + 分组 + 保存） */
  bindSuggest('wfInput', 'wfSug', h => {
    $('wfInput').value = `${h.code} ${h.name}`;
    $('wfInput').dataset.picked = h.code;
    $('wfNoteQuick').focus();   // 选完股票，光标进备注/理由框
  });
  /* 分组下拉不筛选：聚焦时临时清空以展示全部分组，未选择则恢复原值 */
  {
    const gq = $('wfGroupQuick');
    let gqPrev = '';
    gq.addEventListener('focus', () => { gqPrev = gq.value; gq.dataset.clearing = '1'; gq.value = ''; });
    gq.addEventListener('blur', () => {
      if (gq.dataset.clearing && !gq.value.trim()) gq.value = gqPrev;
      delete gq.dataset.clearing;
    });
  }
  $('watchForm').addEventListener('submit', async e => {
    e.preventDefault();
    const note = $('wfNoteQuick').value.trim();
    const group = $('wfGroupQuick').value.trim() || watchTab || '默认';
    /* 编辑：列表点「编辑」后，票已定，只更新理由/分组 */
    if (S.editingWatchId) {
      const w = S.watchlist.find(x => x.id == S.editingWatchId);
      if (!w) { resetWatchForm(); return; }
      try {
        await store.update('watchlist', w.id, { group_name: group, note });
        await store.log('watch', `修改自选 ${w.stock_name || w.stock_code}（理由/分组）`);
        toast('已保存');
        resetWatchForm();
        await loadAll(); renderWatch(); renderToday();
      } catch (err) { toast(err.message || '保存失败', 'warn'); }
      return;
    }
    /* 添加：联想命中 / 「代码 名称」/ 纯代码 / 名称拼音 */
    const inp = $('wfInput');
    const picked = inp.dataset.picked;
    const txt = inp.value.trim();
    let hit = null;
    if (picked && txt.startsWith(picked)) hit = { code: picked, name: txt.slice(picked.length).trim() };
    else hit = StockDict.resolve(txt);
    if (!hit || !hit.code) { toast('未识别股票，请输入代码或名称', 'warn'); return; }
    if (!hit.name) hit.name = hit.code;
    /* 添加时记一个现价锚点（供「自选收益」计算）；网络行情没有则留空 */
    let anchor = NetQuote.get(hit.code);
    if (!anchor) { try { await refreshQuotes(true); } catch (e) { /* */ } anchor = NetQuote.get(hit.code); }
    const row = {
      stock_code: hit.code,
      stock_name: hit.name,
      group_name: group,
      note, cur_price: anchor ? anchor.price : null, prev_close: null
    };
    try {
      await store.insert('watchlist', row);
      await store.log('watch', `添加自选 ${row.stock_name}（${row.stock_code}）`);
      toast(`已添加自选 ${row.stock_name}`);
      resetWatchForm();
      await loadAll(); renderWatch(); renderToday();
    } catch (err) { toast(err.message || '保存失败', 'warn'); }
  });
  $('wfCancel').addEventListener('click', resetWatchForm);
  /* 分组 Tab：切换 / 新建；切 Tab 后添加自动归入当前分组 */
  $('watchTabs').addEventListener('click', e => {
    const b = e.target.closest('.wtab'); if (!b) return;
    const g = b.dataset.g;
    if (g === '+') {
      const name = (prompt('新分组名称：') || '').trim();
      if (!name) return;
      watchTab = name;
      renderWatch();
      $('wfGroupQuick').value = name;
      return;
    }
    watchTab = g;
    try { localStorage.setItem('sj_watchTab', watchTab); } catch (e) { /* */ }
    renderWatch();
    $('wfGroupQuick').value = g || '';   // 当前分组即默认归组，可手动改
  });
  /* 删除当前分组：组内股票移回「默认」 */
  $('delGroupBtn').addEventListener('click', () => {
    if (!watchTab || watchTab === '默认') return;
    const n = S.watchlist.filter(w => (w.group_name || '默认') === watchTab).length;
    confirmDlg('删除分组', `确认删除分组「${watchTab}」？${n ? `组内 ${n} 只自选将移回「默认」分组` : '该分组当前为空'}。`, async () => {
      try {
        for (const w of S.watchlist.filter(w => (w.group_name || '默认') === watchTab)) {
          await store.update('watchlist', w.id, { group_name: '默认' });
        }
        await store.log('update', `删除分组「${watchTab}」（${n} 只移回默认）`);
        watchTab = '默认';
        try { localStorage.setItem('sj_watchTab', watchTab); } catch (e) { /* */ }
        $('wfGroupQuick').value = '';
        await loadAll(); renderWatch(); renderToday();
        toast('分组已删除');
      } catch (err) { toast(err.message || '删除失败', 'warn'); }
    }, '删除');
  });
  $('watchTable').querySelector('tbody').addEventListener('click', async e => {
    const editBtn = e.target.closest('.edit-watch');
    const delBtn = e.target.closest('.del-watch');
    if (editBtn) {
      const w = S.watchlist.find(x => x.id == editBtn.dataset.id);
      if (w) { fillWatchForm(w); $('watchForm').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
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
    confirmDlg('重算历史费用', `将按当前费率设置与最新费用口径（最低佣金由佣金补足规费差额）重新计算 ${S.trades.length} 条交易的费用与发生金额，持仓成本/盈亏随之变化。确定执行？`, async () => {
      try {
        let n = 0;
        for (const t of S.trades) {
          const fee = calcFees(t.gross_amount, t.transaction_type, t.market);
          const net = t.transaction_type === 'buy' ? t.gross_amount + fee.total : t.gross_amount - fee.total;
          if (JSON.stringify(t.fee) !== JSON.stringify(fee) || Number(t.net_amount) !== net) {
            await store.update('trades', t.id, { fee, net_amount: net });
            n++;
          }
        }
        await store.log('update', `按当前费率重算历史费用（${n} 条变更）`);
        await loadAll(); renderAll(); refreshQuotes();
        toast(`已重算：${n} 条费用有变更`);
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
      const newP = prompt(`为「${u}」设置新密码（至少 6 位）：`);
      if (!newP) return;
      try {
        const r = await rpc('app_reset_pwd', { p_token: S.token, p_username: u, p_new: newP });
        if (!r.ok) { toast(r.msg || '重置失败', 'warn'); return; }
        toast('已重置，该用户下次登录需改密');
      } catch (err) { toast(err.message || '重置失败', 'warn'); }
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
function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('view-' + name).classList.add('active');
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  try { localStorage.setItem('sj_view', name); } catch (e) { /* */ }
}

boot();

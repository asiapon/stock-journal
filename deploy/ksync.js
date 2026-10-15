/* ============================================================
   操作日记 · 服务端 K 线定时采集模块（deploy/ksync.js，v3.10.3）
   ------------------------------------------------------------
   为什么存在：浏览器端的「打开应用时自动增量同步」依赖有人打开页面；
   自托管后端是常驻进程，可以直接定时采集 —— 这是真正的服务端 cron。
   由 server.js 调用：每日 SYNC_AT（默认 17:30 收盘后）自动拉全市场日K
   入库 kline_cache；启动时若库为空自动全量回补。

   设计：
   · 宇宙清单读仓库自带的 stock-dict.json（与应用同一份，无额外依赖）；
   · 数据源东财 push2his（fqt=1 前复权，f51-f57 含成交额），与前端同参数；
   · 是否有新数据用「600519 末根日期」当锚 —— 天然跳过周末/节假日，
     无新交易日时整轮只需 1 次请求即跳过；
   · 全部数据经 INSERT ... ON CONFLICT 幂等 upsert，重复跑不产生脏数据；
   · db 参数只要求 {query(sql, params)}（pg Pool 兼容），便于 mock 测试。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- 纯函数（可独立测试） ---------- */

function inferMarket(code) {
  if (/^6/.test(String(code))) return 'sh';
  if (/^(0|3)/.test(String(code))) return 'sz';
  if (/^(4|8|9)/.test(String(code))) return 'bj';
  return 'sh';
}
function secidOf(code) {
  if (inferMarket(code) === 'bj') return '0.' + code;   // 东财北交所用 0 前缀
  return /^(6|5|9)/.test(code) ? '1.' + code : '0.' + code;
}
/* 本地时间的 HH:MM（调度器逐分钟比对用） */
function hhmm(d) {
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}
/* 找出需要补的代码：库中没有，或最后入库交易日 < 目标日 */
function pickStale(universe, updatedMap, target) {
  const stale = [];
  for (const code of Object.keys(universe)) {
    const u = updatedMap.get(code);
    if (!u || String(u) < String(target)) stale.push(code);
  }
  return stale;
}
/* 行组 → 多行 VALUES upsert 语句分批（行数组 [code,name,barsJson,days,updated]） */
function buildUpsertBatches(rows, size) {
  const batches = [];
  for (let i = 0; i < rows.length; i += size) {
    const part = rows.slice(i, i + size);
    const values = [];
    const params = [];
    part.forEach((r, j) => {
      const b = j * 5;
      values.push(`($${b + 1},$${b + 2},$${b + 3}::jsonb,$${b + 4},$${b + 5})`);
      params.push(r[0], r[1], r[2], r[3], r[4]);
    });
    batches.push({
      sql: `INSERT INTO kline_cache (code, name, bars, days, updated) VALUES ${values.join(', ')}`
        + ' ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, bars = EXCLUDED.bars,'
        + ' days = EXCLUDED.days, updated = EXCLUDED.updated, updated_at = now()',
      params,
    });
  }
  return batches;
}
function loadUniverse() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'stock-dict.json'), 'utf8'));
  const out = {};
  for (const row of (raw.d || [])) out[String(row[0]).padStart(6, '0')] = String(row[1] || '');
  return out;
}

/* ---------- IO ---------- */

/* 东财日K（前复权，含成交额）：bars 紧凑数组 [d,o,c,h,l,v,a] */
async function fetchKlineEast(code, lmt) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secidOf(code)
    + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=' + lmt;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const bars = ((j.data && j.data.klines) || []).map(s => {
    const a = s.split(',');
    return [a[0], +a[1], +a[2], +a[3], +a[4], +a[5] || 0, +a[6] || 0];
  });
  return { name: (j.data && j.data.name) || code, bars };
}

/* —— 数据源：东财主源（带真实成交额 f57）+ 腾讯兜底（与前端口径一致：
   量单位手 → ×100 股；成交额缺失 → (O+H+L+C)/4 × 股数 近似） —— */
async function fetchKlineTx(code, lmt) {
  const sym = (inferMarket(code) === 'bj' ? 'bj' : inferMarket(code)) + code;
  const urls = [
    'https://web.ifzq.gtimg.cn/appstock/app/newfqkline/get?param=' + sym + ',day,,,' + Math.min(lmt, 320) + ',qfq',
    'https://ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + sym + ',day,,,' + Math.min(lmt, 320) + ',qfq',
  ];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
      const j = await res.json();
      const d = (j.data && j.data[sym]) || {};
      const arr = d.qfqday || d.day || [];
      if (!arr.length) { lastErr = new Error('空数据'); continue; }
      return {
        name: (d.qt && d.qt.data && d.qt.data[1]) || code,
        bars: arr.map(k => {
          const o = +k[1], c = +k[2], h = +k[3], l = +k[4], v = (+k[5] || 0) * 100;   // 手 → 股
          return [k[0], o, c, h, l, v, Math.round(((o + h + l + c) / 4) * v)];
        }),
      };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('腾讯K线无数据');
}
/* 东财 → 腾讯兜底；eastDown 熔断：东财连续失败 5 次后，本轮剩余请求直接走腾讯
   （东财主源优点是真实成交额 f57，能用则用） */
function makeSmartFetcher() {
  let eastFails = 0;
  return async function (code, lmt) {
    if (eastFails < 5) {
      try {
        const k = await fetchKlineEast(code, lmt);
        if (k.bars && k.bars.length) { eastFails = 0; return k; }
        eastFails += 1;
      } catch (e) { eastFails += 1; }
      if (eastFails >= 5) console.error('[ksync] 东财源连续失败 5 次，本轮改用腾讯源（成交额将为近似值）');
    }
    return fetchKlineTx(code, lmt);
  };
}

/* ---------- 主流程 ---------- */

/* 全量/增量同步一轮。opts: {db, fetcher?, lmt?, concurrency?, gapMs?, batchSize?, onProgress?} */
async function syncAll(opts) {
  const { db } = opts;
  /* 默认智能取数器：东财主源 + 腾讯兜底 + 熔断（可用 opts.fetcher 注入 mock） */
  const fetcher = opts.fetcher || makeSmartFetcher();
  const lmt = opts.lmt || 280;
  const conc = opts.concurrency || 6;
  const gapMs = opts.gapMs == null ? 12 : opts.gapMs;
  const batchSize = opts.batchSize || 60;
  const prog = msg => { try { opts.onProgress && opts.onProgress(msg); } catch (e) { /* */ } };

  /* ① 目标交易日（600519 锚） */
  const ref = await fetcher('600519', 5);
  const target = ref.bars.length ? ref.bars[ref.bars.length - 1][0] : null;
  if (!target) throw new Error('无法确定最新交易日（参考票 K 线未返回）');

  /* ② 库内现状（universe 可注入，测试用；缺省读仓库自带的 stock-dict.json） */
  const universe = opts.universe || loadUniverse();
  const { rows: cur } = await db.query('SELECT code, updated FROM kline_cache');
  const updatedMap = new Map(cur.map(r => [r.code, r.updated]));
  const isEmpty = cur.length === 0;

  /* ③ 无新交易日 → 一发请求即跳过（周末/节假日/已同步） */
  if (!isEmpty) {
    const staleCnt = pickStale(universe, updatedMap, target).length;
    if (staleCnt === 0) {
      return { skipped: 'up-to-date', target, stocks: cur.length };
    }
  }

  /* ④ 拉取缺的票（空库 → 全市场回补） */
  const stale = isEmpty ? Object.keys(universe) : pickStale(universe, updatedMap, target);
  prog(`需补 ${stale.length}/${Object.keys(universe).length} 只（目标日 ${target}）`);
  const rows = [];                       // [code, name, barsJson, days, updated]
  let okCnt = 0, failed = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= stale.length) return;
      const code = stale[i];
      try {
        const k = await fetcher(code, lmt);
        if (k.bars && k.bars.length) {
          rows.push([code, k.name, JSON.stringify(k.bars), k.bars.length, k.bars[k.bars.length - 1][0]]);
          okCnt++;
        } else failed.push(code);
      } catch (e) { failed.push(code); }
      if ((okCnt + failed.length) % 100 === 0) prog(`已拉取 ${okCnt + failed.length}/${stale.length}`);
      if (gapMs) await new Promise(r => setTimeout(r, gapMs));
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, stale.length) }, worker));

  /* ⑤ 幂等 upsert（分批多行 VALUES） */
  const batches = buildUpsertBatches(rows, batchSize);
  let written = 0;
  for (let i = 0; i < batches.length; i++) {
    await db.query(batches[i].sql, batches[i].params);
    written += batchSize;
    if (i % 10 === 9 || i === batches.length - 1) prog(`已入库 ${Math.min(written, rows.length)}/${rows.length}`);
  }

  return { target, fetched: okCnt, failed: failed.length, stocks: isEmpty ? okCnt : cur.length, batches: batches.length };
}

module.exports = { inferMarket, secidOf, hhmm, pickStale, buildUpsertBatches, loadUniverse, fetchKlineEast, syncAll };

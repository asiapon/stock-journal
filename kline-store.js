/* ============================================================
   v3.10.0 全市场日K库（KLib）—— 动量筛选的数据底座
   ------------------------------------------------------------
   为什么要有它：动量筛选的核心条件是「连续 N 日涨幅都排进全市场前 M 名」，
   这需要**每一天对全市场 5600 只逐日排序**，而任何在线接口都只给当日快照，
   历史名次只能估算（v3.8.74 的局限）。把 12 个月日K（开高低收量额）存下来
   之后，历史名次可以 100% 精确复算。

   存储三层：
   1) IndexedDB（sj_kline）：本机缓存，筛选计算直接在内存里跑，秒级；
   2) 云端 kline_cache 表：每股一行（bars 为紧凑数组 JSON），多设备共享，
      经 kline_all / kline_upsert / kline_status 三个 RPC 读写（会话 token 鉴权）；
   3) 在线接口（东财 push2his，带 f57 成交额）：首次回补 + 每日增量。

   bars 紧凑格式：[日期, 开, 收, 高, 低, 量(手), 额(元)]，比对象省 ~60% 空间。
   全库约 5600 只 × 250 根 ≈ 45MB（IndexedDB / 云端各一份）。

   本地模式（未登录云端）也能用：只走 IndexedDB，功能不缺，只是不跨设备。
   ============================================================ */
'use strict';

const KLib = {
  DB_NAME: 'sj_kline', VER: 1,
  S_BARS: 'bars', S_META: 'meta',
  LMT: 280,            // 回补取 280 根（一年约 244 个交易日，留余量）
  CONC: 6,             // 回补并发（东财 K 线接口，实测宽容；并发 6 + 12ms 间隔 ≈ 80 req/s 安全）
  GAP: 12,             // 每次启动请求的间隔 ms
  CHUNK: 150,          // 云端 upsert 每批行数（150 × ~11KB ≈ 1.6MB/请求）

  _db: null,
  _map: null,          // 内存缓存：Map(code -> {name, bars})
  _meta: null,

  /* ---------- IndexedDB 基础 ---------- */
  idb() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const rq = indexedDB.open(this.DB_NAME, this.VER);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains(this.S_BARS)) db.createObjectStore(this.S_BARS, { keyPath: 'code' });
        if (!db.objectStoreNames.contains(this.S_META)) db.createObjectStore(this.S_META, { keyPath: 'k' });
      };
      rq.onsuccess = () => { this._db = rq.result; res(this._db); };
      rq.onerror = () => rej(rq.error || new Error('IndexedDB 打开失败'));
    });
  },
  _tx(store, mode, op) {
    return this.idb().then(db => new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const rq = op(t.objectStore(store));
      t.oncomplete = () => res(rq && rq.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('IndexedDB 事务中止'));
    }));
  },
  idbAll() {
    return this._tx(this.S_BARS, 'readonly', st => st.getAll()).then(rows => {
      const m = new Map();
      for (const r of rows || []) m.set(r.code, { name: r.name, bars: r.bars || [] });
      return m;
    });
  },
  idbPut(map) {
    const rows = [];
    for (const [code, rec] of map) rows.push({ code, name: rec.name, bars: rec.bars });
    return this._tx(this.S_BARS, 'readwrite', st => {
      st.clear();
      for (const r of rows) st.put(r);
    });
  },
  metaGet() {
    if (this._meta) return Promise.resolve(this._meta);
    return this._tx(this.S_META, 'readonly', st => st.get('sync')).then(r => { this._meta = r && r.v || {}; return this._meta; });
  },
  metaSet(patch) {
    return this.metaGet().then(m => {
      this._meta = Object.assign({}, m, patch, { at: Date.now() });
      return this._tx(this.S_META, 'readwrite', st => st.put({ k: 'sync', v: this._meta }));
    });
  },

  /* ---------- 云端 kline_* RPC（本地模式自动跳过） ---------- */
  cloudOn() { return typeof S !== 'undefined' && S.mode === 'cloud' && !!S.token; },
  async cloudAll(since) {
    const p = { p_token: S.token };
    if (since) p.p_since = since;                     // 'YYYY-MM-DD'
    const r = await rpc('kline_all', p);
    if (!r.ok) throw new Error(r.msg || 'kline_all 失败');
    return r.data || [];
  },
  async cloudUpsert(rows) {
    if (!rows.length) return 0;
    const r = await rpc('kline_upsert', { p_token: S.token, p_rows: rows });
    if (!r.ok) throw new Error(r.msg || 'kline_upsert 失败');
    return r.count || 0;
  },
  async cloudStatus() {
    const r = await rpc('kline_status', { p_token: S.token });
    if (!r.ok) throw new Error(r.msg || 'kline_status 失败');
    return r.data || {};
  },
  /* v3.10.1 入库统计：按交易日分组的每日入库股票数 / K 线根数 */
  async cloudStats() {
    const r = await rpc('kline_stats', { p_token: S.token });
    if (!r.ok) throw new Error(r.msg || 'kline_stats 失败');
    return r.data || {};
  },

  /* ---------- 取数 ---------- */
  /* 最新已收盘交易日：拿一只活跃票的日K末根日期当「锚」（比日历推算可靠，避开节假日） */
  async targetDate() {
    const k = await fetchKlineEast('600519', 101, 5);
    const b = (k && k.bars) || [];
    if (!b.length) throw new Error('无法确定最新交易日（参考票 K 线未返回）');
    return b[b.length - 1].d;
  },
  /* 单只：东财优先（带成交额），腾讯兜底（无成交额 → 按 (O+H+L+C)/4×量 近似，入库时注明口径）。
     统一输出紧凑数组 [d,o,c,h,l,v,a] —— 库里只存这一种形状，算量/排序都吃数组。 */
  async fetchOne(code) {
    try {
      const k = await fetchKlineEast(code, 101, this.LMT);
      if (k.bars && k.bars.length >= 30) return { name: k.name, bars: this.compact(k.bars) };
    } catch (e) { /* 降级腾讯 */ }
    const k2 = await fetchKlineTx(code, 'day', this.LMT);
    const bars = (k2.bars || []).map(b => [b.d, b.o, b.c, b.h, b.l, b.v,
      Math.round(((b.o + b.c + b.h + b.l) / 4) * b.v * 100)]);      // 手 → 股，均价×股数 ≈ 额（元）
    return { name: k2.name, bars };
  },
  /* 对象 bars → 紧凑数组 */
  compact(bars) {
    return bars.map(b => [b.d, b.o, b.c, b.h, b.l, b.v, b.a || 0]);
  },

  /* ---------- 主流程：确保库就绪（回补 / 增量 / 多设备拉平） ---------- */
  /* onProgress({stage, done, total})；opts.quiet=true 时网络日志标注「自动」。
     返回 {n, targetDate, fetched, pulled, failed, okCnt} */
  async ensure(onProgress, opts) {
    opts = opts || {};
    const prog = (stage, done, total) => { try { onProgress && onProgress({ stage, done, total }); } catch (e) { /* */ } };
    prog('读取本机缓存…');
    let map = await this.idbAll();
    const meta = await this.metaGet();

    /* ① 本机基本为空：先看云端能不能拉（多设备场景 / 换浏览器） */
    let pulled = 0;
    if (map.size < 1000 && this.cloudOn()) {
      prog('从云端拉取 K 线库…');
      try {
        const rows = await this.cloudAll();
        for (const r of rows) if (r.bars && r.bars.length) map.set(r.code, { name: r.name, bars: r.bars });
        pulled = map.size;
      } catch (e) { NetLog.push('kline', '云端 kline_all', false, 0, e.message || String(e)); }
    }

    const target = await this.targetDate();

    /* ② 找出缺当日 / 数据不足 250 根的票 → 逐只补 */
    const need = [];
    for (const code of Object.keys(StockDict.d)) {
      const rec = map.get(code);
      if (!rec || !rec.bars.length || rec.bars[rec.bars.length - 1][0] < target || rec.bars.length < 250) {
        need.push(code);
      }
    }
    /* 字典里没有、但本机已有的票保留；字典有而本机没有的 = 回补主体 */
    let fetched = 0, failed = [];
    if (need.length) {
      prog('回补/增量：0/' + need.length, 0, need.length);
      let next = 0, okCnt = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= need.length) return;
          const code = need[i];
          try {
            const rec = await this.fetchOne(code);
            if (rec.bars && rec.bars.length) { map.set(code, rec); okCnt++; }
            else failed.push(code);
          } catch (e) { failed.push(code); }
          fetched++;
          if (fetched % 25 === 0 || fetched === need.length) prog('回补/增量：' + fetched + '/' + need.length, fetched, need.length);
          await new Promise(r => setTimeout(r, this.GAP));
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.CONC, need.length) }, worker));
      NetLog.push('kline', 'K线库回补/增量' + (opts.quiet ? '（自动）' : ''), okCnt > 0 || need.length === 0, 0,
        `补 ${okCnt}/${need.length} 只（目标日 ${target}${failed.length ? '，失败 ' + failed.length + ' 只' : ''}）`);
    }

    /* ③ 落盘：IndexedDB + 云端 upsert（分批）。无任何增量时跳过整库重写（45MB 写入不值得） */
    if (pulled > 0 || need.length) {
      prog('写入本机缓存…');
      await this.idbPut(map);
    }
    if (this.cloudOn()) {
      /* 只上传本轮有变动的票（缺当日被补过的），其余云端已同步 */
      const rows = [];
      for (const code of need) {
        const rec = map.get(code);
        if (rec && rec.bars.length) rows.push({ code, name: rec.name, bars: rec.bars, updated: rec.bars[rec.bars.length - 1][0] });
      }
      for (let i = 0; i < rows.length; i += this.CHUNK) {
        prog('同步云端：' + Math.min(i + this.CHUNK, rows.length) + '/' + rows.length);
        try { await this.cloudUpsert(rows.slice(i, i + this.CHUNK)); }
        catch (e) { NetLog.push('rpc', 'kline_upsert', false, 0, '第 ' + (i / this.CHUNK + 1) + ' 批失败：' + (e.message || e)); break; }
      }
    }
    /* v3.10.1 同步历史入 meta（设置页统计用，最近 60 次） */
    const syncLog = (meta.syncLog || []).slice(0, 59);
    syncLog.unshift({ at: Date.now(), targetDate: target, fetched, okCnt: need.length - failed.length, failed: failed.length, n: map.size });
    await this.metaSet({ n: map.size, targetDate: target, fetched, failed: failed.length, syncLog });

    this._map = map;
    prog('完成：' + map.size + ' 只 · 最新 ' + target);
    return { n: map.size, targetDate: target, fetched, pulled, failed, okCnt: need.length - failed.length };
  },

  /* ---------- v3.10.1 每日自动入库 ---------- */
  AUTO_KEY: 'sj_klib_auto',            // '0'=关；缺省=开
  AUTO_AT: 'sj_klib_auto_at',          // 上次自动同步时间戳（30 分钟节流）
  autoOn() {
    try { return localStorage.getItem(this.AUTO_KEY) !== '0'; } catch (e) { return true; }
  },
  /* 打开应用后调用：库已建立 && 缺最新交易日 && 距上次自动同步 > 30 分钟 → 后台静默增量。
     首次回补（meta.n 为 0）绝不自动跑 —— 3-5 分钟的大流量动作留给用户手动触发。 */
  async autoSyncIfStale() {
    if (!this.autoOn()) return { skipped: 'off' };
    let lastAt = 0;
    try { lastAt = Number(localStorage.getItem(this.AUTO_AT) || 0); } catch (e) { /* */ }
    if (Date.now() - lastAt < 30 * 60 * 1000) return { skipped: 'throttled' };
    try { localStorage.setItem(this.AUTO_AT, String(Date.now())); } catch (e) { /* */ }
    const meta = await this.metaGet();
    if (!meta.n) return { skipped: 'empty' };          // 还没回补过 → 不自动
    /* 等 StockDict 就绪（最多 30 秒），否则全市场清单是空的 */
    for (let i = 0; i < 60 && Object.keys(StockDict.d).length < 1000; i++) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (Object.keys(StockDict.d).length < 1000) return { skipped: 'no-dict' };
    const r = await this.ensure(null, { quiet: true });
    try { localStorage.setItem(this.AUTO_AT, String(Date.now())); } catch (e) { /* */ }
    return r;
  },

  /* ---------- v3.10.1 统计聚合（纯函数，设置页表格用） ---------- */
  /* cloud: kline_stats 返回 {stocks,totalBars,first,last,daily:[{d,stocks,bars}]}；
     meta: 本机 meta（syncLog）。返回 {summary, rows}，rows 为表格行（最近在前） */
  statRows(cloud, meta) {
    const out = { summary: '', rows: [] };
    const daily = (cloud && cloud.daily) || [];
    out.rows = daily.map(x => ({
      d: x.d, stocks: x.stocks, bars: x.bars,
      pct: cloud.stocks ? Math.round(x.stocks / cloud.stocks * 1000) / 10 : null,
    }));
    const localTxt = meta && meta.n
      ? `本机 ${meta.n} 只 · 已到 ${meta.targetDate}`
      : '本机暂无（首次回补请到「分析 → 动量筛选」点「开始筛选」或「同步K线库」）';
    if (!cloud || !cloud.stocks) {
      out.summary = localTxt + '；云端暂无数据';
      return out;
    }
    out.summary = `云端 ${cloud.stocks} 只 · 共 ${Number(cloud.totalBars).toLocaleString('zh-CN')} 根日K`
      + ` · 覆盖 ${(cloud.first || '?')} ~ ${(cloud.last || '?')}` + '；' + localTxt;
    return out;
  },

  /* 内存态全库（ensure 之后的只读快照） */
  async all() {
    if (this._map) return this._map;
    this._map = await this.idbAll();
    return this._map;
  },
  /* 状态行（动量页顶部） */
  async statusLine() {
    const meta = await this.metaGet();
    if (!meta.n) return { txt: '本机没有 K 线库，首次使用会自动回补（约 3-5 分钟）', n: 0 };
    const stale = meta.targetDate && meta.targetDate < new Date().toISOString().slice(0, 10) ? '（可能缺最近交易日，建议同步）' : '';
    return { txt: `本机 ${meta.n} 只 · 已到 ${meta.targetDate} · 同步于 ${new Date(meta.at).toLocaleString('zh-CN')}${stale}`, n: meta.n };
  },
};

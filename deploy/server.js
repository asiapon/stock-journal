/* ============================================================
   操作日记 · 自托管后端（v3.10.2）
   ------------------------------------------------------------
   职责两件事：
   1) 静态托管应用本体（仓库根目录：index.html / app.js / kline-store.js / 字典…）
   2) RPC 兼容层：POST /.cloud/database/rest/rpc/<函数名>
      —— 与 WorkBuddy 云端同协议（JSON body 的键 = 函数命名参数），
         直呼 public schema 下的 18 个 SECURITY DEFINER 函数。
      前端零改动：非 WorkBuddy 域名（含 localhost 自托管）自动走相对路径。

   依赖：node >= 18，express，pg（见 package.json）
   配置：同目录 .env（见 .env.example）：PORT / DATABASE_URL / REQUIRE_KEY / ACCESS_KEY

   安全模型：与云端一致 —— 数据访问全部经 18 个 RPC 函数（内部做会话
   token 鉴权 + 表名白名单 + owner_id 隔离），服务器不暴露任何直连表的
   接口。REQUIRE_KEY=1 时额外校验 x-wb-webapp-access-key 头。
   ============================================================ */
'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');

/* ---------- .env 手工加载（不引第三方依赖） ---------- */
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || m[1].startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const REQUIRE_KEY = process.env.REQUIRE_KEY === '1';
const ACCESS_KEY = process.env.ACCESS_KEY || '';

/* RPC 函数白名单：与 schema.sql 一一对应，陌生函数名直接 404 */
const ALLOWED_FN = new Set([
  'app_has_users', 'app_setup_admin', 'app_login', 'app_logout', 'app_change_pwd',
  'app_create_user', 'app_delete_user', 'app_list_users', 'app_reset_pwd',
  'app_query', 'app_insert', 'app_update', 'app_delete', 'app_bulk_insert', 'app_bulk_delete',
  'kline_all', 'kline_upsert', 'kline_status', 'kline_stats',
]);

if (!DATABASE_URL) {
  console.warn('⚠ 未配置 DATABASE_URL（deploy/.env），RPC 将返回 500；静态页面仍可访问。');
}
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, max: 20 }) : null;
if (pool) {
  pool.query('SELECT current_user AS u').then(r => {
    console.log('✓ 数据库自检: current_user =', r.rows[0].u, '| 连接串掩码:', DATABASE_URL.replace(/:[^:@/]+@/, ':***@'));
  }).catch(e => {
    console.error('✗ 数据库自检失败:', e.message, '| 原始串:', JSON.stringify(DATABASE_URL));
  });
}

/* 函数参数名：从 pg_catalog 现取（与建库 DDL 永远一致，不用手维护清单）。
   identity args 形如 "p_token text, p_since date" —— 取每段第一个 token 即参数名 */
const fnArgsCache = new Map();
async function fnArgs(fn) {
  if (fnArgsCache.has(fn)) return fnArgsCache.get(fn);
  const { rows } = await pool.query(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = $1
      ORDER BY p.oid LIMIT 1`, [fn]);
  const names = (rows[0] && rows[0].args || '')
    .split(',').map(s => s.trim().split(/\s+/)[0]).filter(n => n && n !== 'MODE');
  fnArgsCache.set(fn, names);
  return names;
}

const app = express();
const skillpack = require('./skillpack');   // v3.12.0 SKILL.md 技能包运行时
const logger = require('./logger');         // v3.12.4 统一日志：deploy/logs/app-YYYYMMDD.log
app.use(express.json({ limit: '16mb' }));          // kline_upsert 单批约 1.6MB，留足余量
/* CORS 必须在所有路由之前（含 RPC）—— 混合模式下 WorkBuddy 托管的前端会跨域调本服务 */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-wb-webapp-access-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/pack/list', (req, res) => res.json({ ok: true, packs: skillpack.list() }));
app.post('/api/pack/install', async (req, res) => {
  try {
    const { url, name } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, msg: '缺少 url（SKILL.md 地址）' });
    const r = await skillpack.install(String(url), name);
    console.log('[pack] 已安装', r.name, '(', r.functions, '个函数 )');
    res.json(Object.assign({ ok: true }, r));
  } catch (e) { res.status(500).json({ ok: false, msg: e.message || String(e) }); }
});
/* v3.15.1 公网加固：敏感端点必须携带有效会话 token（前端登录后随 x-sj-token 头发送）。
   背景：这些端点此前无鉴权 —— 内网无所谓，暴露公网后任何人都能看日志、跑 Python 技能。 */
async function requireSession(req) {
  const t = req.get('x-sj-token') || '';
  if (!t || !pool) return false;
  try {
    const { rows } = await pool.query('SELECT 1 FROM app_sessions WHERE token = $1 AND expires_at > now()', [t]);
    return rows.length > 0;
  } catch (e) { return false; }
}

app.post('/api/pack/execute', async (req, res) => {
  if (!(await requireSession(req))) return res.status(401).json({ ok: false, msg: '需要登录（token 无效）' });
  try {
    const { pack, fn, args } = req.body || {};
    if (!pack || !fn) return res.status(400).json({ ok: false, msg: '缺少 pack / fn' });
    const t0 = Date.now();
    try {
      const r = await skillpack.runPython(pack, fn, args || {});
      logger.log('pack', 'execute', pack + '.' + fn, true, Date.now() - t0, 'ok', JSON.stringify(args || {}).slice(0, 200));
      res.json({ ok: true, data: r });
    } catch (e) {
      logger.log('pack', 'execute', pack + '.' + fn, false, Date.now() - t0, e.message || String(e), JSON.stringify(args || {}).slice(0, 200));
      throw e;
    }
  } catch (e) { res.status(500).json({ ok: false, msg: e.message || String(e) }); }
});

/* v3.12.4 前端调用日志上报：页面里的每一次外部接口调用（东财/腾讯等）批量落日志文件
   v3.15.1 日志上报也要求会话（日志里含 token 摘录，公网不能裸奔） */
app.post('/api/log', express.json({ limit: '2mb' }), async (req, res) => {
  if (!(await requireSession(req))) return res.status(401).json({ ok: false, msg: '需要登录（token 无效）' });
  const entries = (req.body && Array.isArray(req.body.entries)) ? req.body.entries.slice(0, 100) : [];
  for (const e of entries) {
    logger.log('web', e.kind || 'fetch', e.name || '', e.ok !== false, e.ms || 0, e.detail || '', e.meta || e.src || '');
  }
  res.json({ ok: true, accepted: entries.length });
});
/* 日志查看：最近 n 行 / 下载当天文件 */
app.get('/api/logs/tail', async (req, res) => {
  if (!(await requireSession(req))) return res.status(401).json({ ok: false, msg: '需要登录（token 无效）' });
  const n = Math.min(2000, Math.max(1, parseInt(req.query.n, 10) || 200));
  res.json({ ok: true, file: logger.todayFile(), lines: await logger.tail(n) });
});
app.get('/api/logs/download', async (req, res) => {
  if (!(await requireSession(req))) return res.status(401).json({ ok: false, msg: '需要登录（token 无效）' });
  res.download(logger.todayFile());
});
/* v3.12.6 按交易日的 K 线覆盖统计（对账视图）：
   kline_cache 每行一支票、bars = [日期,开,收,高,低,量,额] ×280 根，
   jsonb 展开按 bar[0]（交易日）聚合——任意一天有多少只票有 K 线一目了然。
   全量展开约 153 万元素（2-5 秒），结果缓存 10 分钟。 */
let _klibDailyCache = null;
app.get('/api/klib/daily', async (req, res) => {
  if (!(await requireSession(req))) return res.status(401).json({ ok: false, msg: '需要登录（token 无效）' });
  if (!pool) return res.status(500).json({ ok: false, msg: '服务端未配置 DATABASE_URL' });
  if (_klibDailyCache && Date.now() - _klibDailyCache.at < 600000)
    return res.json(Object.assign({ ok: true, cached: true }, _klibDailyCache.data));
  try {
    const { rows } = await pool.query(
      `SELECT b->>0 AS day, count(*)::int AS stocks
         FROM kline_cache, jsonb_array_elements(bars) b
        GROUP BY 1 ORDER BY 1 DESC LIMIT 120`);
    const { rows: tot } = await pool.query('SELECT count(*)::int AS n FROM kline_cache');
    const data = { total: tot[0].n, rows };
    _klibDailyCache = { at: Date.now(), data };
    res.json(Object.assign({ ok: true, cached: false }, data));
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});
app.post('/api/pack/remove', async (req, res) => {
  if (!(await requireSession(req))) return res.status(401).json({ ok: false, msg: '需要登录（token 无效）' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, msg: '缺少 name' });
  res.json(Object.assign({ ok: true }, skillpack.remove(name)));
});

/* RPC 兼容层：body 键 = 函数命名参数，缺省补 NULL（如 kline_all 不传 p_since）
   v3.12.4：每次 RPC 调用（查了哪张表/什么参数/几行结果）都记入日志文件 */
app.post('/.cloud/database/rest/rpc/:fn', async (req, res) => {
  const fn = String(req.params.fn || '');
  if (!ALLOWED_FN.has(fn)) return res.status(404).json({ ok: false, msg: '未知接口: ' + fn });
  if (REQUIRE_KEY && req.get('x-wb-webapp-access-key') !== ACCESS_KEY)
    return res.status(401).json({ ok: false, msg: 'access key 不匹配' });
  if (!pool) return res.status(500).json({ ok: false, msg: '服务端未配置 DATABASE_URL' });
  const t0 = Date.now();
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const argsSummary = JSON.stringify(body).slice(0, 300);
  try {
    const names = await fnArgs(fn);
    /* v3.12.6 数组/对象参数 → JSON 字符串：云端平台序列化数组为 JSON（函数声明 jsonb），
       而 node-pg 会把 JS 数组序列化成 PG 数组字面量 '{a,b}' —— jsonb 解析必炸
       （导入的 app_bulk_delete/app_bulk_insert 第一步就报「类型json的输入语法无效」）。 */
    const values = names.map(n => {
      const v = body[n] === undefined ? null : body[n];
      return (Array.isArray(v) || (v && typeof v === 'object')) ? JSON.stringify(v) : v;
    });
    const { rows } = await pool.query(
      `SELECT public."${fn}"(${values.map((_, i) => '$' + (i + 1)).join(', ')}) AS result`, values);
    const out = rows[0] ? rows[0].result : { ok: false, msg: '函数无返回' };
    /* 数据表类调用（app_query/app_insert/...）把查/写的表名也记出来 */
    const table = body.p_table || body.table || '';
    logger.log('rpc', fn, table || fn, true, Date.now() - t0,
      (out && out.rows ? out.rows.length + ' 行' : (out && out.ok === false ? out.msg || 'ok:false' : 'ok')),
      argsSummary);
    res.json(out);
  } catch (e) {
    console.error('[rpc]', fn, e.message);
    logger.log('rpc', fn, body.p_table || '', false, Date.now() - t0, e.message, argsSummary);
    res.status(500).json({ ok: false, msg: '数据库错误: ' + e.message });
  }
});

/* 手动触发 / 状态查询（必须注册在静态与 catch-all 之前） */
app.get('/api/sync/status', (req, res) => {
  res.json({ ok: true, syncAt: SYNC_AT, running: _syncing, last: _lastSync });
});
/* v3.16.0 语音转写代理：手机录音（raw audio）→ 转发硅基流动 SenseVoice → 文字。
   .env 配置：ASR_API_KEY（硅基流动 Key，sfr- 开头；未配置时本接口 501 并给指引）
             ASR_BASE_URL（默认 https://api.siliconflow.cn/v1）
             ASR_MODEL（默认 FunAudioLLM/SenseVoiceSmall） */
app.post('/api/asr', express.raw({ type: () => true, limit: '14mb' }), async (req, res) => {
  if (!(await requireSession(req))) return res.status(401).json({ ok: false, msg: '需要登录（token 无效）' });
  const key = process.env.ASR_API_KEY || '';
  if (!key) return res.status(501).json({ ok: false, msg: '服务器未配置 ASR_API_KEY：请在 deploy/.env 填入硅基流动 Key（sfr- 开头）后重启' });
  if (!req.body || !req.body.length) return res.status(400).json({ ok: false, msg: '没有收到录音' });
  const base = (process.env.ASR_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
  const model = process.env.ASR_MODEL || 'FunAudioLLM/SenseVoiceSmall';
  const t0 = Date.now();
  try {
    const fd = new FormData();
    fd.append('file', new Blob([req.body], { type: req.headers['content-type'] || 'audio/webm' }), 'speech.webm');
    fd.append('model', model);
    const r = await fetch(base + '/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd,
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      logger.log('asr', 'transcribe', model, false, Date.now() - t0, 'HTTP ' + r.status + ': ' + (j.message || j.error || ''));
      return res.status(502).json({ ok: false, msg: 'ASR 服务返回 ' + r.status + (j.message ? '：' + j.message : '') });
    }
    logger.log('asr', 'transcribe', model, true, Date.now() - t0, (j.text || '').slice(0, 80));
    res.json({ ok: true, text: j.text || '' });
  } catch (e) {
    logger.log('asr', 'transcribe', model, false, Date.now() - t0, e.message || String(e));
    res.status(502).json({ ok: false, msg: '转写失败：' + (e.message || e) });
  }
});

app.post('/api/sync/run', async (req, res) => {
  if (REQUIRE_KEY && req.get('x-wb-webapp-access-key') !== ACCESS_KEY)
    return res.status(401).json({ ok: false, msg: 'access key 不匹配' });
  if (!(await requireSession(req))) return res.status(401).json({ ok: false, msg: '需要登录（token 无效）' });
  const r = await runSync('manual');
  res.json(Object.assign({ ok: true }, r));
});

/* 静态：仓库根目录（deploy/ 的上一级） */
const ROOT = path.join(__dirname, '..');
app.use(express.static(ROOT, { extensions: ['html'] }));
/* 其余路径回退到首页（没用前端路由，只是兜底） */
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

/* ============================================================
   v3.10.3 服务端定时采集（真正的 cron，不依赖有人打开网页）
   · 启动 5 秒后先跑一轮：库空 → 全市场回补（3-5 分钟）；
     库已有数据且无新交易日 → 一发请求即跳过；
   · 每天 SYNC_AT（默认 17:30，收盘后）自动增量入库；
   · /api/sync/run 手动触发；/api/sync/status 查看状态。
   ============================================================ */
const ksync = require('./ksync');
const SYNC_AT = process.env.SYNC_AT || '17:30';
let _syncing = false;
let _lastSync = null;

async function runSync(reason) {
  if (!pool) return { skipped: 'no-db' };
  if (_syncing) return { skipped: 'busy' };
  _syncing = true;
  const t0 = Date.now();
  try {
    const r = await ksync.syncAll({
      db: pool,
      onProgress: m => console.log('[ksync]', reason, m),
      /* v3.12.4 每只票的取数明细落日志文件 */
      log: (kind, name, ok, ms, detail, meta) => logger.log('ksync', kind, name, ok, ms, detail, meta),
    });
    _lastSync = Object.assign({ at: new Date().toISOString(), reason, ms: Date.now() - t0 }, r);
    console.log('[ksync] 完成:', JSON.stringify(_lastSync));
    return _lastSync;
  } catch (e) {
    _lastSync = { at: new Date().toISOString(), reason, error: e.message };
    console.error('[ksync] 失败:', e.message);
    return _lastSync;
  } finally {
    _syncing = false;
  }
}

if (pool) {
  setTimeout(() => runSync('startup'), 5000);
  let _lastDay = '';
  setInterval(() => {
    const now = new Date();
    if (ksync.hhmm(now) === SYNC_AT && _lastDay !== now.toDateString()) {
      _lastDay = now.toDateString();
      runSync('cron');
    }
  }, 60 * 1000);
  console.log(`  定时采集: 每天 ${SYNC_AT} 自动增量入库（SYNC_AT 环境变量可改）；启动时自动补齐`);
}

const server = app.listen(PORT, () => {
  console.log(`✓ 操作日记自托管后端已启动: http://localhost:${PORT}`);
  console.log(`  静态根目录: ${ROOT}`);
  console.log(`  数据库: ${DATABASE_URL ? DATABASE_URL.replace(/:[^:@/]+@/, ':***@') : '(未配置!)'}`);
});
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });

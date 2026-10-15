/* ============================================================================
 * 统一日志（v3.12.4）：所有数据调用的明细都落到 deploy/logs/app-YYYYMMDD.log
 * 覆盖三类调用：① 前端外部接口（东财/腾讯等，由页面批量上报）
 *               ② 后端 HTTP/RPC（含 app_query 查的数据表与参数）
 *               ③ Python 技能包执行
 * 行格式：ISO时间 | 来源 | 类型 | 名称 | ok | 耗时ms | 明细 | 附加(JSON)
 * ========================================================================== */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function ymd(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
function todayFile() { return path.join(LOG_DIR, 'app-' + ymd() + '.log'); }

/* 串行追加写：高并发下不阻塞事件循环，也不乱序 */
let _chain = Promise.resolve();
function _append(line) {
  _chain = _chain.then(() => fs.promises.appendFile(todayFile(), line + '\n', 'utf8')).catch(() => { });
  return _chain;
}

function esc(s) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ⏎ '); }

/* log(source, kind, name, ok, ms, detail, meta)：meta 为对象或字符串 */
function log(source, kind, name, ok, ms, detail, meta) {
  const ts = new Date().toISOString();
  const m = meta == null ? '' : (typeof meta === 'string' ? esc(meta) : JSON.stringify(meta));
  return _append(ts + ' | ' + esc(source) + ' | ' + esc(kind) + ' | ' + esc(name) + ' | '
    + (ok ? 'OK' : 'FAIL') + ' | ' + Math.round(ms || 0) + 'ms | ' + esc(detail) + (m ? ' | ' + m : ''));
}

/* 最近 n 行（跨当天与前一天文件合并取尾） */
async function tail(n) {
  const files = [todayFile()];
  const y = new Date(Date.now() - 86400000);
  const prev = path.join(LOG_DIR, 'app-' + ymd(y) + '.log');
  if (fs.existsSync(prev)) files.unshift(prev);
  let lines = [];
  for (const f of files) {
    try {
      const txt = await fs.promises.readFile(f, 'utf8');
      lines = lines.concat(txt.split('\n').filter(Boolean));
    } catch (e) { /* 文件不存在跳过 */ }
    if (lines.length >= n + 50) break;   // 读够了就停
  }
  return lines.slice(-n);
}

module.exports = { log, tail, todayFile, LOG_DIR };

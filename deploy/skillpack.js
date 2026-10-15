/* ============================================================
   股票日记 · SKILL.md 技能包管理（deploy/skillpack.js，v3.12.0）
   ------------------------------------------------------------
   目的：让用户「整包安装」任意符合 a-stock-data 形态的 SKILL.md
   （单文件 Markdown + 内嵌 Python 函数，如 github.com/simonlin1212/a-stock-data）。
   自托管后端有 Python 运行时，可以真正执行它们 —— 浏览器做不到，
   所以整包安装能力落在自托管后端，前端通过 /api/pack/* 调用。

   流程：
   1. install(url)：下载 SKILL.md → 抽出全部 ```python 代码块 → 按原顺序
      合成一个可 import 的模块文件 packs/<名>.py（顶层函数互相可见）→
      用 ast 提取顶层函数清单（含 docstring 首行做说明）→ 写 packs/<名>.json 元数据。
      非交易日/缺依赖在 execute 时才报错，安装只负责「把代码装进来」。
   2. execute(pack, fn, args)：python 子进程 import 模块 → json.dumps(fn(**args))。
      stdout 约定：最后一行是 JSON（函数内 print 的调试输出会被容忍）。
   3. list / remove。
   依赖：node ≥18（全局 fetch）；系统 python3 + requests（缺依赖时 execute
   的错误信息会原样带回，引导用户 pip install）。
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PACK_DIR = path.join(__dirname, 'packs');
if (!fs.existsSync(PACK_DIR)) fs.mkdirSync(PACK_DIR, { recursive: true });

function packPath(name) { return path.join(PACK_DIR, name); }
function safeName(name) { return String(name || '').replace(/[^\w.-]/g, '_').slice(0, 40) || 'pack'; }

/* —— 抽取 SKILL.md 里的 python 代码块 —— */
/* 只要「以 import/def/from 开头」的块：SKILL.md 里混有用法示例（顶层 print/赋值），
   合成模块时把它们排除，否则 import 模块就会执行示例打印。 */
function extractBlocks(md) {
  const blocks = [];
  const re = /```python\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md))) {
    const code = m[1];
    const head = code.slice(0, 400).replace(/^\s+/, '');
    if (/^(import|from|def|async def|#|@)/.test(head) || /\ndef\s+\w+\(/.test(code)) {
      /* 用法示例块可能以 def 开头但结尾带顶层 print —— 去掉顶层 print 行 */
      const cleaned = code
        .split('\n')
        .filter(line => !/^print\(|^zt\s*=|^s\s*=|^for\s+\w+\s+in\s+\w+\[:3\]|^#\s*用法/.test(line))
        .join('\n');
      blocks.push(cleaned);
    }
  }
  return blocks;
}
/* 顶层函数清单（ast 在 python 侧解析更准，这里先正则给前端展示；真执行以 python 为准） */
function extractFunctions(md) {
  const out = [];
  const re = /def\s+([a-zA-Z]\w*)\s*\(([^)]*)\)/g;
  const docRe = /"""([^"]{0,120})/;
  let m;
  while ((m = re.exec(md))) {
    if (m[1].startsWith('_')) continue;
    /* 找函数定义后面最近的 docstring 首行 */
    const after = md.slice(re.lastIndex, re.lastIndex + 500);
    const d = docRe.exec(after);
    if (!out.some(f => f.name === m[1])) {
      out.push({ name: m[1], args: m[2].replace(/\s+/g, ' ').trim(), doc: d ? d[1].trim().split('\n')[0] : '' });
    }
  }
  return out;
}

/* —— 安装：下载（或本地文件）+ Python ast 级合成 + 元数据 ——
   url 支持 http(s):// 与本地路径（file: 前缀或直接给磁盘路径，离线可装）。
   合成交给 synth.py（ast 解析逐块过滤用法示例，保证产出语法正确）；
   安装即需要 python3（执行更需要），未装时报错引导。 */
async function install(url, name) {
  let md;
  if (/^file:/i.test(url)) {
    md = fs.readFileSync(new URL(url).pathname.replace(/^\/(\w:)/, '$1'), 'utf8');
  } else if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error('下载 SKILL.md 失败 HTTP ' + res.status);
    md = await res.text();
  } else {
    md = fs.readFileSync(url, 'utf8');   // 本地磁盘路径
  }
  const safe = safeName(name || 'askill');
  const mdTmp = packPath(safe + '.md.tmp');
  fs.writeFileSync(mdTmp, md);
  const meta = await new Promise((resolve, reject) => {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const p = spawn(py, [path.join(__dirname, 'synth.py'), mdTmp, packPath(safe + '.py')],
      { timeout: 30000, env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }) });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => reject(new Error('Python 启动失败（' + e.message + '）。安装 SKILL.md 技能包需要服务器已安装 Python 3。')));
    p.on('close', code => {
      /* 稳健解析：取最后一个 ===META=== 之后的首个 { 到末个 }（容忍游离字符/\r\n） */
      const idx = out.lastIndexOf('===META===');
      const start = idx >= 0 ? out.indexOf('{', idx) : -1;
      const end = out.lastIndexOf('}');
      if (code !== 0 || start < 0 || end <= start) {
        return reject(new Error('合成失败：' + (err || out).trim().split('\n').slice(-4).join(' | ')));
      }
      try { resolve(JSON.parse(out.slice(start, end + 1))); }
      catch (e) { reject(new Error('合成元数据解析失败: ' + e.message + ' | head=' + out.slice(0, 100))); }
    });
  });
  fs.unlinkSync(mdTmp);
  const functions = meta.functions || [];
  if (!functions.length) throw new Error('SKILL.md 里没有解析到顶层函数');
  /* import 预检：缺依赖立刻报清楚（不阻断安装 —— 用户装完依赖即可用） */
  let importOk = true, importMsg = '';
  await new Promise((resolve) => {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const p = spawn(py, ['-c', 'import ' + safe], { cwd: PACK_DIR, timeout: 60000 });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', () => {
      const m = /ModuleNotFoundError: No module named '([^']+)'/.exec(err);
      if (m) { importOk = false; importMsg = '缺少 Python 依赖 ' + m[1] + '，请在服务器执行: pip install ' + m[1]; }
      else if (err) { importOk = false; importMsg = err.trim().split('\n').slice(-2).join(' ⏎ '); }
      resolve();
    });
  });
  const jsonMeta = { name: safe, url, functions, installedAt: new Date().toISOString(), mdBytes: md.length, blocks: meta.blocks, kept: meta.kept, importOk: importOk, importMsg: importMsg || undefined };
  fs.writeFileSync(packPath(safe + '.json'), JSON.stringify(jsonMeta, null, 2));
  return { name: safe, functions: functions.length, list: functions.map(f => f.name), importOk: importOk, importMsg: importMsg };
}

function list() {
  try {
    return fs.readdirSync(PACK_DIR).filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(PACK_DIR, f), 'utf8')); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}
function remove(name) {
  const safe = safeName(name);
  for (const ext of ['.py', '.json']) { try { fs.unlinkSync(packPath(safe + ext)); } catch (e) { /* 不存在忽略 */ } }
  return { removed: safe };
}

/* —— 执行：python 子进程调用模块内函数（文件式运行器 _runner.py；
   结果写文件而非 stdout —— mootdx 等库的进度条会异步污染 stdout） —— */
function runPython(pack, fn, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const resultFile = path.join(PACK_DIR, '_result.json');
    try { fs.unlinkSync(resultFile); } catch (e) { /* 不存在忽略 */ }
    const p = spawn(py, [path.join(PACK_DIR, '_runner.py'), safeName(pack), String(fn), JSON.stringify(args || {}), resultFile], {
      cwd: PACK_DIR, timeout: timeoutMs || 60000,
      env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }),
    });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => reject(new Error('Python 启动失败（' + e.message + '）。请确认服务器已安装 Python 与依赖（pip install requests pandas）。')));
    p.on('close', code => {
      let raw = null;
      try { raw = fs.readFileSync(resultFile, 'utf8'); } catch (e) { /* 没写出来 = 执行失败 */ }
      if (code !== 0 || raw == null) {
        const lines = (err || out).trim().split('\n');
        const last = lines[lines.length - 1] || '';
        return reject(new Error('Python 执行失败：' + last
          + (lines.length > 1 ? ' ｜ 详见：' + lines.slice(-4).join(' ⏎ ') : '')));
      }
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('结果解析失败：' + raw.slice(0, 200))); }
    });
  });
}

module.exports = { extractBlocks, extractFunctions, install, list, remove, runPython, PACK_DIR };

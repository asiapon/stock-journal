# 股票日记 · 自托管部署包

把自己的服务器（Ubuntu / Windows）变成运行环境：Node.js 后端 + PostgreSQL，与 WorkBuddy 云端**同协议同构**，前端零改动。

```
deploy/
├── install-ubuntu.sh        Ubuntu/Debian 一键安装（sudo bash install-ubuntu.sh）
├── install-windows.ps1      Windows 一键安装（管理员 PowerShell）
├── start-windows.bat        Windows 启动脚本（装完自动生成）
├── stock-journal.service    systemd 服务模板（Ubuntu 装完自动注册）
├── schema.sql               数据库全量 DDL（9 表 + 18 个 RPC 函数，幂等可重复执行）
├── server.js                后端：静态托管 + RPC 兼容层 + 定时采集调度
├── ksync.js                 服务端 K 线采集模块（定时任务的核心）
├── package.json             后端依赖清单
└── .env.example             配置样例（端口 / 数据库连接 / 采集时刻 / 密钥开关）
```

## 服务端定时采集（不需要任何人打开网页）

后端是常驻进程，内置真正的定时任务：

- **每天 `SYNC_AT` 时刻（默认 17:30，收盘后）自动增量入库**全市场日K——只补缺的票，平时几秒到一两分钟；
- **后端启动时自动补齐一次**：库为空则全市场回补（3-5 分钟），已有数据且无新交易日则一发请求即跳过（周末/节假日零成本）；
- `POST /api/sync/run` 手动立即采集；`GET /api/sync/status` 查看上次采集结果；
- 时刻可改：`.env` 里 `SYNC_AT=18:00`。

这意味着：**装好服务器后，K 线库每天自动生长，动量筛选随时打开随时是最新数据**，浏览器的「打开应用时自动同步」变成双保险而非唯一入口。

## Ubuntu（一行命令）

```bash
sudo bash install-ubuntu.sh
```

自动完成：系统依赖 → Node 20（缺才装）→ PostgreSQL（缺才装）→ 建角色/建库 → 导入 schema → npm 依赖 → 写 .env → 注册 systemd 服务（开机自启、崩溃自动拉起）→ 健康检查。

## Windows（管理员 PowerShell）

```powershell
cd deploy
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

自动完成：Node LTS（winget）→ PostgreSQL 16（winget）→ 建角色/建库/schema → npm 依赖 → .env → `start-windows.bat`。加 `-AutoStart` 可注册登录自启（计划任务）。装完双击 `start-windows.bat` 即启动。

## 装完之后

1. 浏览器打开 `http://<服务器IP>:3000`（首次显示「首次初始化」表单 → 设置管理员账号密码）；
2. 数据迁移：在旧云端应用「设置 → 数据管理 → 导出 JSON 备份」，再在新部署的同一位置「导入 JSON」；
3. 动量筛选首次回补：分析 → 动量筛选 → 开始筛选（或「同步K线库」）。

## 升级

```bash
git pull            # 拿到新代码
sudo bash install-ubuntu.sh   # 或 Windows 重跑 install-windows.ps1
```

schema.sql 幂等，重跑不会动已有数据；后端 `systemctl restart stock-journal`（Ubuntu）或重开 bat（Windows）。

## 与 WorkBuddy 云端的差异

| 能力 | 自托管 | 说明 |
|---|---|---|
| 交易/自选/行情缓存/日志/问答历史 | ✅ 完全一致 | 同一套 18 个 RPC 函数 |
| K 线库（动量筛选） | ✅ 完全一致 | kline_cache 表随 schema 建 |
| 云端 LLM（免密钥模型） | ❌ 不可用 | 用「设置 → 模型 → 自定义模型」配你自己的 API Key 即可 |
| HTTPS | 自理 | 局域网 HTTP 够用；公网建议 Caddy 反代（3 行配置自动签证书） |

## 安全要点

- 数据访问全部经 18 个 RPC 函数：内部做会话 token 鉴权（30 天）、表名白名单、owner_id 行级隔离——服务器不暴露任何直连表接口；
- 数据库密码随机生成并写入 `deploy/.env`（脚本输出会提示），`.env` 已在 git 忽略范围内的话请自行保管好；
- 公网部署：建议改 `REQUIRE_KEY=1` + 自定义 `ACCESS_KEY`，并套一层 Caddy/Nginx 上 HTTPS；
- 备份：`pg_dump -U stockjournal stockjournal > backup.sql` 一条命令全量备份。

## 两种客户端的访问方式（混合模式）

部署到自己的服务器后，有两个入口，共用同一个后端和数据库：

**客户端 1：自托管前端（同源，最简单）**
- 浏览器直接打开 `http://服务器IP:3000`（局域网/本机），一切功能同源直连，零配置。

**客户端 2：WorkBuddy 托管的前端（它就是你的"域名"）**
- WorkBuddy 托管的页面是 HTTPS，按浏览器混合内容规则，它**不能**调用 `http://IP` 的接口 —— 后端必须是 HTTPS。纯 IP 签不了受信证书，推荐零成本方案：注册一个免费二级域名（如 DuckDNS），解析到你服务器 IP，再用 Caddy 反代自动签证书：

  ```
  # Caddyfile（服务器上装 Caddy 后直接运行）
  api.你的名字.duckdns.org {
      reverse_proxy localhost:3000
  }
  ```

- 然后在 WorkBuddy 托管的页面里：**设置 → 技能 → 「后端服务器地址」填 `https://api.你的名字.duckdns.org` → 保存 → 刷新页面**。此后数据、账号、技能包全部走你自己的服务器；清空该地址并刷新 = 随时切回 WorkBuddy 云端，两边互不干扰。

**未来微信小程序**：小程序的 request 合法域名要求「备案过的 HTTPS 域名」，纯 IP 不允许 —— 所以上面那个域名建议尽早转正（买个便宜域名做备案），后端 API 完全复用。

**数据迁移**：WorkBuddy 云端「设置 → 数据管理 → 导出 JSON 备份」→ 自托管站同位置「导入」；K 线库在新站点一次「同步K线库」即可重建。

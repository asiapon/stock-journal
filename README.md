# stock-journal · 操作日记（重构版）

个人交易信息管家：持仓 / 操作记录 / 自选 / 费率与日志。这是 trade-manager 的重构起点——先做扎实的**记录与核算**，分析功能在数据积累后再上。

## 功能（v2.0 基础版）

- **今日**：持仓快照（总市值 / 浮动盈亏 / 今日已实现 / 持仓只数）、自选关注、快捷记一笔（自然语言解析）、近期操作
- **持仓**：双口径成本（移动加权平均 = 统计权威；摊薄成本 = 展示参考）、手动改价、仓位占比条、单票买卖明细与逐笔已实现盈亏
- **操作**：记一笔（费用按三市费率自动计算，五项费用明细可展开）、筛选、编辑、删除（二次确认）
- **自选**：分组、现价/昨收手动录入、涨跌幅、关注标记
- **我的**：三市费率配置 + 费用试算、JSON 导出/导入、清空数据、操作日志、账号改密、管理员用户管理

## 双模式部署

### 1. 云端（WorkBuddy 平台，已发布）

应用「操作日记」，数据存 WorkBuddy 云数据库（PostgreSQL，按账号隔离，跨设备同步）。

- 独立用户系统：首次访问需**初始化管理员**，之后由管理员在「我的 → 用户管理」创建账号（首次登录强制改密）
- 前端为纯静态单页应用，后端为数据库 RPC 函数（`app_login` / `app_query` / `app_insert` / `app_update` / `app_delete` 等）

### 2. 本地

```bash
# Windows 双击 start.bat，或：
./start.sh          # macOS / Linux
# 本质：任意静态服务器即可
python -m http.server 8080
```

浏览器打开 http://localhost:8080 。本地模式下云端不可达时**自动切换 localStorage 存储**（右上角显示"本地"徽标），数据仅存本机，请定期「导出 JSON 备份」。

## 架构

```
index.html / app.js / style.css   ← 纯静态 SPA，零依赖
        │  fetch（REST RPC）
        ▼
WorkBuddy 云数据库（PostgreSQL）
  ├─ trades / watchlist / quotes / settings / op_logs（RLS 按用户隔离）
  └─ app_users / app_sessions + app_* RPC（登录、CRUD、用户管理）
```

- 费用口径：佣金（‰，最低收费）、印花税（卖出）、过户费、经手费、证管费；沪 / 深 / 北三市独立配置，可在「我的」调整
- 成本核算：移动加权平均（只在买入时重算成本价，卖出只减份额），每笔卖出按成交时成本价计算已实现盈亏；摊薄成本仅作展示
- 后续规划（分析层）：轮次（round trip）统计、纪律执行度、买入理由标签交叉分析、买点质量、AI 周报——数据库设计见 `schema.sql`

## 文件

| 文件 | 说明 |
|---|---|
| `index.html` / `app.js` / `style.css` | 前端应用 |
| `schema.sql` | 完整 PostgreSQL 设计（rounds / transactions / fee_schedules 等，分析层地基） |
| `start.bat` / `start.sh` | 本地一键启动 |

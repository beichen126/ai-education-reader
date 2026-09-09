# 开发者文档

本文面向需要运行、测试或贡献 AI Education Reader 的开发者。面向普通用户的产品说明请阅读仓库根目录的 [README.md](../README.md)。

## 环境

- Node.js `>=20.0.0 <26`；
- npm；
- Microsoft Edge（本地浏览器 E2E 默认使用）或 CI 使用的 Chromium；
- Windows、macOS、Linux 均可运行 Vite 构建；部分本地浏览器脚本会根据系统选择 Edge/Chromium。

## 安装和启动

```bash
npm install
npm run dev
```

开发服务器启动后，打开终端显示的本地地址。应用是浏览器本地优先产品，不需要项目后端或数据库服务。

## 常用命令

```bash
npm run typecheck       # TypeScript 类型检查
npm test                # 全部离线 unit/domain 回归
npm run build           # production 构建
npm run preview         # 预览 production 构建
npm run test:release    # release runner：类型、全量测试、构建和关键 E2E
npm run test:readme-contract # README 结构、链接、图片和事实契约
npm run docs:screenshots     # 从 production preview 生成 README 截图
```

`npm test` 不调用付费模型；AI 目录等需要模型的浏览器测试使用确定性 mock。真实 API smoke 不属于默认 CI，执行前不要把 API Key 写入仓库、Issue、日志或 Backup。

## 测试分层

### Typecheck

```bash
npm run typecheck
```

验证 TypeScript 类型和构建期模块引用。

### Unit / domain / storage

```bash
npm test
```

覆盖会话、草稿、流式输出、Prompt、PDF Context、目录、文档、页面笔记、备份、OPFS/IndexedDB 和导出等领域逻辑。单项脚本可在 `package.json` 的 `test:*` 中查找。

### Browser E2E

关键脚本位于 `scripts/e2e-*.mjs`，在 production preview 上运行真实用户行为。常用方式：

```bash
npm run build
npm run preview -- --port 5299
# 另开终端运行目标 e2e 脚本
npm run test:e2e-document-context
npm run test:e2e-conversation-modes
npm run test:e2e-bookmark-range
```

发布门禁使用 `npm run test:release` 管理 preview 生命周期；不要通过删除 assertion 或把行为改成内部状态断言来“修复” E2E。

### Build 和 release gate

代码改动至少运行 typecheck、相关 domain 测试、相关 browser E2E 和 build。进入发布前还要运行：

```bash
npm run test:release
git diff --check v2.0.3..HEAD
```

Pages workflow 会在构建后执行 browser gate；browser gate 失败时不应宣称部署完成。

## README 截图

`npm run docs:screenshots` 使用 production build、仓库内 `test/fixtures` 的确定性 PDF 和 mock AI 目录生成 `docs/assets/readme/v210-*.webp`。脚本不会读取个人资料或 API Key。

如果使用非默认端口：

```powershell
$env:E2E_BASE = 'http://localhost:5299/ai-education-reader/'
npm run docs:screenshots
```

截图属于文档资产，不替代 browser E2E；更新截图后要检查 README 引用的每一张图片都存在。

## 文档契约

```bash
npm run test:readme-contract
```

契约测试检查 README 的固定用户章节、FAQ 数量、Zotero/AI 网页端差异说明、产品信息顺序、五张高信息量截图及其 HTML 路径、仓库内链接、版本 badge、已删除入口和 PDF Context 的 30/120 页事实。新增产品入口或改变实际阈值时，应先更新产品实现/测试，再更新 README 契约。

## 代码组织

- `src/documents`：PDF 文档、目录、Reader、Context 和页面笔记；
- `src/pdf`：PDF 类型、页码范围、渲染和上下文限制；
- `src/prompts`：会话模式、学习成果、快捷追问和系统协议；
- `src/engine`：会话、附件、草稿和消息持久化；
- `src/storage`：IndexedDB、OPFS 和本地存储边界；
- `src/export`：Backup 导入导出与校验；
- `docs/ARCHITECTURE.md`：内部架构说明；
- `scripts`：领域测试、浏览器 E2E、发布 runner 和文档截图工具。

用户文案应优先放在 README 或后续 Stage 4 的产品说明单一来源中；不要把内部字段、migration 版本或 generation token 堆进普通用户章节。

## 贡献约定

1. 先确认任务范围和当前 `main`/`origin/main` 状态；
2. 每个 Stage 保持独立 commit，commit message 说明单一目的；
3. 代码改动必须附对应测试，失败时保留首次失败原因；
4. 不提交 API Key、真实教材、Backup JSON 或个人截图；
5. 提交前检查 `git diff --check`、测试结果和 working tree；
6. 推送前确认远端分支与本地 commit 一致。

## 数据兼容提示

IndexedDB schema、Backup schema、消息来源和文档所有权属于高风险改动。涉及它们时必须补充旧数据读取、旧 Backup 导入、新 Backup round-trip 和失败回滚测试，并在固定开发汇报中记录证据。只改文档时不需要 Pages 部署验证；改代码时必须等待对应 CI/Pages gate 结果。

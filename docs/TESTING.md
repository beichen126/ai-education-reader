# Testing — AI Education Reader

本文档说明 v1.0.0 的测试分层与如何运行。所有测试默认本地、离线（除标注的 paid smoke）。

## 快速运行

```bash
npm test           # 全部单元/领域测试（test:all，无网络）
npm run typecheck  # tsc --noEmit
npm run build      # production 构建
npm run test:pdf-codec   # PDF Codec（浏览器专用）
```

## 分层

### 1. 单元 / 领域

用 tox（`npx tsx`）驱动，无浏览器、甚至无真实 PDF 的纯逻辑测试：

- 缩放/平移数学（`test:zoom`）、表格操作、Math 解析
- 会话 / 草稿 / 附件 / 发送 / 持久化（`test:session-lifecycle`, `test:draft-*`）
- 标注（annotation-ops / annotation-storage / annotation-ownership）
- 备份校验与安全/来源（`test:backup-validation`, `test:backup-security`）
- PDF 书签解析、多范围、附件、运行时资源（`test:pdf-*`）
- 章节模型、Document 模型/存储/备份/来源（`test:document-*`）
- Document → Context 领域（`test:document-context`）、Context 渲染（`test:context-render`）
- AI TOC 转录、提示词、全局结构、同页歧义（`test:ai-toc`, `test:toc-*`）
- 大上下文限制（页数 / 字节预算 / 图片预算，`test:large-context`）
- 导出：PDF Outline Writer（`test:pdf-outline-writer`）、Markdown+图片 Bundle（`test:conversation-bundle`）

### 2. 存储

OPFS / IndexedDB / 迁移 / 诊断：`test:opfs-storage`, `test:document-migration`, `test:binary-store`, `test:backup-*`, `test:storage-diagnostics`。

### 3. PDF Codec

`npm run test:pdf-codec` 在浏览器环境验证 PDF 编解码（输出非纯文本，需浏览器）。

### 4. 浏览器 E2E（Edge / Chromium）

用 Playwright-core + Microsoft Edge 对 production preview 跑真实交互。
运行前：`npm run build` + `npm run preview -- --port 5299`。

脚本在 `scripts/e2e-*.mjs`。关键 E2E：

- `e2e-document-context`：Composer 入口 → 选 PDF → 章节选择 → 加入 Draft（断言**实际** Draft 输出与 provenance，非仅状态消息）。
- `e2e-document-reader`：Reader 生命周期、加入对话祖先/手动、取消。
- `e2e-theme` + `e2e-theme-computed`：system/light/dark 切换、刷新持久化、计算样式非 light 值。
- `e2e-ai-toc` / `e2e-toc-review-layout` / `e2e-toc-thumbnails` / `e2e-native-toc` / `e2e-toc-layout`。
- `e2e-chapter-builder`、`e2e-settings-byok`、`e2e-viewer-edge`、`e2e-opfs-storage`、`e2e-opfs-migration`、`e2e-stage*`、`e2e-responsive`。


### 5. 响应式

`e2e-responsive` 覆盖桌面 / 平板 / 手机的布局收敛；`e2e-toc-*` 与 `e2e-chapter-builder` 内含 360px / 768px / 1024px / 1280px 的溢出与可点性断言。

### 6. 确定性 AI mock

- AI TOC 使用 `window.__dshMockAiToc` 测试缝（返回转录 JSONL + 结构 JSON），无需真实付费 API。
- 应用**永不**把 AI 当作持久化权威——识别结果只是草稿，需人工检查后保存。

### 7. 真实付费 AI smoke

- 调用真实 DeepSeek 的行为**不是**默认 CI；需配置真实 API Key、网络与额度。
- 此类冒烟仅本地手动执行：`testConnection`（GET /models）验证服务可达与 Key 有效；视觉识别走 `e2e-ai-toc` 的 mock 路径。

## 一致性保证

- `npm test` 以 `&&` 串联：任一失败即中断，保证全套通过。
- E2E 断言真实产物（Draft、附件字节、导出 ZIP 字节、provenance），不为通过而放宽为"出现消息"或"出现过进度"。

## 截图（文档工具，非测试）

`npm run docs:screenshots` 由 production build 生成 `docs/assets/readme/*.webp`，仅用于 README，不进 `npm test`。


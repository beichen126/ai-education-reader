# AI Education Reader

AI 学习阅读器：面向教材、讲义、论文和学习资料的 AI 学习阅读器。你决定 AI 现在看哪里。

## What it does

- 上传教材/题目/笔记图片，直接进入对话；
- 打开 PDF，选择页面范围；
- 带书签（Outline/Bookmarks）的 PDF 可直接选择章节；
- PDF 页面以“PDF Context Group”作为一个整体加入学习上下文；
- 支持 30–120 页的大章节安全处理；
- 发送后由你配置的 (DeepSeek) Vision 模型作答。

## Why

用户明确选择当前学习的内容（User-controlled Context），系统把这段内容交给视觉 AI。
不是“全书 OCR → chunk → embedding → vector DB → retrieval”的 RAG 知识库。

## Privacy / Local-first

- PDF 在浏览器本地用 PDF.js 读取与渲染：**打开 PDF ≠ 上传整个 PDF**；
- API Key 保存在浏览器本地，发送时浏览器直连你配置的 API 服务（默认 https://api.deepseek.com）；
- **本项目（当前 GitHub Pages 版本）没有自己的应用后端，没有中转服务器**；
- 仅在真正发送消息时，选中的图片/PDF 页面与聊天上下文才发送到你配置的 API 服务；
- 数据（会话、图片附件、PDF 页面、标注、设置）保存在浏览器 IndexedDB 本地；
- 无产品分析/广告追踪代码。详见 [PRIVACY.md](./PRIVACY.md)。

## Quick Start

1. 打开在线 Alpha（见下方部署说明 / GitHub Pages 链接）；
2. 在设置中填写你自己的 DeepSeek API Key（BYOK）；
3. 上传图片，或打开 PDF（有书签可按章节，无书签手动选页）；
4. 加入学习上下文，开始提问。

## Local Development

```bash
npm install
npm run dev      # 开发模式（Vite）
npm run build    # 产出 dist/
npm run typecheck
npm run preview  # 预览 production build
```

单元测试（核心逻辑，无网络）：`npm run test:pdf-outline`、`npm run test:pdf-attach`、
`npm run test:attachment-display`、`npm run test:large-context`、`npm run test:backup-source` 等。

## Current Limitations (Alpha)

- 单次 PDF Context 最多 120 页（产品安全限制，非模型限制），单次请求图片数据有 30 MiB 内联预算；
- 采用 inline Base64 图片（Chat Completions），尚未使用 Files API；
- 需要选择支持视觉输入的模型（默认 `deepseek-v4-flash-vision-exp`）；
- 不含 OCR / 自动目录识别：无书签 PDF 请手动选择页码；需要章节式导航时，可先用任意 PDF 工具生成标准 Outline/Bookmarks；
- 不含 PDF Reader / 双栏阅读工作区；
- 不含云同步 / 登录 / 账户。

## Contributing & Security

社区共建欢迎：见 [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [SECURITY.md](./SECURITY.md)。
**不要在 Issue 中提交 API Key、备份 JSON 或私人教材。**
请使用仓库内的 Issue 模板（bug_report / feature_request）。

## License / Attribution

本项目代码采用 MIT License（见 [LICENSE](./LICENSE)）。

- 代码与设计 token 部分来自 DeepSeek Harness (DSH) 上游 Web UI：MIT，版权归 DeepSeek（见 [LICENSE](./LICENSE) 与 [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES)）；
- PDF.js (pdfjs-dist)：Apache-2.0，Mozilla 基金会（见 THIRD_PARTY_NOTICES）；
- 其余依赖见 package.json。
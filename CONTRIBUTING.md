# Contributing

欢迎贡献。请保持简洁、本地优先、无后端的原则。

## Getting started

```bash
npm install
npm run dev       # local dev (Vite)
npm run typecheck
npm run build
```

## Running tests

```bash
npm run test:pdf-outline
npm run test:pdf-outline-real
npm run test:attachment-display
npm run test:large-context
npm run test:pdf-attach
npm run test:backup-security
npm run test:multimodal
```

## Issues / PRs

- Bug 与功能建议都用 GitHub Issue（模板见 .github/ISSUE_TEMPLATE）。
- PR 前请先运行 `npm run typecheck` 与相关测试。
- 新功能请先开 Issue 讨论方向，避免大 PR 无讨论。

## 隐私提醒（重要）

**请不要在 Issue / PR 中提交：**

- DeepSeek API Key 或任何 token；
- backup JSON（含会话/图片）；
- 私人教材 PDF；
- 含个人信息的截图或数据。

需要日志时，请先脱敏（移除 API Key、文件名、个人信息）。

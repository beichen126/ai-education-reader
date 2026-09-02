# ai-education-reader

AI Learning Reader（AI for Education Reader，中文名“AI 学习阅读器”）产品版——面向教材、讲义、论文与学习资料的 AI 学习阅读器。

> 产品版：自 [dsh-eink-client](../dsh-eink-client) 个人版完整复制而来，作为未来公开发布的产品基线。两个项目独立开发、独立维护，互不产生运行时依赖。

- 视觉/交互：来源于 DeepSeek Harness（DSH）Web UI 的 React 组件与 `--dsw-*` 设计 token。
- 数据层：本地 service 层 → DeepSeek API（文本/多模态）+ IndexedDB（设置/聊天）。
- **不依赖**：全局 DSH 安装、DSH Node Host、Cordis Host、`/api/*` RPC、WebSocket、DSH Agent/Tool/Workspace 后端。

## 上游来源与许可证

- 上游仓库：https://github.com/deepseek-ai/deepseek-harness (branch `master`, commit `0a53fb55bea101816fa226bb964ae2bed71c343b`)
- 上游许可证：MIT（MIT 全文见本仓库根目录 [LICENSE](./LICENSE)，版权归 DeepSeek 所有；来源与归属详见 [THIRD_PARTY_NOTICES](./THIRD_PARTY_NOTICES)）。
- 从上游 `packages/client/*`、`apps/web` 复制到本工程的任何文件均保留原始版权/许可证信息；本工程当前为个人使用，但保持来源可追踪。
- `vendor/dsh/` 仅为上游源码参考与迁移来源，被 .gitignore 排除、不进入公开仓库，也不是构建/运行依赖；因此上游 MIT 全文以根目录 `LICENSE` 形式随公开仓库一起发布。

## 与全局 DSH 的关系

1. 全局安装的 `@deepseek-ai/dsh`（全局 `@deepseek-ai/dsh` 安装目录）**保持完全只读**，任何情况下不修改。
2. 全局 DSH 基线见 `DSH_BASELINE.json`（每个文件的 SHA256 + 长度 + mtime）。关键阶段后重算比对，任何变化视为失败。
3. `vendor/dsh` 仅为上游源码参考与迁移来源，**不是最终工程的运行时或构建依赖**。临时移走 `vendor/dsh` 后，`npm install` + `npm run build` 仍须独立成功。

## 构建

```bash
npm install
npm run build   # 产出 dist/
```

预期 `dist/` 结构：`index.html` + `assets/*.js` + `assets/*.css` + 静态资源，可部署到任意标准 HTTPS 静态托管。

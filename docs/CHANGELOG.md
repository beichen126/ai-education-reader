# Changelog

AI Education Reader 的用户可感知更新记录。

格式参考 Keep a Changelog，但保持简洁。开发中的改动先进入 `Unreleased`，正式发布 tag 时再移动到对应版本。

## [Unreleased]

### Added

- PDF Outline 支持多章节选择（真实 checkbox，展开/选择分离）。
- 支持多个不连续 PDF 页码范围作为同一 Context：选择章节 → 规范化范围 → 去重 → 合计页数 → 渲染 → 一个 PDF Context Group 加入对话。

### Changed

- PDF Context 页数限制改为按照去重后的真实页面数计算（父章节 + 子章节重叠不再重复计数）。
- PDF 加入 Draft 后不再自动关闭选择窗口，可连续添加多组 Context（提供“完成”关闭）。
- PDF Context 卡片支持多范围显示（如 `PDF 30–48, 100–118`），不再把多范围压回一个假连续区间。

### Planned

- PDF 章节多选：允许一次选择多个不连续章节并统一加入 AI Context。
- 新增“文件”资料入口和完整 PDF Reader，可阅读未加入 AI Context 的页面。
- 统一 Document → Chapter → Context 数据模型。
- 无书签 PDF 支持目录页缩略图选择、AI 目录识别与手动分章。
- 支持导出带章节书签的新 PDF。
- PPT / PPTX 作为导入格式：浏览器本地转换为 PDF 后复用完整 PDF 阅读链路，不建设第二套 PPT Reader。
- 图片查看器缩放控件改为瞬时 HUD：缩放发生时显示比例，停止缩放约 3 秒后自动隐藏。

---

## [v0.1.0-alpha.3] - 2026-09-02

### Fixed

- 修复图片查看器放大后平移边界不对称的问题；改为以画布中心为坐标原点的对称钳制。
- 修复大图查看器焦点管理：打开时焦点进入关闭按钮，关闭后恢复到原入口元素。
- 草稿图片缩略图支持键盘 Enter / Space 打开大图。

### Changed

- 扩充缩放 / 平移数学测试，新增四方向边界测试。
- 增加 Edge 浏览器大图查看器 E2E 验收脚本。
- `npm test` 纳入此前遗漏的 PDF、备份、安全、附件、大上下文与缩放测试。

---

## [v0.1.0-alpha.2] - 2026-09-02

### Added

- 新增统一的全屏图片查看器 `ZoomableImageDialog`。
- 支持鼠标滚轮中心缩放、拖拽平移、双指捏合、双击缩放、键盘 `+ / - / 0 / ← / →`。
- 支持消息图片、待发送图片、PDF Context 页面共用同一查看器。
- PDF Context 页面支持组内上一张 / 下一张浏览。
- 新增产品截图与新版 README 产品页。

### Changed

- 编辑器输入区的图片 / PDF 按钮改为正确的图片和文档图标，不再使用错误的麦克风图标。
- 图片查看器将 `scale=1` 定义为真正的 fit-to-viewport。

---

## [v0.1.0-alpha.1] - 2026-09-02

### Added

- 首个公开 Alpha 版本。
- 图片上传与视觉模型问答。
- PDF 浏览器本地读取与渲染。
- PDF 原生 Outline / Bookmark 解析。
- 按章节或手动页码选择 PDF Context。
- PDF Context Group 分组显示。
- 30–120 页大章节处理与本地安全限制。
- IndexedDB 本地会话、附件、草稿、设置持久化。
- BYOK API 配置与浏览器直连模型服务。
- GitHub Pages 在线部署。
- 开源仓库基础文档：README、PRIVACY、SECURITY、CONTRIBUTING、LICENSE、Issue 模板。

### Notes

- 当前 Alpha 不包含完整 PDF Reader、无书签 PDF 自动目录识别、云同步或账户系统。

# Changelog

AI Education Reader 的用户可感知更新记录。

格式参考 Keep a Changelog，但保持简洁。开发中的改动先进入 `Unreleased`，正式发布 tag 时再移动到对应版本。

## [Unreleased]

### Fixed

- 修复 PDF Reader 返回文件库或切换文档后旧 PDF session / 页面预览未及时释放，以及再次导入 PDF 时按钮状态未恢复的问题。
- 修复多个同级章节从同一 PDF 页面开始时目录无法保存的问题。
- 修复 AI 目录中待确认页码可能被错误当作 PDF 第 1 页保存的问题。
- 修复“继续检查”和未检查目录保存确认行为。

### Changed

- AI 目录识别改为“视觉转录 → 全局结构判断”，避免目录跨页时因分批识别破坏层级。

### Added

- 新增本地“文件”资料入口，可查看和管理保存在浏览器中的 PDF 学习文档。
- 新增完整 PDF Reader，可阅读整份文档、通过章节目录和页码导航，并自动恢复上次阅读位置。
- PDF Reader 支持将当前页、当前章节或指定页码范围直接加入当前对话的 AI Context，无需重新上传或重新定位 PDF。
- 建立本地 Document Store：原始 PDF 可作为独立学习文档保存在浏览器 IndexedDB 中，为后续完整文件阅读器提供数据基础。
- PDF Context 新增来源文档引用，可追溯到对应的本地 Document。
- 统一 Document → Chapter → Context 数据模型（原始资料 → 书签/AI 目录/手动章节 → 发送给 AI 的页码集合）。
- PDF Outline 支持多章节选择（真实 checkbox，展开/选择分离）。
- 支持多个不连续 PDF 页码范围作为同一 Context：选择章节 → 规范化范围 → 去重 → 合计页数 → 渲染 → 一个 PDF Context Group 加入对话。
- 无原生目录的 PDF 可在 Reader 中手动创建和编辑章节，保存后可直接用于章节导航与 AI Context。
- 支持整理 PDF 自带目录，并可随时恢复 PDF 原始目录；整理结果仅保存在本地，不修改原 PDF。
- 支持选择 PDF 目录页并通过视觉模型生成目录草稿，识别后可逐项跳转检查、调整并确认保存。
- 设置页新增 BYOK 使用说明与 DeepSeek 开放平台入口。

### Changed

- 重构侧栏资料入口，将“图片”和“文件”明确分离，并以统一图标替代原有单字快捷按钮。
- 图片 / PDF 页面全屏查看器不再常驻显示缩放工具条；缩放时仅显示当前百分比，并在最后一次缩放约 3 秒后自动隐藏。
- PDF Context 页数限制改为按照去重后的真实页面数计算（父章节 + 子章节重叠不再重复计数）。
- PDF 加入 Draft 后不再自动关闭选择窗口，可连续添加多组 Context（提供“完成”关闭）。
- PDF Context 卡片支持多范围显示（如 `PDF 30–48, 100–118`），不再把多范围压回一个假连续区间。
- 设置窗口在桌面端加宽，改善 API 配置、提示词和本地数据管理的可读性。

### Planned

- 支持导出带章节书签的新 PDF。
- PPT / PPTX 作为导入格式：浏览器本地转换为 PDF 后复用完整 PDF 阅读链路，不建设第二套 PPT Reader。

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
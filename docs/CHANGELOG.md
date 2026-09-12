# Changelog

AI Education Reader 的用户可感知更新记录。

格式参考 Keep a Changelog，但保持简洁。正式发布的改动按版本记录，未发布改动再单独进入 `Unreleased`。

## [2.2.0] - 2026-09-12

### Added

- **学习卡片**：在任意已完成 AI 回复的「⋯」菜单里选择「保存本轮回复为学习卡片」，即可把这条回复原样收藏。保存不调用 AI、不消耗额度，正文就是那条回复本身；同一条回复重复保存只有一张卡。
- **学习中心**：侧栏「学习 → 学习卡片」打开全局学习中心，含「学习卡片 / 学习成果」两个分类。卡片可查看标题、正文摘要、来源会话与来源 PDF、创建与最近打开时间，并支持按来源 PDF 筛选、搜索、重命名、删除与五种排序（含稳定随机顺序）。
- **上一张 / 下一张**：卡片详情按打开时的筛选与排序结果翻阅，边界按钮真实禁用；每张真正显示的卡片会记录一次最近打开时间。
- **双向回链**：卡片可「返回原会话」到精确的会话、分支与那条 AI 回复；可打开来源 PDF 的精确页（多页时提供页码按钮）。Reader 的「关于此页」同时列出这一页相关的会话与学习卡片。
- **备份 V7**：完整备份 JSON 从本版起包含学习卡片与卡片列表偏好（仍不含 API Key）；V1–V6 备份继续可导入，导入后卡片为空且偏好重置。
- 学习卡片的“来源已删除”语义：删除原会话或 PDF 不会删除卡片，卡片正文与来源快照仍可读，跳转按钮变为不可用，应用不会按标题猜同名会话。

### Changed

- **PDF 阅读方式点击即保存**：在「设置 → PDF 阅读方式」选择单页翻页或连续上下滚动后立即持久化，关闭设置、刷新页面或重开 PDF 都不会回退；保存失败会回滚选择、显示原因并提供重试。设置里的 API 表单保存按钮改为「保存 API 设置」，只保存 API 相关字段。
- **侧栏导航整顿**：展开侧栏改为「资料 / 学习 / 会话 + 底部固定区」，移除一级「提示词」入口；收起栏为「历史 / 新建会话 / 图片 / 文件 / 学习卡片 / 全屏 / 设置 / 帮助」，帮助固定在两种布局的最后一位。
- **提示词管理入口移入设置**：「设置 → 提示词管理」提供全部提示词 / 会话模式 / 学习成果 / 快捷追问四个入口；关闭提示词管理会返回设置并聚焦原按钮。系统协议只在提示词管理内部的分类中查看。
- **消息菜单改为三层语义**：「从这里分支」「开启特殊分支 ›（整理成笔记 / 生成题目 / 自定义提示词…）」「保存本轮回复为学习卡片」，自定义提示词需要先确认结果格式（笔记 = Markdown，题目 = Quiz）。
- 连续滚动改为真正的窗口化：页面节点与画布数量不随页数增长，10000 页文档也只保留十来个页面节点；混合页尺寸下滚动锚点不再漂移。
- 「关于此页」从「相关对话 N」改为按需查询的两个分类（会话 / 学习卡片），面板关闭时不查询，翻页时防抖并丢弃迟到结果。

### Fixed

- 修复“选择连续滚动后直接关闭设置会丢失选择”的问题：阅读方式现在点击即提交，并进入统一的设置串行队列，快速 A→B 选择以最后一次为准。
- 修复连续模式下分页渲染器仍在工作的问题：两种渲染器互斥，未激活的一方不读页面、不渲染、不缓存。
- 修复连续滚动把整本文档都创建为 DOM 节点、以及每次翻页清空全部页面尺寸缓存导致的跳动。
- 修复滚动热路径每次翻页都全量读取会话与分支的问题；面板关闭时零查询。

### Performance

- 连续滚动：500 / 2000 / 10000 页文档的挂载页面节点上限 11、画布上限 7、页面尺寸缓存上限 7；跳页改为两阶段定位（估算跳转 + 一次测量微调）。
- 卡片列表只读取元数据并对纯文本做摘要，不在列表渲染完整 Markdown；`(documentId, page)` 查询走派生复合索引，不扫描全部卡片。

### Data

- IndexedDB schema v7 → v8：新增 `studyCards` 与派生索引 `studyCardPageRefs`。升级只创建空表与索引，不复制、不改写任何既有数据。
- 降级限制：已经被 v2.2.0 升级到 v8 的浏览器数据**无法被旧版本应用读取**（IndexedDB 不支持降级）。如需要回到旧版本，请先导出备份并清除本地数据。

## [2.1.0] - 2026-09-09

### Added

- README 重构为普通用户产品说明书：补充 PDF 一等对象、与传统 PDF 阅读器/AI 网页端的差异、首次使用、按页选 Context、笔记/题目、AI 目录、来源回链、隐私备份、FAQ 和故障排查。
- 新增 `docs/DEVELOPMENT.md`，集中记录安装、测试分层、production 截图和贡献约定。
- 新增 README contract test，检查用户章节、FAQ、图片、仓库内链接、版本 badge 和 PDF Context 阈值。
- README 返工为人话优先的阅读顺序：先讲打开后就是 AI 对话、与 Zotero/网页端 AI 的核心区别和 FAQ，再讲设计理念、功能和页面展示。
- 新增 Product Guide：首次无 API 进入时在应用就绪后非阻塞展示，并从桌面侧栏与收起 rail 的“帮助”入口永久可达。

### Changed

- Roadmap 当前版本同步为 v2.1.0 开发中，并明确已完成与后续阅读能力的边界。
- README 截图改由当前 production build 重新生成，使用 v2.1.0 命名的确定性文档资产；正文只保留 5 张信息增量明确的画面，移除移动端竖栏、drawer、深色模式和空白 Reader 截图。
- README contract test 增加内容顺序、核心差异人话文案、HTML 图片路径和低信息截图禁用检查。
- Product Guide 与 README 共用 `src/help/product-guide.md` 内容源；同步脚本使用固定章节边界，不向 README 插入标记，也不会改变冻结章节之外的内容。
- Product Guide 的“导入 PDF”“打开资料库”“配置 API”按钮分别进入现有资料库导入面板、资料库和设置；首次查看版本写入既有 settings store，不升级 IndexedDB。

### Fixed

- 修正 v2.0.3 遗留的发布契约：连续 PDF 阅读使用真实 viewport/controller 文件，设置契约从 PDF navigation domain 读取，CORE browser gate 增加注册完整性检查。
- 连续滚动 Reader 与 Context Preview 共用分页/连续模式设置，并保持现有 PDF、消息、页面笔记和来源回链行为。

### Performance

- 连续滚动使用虚拟化窗口和附近页面渲染，避免大型 PDF 首屏一次性挂载全部页面。
- 发布门禁同时保留 PDF 冷启动性能基线与连续渲染 controller 测试。

### Compatibility

- package/package-lock 与文档同步到 v2.1.0；IndexedDB schema/version 不变，旧文档、旧设置和旧 Backup 无需 migration。
- 旧分页模式仍是默认值；旧 Backup 缺失 `pdfNavigationMode` 时继续回落为 `paged`，现有 V1–V6 Backup 兼容保持不变。

## [2.0.3] - 2026-09-09

### Fixed

- 页面笔记的连续输入、异步保存、切页/关闭 flush 和删除文档竞态继续由 domain 与 browser gate 保护；旧写入不能覆盖新内容，也不能在文档删除后复活笔记。
- DeepSeek 请求默认显式使用 `reasoning_effort: "max"`；其他 OpenAI-compatible endpoint 不会收到 DeepSeek 专属字段。

### Changed

- Prompt Manager 的会话模式主界面只保留“默认”；学习成果新建面只保留“整理成笔记”和“生成题目”；历史总结、学习指南、自定义成果和旧 prompt snapshot 仍可读取。
- 系统协议从默认“全部”目录隐藏，只有主动进入“系统协议”分类才展示；离开分类后协议详情清除。
- Reader 目录面板增加明确的返回阅读路径；收起侧栏继续保留原 rail 的直接入口，桌面和移动端不改变基础导航语义。
- 章节范围控件改为紧凑的 `[)` / `[]` 符号选择；不再重复显示实际发送页码或长语义文案。

### Added

- 文件/章节 Context picker 增加只读 PDF 预览：预览从选区首段、文档 `lastReadPage` 或第 1 页开始，支持翻页和目录跳转；返回时保留选择、滚动、焦点与阅读状态。
- 正式 release runner CORE 注册 v2.0.2 与 v2.0.3 关键 browser suites，包含 preview、prompt simplification、Reader navigation 和 note read safety。
- README 改为以“PDF 是一等对象”为中心的功能说明，并用最终 v2.0.3 构建重新生成桌面/移动端截图。

### Compatibility

- IndexedDB schema/version 未升级；旧文档、章节、页面笔记、provenance、Prompt snapshot 和 v1.3.x/v2.0.x 数据继续按既有 migration 读取。
- Backup V1–V6 继续导入；旧 artifact、旧 summary/study-guide/custom 数据保留可查看与导出，新的 catalog 过滤不做物理删除。
- preview 不写 attachment、message、note、chapter、`lastReadPage` 或 Backup；旧 PDF 无范围偏好时仍使用左闭右开 `[)` 安全默认。

## [2.0.2] - 2026-09-08

### Fixed

- Backup 导入现在统一校验 root/branch 消息的 `status`、`error` 和 assistant 角色关系；非法的 failed/aborted 组合会在写入前被原子拒绝。
- failed/aborted 的部分 assistant 回答不再作为稳定答案用于分支、学习成果或快捷追问；部分内容和失败提示仍会保留，便于用户重试。
- branch/root 的拒绝结果进入一致的可见错误通道，清理旧错误时同步恢复可发送状态，避免出现“按钮无反应”或 `status=error` 无错误文本。
- Reader 顶栏移除重复的章节入口；无目录文档仍从目录区进入 Chapter Builder，并保留从当前页添加章节的能力。
- 页面笔记按当前文档与页码显示“新建笔记 / 查看笔记 / 收起笔记”状态；连续输入使用 debounce，切页、关闭和删除文档时正确 flush，旧异步写入不能覆盖新页或复活数据。

### Changed

- v2.0.1 的领域回归进入默认 `npm test`；release runner 现在使用唯一、稳定的 E2E 列表，在未知名称、端口占用和子测试失败时 fail-closed，并保证 preview cleanup。
- Windows release runner 改用 shell-free 的 Node/npm CLI 解析，消除原有 child-process shell warning；GitHub Pages deploy 依赖 browser E2E gate。

### Compatibility

- IndexedDB schema / DB version 保持 7，不需要 migration；v1.3.x、v2.0.0 和 v2.0.1 的 PDF、章节、页面笔记、provenance 与 Reader ↔ Conversation 学习路径继续可读。
- Backup V1–V6 继续导入；缺失的 v2.0.x 新字段使用既有安全默认值，新的消息终态字段按严格规则验证；API Key 仍不会进入 Backup。
- README 只更新了当前版本 badge 与稳定化说明；现有截图已对应当前界面，无需重复生成。

### Tests

- 发布门禁覆盖 `npm run typecheck`、`npm test`、`npm run build`、Backup E2E、v2.0.1 regression E2E、Notes E2E、Chapter Builder E2E、完整 `npm run test:release`、CI quality gate、Pages browser gate 和 deploy。
- 每组关键 browser E2E 均检查真实用户行为链与 `PAGEERRORS`，最终发布证据记录在固定开发汇报中。

### Known warnings

- Vite 仍报告既有 dynamic/static import 与 large-chunk warnings；部分本地测试仍会显示 `--localstorage-file`、PDF.js `standardFontDataUrl` 等非阻断 warning。
- `e2e-document-reader / rail-files` 的既有 CI 问题仍单独登记，最终 release report 会区分其与本轮回归的关系。

## [2.0.1] - 2026-09-08

### Added

- 收起 rail 保留历史、新会话、图片、文件和提示词等直接入口；点击提示词可直接打开 Prompt Manager，不改变侧栏展开状态。
- 正式 release gate 纳入 v2.0.1 关键反例：rail direct-open、Prompt Manager focus boundary、initial transition、branch failure、protocol copy-of-copy、空 Quick Follow-up、overflow-only 列表和 timeline 性能隔离。

### Fixed

- branch 发送失败现在进入可观察、可访问的失败通道，不再把 HTTP/API 失败表示为伪成功；已接受的用户消息保持耐久。
- 首条消息前的 initial mode transition 可见且只渲染一次；root、branch 和导出保持同一边界语义。
- protocol copy-of-copy 直接继承 canonical lineage；非法或不可激活协议不再显示无响应的启用操作。
- Prompt Manager 建立完整的 Tab、Shift+Tab、Escape 和 opener focus restore 边界。
- root/branch 的空白 Quick Follow-up 在 UI、service、backup 和 runtime 层统一拒绝，不产生消息、lease 或网络请求。
- Quick Follow-up 的“更多”列表只显示前三项之后的 overflow，关闭后恢复 opener focus。

### Performance

- 有效 Prompt timeline materialization 只使用当前 lineage，不再为每次读取扫描全部无关 branches；5k/20k 结构性 warm 访问计数为 0。

### Compatibility

- IndexedDB schema 和 DB version 未升级；Backup schema 保持 V1–V6 兼容，API Key 仍不进入 Backup。
- PDF、书签范围、目录、页面笔记、provenance、Reader ↔ Conversation 反向链和原有 v1.3.x 学习路径未改变。
- README collapsed rail 截图已更新为包含提示词直接入口的当前界面；其余截图未因无关页面重复生成。

### Release evidence

- Local: `npm run typecheck`、`npm test`、`npm run build`、`npm run test:prompt-performance`、`npm run test:v201-red-domain`、`npm run test:release` 全部通过。
- Remote: CI quality gate、Pages build、26 组 critical browser E2E（658 assertions）和 deploy 全部 success；所有 PAGEERRORS 为 none，线上站点 HTTP 200。

### Known warnings

- 构建仍有既有 dynamic/static import 与 large-chunk warnings；GitHub Actions 仍显示 Node.js 20 deprecation annotation，均未阻断本次发布。

## [2.0.0] - 2026-09-08

### Added

- 交付 Prompt-native 学习工作区：用「会话模式、学习成果、快捷追问、系统协议」四个用户入口组织 AI 学习行为。
- 会话模式支持从下一条消息开始切换，主线与分支各自保留可追溯的模式历史；分支继承父路线的有效学习方式后，可以追加自己的方式。
- 提示词管理支持按类别搜索、查看、复制、编辑和恢复内置定义；内置协议可查看用途、输出约束和校验说明。
- 快捷追问支持根路线与分支路线，并作为真实用户消息写入历史；学习成果保存模板与结构化输出协议的来源快照。
- 新增分支 Prompt timeline browser gate，发布门禁覆盖根路线继承、分支本地切换与下一条消息编译。

### Changed

- 导出会话时保留模式切换、快捷追问和学习成果所需的用户可读来源信息。
- README、Roadmap 和隐私说明改用用户心智模型描述 Prompt 能力，并刷新为 v2.0.0 当前界面截图。
- GitHub Pages 的 critical browser suite 与本地 `test:release` 共用同一组 E2E source of truth，包含 Prompt Manager、会话模式、分支 Prompt timeline、快捷追问、协议覆盖、Backup V6 和移动端 Prompt 导航。

### Compatibility

- 旧会话没有模式历史时显示为“模式未记录”，不会伪造历史 Prompt；旧 v1.x 的固定系统提示词和自定义操作仍通过迁移进入新的 Prompt 工作区。
- IndexedDB v6 继续读取旧记录；Prompt 相关字段采用可选增量结构，新写入使用规范化数据。
- Backup V6 保存 Prompt 定义、偏好、模式历史、快捷追问、Artifact bundle 和旧 PDF 学习关系；V1–V5 Backup 继续可导入，缺失的新字段使用安全默认值。
- API Key 仍不进入 Backup；PDF、章节、页面笔记、来源回链和原有 v1.3.4 学习路径保持兼容。

### Release evidence

- Final gate: `npm ci`、`npm run typecheck`、`npm test`、`npm run build`、`npm run test:release`、`git diff --check`。
- 发布前必须同时满足 CI quality gate、critical browser E2E、GitHub Pages deploy success、`origin/main` 与 `v2.0.0` tag 指向同一 release SHA。

## [1.3.4] - 2026-09-07

### Fixed

- 修正书签范围 option 文案与实际页集合可能不一致的问题；左闭右开 `[start, end)` 与左闭右闭 `[start, end]` 现在使用稳定、与当前书签结束页无关的边界表示。
- 恢复章节选择 checkbox 的无障碍名称、标题点击和键盘操作语义。
- 修复范围模式保存失败时仍可发送或关闭 Picker 的问题；失败会保留 Picker 并阻止发送。
- Reader 在 Picker 保存范围模式后立即使用新模式，无需 reload。
- 长目录渲染不再为每个节点展开完整 `pages` array，降低不必要的分配。
- 范围预览使用 `[start, end)` / `[start, end]` 符号；完整模式名称仅在下拉栏中选择，不再展示“实际发送”提示文案。

### Changed

- 强化 v1.3.3 bookmark range 的持久化、边界页、同名文档隔离、移动端和 Backup 回归门禁。

## [1.3.3] - 2026-09-07

### Added

- PDF 书签选择支持左闭右开 `[start, end)` 与左闭右闭 `[start, end]` 两种右边界语义。
- 每个文档、每个稳定书签节点可独立保存范围模式，选择器按所选模式计算最终发送页集合。
- 新增末页、单页和 375 / 390 / 412px 移动端 bookmark range release gate。

### Changed

- PDF Context 的书签范围、页数统计和实际生成页码统一使用 canonical range resolver。
- 旧文档与旧 Backup 缺少范围偏好时默认使用左闭右开；新偏好可随文档 Backup round-trip。
- README 截图刷新为 v1.3.3 当前界面，并补充书签范围选择说明。

## [1.3.2] - 2026-09-07

### Added

- Chapter Editor 支持直接选择章节层级、多选、Shift 范围选择、搜索和按当前层级快速选择。
- 长目录编辑器新增固定可用的批量工具栏，可批量设为目标层级或增减一级；移动端保持可操作且不产生横向溢出。

### Changed

- AI 目录结构分析改为更紧凑、可校验的结构输出，减少模型输出开销并提高层级分析成功率。
- AI 目录识别失败时提供更准确的诊断和一次定向校正，并优化阶段进度反馈。
- README 更新为 v1.3.2 当前界面截图，并补充“PDF 是一等对象”与长目录编辑工作流说明。

## [1.3.1] - 2026-09-07

### Added

- Reader 页面新增按文档 + 页码归属的页面笔记，支持 debounce 自动保存、切页/关闭时 flush、备份恢复和删除文档时级联清理。
- PDF provenance 支持多文档消息，并建立 Reader 页面 ↔ 对话消息的双向来源导航，支持主线与分支的精确定位。
- 代码块进入文本标注管线，支持单行、多行和整段代码选择，刷新后保持高亮。
- 移动端保留原有收起 rail，展开时使用历史会话 drawer；桌面端恢复页面笔记入口。

### Fixed

- 修复页面笔记连续输入、异步保存、切页/关闭和删除文档之间的竞态，避免旧写入覆盖新内容或复活已删除笔记。
- 修复 PDF 多文档 provenance 被单一来源覆盖的问题。
- 修复 Reader 与 Conversation 之间的分支消息导航需要等待分支准备完成的问题。

### Changed

- 发布门禁纳入关键 Reader、PDF provenance、笔记、代码标注和移动端历史会话 browser E2E，并由 GitHub Pages deploy gate 验证。
- Backup 测试命名改为版本中性；当前 Backup V5 继续兼容导入 V1–V4 数据。
- README 重构为以“PDF 是一等对象”为核心的产品说明，并更新为当前界面截图。

---

## [1.3.0] - 2026-09-07

### Added

- PDF 消息现在携带文档 ID、页码和创建时间，可从历史消息直接打开来源页面。
- 阅读器新增按文档 + 页码保存的页面笔记，支持自动保存、备份恢复，并在删除 PDF 时级联清理。
- 代码块进入文本标注管线，支持单行、多行和整段代码选择，刷新后保持高亮。
- 移动端历史会话改为最大 240px 的 drawer，支持遮罩、返回和选中会话关闭。
- 所有消息统一提供 `data-message-id`，backup schema 升级到 v5；旧 v1–v4 backup 仍可导入。

### Changed

- IndexedDB schema 升级，新增 `documentNotes` 页面笔记存储。

---

## [1.2.0] - 2026-09-06

### Added

- 可保存、复用、编辑、删除的「自定义操作」：自定义学习成果现在是一个「操作名称 + 提示词」的可复用预设，刷新与备份恢复后仍然存在。
- AI TOC 更健壮的 printed-page mapping：装饰性数字页码（如 `/1`、`……24`）可被安全规范化用于映射；无 PDF PageLabels 时可用单一锚点做 physical-page 校准批量映射；原始印刷页码始终保留。
- 统一「添加资料」入口：Composer 左侧改为文件图标，菜单提供「打开本地图片 / 打开本地 PDF / 从资料库添加」；新建对话空状态提供「添加资料 / 打开资料库」（真实打开资料库）。
- Branch action menu 明确 13px / 20px 行高的操作字号，不再回退到浏览器默认 16px。

### Changed

- 学习成果默认一级入口收敛为「笔记 / 题目 / 自定义」；总结、学习指南折入自定义中的内置常用操作（历史数据仍兼容可见）。
- UI 密度收敛：TOC Review / Chapter Builder / Artifact / Branch 等二级界面字号与间距与主界面对齐。
- 版本号改为单一来源：package.json → 构建期注入，Settings 不再手写版本字符串。

### Fixed

- 修复失败或尚未完成的 Quiz 学习成果可能导致备份无法生成或恢复的问题。
- 修复恢复备份后生成中的学习成果可能永久停留在“生成中”的问题。
- 修复快速关闭笔记编辑器时最后一小段编辑可能未保存的问题。
- 修复 PDF 放大渲染期间翻页或切换文档可能打开旧页面的问题。
- PDF 导入在 Web Crypto 不可用的环境中不再因重复检测失败而被阻断。
- 改进 PDF 重复文件检测，只有真正的候选文件才计算完整内容哈希。
- 修复重命名或自定义名称可能产生重复文件名的问题。
- 强化发布测试预览服务器的端口与进程生命周期管理。
- 修复自定义操作内置 preset（总结/学习指南）无法“另存为自定义操作”的问题。
- 修复 note / quiz 创建时提示词未预填导致的生成失败回归。
- AI TOC 保存后的目录导航已覆盖（root + 嵌套子章节、保存后与 reload 后均能正确跳页）。

---

## [1.1.1] - 2026-09-05

### Fixed

- 修复学习成果（Study Artifacts / 笔记 / 题目）生成失败后可能留下“生成中”状态的问题；现在只会在真正取得全局生成权限后才进入生成中，失败后稳定落为“错误”并可重新生成。
- 提升选择题生成的结构兼容性：只会做无歧义的规范化（如 “B”→“1”、option→options、“true”→true），写入前仍走严格校验；失败时保留模型原始输出，可查看并恢复。
- 修复学习成果 Markdown 预览：标题、列表、加粗、表格与公式现在按真实 Markdown 渲染，而不是另一套简化解析。
- 修复从旧版本备份/迁移回来的文档记录：读取时间与版本字段缺失时不再导致排序非数字或界面异常；后台回填使用原子更新，不会覆盖用户正在进行的重命名/翻页。
- 修复重复文件检测：重复判定只依据完整 SHA-256，不会被“大小相同”或“首尾指纹相同”误判为重复。
- PDF Reader 改为直接 Canvas 显示：正文不再走 JPEG Blob；翻页时的过期渲染会被真正取消，取消不再误报“渲染失败”，离屏位图会被正确释放。

### Added

- 笔记 / 题目一键导出：笔记导出为 Markdown（取当前编辑内容），题目支持 Markdown 与结构化 JSON 导出。
- 文件资料库新增排序、重命名与重复文件检测；导入时可处理“同名冲突”与“完全相同文件”两种冲突并给出选择。
- 新增统一的发布门禁 npm run test:release：自动执行类型检查、完整单元测试、构建、关键端到端测试，并在结束时（无论成败）清理预览服务器进程树。

### Changed

- 默认学习成果生成面收缩为“笔记 / 题目 / 自定义”，历史“总结 / 学习指南”成果仍可打开查看。
- 文件资料库卡片操作改为溢出菜单，布局更简洁。
- PDF Reader 采用直接 Canvas 渲染 + 页面缓存 + 邻页预取 + 过期渲染取消，大幅减少翻页等待并控制内存峰值。
- 阅读进度（lastReadAt）与元数据修改（updatedAt）语义分离：翻页只更新阅读进度，重命名/改目录才更新元数据时间。

---

## [1.1.0] - 2026-09-05

### Added

- 会话分支（Conversation Branching）：可从任意历史回答继续另一条学习路线，支持嵌套分支，并从消息的规范属主正确分叉。
- 分支独立草稿：主线 / 各分支各自独立的未发送文本、图片与 PDF Context，切换互不串扰。
- 统一生成归属与停止：主线与分支共用同一全局生成状态，支持统一的「停止生成」。
- 学习成果（Study Artifacts）：从当前学习上下文生成 笔记 / 总结 / 学习指南 / 测验 / 自定义学习成果。
- 可编辑笔记：AI 输出进入独立可编辑学习文档，而非普通聊天气泡。
- 结构化测验：结构化题目、答案、解释与来源信息。
- 学习成果库（Artifact Library）：浏览 / 筛选 / 打开 / 删除学习成果。
- 完整备份升级为 Backup V4：分支、分支草稿、学习成果、激活分支与附件一并持久化。
- IndexedDB schema 升级到 v5：新增 conversationBranches 与 artifacts 存储。

---

## [1.0.0] - 2026-09-04

### 正式发布前的最终收尾（release-blocking）

- 普通图片上传改为与 PDF Context 一致的原子归属（一个 IndexedDB 事务内同时写入附件元数据与 Draft 归属，失败则两者都不落库），杜绝“附件已写、草稿未写”的中间态。
- Composer 左侧合并为【一个】“添加内容”按钮：弹出菜单进入图片 / 打开本地 PDF / 从文件资料库选择，原有入口不变。
- 折叠侧边栏的“历史会话”调整为首个控件（真实 DOM 顺序），底部全屏 / 设置仍贴底。
- 修复暗色模式下 Composer 附件按钮继承原生浏览器样式导致的泄漏，改为语义 token 换肤。

### Added

- 新增本地 Document Library + 完整 PDF Reader：导入的原始 PDF 作为一等学习对象保存，可反复被不同对话复用。
- 新增 Document → Context 选择器：从文件资料库选择章节 / 不连续页码范围 / 整份文档加入任意对话；Reader 内可加入当前页、父级章节或任意祖先层级。
- 新增 `--dsw-specific-study-highlight` 语义 token：学习标注在深色模式下为低眩光、不近白、不损正文对比。
- 支持导出带章节书签的新 PDF（原有 Planned 项已完成）；支持导出会话为 Markdown + 图片 ZIP（自包含）。
- 支持系统 / 浅色 / 深色三档外观（设计 token 层统一换肤，深色低眩光）。

### Fixed

- 修复 AI 目录真实模型请求仍使用旧 JSON 数组协议、可能导致识别失败的问题。
- 修复切换文档或离开 Reader 时旧 AI 目录请求可能污染新文档的问题。
- 修复目录页缩略图使用正文分辨率渲染造成的额外性能开销。
- 修复极端 PDF 页面尺寸可能突破渲染像素预算的问题。
- 修复从章节内部页新建顶层章节可能意外改变现有父子结构的问题。
- 修复 PDF Reader 返回文件库或切换文档后旧 PDF session / 页面预览未及时释放，以及再次导入 PDF 时按钮状态未恢复的问题。
- 修复多个同级章节从同一 PDF 页面开始时目录无法保存的问题。
- 修复 AI 目录中待确认页码可能被错误当作 PDF 第 1 页保存的问题。
- 修复“继续检查”和未检查目录保存确认行为。
- OPFS 枚举、清理与 GC 严格限定在本应用目录，绝不触碰同 origin 其它应用数据。
- 导出完整备份时，任一文档/附件二进制无法读取会明确失败，不再静默缺漏。
- 图片附件批量写入遇到暂时性 OPFS 失败时，整批回退到 IndexedDB，不会部分失败。
- 目录缩略图滚动离开再回来不会重复渲染，也不会泄漏重复的 object URL。
- 目录检查里“待修改”的行不再被当成“已检查/正确”，保存时需二次确认。

### Changed

- AI 目录识别进一步采用严格 JSONL 转录与全局结构分析，并为长目录保留跨批次连续上下文。
- 原始 PDF 与图片附件优先使用浏览器 OPFS 保存；不支持 OPFS 时自动回退 IndexedDB。
- Document Library 的列表只读取文档 metadata，不再需要读取原始 PDF Blob。
- AI 目录识别改为“视觉转录 → 全局结构判断”，避免目录跨页时因分批识别破坏层级。

### Added

- 新增 OPFS/IndexedDB 二进制存储抽象与旧数据自动迁移。
- 存储诊断显示 OPFS 支持状态与本地文件存储分布。
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

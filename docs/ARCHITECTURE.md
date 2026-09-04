# Architecture — AI Education Reader

本文档描述 v1.0.0 的实际架构。所有数据与处理默认在浏览器本地完成。

## 产品领域模型

```
Document  原始学习资料（当前为 PDF，一等对象，全局所有权）
  └─ Chapter  书签 / AI 目录 / 手动章节（结构性章节）
       └─ Context  真正发送给 AI 的页码集合
            └─ Draft  待发送内容（文本 + 图片 id）
                 └─ Message  你与 AI 的对话
                      └─ AI  按你配置的模型请求
```

- **Document**：一个完整原始文件，存储在浏览器（IndexedDB 元数据 + OPFS 二进制），与会话无关。
- **Chapter**：结构化章节（`native` / `ai-toc` / `manual`），可带已解析的物理页码范围。
- **Context**：用户选定的一组（可能不连续）物理页，逐一渲染为图片，作为一个分组加入 Draft。
- **Draft**：按会话隔离的待发送内容，可跨刷新持久化。

## PDF 运行时

- 使用 PDF.js（worker + WASM + CMap + fonts + ICC），在浏览器本地读取与渲染，**不上传 PDF**。
- 每个 Reader 实例拥有独立的 `PdfSession`（`loadingTask` + `documentProxy`），不与 Composer 面板共享单例。
- 阅读器打开/关闭/切换文档时，通过 effect cleanup 释放旧 session、撤销对象 URL、按绑定 id 刷新进度。


## Document Library 与 OPFS / IndexedDB 拆分

- **IndexedDB**：元数据、会话、消息、设置、章节树、二进制引用。原子读写（`idbUpdate`），避免并发丢更新。
- **OPFS-first 二进制**：原始 PDF 与较大附件优先存 OPFS，仅当前站点 origin 可访问；不支持 OPFS 或写入失败时自动回退 IndexedDB 内联 Blob。
- 二进制迁移：后台把旧版 IndexedDB 内联 Blob 迁入 OPFS（best-effort，不阻塞）。
- 存储诊断：只读地统计 OPFS 支持状态与各类占用，不清理、不删除。

## 附件所有权

- 图片附件可来自：用户上传、PDF 页面渲染、内容生成。
- 一个用户 PDF 选择 = 一个 `groupId`（一个 Context 分组，绝不按文件名合并）。
- 删除「本地文档」不会级联删除已保存的 Context 附件；删除 Draft 中的附件会同时删除其二进制。

## Document → Context picker

- 单一共享的 `DocumentContextPicker`，三个入口复用：Composer「从文件资料库选择」、Library 卡片「加入对话」、Reader「选择其他章节 / 多章节」。
- 显式阶段状态：未预指定 documentId 时先显示文档列表，点选后进入 Context 选择；预指定时直接进入 Context，且无"清空文档"式误导返回。
- 纯领域 `document-context.ts`：`findChapterPathById`、`findCurrentChapterPath`、`selectableChapterRange`、`buildChapterNodesSelection`（多章节规范化 + 去重 + TOC 序标题 + `selectedChapterIds` provenance）。

## Reader 祖先路径

- `findCurrentChapterPath(chapters, page)` 返回 [根 → … → 最深] 的确定性祖先链。
- Reader「加入对话」上下文菜单按最深→根列出祖先，可直接加入任意层级，无需手动换算页码。


## AI TOC（目录识别）

```
所选目录页图片
  → 视觉转录（JSONL，仅透明当前页，含图片身份标注）
  → 全局结构分析（文本，仅提议 {id, level}）
  → 映射到物理页 + 分配本地行 id
  → 人工检查（跳转 / 调整 / 待确认 / 统一偏移重算）
  → 保存为 ChapterNode（ai-toc）
```

- 物理页**永远**由本地 `sourceImageIndex` 派生，模型**永不**返回 PDF 页码。
- 识别结果只是**不可信草稿**，只有人工检查并保存后才写入本地。
- 长目录分批（每窗口 ≤8 页），带跨批连续上下文；批次间只做精确边界去重，**不做**模糊合并。

## 异步所有权

- `PdfSession`：服务打开即拥有、结束后必须关闭；调用方传入的 session 永不关闭。
- `AbortController` / generation token：取消或切换时使旧操作失效。
- Document → Context 执行使用 generation token + `isCancelled` / `isStale`，确保切换会话时旧操作**不写入**新会话，取消不留部分附件组 / 孤儿附件。


## 备份与导出

- **备份**：V2 JSON，逐条迭代文档二进制（一次只读一个），任一文档/附件二进制无法读取则整个备份失败（无静默缺漏）。不含 API Key。
- **导出带书签 PDF**：用 pdf-lib 把当前章节树写成 `/Outline`，中文标题为 UTF-16BE；不会重排页面、不做栅格化。
- **导出 Markdown + 图片 ZIP**：会话转 Markdown + `images/<安全名>`，相对路径引用；文件名全局去重；缺附件则整个导出失败。

## 深色主题

- 设计 token 层分级：`--dsw-static-*`（静态色板）、`--dsw-alias-*`（按主题别名）、`--dsw-specific-*`（语义）。
- `body[data-ds-dark-theme]` 切换 alias 层；浅色/深色在同一套 token 上解析，不做逐组件 override。
- 首次渲染用 localStorage 的**外观模式提示**同步上色（只存主题，绝不存 API Key / 模型 / 会话 / 设置）。

## PPTX

- **v1.0.0 未开放 PPTX 导入**：未针对 fidelity gate 验证浏览器内 PPTX→canonical PDF 渲染器。
- 未来方向：浏览器本地转换 → 复用完整 PDF 链路，**不建独立的 PPT Reader**。


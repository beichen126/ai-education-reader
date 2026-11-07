# GenUI 交互回答

参考 [dsh-genui](https://github.com/omdsh-dev/dsh-genui) 的声明式围栏与 action 回传设计，在阅读器内以 React 原生组件实现，无新增运行时依赖。不是 DSH 插件安装，也不承诺兼容其完整组件集。

## 使用

在普通对话中输入：

> 用交互界面讲解牛顿第二定律，给一张质量与加速度的对比表，再出一道能直接点击作答的选择题。

普通流式对话在提示词编译时向当前用户消息附加已支持组件的说明（仅用于本次请求，不改写保存的消息或模式时间线，也不额外插入 system 消息），DeepSeek 与 OpenAI 本机服务共用。模型仍可按问题选择纯文字；用户要求纯文字或严格 JSON 时应遵守该要求。结构化目录与学习成果生成不经过此注入入口。

回复中的 `dsh-ui`、`json dsh-ui` 或 `genui` 围栏在助手回答中渲染；用户消息中的代码保持源码显示。组件正文按纯文本显示，不执行 HTML 或 JavaScript。原始消息仍以 Markdown 保存，复制、导出、重载时保留围栏源码。

支持 text、heading、card、stack、row、grid、callout、stat、badge、progress、list、steps、table、chart（条形图）、quiz、input、select、slider、button、submit、tabs、accordion。完整字段约定见 `src/genui/schema.ts` 中的模型协议。

```dsh-ui
{"items":[{"type":"quiz","question":"质量不变时，合力加倍，加速度如何变化？","options":[{"label":"加倍","correct":true},{"label":"不变"}],"explanation":"由 F=ma，质量不变时加速度与合力成正比。"},{"type":"input","id":"topic","label":"想继续学习的主题","value":"牛顿定律"},{"type":"submit","label":"继续讲解","action":"explain-topic"}]}
```

选择题在本地判分。按钮及提交会发送包含 `action` 和当前区块 `fields` 的 `[genui-action]` 用户消息，沿该回答所属的主会话或分支继续生成，保留输入框草稿。发送失败时区块显示错误并可重试。没有对话宿主的展示不启用发送按钮。

表格支持筛选、按列升降序排序。交互状态只保存在当前挂载的 UI 内，刷新后重置；相同回答的不同区块独立管理状态。表单须为每个字段提供唯一 id；不要用于输入密钥等敏感内容。

当前未实现参考插件的 Mermaid、ECharts、函数绘图、3D、任意 HTML、条件显隐、状态持久化。未知组件、格式错误或流式尚未完成时保留查看源码入口；限制围栏 64 KB、160 个组件及 8 层嵌套。

## 验证

- `npm run test:genui`：协议解析、无效结构、组件白名单及资源上限。
- 启动 `npm run dev -- --host 127.0.0.1 --port 5328 --strictPort` 后运行 `npm run test:e2e-genui`：桌面和手机宽度的 Markdown 围栏渲染、选择题判分、表格排序筛选、表单 action、标签页及横向溢出检查。
- `npm run typecheck`、`npm run build`。

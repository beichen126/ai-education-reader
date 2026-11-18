# GenUI 交互回答

当前生成目录包含 17 种基础组件，采用 @changfenhuang/dsh-genui 0.16.0 渲染。网页和 Android 使用同一份生成协议。

## 当前组件

- 布局：card、grid、arrow。
- 文字与重点：text、badge、stat、callout。
- 内容组织：steps、accordion。
- 数据与数学：chart、echart、plot、slider。
- 选择与测验：choices。
- 图形：icon、svg、scene3d。

词汇表使用 genui 围栏，items 填写 vocabulary 条目。保存 Firecrawl Key 后，当前请求额外开放 image、image-group，可嵌入 card/grid。图片由 query 检索，优先首张，加载失败依次尝试第二、第三张；全部失败显示紧凑占位与来源。

## 输出格式

普通界面使用 genui 围栏，根对象填写 title 和 items：

```genui
{"title":"正弦函数","items":[{"type":"plot","xMin":-6.28,"xMax":6.28,"yMin":-3,"yMax":3,"series":[{"expr":"a*sin(x)","label":"y=a sin(x)","params":[{"name":"a","value":1,"min":0.1,"max":3,"step":0.1}]}]}]}
```

根级 computed 读取 slider.id 和其他 computed.id；plot.params 是曲线自身参数。choices 的 answer 支持单选标签和多选标签数组，submit 把选择整理成消息发送到所属会话。卡片默认紧凑，grid.cols 控制列数和自动换行。

## 提示词维护

- `src/genui/generation-rules.md`：人工维护的用途、布局、字段与交互说明。
- `src/genui/prompt-examples.ts`：8 个完整、可独立渲染的 JSON 示例。
- `scripts/generate-genui-catalog.ts`：结合规则、示例及运行时字段生成目录。
- `src/genui/catalog-prompt.ts`：实际内置提示词，修改源文件后运行 `npx tsx scripts/generate-genui-catalog.ts`。
- `src/web-images/protocol.ts`：按当前 Firecrawl 配置注入网络配图扩展。

设置中的提示词管理 → 系统协议 → GenUI · 交互界面，可查看内置规则。普通对话在请求编译时追加到最后一条用户消息，保持各供应商提示词策略兼容；原始消息持久化内容保持不变。自定义启用的协议继续按用户选择使用，内置更新保留用户自定义内容。

## 容错与资源

渲染器对常见字段类型做归一化，并尽量保留可渲染部分；生成规则仍以准确字段为目标。当前宿主预算见 `src/genui/limits.js`：源码 4 MiB、节点 5000、深度 32。长内容可分组、折叠或使用多个独立界面。

图形引擎随构建分包加载。数学表达式使用受限解释器。网络配图依赖服务与原图站点可用性；3D 依赖设备 WebGL。展开画布与 JSON 导出可用；HTML 导出适用于支持独立运行的展示内容，网络配图、统一选择及大型界面在阅读器内使用。

## 验证

- `npm run test:genui`：字段目录政策、示例完整性、计算变量、模板、图片能力与生命周期。
- `node scripts/e2e-genui-prompt-examples.mjs`：桌面/手机完整示例渲染、面积实时计算与多选反馈。
- `node scripts/e2e-genui-protocol.mjs`：提示词管理与实际 API 请求注入。

解析校验与浏览器测试验证协议可执行；不同模型的生成正确率仍取决于模型及任务，测试结果不等同于生成成功率保证。

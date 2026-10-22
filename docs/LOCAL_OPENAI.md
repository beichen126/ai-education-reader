# OpenAI 本机服务：实施说明与当前边界

## 整体架构与交付状态

Reader 原有的 Vite + React + TypeScript 前端不变。DeepSeek 及兼容 API 仍由浏览器直接请求；新增的 OpenAI 对话入口只连接可选的本机 Node.js 服务。PDF 阅读、会话及分支、学习中心、IndexedDB 和 OPFS 不迁移、不重建。

**已实现官方 ChatGPT 订阅 OAuth 登录，并已完成实际账户文本调用验证。** 未登录或未授予订阅权限时服务拒绝推理。没有读取 Codex 登录文件，也没有 Platform API Key 回退。

图片沿用 Reader 当前上下文与附件投影：只发送被原有上下文策略保留的图片及已选 PDF 页面，不上传整本 PDF。模型能力取自当前账户官方模型列表的 `input_modalities`，只有明确包含 `image` 的所选模型才允许图片请求；未知能力默认拒绝。DeepSeek 的视觉能力配置不影响本机 OpenAI。支持 PNG、JPEG、WebP 的内联图片，保留页面顺序，并继续执行请求大小和图片数量限制。

只有用户明确选择 `OpenAI` 时，对话请求才走本机接口。默认及旧配置继续使用原有 DeepSeek/兼容 API。OpenAI 的模型名单独保存，不覆盖原模型、地址和 Key。目录识别与其他既有 AI 功能仍使用原来的配置；DeepSeek Search/Fetch 不转发给 OpenAI。v3.0.7 起 OpenAI 请求默认启用原生 `web_search`（`tool_choice:auto`），模型按需搜索，流式回答保留来源链接。允许搜索不代表每轮一定搜索，实际可用性受模型和账户策略限制；不回退到付费 Platform API。依据：[订阅接入限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)、[Web search](https://developers.openai.com/api/docs/guides/tools-web-search)。本次只通过 Mock 验证搜索参数和引用处理，未消耗真实账户额度验证联网工具。

Android APK 通过原生官方登录桥独立接入，无需电脑配对码。v1.0.2（内置 Reader v3.0.7）允许在后台状态检查尚未完成时直接发起登录，且不依赖旧版 WebView 缺少的 `AbortSignal.any/timeout`。添加资料菜单提供拍照；系统相机返回的照片只加入草稿。APK 自带网页资源，更新 GitHub Pages 不会更新已安装 APK，需覆盖安装新版。

## 安装、启动和停止

2026-10-19 图片验证：通过本地 Vite 代理、本机服务和真实订阅授权，使用 `gpt-6.1-sol` 发送一张合成红蓝左右分区 PNG。收到 HTTP 200、完整 `completed` 事件及正确回答“Left: red. Right: blue.”。不涉及用户 PDF 或聊天资料。该结果证明此模型的图片调用链可用，不代表已逐一实测其他模型、大批量 PDF 页面或所有 UI 操作。新增测试覆盖所选模型的图片能力拒绝、两页顺序保留及 101 张图片超限；本机服务共 11 项测试、OAuth 共 7 项测试通过。

使用项目支持的 Node.js 20–25，安装现有依赖：

```powershell
npm ci
```

终端一启动服务：

```powershell
npm run local:server
```

终端二启动前端：

```powershell
npm run dev:local
```

打开 `http://127.0.0.1:5173/ai-education-reader/`，进入“设置 → API 配置”。`dev:local` 使用专用 `reader-local` 模式，通过同源 `/__reader_local` 自动连接，不再要求浏览器反复填写配对码。它由本地 Vite 进程从独立受保护存储读取连接能力，添加仅在 Node 进程之间传递的认证头；网页不能读取该密钥。现有 ChatGPT 授权自动恢复，不需要重新登录。

非该专用模式的手动直连仍可使用终端配对码，十分钟过期、最多五次错误尝试、用过即失效。不要把配对码或本机连接密钥贴到公开日志。

服务连接成功不等于订阅授权成功。首次连接后点击 Continue with ChatGPT，在官方页面登录并同意订阅使用；返回后界面轮询登录状态，加载账户可用模型。已有授权会直接恢复。选择模型并切换对话 Provider 后才能发送。没有付费回退。图片支持按官方账户模型目录逐模型判断，不通过模型名称猜测，也不会将文本模型默认为支持图片。

若 Windows 系统代理已开启，但 Node 直连失败，Node 24+ 可在当前终端配置 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY=127.0.0.1,localhost`，然后运行 `npm run local:server:proxy`。代理地址必须使用自己确认的本机端口；不会自动修改系统代理或切换节点。普通 `npm run local:server` 仍用于可直连环境。

在两个终端分别按 Ctrl+C 停止。服务停止后进行中的请求会取消；手动浏览器配对会话失效。同源连接凭据有效八小时，服务重启在有效期内复用，过期重启时更新；前端按需重新读取。固定端口为服务 8091、开发前端 5173；端口被占用时明确退出，不自动换端口或扩大来源范围。

本机地址与 GitHub Pages 是不同浏览器存储来源。线上资料不会自动出现在本机地址；如需迁移应由用户显式备份/导入，不能清空原站数据。本功能不提供跨设备同步，也不支持安卓远程访问电脑服务。

## 认证核实与当前阻塞

2026-10-19 核对的官方依据：

- [开源/本机应用的订阅使用范围](https://developers.openai.com/siwc/token-sharing-open-source)：存在独立订阅授权机制，远程托管和分发范围需要分别确认。
- [注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)：本机回调监听、PKCE S256、state、nonce、动态注册后签发的 client ID、ID Token 验证及实际授予的 `chatgpt.tokens.use.direct`。不能借用 Codex 身份或网页登录 Cookie。
- [账户与凭证](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)：凭证在受保护的本地运行环境保存，不进入浏览器存储；刷新串行处理，正确处理撤销。
- [模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)：账户模型发现及公共 `/v1/responses`，必须收到 `response.completed` 才能算完成。
- [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)：`store:false`、`stream:true`，自行提供上下文，不能原样转发 DeepSeek 参数。

**实际账户接入成功与否仍待验证。** 用户已同意推进官方授权；仅在用户点击登录、在 OpenAI 页面确认后才创建注册/授权。采用独立实现，没有复制官方 DevKit 的非商业许可代码。新增 `jose` 用于维护中的 JWT 签名、issuer、audience、expiry 和 nonce 校验，不手写签名验证。

`server/chatgpt-auth.mjs` 实现 Reader 独立注册、回环监听、PKCE/state/nonce、实际 scope 校验、模型发现、串行刷新、账户切换和退出撤销。凭证保存在用户应用数据目录，不在仓库：Windows 使用 DPAPI CurrentUser 加密；非 Windows 使用 0700 目录和 0600 原子文件。退出时尽力撤销远端会话，失败也清除本机凭证并明确提示。真实文本与单张图片调用已验证；若其他模型或场景不可用则报告原因，不改用计费 Key。

Platform API 是另一计费体系，ChatGPT Plus 不等于 Platform API 额度。本版本没有该模式，也不接受 `OPENAI_API_KEY`，不会偷偷启用额外收费。订阅模式若以后启用，仍受账户额度和积分策略限制。

## 模块与请求流程

`server/local-server.mjs` 负责本机 HTTP 服务、Host/Origin 检查、配对会话、请求限制和生命周期。`server/start.mjs` 负责固定回环地址启动与进程退出。它们只使用 Node.js 内置模块，没有新增服务框架或数据库。

`server/openai-contract.mjs` 把 Reader 已选上下文投影为 Responses 输入：system 转 developer，保留用户文本和已编码的页面图片，不读取 PDF、不自行扩展历史。远程图片 URL 不被服务抓取，避免任意代理和 SSRF。当前上限为 24 MiB 请求、100 张图片、1000 条消息，超限明确报错；这只是本机资源限制，不代表真实模型能力。真实模型适配器仍需按所选模型实施能力与上下文限制。

`src/api/chat-provider.ts` 是对话发送前检查与流式分流的最小边界；原 `deepseek.ts` 完全不改。`src/api/openai-local.ts` 只处理本机协议，复用现有消息格式。`LocalProviderSettings.tsx` 提供中英文 Provider 选择、配对、状态和本机模型入口。

主线与分支在持久化用户消息前检查 Provider，避免服务不可用留下已发送消息；已有流式引擎继续负责占位、增量渲染、检查点、分支隔离、失败和停止。用户停止或组件的 AbortSignal 中断时，取消浏览器请求，由服务连接关闭取消上游。

## 本机 API 与安全边界

v3.0.5 发送延迟处理：主线和分支都在远程状态检查前占用生成租约，界面立即显示“准备中”；并发重复提交返回 busy，不追加消息、不制造授权错误。检查可被停止操作取消，取消后不提交消息或清空未接受的草稿。前端只将成功且已授权的状态缓存最多 15 秒供发送/图片检查复用，设置页显式检查始终请求新状态；登录、切换账户、配对变化和错误会清缓存。纯文字跳过图片能力检查。后端合并同一账户的并发模型发现，推理前仍执行真实权限检查，不因客户端缓存跳过服务端鉴权。实际网络失败或登录尚在进行会显示对应原因，不宣称能消除模型推理首字耗时。

所有接口都只接受 `http://127.0.0.1:5173`、`http://127.0.0.1:4173`、`https://beichen126.github.io` 的精确 Origin，并检查 Host 为当前服务的 `127.0.0.1:端口`。4173 仅预留给手动以该地址启动的本机 preview；默认 preview 命令不因此改变。其他 GitHub Pages 用户域名、localhost、局域网地址和其他端口不在允许列表。CORS 的安全边界是 Origin，不能按 `/ai-education-reader/` 路径隔离；该账户同一 Pages 域名下的其他项目也必须可信。

| 接口 | 用途与权限 |
| --- | --- |
| GET /health | 允许来源可检查是否启动；不返回凭证或账户信息 |
| POST /pair | 一次性配对；本地页面使用 HttpOnly/SameSite=Strict Cookie，Pages 页面使用短期、来源绑定的本机会话能力 |
| GET /status | 需配对；只返回明确允许的状态、模型和图片能力字段 |
| POST /chat | 需配对、已验证授权与当前账户可用模型；只调用公共 Responses API |
| POST /auth/start、/auth/cancel | 开始或取消独立官方授权；回调使用临时回环监听器 |
| POST /auth/account、/auth/logout | 切换已保存账户，或撤销并清除当前账户凭证 |
| POST /disconnect | 删除本机配对并取消进行中的请求；不等同于撤销 OpenAI 授权 |

Cookie 不包含 OpenAI 凭证，只是本机服务会话，最长八小时、服务停止即失效。回环 HTTP Cookie 没有 Secure 标记，因此服务不能暴露在局域网。不同端口并不是完全隔离的浏览器信任边界；来源校验和配对共同防护，但不能抵御同机恶意软件或已被攻陷的允许来源。

### GitHub Pages 连接同一电脑的服务

先在电脑启动 `npm run local:server`（需要代理的环境沿用代理启动方式），然后打开 `https://beichen126.github.io/ai-education-reader/`，在 API 设置选择本机 OpenAI，填写终端配对码并点击“配对”。浏览器若请求本地网络访问权限，需要用户允许；服务不会绕过权限或建议关闭浏览器安全机制。已有 ChatGPT 授权直接复用；没有授权才继续官方登录。原线上会话与 PDF 仍在原 Origin，不需要导入迁移。无需运行本地 Vite。

Pages 请求固定连接 `http://127.0.0.1:8091`，不允许自定义目标地址。配对使用 JSON 请求和精确来源校验，返回的随机能力仅供 Reader 本机接口使用，不是 OAuth Access/Refresh Token。以 `X-Reader-Session` 请求头发送，跨站请求禁用 Cookie。

v3.0.4 新增默认勾选的“记住这台电脑”：在用户点击配对后，浏览器将本机配对能力保存在独立 localStorage 键 `aer-local-pairing-v1` 中，不进入 IndexedDB、Reader 备份或日志。本机只保存能力的 SHA-256 摘要及来源、期限，保存在独立的 `pairings` 凭证库中；Windows 使用 DPAPI 加密。刷新页面、重开浏览器、重启服务后自动恢复，无需重新输入配对码。约 30 天未使用过期，有效使用时最多每天持久续期一次。点击“断开并忘记配对”会在服务在线时撤销该能力并清除浏览器保存值；清除站点数据或配对库也会要求重新配对。最多保存 16 个配对。新能力必须在一次性配对码校验后签发，不提供免配对获取接口。

不勾选时继续使用页面内存中的临时配对，最长八小时，刷新页面或服务停止即失效。已有旧版临时配对不能自动升级为长期配对，需要在新服务中重新配对一次。浏览器禁止保存时明确提示本次连接只能临时使用。OpenAI 长期凭证始终不进入网页。被信任 Origin 内的恶意脚本仍可能读取本机配对能力，故仅在可信任的个人电脑上勾选，不能将它视为操作系统凭证库。

HTTPS 网页访问回环服务受浏览器本地网络权限、混合内容策略和企业策略影响；本项目不承诺所有浏览器可用。现代 Chrome/Edge 应按站点提示允许本地网络访问；被策略阻止时提供本地 Reader 作为替代，不放开监听地址或通配 CORS。旧版 PNA 的预检仅对精确允许来源响应，不替代实际配对。参考 [Chrome 官方本地网络访问说明](https://developer.chrome.com/blog/local-network-access)。手机的回环地址仍指手机本身，不能用此方式连接电脑。

测试 `npm run test:e2e-pages-local-provider`：隔离 Edge 上下文使用受控 HTTPS Pages-origin 测试页面，实际跨源连接随机端口本机测试服务；验证真实 CORS/预检、图片流式完成、临时连接刷新失效，以及记住配对后刷新/服务重启恢复、断开后服务重启仍保持撤销。配对存储单元测试另验证摘要存储、来源绑定、自动续期及闲置过期。上游为 Mock，不消耗订阅。此测试不等同于已部署 GitHub Pages 的真实 OAuth 验证；上线后仍需用户在实际浏览器允许权限并完成官方登录。

v3.0.4 同时细分 OAuth 回调的地址、方法、重复处理和过期错误；凭证接口失败返回安全的 HTTP 状态分类或已知机器错误码，不回显 Token、授权码或原始响应内容。代理环境应使用 `npm run local:server:proxy` 并按实际本机代理设置环境变量。登录、配对和模型就绪是不同阶段，不以编译或 Mock 成功代表真实授权成功。

本机开发模式新增 `server/local-transport.mjs`：本机服务与 Vite 进程共享单独的受保护连接能力（Windows 同样使用 DPAPI），Vite 校验精确 Host、Origin/Referer 和方法后才代理固定本机接口，忽略并覆盖浏览器伪造的认证头。直接访问后端仍要求认证；同源代理不对 GitHub Pages、普通构建或其他开发模式开放。连接能力只进入 Node 请求头，不进入浏览器、Vite define、环境注入或产物。可正常进行的本机前端进程属于受信任运行环境，不能抵御同一用户权限的恶意本机程序。

流式接口使用 `delta`、`completed` 和 `error` 事件；失败、未完成、非法 JSON、超大事件和提前断流不作为成功。最多两路请求，单请求三分钟，HTTP 头和请求体接收有超时限制。服务端不记录聊天、Token、上游原始异常或请求体。除了启动地址、一次性配对码和固定错误提示，不输出敏感调试信息。

实测订阅 Responses 接口可能返回 HTTP 200 和合法 SSE，但省略 `Content-Type`。后端允许响应头缺失，仍严格检查事件帧和 `response.completed`；明确返回 JSON/HTML 类型的响应不会被当成正常流。回归测试覆盖缺失响应头时的成功、提前断流、伪 HTML，以及显式 JSON 拒绝。

没有新增 `.env` 文件或 Vite 凭证配置。现有 `.gitignore` 已排除环境文件，额外预留 `.reader-local/` 排除目录；实际凭证位于操作系统用户应用数据目录。本机配对和认证凭证不参与 Reader 备份；Provider 选择是设备相关设置，不新增备份格式或数据库版本。

## 验证方法与验收边界

```powershell
npm run typecheck
npm run build
npm run test:local-server
npm run test:chatgpt-auth
npm run test:e2e-local-provider
```

本机测试覆盖：精确来源与 Host、未配对拒绝、配对失败次数/一次性限制、默认授权关闭、状态字段脱敏、原上下文投影、图片限制、流式完成和错误、断流、取消、Provider 持久化、API Key 不被转发，以及原 DeepSeek 地址和 max 推理强度不变。

浏览器测试使用真实本地前端和本机 HTTP 服务，**上游是 Mock**，验证真实浏览器的 CORS、HttpOnly Cookie、配对、设置持久化、文本/图片投影、服务停止反馈。不把 curl/Node fetch 的成功当作浏览器跨源成功。

2026-10-19 用户完成真实授权后，已确认本机保存了 Reader 自身的授权，具备订阅使用 Scope；官方模型接口返回 HTTP 200，9 个目录条目中有 7 个供界面选择。随后使用账户返回的首个可用模型向公共 Responses API 发送一次固定短文本，HTTP 200、收到 `response.completed`、输出 `OK`。这证明本机订阅授权与最小文本推理已实测可用，不代表图片、全部模型或所有 Reader 场景均已验证。JWT 验证、scope 拒绝、回调 state/PKCE、模型过滤、串行刷新和退出另有 Mock 测试；Windows DPAPI 使用真实系统 API 完成测试数据加解密。GitHub Pages 部署配置保持不变，未执行推送或部署。

本次实际结果：TypeScript 与生产构建通过；本机服务 7 项 Node 测试、前端 Provider 测试和真实 Edge 浏览器本机链路测试通过。原有设置持久化、DeepSeek 推理强度、发送原子性、分支流、发送前检查、SSE、流式持久化、多模态、教学协议投影和图片能力测试通过；原有主线停止生成浏览器测试 4/4，通过刷新确认部分回复仍保留；设置页中英文桌面/手机三组回归通过。README 契约和产品指南同步检查通过。未运行整个项目全部测试。构建仍报告既有的较大 chunk 与混合动态/静态导入提示，未为本次功能重构打包。

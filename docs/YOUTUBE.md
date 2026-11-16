# YouTube 字幕：无自建后端

网页版使用 `extensions/youtube-bridge` 配套 Manifest V3 扩展。下载发布包中的 ZIP 并解压，在 Chrome/Edge 扩展管理页打开开发者模式，加载该目录，刷新阅读器。扩展只匹配正式阅读器路径，并仅申请 YouTube 的脚本权限。源码中的主站地址是明确白名单；自部署需自行修改白名单。

用户点击提取后扩展新开 YouTube 标签页，读取可用字幕：先尝试播放器字幕轨，再尝试转写数据和实际转写面板，兼容旧 renderer 与新版 transcript-segment-view-model。成功后激活阅读器标签页，YouTube 标签页保留供查看。登录或验证由用户在 YouTube 完成。不会向阅读器传递 Cookie 或账户资料。失败或取消不会加入附件。

Android 2.0.1 使用独立原生 WebView 提取，相同 extractor.js 随 APK 打包。YouTube WebView 不注入 JavaScript 原生接口，只由宿主在已核对的 YouTube 视频页面执行固定提取代码、轮询结果。阅读器自己的可信 appassets 页面通过 AndroidYoutube 请求提取；原生请求有视频 ID、来源和语言检查。系统返回可关闭提取窗口。

Android 工程位于 F:/Android/projects/ai-education-reader。本仓库 android/youtube/YoutubeBridge.kt 保留本次桥接源码；WebAppScreen 注册 AndroidYoutube 并在 dispose 调用 shutdown。assets/android/youtube-extractor.js 必须从扩展源码同步，避免两端漂移。

字幕按视频 ID + 语言偏好保存在 IndexedDB。再次使用直接读取缓存。附件快照带标题、来源、时间戳和全部已取得的字幕；发送时投影成 text，不发送预览 PNG，不占最近图片预算。附件预览图在本机生成，用户输入框不填入字幕。原生和扩展均不下载视频，不使用付费转写服务，没有字幕时不能凭空生成。

语言是偏好，不保证视频提供该语言；转写面板回退使用页面当前语言，并在预览中明确显示。未接 ASR。网页必须安装扩展，普通手机浏览器不保证可用，请使用 APK。浏览器扩展依赖 YouTube 页面结构，未来变化可能需要更新。

验证：真实 Chromium 加载完整扩展，从正式阅读器域名请求 3Blue1Brown 的 aircAruvnKk，收到 130 段，最后时间戳 1102 秒。浏览器模拟测试覆盖 2×2 菜单、预览、上下文文本、纯文本模型、刷新缓存和手机宽度。Android 经过编译、单元测试与 lint；当前没有连接实体手机，不能将共享提取逻辑的桌面验证等同于 Android 真机验证。

import {writeFileSync} from 'node:fs'
import {COMPONENT_SCHEMAS,GENUI_SPEC_SCHEMA} from '../node_modules/@changfenhuang/dsh-genui/src/client/genui-runtime/schema.ts'
const common=new Set(['type','span','when','enableWhen'])
const describe=(s:any):string=>{
 const fields=Object.keys(s.fields).filter(k=>!common.has(k)).map(k=>k+(s.required.includes(k)?'*':'')+(s.enums[k]?':'+s.enums[k].join('|'):s.fields[k]==='nodes'?':nodes':'')).join(',')
 const nested=Object.entries(s.nested).filter(([k])=>!common.has(k)).map(([k,v])=>k+'{'+describe(v)+'}').join(';')
 return fields+(nested?' ['+nested+']':'')
}
const lines=Object.entries(COMPONENT_SCHEMAS).map(([name,s])=>name+': '+describe(s))
lines.unshift('ROOT: '+describe(GENUI_SPEC_SCHEMA))
const intro=`GenUI 生成规则（真实可渲染，不只是示意代码）
当可视化能帮助理解，直接给一个聚焦的交互界面，不必先询问。用户明确要图、交互或单词卡时，应生成相应界面；简单事实、纯文字或严格 JSON 请求遵从用户格式。通常“一个界面＋简短解释”即可，不堆组件、不重复长篇复述，不虚构数据或已经实现的业务功能。
布局优先：讲解型流程、架构优先用原生 col + card/grid + arrow 组成紧凑卡片图：一个外框，标题与说明紧邻，顺序段可直接放居中文字，并行段用等宽 grid，随后短箭头汇合。不要把整幅图缩小，也不要每段套框、固定高卡片或用 spacer 撑高。通常 gap=8–12，箭头 length=18–24；分支注释放箭头 label，不占中间一列。桌面2–3列，手机自然堆叠。概览用跨列 card.span，分类可嵌套一层；按内容混排，不机械重复模板。细节用 accordion、多视角用 tabs、可计算内容用 slider + computed 或 plot；必须真的联动，核心结论始终可见。
用途速查：
- card/row/grid/divider：分类介绍、概念分组、并排比较；保持清晰层级。
- steps/timeline/arrow：操作步骤、事件先后、纵向链路；箭头表达真实依赖。
- diagram/mermaid：需要精确连线的复杂网络、时序、层级、思维导图；并行处理须画分叉与汇合，不能误画成串行。
- chart/echart：数据趋势、组成、分布、关系和流向；按数据选折线、柱、饼、散点、雷达、热力、桑基等，不默认一律柱状图。
- plot：连续函数和数学模拟；用参数滑杆、缩放或动画展示变化，不能用离散条形图代替曲线。
- table/keyvalue/compare/badge：精确数值、属性与能力对照；状态标签同时用文字和颜色表达结果。
- stat/progress/ring：关键指标、进度、目标完成度；注明单位和口径。
- input/select/slider/checkbox/radio/switch/date-picker：收集输入或调整参数；computed 负责实时计算，when/enableWhen 控制显隐和可用性。
- quiz/choices/submit：练习、测验、即时反馈；给出正确答案与解释，不做无反馈的装饰按钮。
- tabs/accordion/popover：组织较多内容、展开细节；首屏保留核心结论。
- scene3d/map：空间几何、旋转观察与地理点位；3D 用于空间理解，地图底图需真实资源。
- text/code/diff/json/file-tree：正文公式、代码讲解、版本差异、结构化数据与文件层级。
- image/carousel/image-group/svg/audio/video：图片与媒体展示；只用真实可访问来源，不编造资源 URL。
- reader-vocabulary：词汇学习与发音；展示单词、音标、释义，可加例句，DeepSeek 朗读由用户点播。
输出：使用 dsh-ui 围栏，普通组件根为 {"schema":"dsh-genui","title":"简短标题","items":[...]}。节点有 type；布局 items 是节点数组。只使用下面字段，*=必填；嵌套字段列在 [] 中。通用字段 span；条件 when/enableWhen:{field,op,value}，op=eq|neq|in|not-in|gt|gte|lt|lte|empty|not-empty|checked。表单 id/group 绑定本地状态，submit.groups 引用这些 id/group；computed:[{id,expr}]，用 "{{id}}" 引用结果。
按钮 action 回传当前会话，回传数据当作用户输入；不索取密钥，不执行 JS/HTML。最多200节点、8层、256KB。语言跟随用户，公式可用 $...$。支持展开画布与 JSON/HTML 导出；不把 DSH 宿主插件或 Flutter transport 当成本应用功能。
最小例子：
紧凑卡片图 {"type":"col","gap":8,"items":[{"type":"text","size":"h2","center":true,"content":"输入"},{"type":"arrow","dir":"down","length":20},{"type":"grid","cols":2,"items":[{"type":"card","title":"处理一","items":[{"type":"text","content":"简短说明"}]},{"type":"card","title":"处理二","items":[{"type":"text","content":"简短说明"}]}]},{"type":"arrow","dir":"down","length":20,"label":"汇合"},{"type":"text","center":true,"content":"输出结论"}]}。

曲线 {"type":"plot","xMin":-6.28,"xMax":6.28,"yMin":-3,"yMax":3,"series":[{"expr":"a*sin(x)","label":"y=a sin(x)","params":[{"name":"a","value":1,"min":0.1,"max":3,"step":0.1}]}]}。支持 x,pi,e,trig,sqrt,log,exp,abs,pow,min,max；参数可设置 animateTo,durationMs,loop。
分叉汇合 {"type":"mermaid","code":"flowchart TB; A[输入] --> B[处理一]; A --> C[处理二]; B --> D[汇合]; C --> D"}。diagram 的节点用 id,label,x,y,w,h，edges 用 from,to；复杂自动布局优先 Mermaid。
状态表 {"type":"table","columns":["能力","状态"],"types":["text","badge"],"rows":[["OCR 文本","通过 · 可以"],["跨服务 file_id","拒绝 · 不可用"]]}。任意标签用 badge:{label,tone:"success"|"danger"|"warn"|"accent"} 配合 grid/row。
单词卡使用单独的 dsh-ui 围栏：{"schema":"reader-vocabulary","items":[{"type":"vocabulary","word":"analytics","phonetic":"/ˌænəˈlɪtɪks/","meaning":"n. 数据分析；分析学","example":"We use analytics to understand learning progress."}]}。1–40词；word≤120字、phonetic≤200、meaning/example≤2000；提供真实音标，勿编造音频或自动播放。此扩展不可嵌入 dsh-genui 布局，可与普通界面分围栏组合。
组件字段目录（dsh-genui 0.16.0，60种）：
`
writeFileSync('src/genui/catalog-prompt.ts','// Generated from @changfenhuang/dsh-genui 0.16.0. See THIRD_PARTY_NOTICES.\nexport const FULL_GENUI_PROMPT = '+JSON.stringify(intro+lines.join('\n'))+'\n')
console.log('catalog components',lines.length-1,'characters',intro.length+lines.join('\n').length)

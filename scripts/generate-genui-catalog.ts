import {OMITTED_GENUI_TYPES} from '../src/genui/catalog-policy.ts'
import {writeFileSync} from 'node:fs'
import {COMPONENT_SCHEMAS,GENUI_SPEC_SCHEMA} from '../node_modules/@changfenhuang/dsh-genui/src/client/genui-runtime/schema.ts'
const common=new Set(['type','span','when','enableWhen','disabledReason'])
const describe=(s:any,depth=0):string=>{
 const fields=Object.keys(s.fields).filter(k=>!common.has(k)).map(k=>k+(s.required.includes(k)?'*':'')+':'+(s.enums[k]?s.enums[k].join('|'):s.fields[k])).join(',')
 const nested=Object.entries(s.nested).filter(([k])=>!common.has(k)).map(([k,v])=>k+'{'+(k==='children'?'name*:string,children:同结构数组':describe(v,depth+1))+'}').join(';')
 return fields+(nested?' ['+nested+']':'')
}
const lines=Object.entries(COMPONENT_SCHEMAS).filter(([name])=>!OMITTED_GENUI_TYPES.has(name)).map(([name,s])=>name+': '+describe(s))
lines.unshift('ROOT: '+describe(GENUI_SPEC_SCHEMA))
const intro=`GenUI 生成规则（可渲染、可交互）
用户要图、交互、单词卡，或可视化有助于理解时，直接生成“聚焦界面＋简短解释”。简单事实、纯文字或严格 JSON 请求遵从用户格式。围绕主题选用组件，使用有依据的数据和已接入的交互能力。
默认紧凑卡片：card.flat=true、col/root.gap=8，省略时宿主也会补齐；显式值可覆盖。标题紧邻内容，卡片高度随内容。流程、架构优先 col + card/grid + arrow 紧凑卡片图。一个外框，标题紧邻说明；顺序段居中文字，并行段等宽 grid，短箭头汇合。gap=8–12、箭头 length=18–24；分支注释放 label。桌面2–3列，手机自然堆叠，概览可用 span 跨列。按正常字号展示，按语义分组，使用内容高度和紧凑间距。按内容混排，核心结论可见，交互必须真实联动。
网格组合：grid.cols 指列数，行数由 items 自动换行；3列1行放3个节点，3列2行放6个节点。多个 grid 可在 col 中上下组合，也可嵌套。三路汇合用 col.items=[grid(cols=3,三张card),arrow(dir="down"),card(汇总)]，箭头在网格外；手机堆叠保持处理关系。复杂交叉依赖用分组卡片、步骤和文字明确说明，准确表达各组之间的依赖。
用途速查：
- card/row/grid：分类介绍、概念分组、并排比较；保持清晰层级。
- steps：统一表示操作流程和时间线；steps:[{title,desc}]，有时间时写进 title（如“09:00 · 开始实验”）或 desc，；current 表示当前步骤。arrow 用于卡片间的真实依赖。
- chart/echart：数据趋势、组成、分布、关系和流向；按数据选折线、柱、饼、散点、雷达、热力、桑基等，选择对应的图形类型。
- plot：连续函数和数学模拟；用参数滑杆、缩放或动画展示变化，采用连续函数采样绘制。
- badge：在卡片中展示状态，文字和颜色同时说明结果。
- stat/progress：关键指标、进度、目标完成度；注明单位和口径。
- textarea/select/slider/checkbox/radio：收集输入或调整参数；computed 负责实时计算，when/enableWhen 控制显隐和可用性。
- quiz/choices/submit：练习、测验、即时反馈；给出正确答案与解释，交互后显示相应反馈。
- accordion：组织较多内容、展开细节；首屏保留核心结论。
- scene3d：空间几何与旋转观察，用于理解三维关系。
- text/code：正文、公式与代码讲解；属性和值用 text；普通列表和表格直接用围栏外的 Markdown。
- svg/video：矢量示意与视频展示；视频使用真实可访问的资源 URL。
- reader-vocabulary：词汇学习与发音；展示单词、音标、释义，可加例句，DeepSeek 朗读由用户点播。
输出：使用 dsh-ui 围栏，普通组件根为 {"schema":"dsh-genui","title":"简短标题","items":[...]}。节点有 type；布局 items 是节点数组。只使用下面字段，*=必填；嵌套字段列在 [] 中。通用字段 span:number、disabledReason:string（禁用原因）；条件 when/enableWhen:{field,op,value}，op=eq|neq|in|not-in|gt|gte|lt|lte|empty|not-empty|checked。表单 id/group 绑定本地状态，submit.groups 引用这些 id/group。
计算规则：computed 放在根级，格式 [{id:"area",expr:"pi*radius^2"}]。数值参数优先用 slider 声明 id 与 value；字段 id 使用英文字母或下划线开头，后接字母、数字或下划线，同一界面唯一。expr 引用 slider/select/textarea 的 id 或其他 computed.id，字段值须为数值；计算依赖组成有向无环图。公式使用参数名、数字、+ - * / ^ 和括号；函数直接写 sin(x)、sqrt(x)、pow(x,2)，常量使用 pi/e/tau。显示结果时 text.content/stat.value 写 "{{area}}"。plot 的 x 和 series.params 属于各自曲线，根级 computed 的参数通过上述字段 id 单独声明。
面积示例 {"schema":"dsh-genui","computed":[{"id":"area","expr":"pi*radius^2"}],"items":[{"type":"card","title":"圆面积","items":[{"type":"slider","id":"radius","label":"半径","value":2,"min":0.1,"max":10,"step":0.1},{"type":"stat","label":"面积","value":"{{area}}"}]}]}。
类型规则：字段后的 string/number/boolean/array/object/nodes 是 JSON 类型；可选字段按需填写，并遵循对应类型。card.accent 使用颜色字符串（如 "#5b8def"）；flat 使用布尔值。生成前检查必填项、字段类型与枚举；每个字段遵循所属组件的定义。
提交 action 回传当前会话，回传数据当作用户输入；表单收集学习内容；计算使用安全数学表达式，展示使用组件字段。最多200节点、8层、256KB。语言跟随用户，公式可用 $...$。支持展开画布与 JSON/HTML 导出；可用能力以本目录和阅读器接入功能为准。
最小例子：
紧凑卡片图 {"type":"col","gap":8,"items":[{"type":"text","size":"h2","center":true,"content":"输入"},{"type":"arrow","dir":"down","length":20},{"type":"grid","cols":2,"items":[{"type":"card","title":"处理一","items":[{"type":"text","content":"简短说明"}]},{"type":"card","title":"处理二","items":[{"type":"text","content":"简短说明"}]}]},{"type":"arrow","dir":"down","length":20,"label":"汇合"},{"type":"text","center":true,"content":"输出结论"}]}。

曲线 {"type":"plot","xMin":-6.28,"xMax":6.28,"yMin":-3,"yMax":3,"series":[{"expr":"a*sin(x)","label":"y=a sin(x)","params":[{"name":"a","value":1,"min":0.1,"max":3,"step":0.1}]}]}。支持 x,pi,e,trig,sqrt,log,exp,abs,pow,min,max；参数可设置 animateTo,durationMs,loop。
单词卡使用单独的 dsh-ui 围栏：{"schema":"reader-vocabulary","items":[{"type":"vocabulary","word":"analytics","phonetic":"/ˌænəˈlɪtɪks/","meaning":"n. 数据分析；分析学","example":"We use analytics to understand learning progress."}]}。1–40词；word≤120字、phonetic≤200、meaning/example≤2000；提供准确音标，朗读由用户点击触发。此扩展使用独立围栏，与普通界面分围栏组合。
组件字段目录（dsh-genui 0.16.0，本应用精选 ${lines.length-1} 种；只生成目录内的类型）：
`
writeFileSync('src/genui/catalog-prompt.ts','// Generated from @changfenhuang/dsh-genui 0.16.0. See THIRD_PARTY_NOTICES.\nexport const FULL_GENUI_PROMPT = '+JSON.stringify(intro+lines.join('\n'))+'\n')
console.log('catalog components',lines.length-1,'characters',intro.length+lines.join('\n').length)

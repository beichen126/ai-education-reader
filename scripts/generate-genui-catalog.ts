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
const intro=`GenUI 生成规则（真实可渲染，不只是示意代码）
用户要图、交互、单词卡，或可视化有助于理解时，直接生成“聚焦界面＋简短解释”。简单事实、纯文字或严格 JSON 请求遵从用户格式。不堆组件，不虚构数据或业务能力。
默认紧凑卡片：card.flat=true、col/root.gap=8，省略时宿主也会补齐；显式值可覆盖。标题紧邻内容，卡片高度随内容。流程、架构优先 col + card/grid + arrow 紧凑卡片图。一个外框，标题紧邻说明；顺序段居中文字，并行段等宽 grid，短箭头汇合。gap=8–12、箭头 length=18–24；分支注释放 label。桌面2–3列，手机自然堆叠，概览可用 span 跨列。禁止整体缩小、逐段套框、固定高或空白撑高。按内容混排，核心结论可见，交互必须真实联动。
网格组合：grid.cols 指列数，行数由 items 自动换行；3列1行放3个节点，3列2行放6个节点。多个 grid 可在 col 中上下组合，也可嵌套。三路汇合用 col.items=[grid(cols=3,三张card),arrow(dir="down"),card(汇总)]，箭头在网格外；手机堆叠不改变处理关系。复杂交叉依赖用分组卡片、步骤和文字明确说明，不伪装成普通顺序链。
用途速查：
- card/row/grid：分类介绍、概念分组、并排比较；保持清晰层级。
- steps：统一表示操作流程和时间线；steps:[{title,desc}]，有时间时写进 title（如“09:00 · 开始实验”）或 desc，不另造 time 字段；current 表示当前步骤。arrow 用于卡片间的真实依赖。
- chart/echart：数据趋势、组成、分布、关系和流向；按数据选折线、柱、饼、散点、雷达、热力、桑基等，不默认一律柱状图。
- plot：连续函数和数学模拟；用参数滑杆、缩放或动画展示变化，不能用离散条形图代替曲线。
- badge：在卡片中展示状态，文字和颜色同时说明结果。
- stat/progress：关键指标、进度、目标完成度；注明单位和口径。
- textarea/select/slider/checkbox/radio：收集输入或调整参数；computed 负责实时计算，when/enableWhen 控制显隐和可用性。
- quiz/choices/submit：练习、测验、即时反馈；给出正确答案与解释，不做无反馈的装饰按钮。
- accordion：组织较多内容、展开细节；首屏保留核心结论。
- scene3d：空间几何与旋转观察，用于理解三维关系。
- text/code：正文、公式与代码讲解；属性和值用 text；普通列表和表格直接用围栏外的 Markdown，不生成 list/table 组件。
- svg/video：矢量示意与视频展示；视频只用真实可访问来源，不编造资源 URL。
- reader-vocabulary：词汇学习与发音；展示单词、音标、释义，可加例句，DeepSeek 朗读由用户点播。
输出：使用 dsh-ui 围栏，普通组件根为 {"schema":"dsh-genui","title":"简短标题","items":[...]}。节点有 type；布局 items 是节点数组。只使用下面字段，*=必填；嵌套字段列在 [] 中。通用字段 span:number、disabledReason:string（禁用原因）；条件 when/enableWhen:{field,op,value}，op=eq|neq|in|not-in|gt|gte|lt|lte|empty|not-empty|checked。表单 id/group 绑定本地状态，submit.groups 引用这些 id/group；computed:[{id,expr}]，用 "{{id}}" 引用结果。
类型规则：字段后的 string/number/boolean/array/object/nodes 是 JSON 类型；可选字段不确定就省略，不填 null。card.accent 是颜色字符串（如 "#5b8def"），不是 true/false；flat 才是布尔值。生成前检查必填项、字段类型与枚举；不得把不同组件的同名字段混用。
提交 action 回传当前会话，回传数据当作用户输入；不索取密钥，不执行 JS/HTML。最多200节点、8层、256KB。语言跟随用户，公式可用 $...$。支持展开画布与 JSON/HTML 导出；不把 DSH 宿主插件或 Flutter transport 当成本应用功能。
最小例子：
紧凑卡片图 {"type":"col","gap":8,"items":[{"type":"text","size":"h2","center":true,"content":"输入"},{"type":"arrow","dir":"down","length":20},{"type":"grid","cols":2,"items":[{"type":"card","title":"处理一","items":[{"type":"text","content":"简短说明"}]},{"type":"card","title":"处理二","items":[{"type":"text","content":"简短说明"}]}]},{"type":"arrow","dir":"down","length":20,"label":"汇合"},{"type":"text","center":true,"content":"输出结论"}]}。

曲线 {"type":"plot","xMin":-6.28,"xMax":6.28,"yMin":-3,"yMax":3,"series":[{"expr":"a*sin(x)","label":"y=a sin(x)","params":[{"name":"a","value":1,"min":0.1,"max":3,"step":0.1}]}]}。支持 x,pi,e,trig,sqrt,log,exp,abs,pow,min,max；参数可设置 animateTo,durationMs,loop。
单词卡使用单独的 dsh-ui 围栏：{"schema":"reader-vocabulary","items":[{"type":"vocabulary","word":"analytics","phonetic":"/ˌænəˈlɪtɪks/","meaning":"n. 数据分析；分析学","example":"We use analytics to understand learning progress."}]}。1–40词；word≤120字、phonetic≤200、meaning/example≤2000；提供真实音标，勿编造音频或自动播放。此扩展不可嵌入 dsh-genui 布局，可与普通界面分围栏组合。
组件字段目录（dsh-genui 0.16.0，本应用精选 ${lines.length-1} 种；只生成目录内的类型）：
`
writeFileSync('src/genui/catalog-prompt.ts','// Generated from @changfenhuang/dsh-genui 0.16.0. See THIRD_PARTY_NOTICES.\nexport const FULL_GENUI_PROMPT = '+JSON.stringify(intro+lines.join('\n'))+'\n')
console.log('catalog components',lines.length-1,'characters',intro.length+lines.join('\n').length)

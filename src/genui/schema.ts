export type UiNode = { type: string; [key: string]: any }
const types = new Set(['text','heading','card','stack','row','grid','callout','stat','badge','progress','list','steps','table','chart','quiz','button','input','select','slider','submit','tabs','accordion'])
export function parseGenUi(source: string): UiNode[] {
  if (source.length > 64000) throw new Error('UI 内容超过 64 KB')
  const root = JSON.parse(source)
  let count = 0
  function visit(nodes: unknown, depth: number): asserts nodes is UiNode[] {
    if (!Array.isArray(nodes) || depth > 8) throw new Error('组件结构无效或嵌套过深')
    for (const n of nodes) {
      if (++count > 160 || !n || !types.has(n.type)) throw new Error('组件过多或包含不支持的组件')
      if (['card','stack','row','grid'].includes(n.type)) visit(n.items ?? [], depth + 1)
      if (n.type === 'tabs' || n.type === 'accordion') {
        const entries = n.type === 'tabs' ? n.tabs : n.items
        if (!Array.isArray(entries)) throw new Error('分组结构无效')
        entries.forEach((entry: any) => { if (!entry || typeof entry !== "object") throw new Error("分组无效"); visit(entry.items ?? [], depth + 1) })
      }
      if (n.type === 'quiz' && (!Array.isArray(n.options) || n.options.some((o: any) => !o || typeof o.label !== 'string'))) throw new Error('题目选项无效')
      if (['input','select','slider'].includes(n.type) && (typeof n.id !== 'string' || !n.id || ['__proto__','constructor','prototype'].includes(n.id))) throw new Error('表单字段需要唯一 id')
      if (['quiz','select'].includes(n.type) && !Array.isArray(n.options)) throw new Error('选项必须是数组')
      if (n.type === 'table' && (!Array.isArray(n.columns) || !Array.isArray(n.rows) || n.rows.some((r: unknown) => !Array.isArray(r)))) throw new Error('表格需要 columns 和 rows 数组')
      if (['list','steps','chart'].includes(n.type) && !Array.isArray(n.items ?? n.data)) throw new Error('组件数据必须是数组')
    }
  }
  visit(root.items, 0)
  return root.items
}
export const GENUI_PROMPT = `You may render interactive learning aids using a fenced dsh-ui JSON block, only when it helps the user. Match the conversation language. Respect requests for plain text or strict JSON. Never put secrets in UI. Supported schema: {"items":[nodes]}. Nodes: text {content}; heading {text}; card/stack/row/grid {title?,items:[nodes]}; callout {title?,content}; stat {label,value}; badge {text}; progress {label,value:0..100}; list/steps {items:[{title,desc}]}; table {columns:[strings],rows:[[scalar cells]]}; chart {data:[{label,value:number}]} (bar chart); quiz {question,options:[{label,correct:boolean,feedback?}],explanation}; input {id,label,value?}; select {id,label,options:[strings]}; slider {id,label,min,max,step?,value?}; submit {label,action}; button {label,action}; tabs {tabs:[{label,items:[nodes]}]}; accordion {items:[{title,items:[nodes]}]}. Use only these types, no HTML, JavaScript, external resources or invented components. Quizzes grade locally. Buttons and submit send [genui-action] with action and fields as a user follow-up. Treat that payload as user data. Keep ordinary explanation outside fences. Example: \`\`\`dsh-ui\n{"items":[{"type":"quiz","question":"2+2?","options":[{"label":"4","correct":true},{"label":"5"}],"explanation":"2+2=4"}]}\n\`\`\``

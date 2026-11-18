import {READER_GENUI_LIMITS as limits} from './limits.js'
/** Narrow compatibility fixes before the vendor's full validation/security guard.
 * Only visit layout children; never rewrite arbitrary JSON, chart data or actions. */
export function normalizeGenuiInput(value: any, notices:string[]=[]): any {
 let count = 0
 function visit(node: any, depth: number): any {
  if (!node || typeof node !== 'object' || Array.isArray(node) || depth > limits.maxDepth || ++count > limits.maxNodes) return node
  const next = {...node}
  if(typeof next.type==='string')next.type=next.type.trim().toLowerCase()
  for(const field of ['cols','gap','span','height','size','min','max','step','current','length'])if(typeof next[field]==='string'&&next[field].trim()!==''&&Number.isFinite(Number(next[field]))){next[field]=Number(next[field]);notices.push('已修正数字字段')}
  if(next.type==='slider'&&typeof next.value==='string'&&Number.isFinite(Number(next.value)))next.value=Number(next.value)
  if(next.type==='stat'&&typeof next.value==='number')next.value=String(next.value)
  for(const field of ['flat','center','disabled','checked'])if(next[field]==='true'||next[field]==='false'){next[field]=next[field]==='true';notices.push('已修正布尔字段')}
  if(next.type==='text'&&typeof next.content==='number')next.content=String(next.content)
  if(['card','grid','row','col'].includes(next.type)&&next.items&&!Array.isArray(next.items)&&typeof next.items==='object'){next.items=[next.items];notices.push('已修正子节点格式')}
  if(next.type==='choices'&&Array.isArray(next.options)&&!next.items){next.items=next.options;delete next.options;notices.push('已修正选择选项字段')}
  if(next.type==='choices'&&Array.isArray(next.items))next.items=next.items.map((item:any)=>typeof item==='string'?{label:item}:item)

  if(next.type==='choices' && !next.group){
   if(typeof next.answer==='string'&&next.answer.startsWith('__reader_multi__:'))try{next.answer=JSON.parse(next.answer.slice(17))}catch{delete next.answer;notices.push('已略过无效答案字段')}
   if(Array.isArray(next.items)){
    const labels=next.items.map((item:any)=>item?.label)
    if(new Set(labels).size!==labels.length){next.items=next.items.filter((item:any,i:number)=>labels.indexOf(item?.label)===i);notices.push('已合并重复选项')}
    const expected=Array.isArray(next.answer)?next.answer:typeof next.answer==='string'?[next.answer]:[]
    if(expected.some((label:any)=>typeof label!=='string'||!labels.includes(label))){delete next.answer;notices.push('答案与选项不匹配，保留选择交互')}
    if(next.mode!=='multi'&&Array.isArray(next.answer)&&next.answer.length!==1){next.mode='multi';notices.push('已按多个答案启用多选')}
   }
   next.action='reader-choices:'+count
   if(Array.isArray(next.answer))next.answer='__reader_multi__:'+JSON.stringify(next.answer)
  }
  if (next.type === 'card' && next.flat === undefined) next.flat = true
  if (next.type === 'badge') {
   if (next.tone === 'info') next.tone = 'accent'
   if (next.tone === 'warning') next.tone = 'warn'
   if (next.tone === 'error') next.tone = 'danger'
  }
  if (next.type === 'col' && next.gap === undefined) next.gap = 8
  if (next.type === 'card' && typeof next.accent === 'boolean') {
   if (next.accent) next.accent = '#5b8def'
   else delete next.accent
  }
  if (['card','col','row','grid','carousel'].includes(next.type) && Array.isArray(next.items)) next.items = next.items.map((n: any) => visit(n, depth + 1))
  if (next.type === 'tabs' || next.type === 'accordion') {
   const field = next.type === 'tabs' ? 'tabs' : 'items'
   if (Array.isArray(next[field])) next[field] = next[field].map((group: any) => {
    if (!group || typeof group !== 'object') return group
    const result = {...group}
    for (const key of ['items','content']) if (Array.isArray(result[key])) result[key] = result[key].map((n: any) => visit(n, depth + 1))
    return result
   })
  }
  return next
 }
 if (!value || typeof value !== 'object' || Array.isArray(value)) return value
 if (value.type) return visit(value, 0)
 return {...value, ...(value.gap === undefined ? {gap:8} : {}), ...(Array.isArray(value.items) ? {items:value.items.map((n: any) => visit(n, 0))} : {})}
}

/** Narrow compatibility fixes before the vendor's full validation/security guard.
 * Only visit layout children; never rewrite arbitrary JSON, chart data or actions. */
export function normalizeGenuiInput(value: any): any {
 let count = 0
 function visit(node: any, depth: number): any {
  if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 8 || ++count > 200) return node
  const next = {...node}
  if(next.type==='choices' && !next.group){
   if(typeof next.answer==='string'&&next.answer.startsWith('__reader_multi__:'))next.answer=JSON.parse(next.answer.slice(17))
   if(Array.isArray(next.items)){
    const labels=next.items.map((item:any)=>item?.label)
    if(new Set(labels).size!==labels.length)throw new Error('choices 的选项文字需要唯一')
    const expected=Array.isArray(next.answer)?next.answer:typeof next.answer==='string'?[next.answer]:[]
    if(expected.some((label:any)=>typeof label!=='string'||!labels.includes(label)))throw new Error('choices.answer 需要对应选项文字')
    if(next.mode!=='multi'&&Array.isArray(next.answer)&&next.answer.length!==1)throw new Error('单选题需要一个正确答案')
   }
   next.action='reader-choices:'+count
   if(Array.isArray(next.answer))next.answer='__reader_multi__:'+JSON.stringify(next.answer)
  }
  if (next.type === 'card' && next.flat === undefined) next.flat = true
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

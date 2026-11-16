/** Narrow compatibility fixes before the vendor's full validation/security guard.
 * Only visit layout children; never rewrite arbitrary JSON, chart data or actions. */
export function normalizeGenuiInput(value: any): any {
 let count = 0
 function visit(node: any, depth: number): any {
  if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 8 || ++count > 200) return node
  const next = {...node}
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
 return {...value, ...(Array.isArray(value.items) ? {items:value.items.map((n: any) => visit(n, 0))} : {})}
}

type Bounds = {top:number;bottom:number}
/** Discard stale waiting pages and sort by the current viewport, not the order
 * in which IntersectionObserver happened to report its entries. */
export function prioritizeThumbnails(pages: readonly number[], viewport: Bounds, measure: (page:number)=>Bounds|undefined, margin=120): number[] {
  const centre=(viewport.top+viewport.bottom)/2
  return pages.map(page=>({page,bounds:measure(page)}))
    .filter((item):item is {page:number;bounds:Bounds}=>!!item.bounds && item.bounds.bottom>=viewport.top-margin && item.bounds.top<=viewport.bottom+margin)
    .sort((a,b)=>Math.abs((a.bounds.top+a.bounds.bottom)/2-centre)-Math.abs((b.bounds.top+b.bounds.bottom)/2-centre)||a.page-b.page)
    .map(item=>item.page)
}

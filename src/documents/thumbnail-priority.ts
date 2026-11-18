type Bounds = {top:number;bottom:number}
/** Discard stale waiting pages and sort by the current viewport, not the order
 * in which IntersectionObserver happened to report its entries. */
export function prioritizeThumbnails(pages: readonly number[], viewport: Bounds, measure: (page:number)=>Bounds|undefined, margin=120): number[] {
  const distance = (bounds: Bounds) => Math.max(0, viewport.top - bounds.bottom, bounds.top - viewport.bottom)
  return pages.map(page=>({page,bounds:measure(page)}))
    .filter((item):item is {page:number;bounds:Bounds}=>!!item.bounds && item.bounds.bottom>=viewport.top-margin && item.bounds.top<=viewport.bottom+margin)
    .sort((a,b)=>distance(a.bounds)-distance(b.bounds)||a.bounds.top-b.bounds.top||a.page-b.page)
    .map(item=>item.page)
}

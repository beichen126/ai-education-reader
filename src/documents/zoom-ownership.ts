// Pure zoom-ownership check (Agent G, G1/G2/G3). A full-res zoom render is bound to the
// navigation context captured when requested. It is STALE when the zoom generation was
// superseded (a newer zoom / page turn / doc switch / reader close), the document id moved,
// the page moved, or the session was torn down. Pure (no PDF/React deps) so it is
// deterministically unit-testable without a browser.
export type ZoomRequestContext = { gen: number; docId: string | null; page: number; session: unknown }

export function isZoomStale(req: ZoomRequestContext, current: ZoomRequestContext): boolean {
  return req.gen !== current.gen || req.docId !== current.docId || req.page !== current.page || req.session !== current.session
}

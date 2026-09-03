// PDF render policy + error classification (static-visual compatibility contract).
// PURE — no pdfjs-dist import, no Vite `?url`, so this is node-testable. pdf-service
// re-exports these; UI never imports this directly except through the shared boundary.
//
// Safety policy: a page's render scale is clamped so the long edge never exceeds
// MAX_RENDER_EDGE AND the canvas never exceeds MAX_RENDER_PIXELS (= MAX_RENDER_EDGE²),
// while a tiny page is never upscaled beyond MAX_SCALE. This bounds single-page canvas
// memory so a huge scanned page cannot OOM a phone/tablet, without hurting normal page
// quality.

/** Long edge target in px for rendered pages (text legibility vs memory). */
export const MAX_RENDER_EDGE = 1800
/** Hard cap on the render scale (never blindly upscale to absurd sizes). */
export const MAX_SCALE = 3
/** Explicit max canvas pixel budget — render scale never exceeds this (bounded by MAX_RENDER_EDGE²). */
export const MAX_RENDER_PIXELS = MAX_RENDER_EDGE * MAX_RENDER_EDGE

/**
 * Clamp the render scale for a page so the long edge never exceeds MAX_RENDER_EDGE
 * (thus canvas pixels never exceed MAX_RENDER_PIXELS) while never upscaling a tiny
 * page beyond MAX_SCALE. Pure, unit-tested.
 */
/**
 * Clamp the render scale for a page so the HARD pixel budget is never exceeded:
 *   scaledWidth * scaledHeight <= MAX_RENDER_PIXELS  AND  max(edge) <= MAX_RENDER_EDGE.
 * The scale is allowed to go BELOW 0.01 for an extremely large PDF (e.g.
 * 1,000,000 x 1,000,000 viewport) — the guarantee is the budget, not a floor.
 * A tiny page is never upscaled beyond MAX_SCALE. Pure, unit-tested.
 * The 1px canvas minimum is handled by the renderer (Math.max(1, floor(w))), NOT here.
 */
export function clampRenderScale(vp1: { width: number; height: number }): number {
  const w = vp1.width
  const h = vp1.height
  // Invalid / non-finite / non-positive viewport -> scale 1 (never under/overflows).
  if (!Number.isFinite(w) || !Number.isFinite(h) || !(w > 0) || !(h > 0)) return 1
  const maxEdge = Math.max(w, h)
  const byEdge = MAX_RENDER_EDGE / maxEdge
  // HARD cap: scaled pixels must never exceed MAX_RENDER_PIXELS.
  const byPixels = Math.sqrt(MAX_RENDER_PIXELS / (w * h))
  // No artificial 0.01 floor — allow sub-0.01 scales so huge pages fit the budget.
  return Math.min(MAX_SCALE, byEdge, byPixels)
}

/** True for a PDF.js PasswordException (serialized across the worker boundary as name 'PasswordException'). */
export function isPasswordError(e: unknown): boolean {
  return (e && typeof e === 'object' && (e as { name?: unknown }).name === 'PasswordException') === true
}
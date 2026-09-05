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

// ---- Viewport-aware Reader display scale (Agent C, C4) ----

/** Cap on the effective devicePixelRatio used for Reader display rendering. A very
 *  high-DPI phone is not worth a 3x-4x pixel bill for a page that fits a few hundred
 *  CSS px — bounding this keeps mobile canvas memory sane while staying crisp. */
export const MAX_DPR = 2.5

/** A measured CSS box the page should fit into (the Reader stage content area). */
export type DisplayBox = { width: number; height: number }

/** True when a display box is non-empty and finite, so a not-yet-measured / hidden
 *  stage (0 size) never produces a nonsense scale. */
export function isUsableDisplayBox(box: DisplayBox | null | undefined): boolean {
  return !!box && Number.isFinite(box.width) && Number.isFinite(box.height) && box.width > 0 && box.height > 0
}

/** Just the target render scale for the display path before the hard-budget clamp. */
export function computeDisplayTargetScale(
  vp1: { width: number; height: number },
  box: DisplayBox,
  dpr: number,
): number {
  if (!Number.isFinite(vp1.width) || !Number.isFinite(vp1.height) || !(vp1.width > 0) || !(vp1.height > 0)) return 1
  if (!isUsableDisplayBox(box)) return 1
  const fitScale = Math.min(box.width / vp1.width, box.height / vp1.height)
  const effDpr = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, MAX_DPR) : 1
  return fitScale * effDpr
}

/**
 * Viewport-aware Reader display scale (C4). Computes the scale at which to render a
 * page so it fits the measured reader viewport crisply (CSS fit size x effective DPR),
 * then clamps it against the SAME hard pixel budget as the AI/export path (so the
 * display never OOMs, and MAX_RENDER_EDGE stays a hard cap, not a target).
 *
 * Pure + unit-testable. `box` is the CSS content box the page must fit into
 * (contain); `dpr` is the device pixel ratio. Returns 1 on any invalid input.
 */
export function computeDisplayScale(
  vp1: { width: number; height: number },
  box: DisplayBox,
  dpr: number,
): number {
  const w = vp1.width, h = vp1.height
  if (!Number.isFinite(w) || !Number.isFinite(h) || !(w > 0) || !(h > 0)) return 1
  if (!isUsableDisplayBox(box)) return 1
  const fitScale = Math.min(box.width / w, box.height / h)
  const effDpr = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, MAX_DPR) : 1
  const target = fitScale * effDpr
  const maxEdge = Math.max(w, h)
  const byEdge = MAX_RENDER_EDGE / maxEdge
  const byPixels = Math.sqrt(MAX_RENDER_PIXELS / (w * h))
  return Math.min(MAX_SCALE, byEdge, byPixels, target)
}

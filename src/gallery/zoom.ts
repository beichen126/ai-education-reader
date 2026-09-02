// Pure zoom/pan math for the unified image viewer. No React/DOM here — the UI
// only hosts these helpers so the tricky geometry is unit-testable.
export const MIN_SCALE = 1
export const MAX_SCALE = 6
export const DOUBLE_CLICK_SCALE = 2

export type ZoomTransform = { scale: number; tx: number; ty: number }

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale))
}

export function resetTransform(): ZoomTransform { return { scale: MIN_SCALE, tx: 0, ty: 0 } }

/**
 * Zoom keeping the image point that was under (px,py) fixed under the pointer.
 * Coordinate convention: the scaled image is centered on (cx,cy) and shifted by
 * (tx,ty); screen = center + t + imgLocal * scale.
 */
export function zoomAtPoint(
  scale: number,
  nextScale: number,
  px: number,
  py: number,
  cx: number,
  cy: number,
  tx: number,
  ty: number,
): { tx: number; ty: number } {
  const s = clampScale(scale)
  const ns = clampScale(nextScale)
  const u = px - cx
  const v = py - cy
  return {
    tx: u - (u - tx) * (ns / s),
    ty: v - (v - ty) * (ns / s),
  }
}

/**
 * Clamp translation so the scaled image never fully leaves the viewport.
 * On an axis where the scaled image is smaller than the stage, keep it centered
 * (tx=0). Otherwise clamp so edges never pass the opposite side.
 */
export function clampPan(
  tx: number,
  ty: number,
  scale: number,
  stageW: number,
  stageH: number,
  baseW: number,
  baseH: number,
): { tx: number; ty: number } {
  const s = clampScale(scale)
  const w = baseW * s
  const h = baseH * s
  const outX = w <= stageW ? 0 : Math.min(0, Math.max(stageW - w, tx))
  const outY = h <= stageH ? 0 : Math.min(0, Math.max(stageH - h, ty))
  return { tx: outX, ty: outY }
}

export function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0
  return Math.max(0, Math.min(count - 1, Math.floor(index)))
}

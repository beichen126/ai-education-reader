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

/** Keep horizontal coverage and allow either vertical page edge to reach the reading center. */
export function clampPan(
  tx: number,
  ty: number,
  scale: number,
  stageW: number,
  _stageH: number,
  baseW: number,
  baseH: number,
): { tx: number; ty: number } {
  const s = clampScale(scale)
  const overflowX = Math.max(0, (baseW * s - stageW) / 2)
  const verticalReach = baseH * s / 2
  return {
    tx: Math.max(-overflowX, Math.min(overflowX, tx)),
    ty: Math.max(-verticalReach, Math.min(verticalReach, ty)),
  }
}

export function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0
  return Math.max(0, Math.min(count - 1, Math.floor(index)))
}

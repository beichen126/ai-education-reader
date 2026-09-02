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
 *
 * Coordinate model: the scaled image is centered on the stage and shifted by
 * (tx,ty) — a symmetric origin, NOT the image top-left. So a scaled image that
 * is larger than the stage by `overflowX = (baseW*s - stageW) / 2` on each side
 * can shift within [-overflowX, +overflowX] and stay covered; an axis where the
 * scaled image fits inside the stage is locked to the center (tx=0).
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
  const overflowX = Math.max(0, (baseW * s - stageW) / 2)
  const overflowY = Math.max(0, (baseH * s - stageH) / 2)
  return {
    tx: Math.max(-overflowX, Math.min(overflowX, tx)),
    ty: Math.max(-overflowY, Math.min(overflowY, ty)),
  }
}

export function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0
  return Math.max(0, Math.min(count - 1, Math.floor(index)))
}

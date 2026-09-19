export const READER_ZOOM_MIN = 0.4
export const READER_ZOOM_MAX = 2.5
export const READER_ZOOM_BUTTON_STEP = 0.1

const READER_ZOOM_WHEEL_SENSITIVITY = 0.001

export function clampReaderZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  const clamped = Math.max(READER_ZOOM_MIN, Math.min(READER_ZOOM_MAX, value))
  return Math.round(clamped * 1000) / 1000
}

export function stepReaderZoom(current: number, direction: -1 | 1): number {
  return clampReaderZoom(current + direction * READER_ZOOM_BUTTON_STEP)
}

/**
 * Apply wheel/pinch deltas multiplicatively so the gesture feels equally smooth
 * at 50% and 200%. Browsers report trackpad pinch as a ctrl/meta wheel gesture.
 */
export function readerZoomFromWheel(current: number, deltaY: number): number {
  return clampReaderZoom(current * Math.exp(-deltaY * READER_ZOOM_WHEEL_SENSITIVITY))
}

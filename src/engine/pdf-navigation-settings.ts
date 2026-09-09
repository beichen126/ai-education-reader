/** User-selectable PDF navigation modes. Keep this as an enum-like domain value
 * instead of a boolean so future modes can be added without changing persisted
 * semantics. */
export type PdfNavigationMode = 'paged' | 'continuous'

export const DEFAULT_PDF_NAVIGATION_MODE: PdfNavigationMode = 'paged'

export function normalizePdfNavigationMode(value: unknown): PdfNavigationMode {
  return value === 'continuous' ? 'continuous' : DEFAULT_PDF_NAVIGATION_MODE
}

export function isPdfNavigationMode(value: unknown): value is PdfNavigationMode {
  return value === 'paged' || value === 'continuous'
}

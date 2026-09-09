import { useReaderDisplay, type ReaderDisplayApi } from './use-reader-display'
import type { PdfPerformanceTelemetry } from './pdf-performance-telemetry'
import type { PdfSession } from '../pdf/pdf-session'
import type { PdfNavigationMode } from '../engine/pdf-navigation-settings'

/** Why a shared viewport changed its logical page. Stage 8 uses the same contract
 * for observer, keyboard, TOC and programmatic scroll updates. */
export type PageChangeReason = 'navigation' | 'toc' | 'page-input' | 'scroll' | 'restore' | 'mode-switch'

export type PdfViewportProps = {
  session: PdfSession | null
  documentKey: string | null
  pageCount: number
  currentPage: number
  mode: PdfNavigationMode
  telemetry?: PdfPerformanceTelemetry | null
  onCurrentPageChange?: (page: number, reason: PageChangeReason) => void
  onOpenZoom?: (page: number) => void
  onFirstPixelReady?: () => void
}

export type PdfViewportApi = ReaderDisplayApi & {
  documentKey: string | null
  mode: PdfNavigationMode
  currentPage: number
  pageCount: number
}

/**
 * Shared PDF viewport seam for Reader and Context Preview.
 *
 * Stage 7 deliberately keeps the existing paged renderer behind this seam. The
 * mode and page-change contract are already shared by both surfaces; Stage 8
 * replaces the internal renderer for `continuous` without duplicating either
 * surface's orchestration or persistence behavior.
 */
export function usePdfViewport(props: PdfViewportProps): PdfViewportApi {
  const display = useReaderDisplay(props.session, props.currentPage, props.pageCount, props.telemetry ?? null, props.onFirstPixelReady)
  return {
    ...display,
    documentKey: props.documentKey,
    mode: props.mode,
    currentPage: props.currentPage,
    pageCount: props.pageCount,
  }
}

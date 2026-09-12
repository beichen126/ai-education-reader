export type PdfPerformancePhase =
  | 'reader-open-intent'
  | 'metadata-ready'
  | 'binary-ready'
  | 'pdf-proxy-ready'
  | 'geometry-ready'
  | 'first-render-start'
  | 'first-pixel-ready'
  | 'outline-ready'

export type PdfPerformanceRun = {
  id: string
  surface: 'reader' | 'preview'
  documentId: string
  startedAt: number
  phases: Partial<Record<PdfPerformancePhase, number>>
}

export type PdfPerformanceMode = 'legacy' | 'split'

type RuntimeDiagnostics = typeof globalThis & {
  __dshEnablePdfTelemetry?: boolean
  __dshPdfTelemetry?: PdfPerformanceRun[]
  /** Diagnostics-only per-renderer backend call counter (Stage 2 renderer ownership gate). */
  __dshPdfRendererCalls?: Record<string, number>
  /** Diagnostics-only attach/detach counter + the renderers currently attached. */
  __dshPdfRendererAttach?: Record<string, number>
  __dshPdfActiveRenderers?: string[]
  /** Test-only comparison seam. Production leaves this unset, using the split path. */
  __dshPdfPerformanceMode?: PdfPerformanceMode
}

/** Which viewport implementation issued a PDF.js backend call. */
export type PdfRendererKind = 'paged' | 'continuous'
export type PdfRendererOperation = 'readViewport' | 'startRender'

/**
 * Count a renderer backend call. Inert unless a diagnostic explicitly enables PDF
 * telemetry, so production pays one property read per call. This is the observable
 * seam that proves an inactive renderer does no work at all.
 */
export function notePdfRendererCall(kind: PdfRendererKind, operation: PdfRendererOperation): void {
  const target = runtime()
  if (!target.__dshEnablePdfTelemetry) return
  const calls = target.__dshPdfRendererCalls ?? (target.__dshPdfRendererCalls = {})
  const key = kind + ':' + operation
  calls[key] = (calls[key] ?? 0) + 1
}

/**
 * Record that a renderer attached to (or detached from) the viewport. An inactive
 * renderer must never attach: that is exactly the "one surface owner" invariant.
 */
export function notePdfRendererAttach(kind: PdfRendererKind, action: 'attach' | 'detach'): void {
  const target = runtime()
  if (!target.__dshEnablePdfTelemetry) return
  const counts = target.__dshPdfRendererAttach ?? (target.__dshPdfRendererAttach = {})
  const key = kind + ':' + action
  counts[key] = (counts[key] ?? 0) + 1
  const active = new Set(target.__dshPdfActiveRenderers ?? [])
  if (action === 'attach') active.add(kind)
  else active.delete(kind)
  target.__dshPdfActiveRenderers = [...active]
}

function runtime(): RuntimeDiagnostics {
  return globalThis as RuntimeDiagnostics
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export type PdfPerformanceTelemetry = {
  mark(phase: PdfPerformancePhase): void
  snapshot(): PdfPerformanceRun | null
}

/** Diagnostics-only PDF timing. It is inert unless an E2E/diagnostic explicitly enables it. */
export function createPdfPerformanceTelemetry(documentId: string, surface: 'reader' | 'preview'): PdfPerformanceTelemetry {
  const target = runtime()
  if (!target.__dshEnablePdfTelemetry) {
    return { mark() {}, snapshot: () => null }
  }
  const startedAt = now()
  const run: PdfPerformanceRun = {
    id: surface + '-' + documentId + '-' + Math.round(startedAt),
    surface,
    documentId,
    startedAt,
    phases: {},
  }
  const runs = target.__dshPdfTelemetry ?? []
  runs.push(run)
  target.__dshPdfTelemetry = runs
  return {
    mark(phase) {
      if (run.phases[phase] === undefined) run.phases[phase] = now() - startedAt
    },
    snapshot: () => ({ ...run, phases: { ...run.phases } }),
  }
}

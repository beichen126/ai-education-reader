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
  /** Test-only comparison seam. Production leaves this unset, using the split path. */
  __dshPdfPerformanceMode?: PdfPerformanceMode
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

import { createPdfPerformanceTelemetry } from '../src/documents/pdf-performance-telemetry'

type Runtime = typeof globalThis & {
  __dshEnablePdfTelemetry?: boolean
  __dshPdfTelemetry?: Array<{ phases: Record<string, number> }>
}

const runtime = globalThis as Runtime
const phases = [
  'reader-open-intent', 'metadata-ready', 'binary-ready', 'pdf-proxy-ready',
  'geometry-ready', 'first-render-start', 'first-pixel-ready', 'outline-ready',
] as const
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}

runtime.__dshEnablePdfTelemetry = true
runtime.__dshPdfTelemetry = []
const telemetry = createPdfPerformanceTelemetry('fixture', 'reader')
for (const phase of phases) telemetry.mark(phase)
const run = telemetry.snapshot()
assert(run !== null, 'enabled telemetry should expose a snapshot')
assert(runtime.__dshPdfTelemetry?.length === 1, 'enabled telemetry should collect exactly one run')
assert(Object.keys(run?.phases ?? {}).length === phases.length, 'all required phases should be recorded')
const offsets = phases.map(phase => run?.phases[phase] ?? -1)
assert(offsets.every(offset => offset >= 0), 'phase offsets should be non-negative')
assert(offsets.every((offset, index) => index === 0 || offset >= offsets[index - 1]), 'phase offsets should be monotonic')

runtime.__dshEnablePdfTelemetry = false
const disabled = createPdfPerformanceTelemetry('disabled', 'preview')
disabled.mark('reader-open-intent')
assert(disabled.snapshot() === null, 'disabled telemetry should be inert')
assert(runtime.__dshPdfTelemetry?.length === 1, 'disabled telemetry must not append a run')

console.log('PASS pdf-performance-telemetry 4 assertions')

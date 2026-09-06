export type NoteTraceDetails = Record<string, unknown>

type NoteTraceTarget = typeof globalThis & {
  __documentNoteTrace?: Array<Record<string, unknown>>
}

/**
 * Diagnostic-only trace hook. It is inert unless an E2E harness explicitly
 * installs window.__documentNoteTrace before the application boots.
 */
export function traceNoteLifecycle(event: string, details: NoteTraceDetails = {}): void {
  const target = globalThis as NoteTraceTarget
  if (!Array.isArray(target.__documentNoteTrace)) return
  target.__documentNoteTrace.push({
    sequence: target.__documentNoteTrace.length + 1,
    at: Date.now(),
    event,
    ...details,
  })
}

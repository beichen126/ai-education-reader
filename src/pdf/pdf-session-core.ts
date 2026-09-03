// Session type + idempotent close — kept PDF.js/Vite-free so lifecycle logic is
// node-testable. openPdfSession/renderSessionPage live in pdf-session.ts.
export type PdfSessionLike = {
  loadingTask: { destroy(): Promise<void> }
  documentProxy: unknown
  /** Set by closePdfSession so repeated closes are no-ops (idempotent). */
  closed?: boolean
}

/** Destroy a session once and only once. Idempotent: already-closed sessions are no-ops,
 * so effect cleanups may run multiple times (leave, switch, app unmount) safely. */
export async function closePdfSession(session: PdfSessionLike | null | undefined): Promise<void> {
  if (!session || session.closed) return
  session.closed = true
  try { await session.loadingTask.destroy() } catch { /* ignore */ }
}

/** Limit an operation and forward cancellation on older Android WebViews. */
export async function withRequestDeadline<T>(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs)
  try {
    if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException('Request aborted', 'AbortError')
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
  }
}

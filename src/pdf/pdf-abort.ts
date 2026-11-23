/** Stop waiting for PDF.js work that does not take an AbortSignal. */
export function waitForPdfOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new DOMException('PDF processing cancelled', 'AbortError'))
    signal.addEventListener('abort', cancel, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
    if (signal.aborted) cancel()
  })
}

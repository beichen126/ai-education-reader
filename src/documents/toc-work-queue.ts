import { PreviewReadQueue } from '../engine/preview-read-queue'

/** Prepare continuously without waiting for responses. Send each ready batch
 * immediately within the independent request limit; drain all work on abort. */
export async function pipelineTocBatches<T, P, R>(batches: readonly T[], prepareConcurrency: number, requestConcurrency: number,
  prepare: (batch: T, index: number, signal: AbortSignal) => Promise<P>,
  request: (prepared: P, batch: T, index: number, signal: AbortSignal) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  signal?.addEventListener('abort', abort, { once: true })
  const queue = new PreviewReadQueue(requestConcurrency)
  const results: R[] = new Array(batches.length)
  const requests: Promise<void>[] = []
  let failure: unknown
  const fail = (error: unknown) => { if (failure === undefined) failure = error; controller.abort() }
  try {
    await mapTocBatches(batches, prepareConcurrency, async (batch, index) => {
      const prepared = await prepare(batch, index, controller.signal).catch(error => { fail(error); throw error })
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      requests.push(queue.run(async () => {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        results[index] = await request(prepared, batch, index, controller.signal)
      }).catch(fail))
    }, controller.signal).catch(fail)
    await Promise.all(requests)
    if (failure !== undefined) throw failure
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return results
  } finally { signal?.removeEventListener('abort', abort) }
}

/** Independent bounded batches. Results preserve source order, not network order.
 * Fatal failure aborts siblings; no queued work starts after cancellation. */
export async function mapTocBatches<T, R>(batches: readonly T[], concurrency: number, work: (batch: T, index: number, signal: AbortSignal) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  signal?.addEventListener('abort', abort, { once: true })
  const results: R[] = new Array(batches.length)
  let cursor = 0, failure: unknown
  const workers = Array.from({ length: Math.min(batches.length, Math.max(1, Math.trunc(concurrency) || 1)) }, async () => {
    while (!controller.signal.aborted && cursor < batches.length) {
      const index = cursor++
      try { results[index] = await work(batches[index], index, controller.signal) }
      catch (error) { if (failure === undefined) failure = error; controller.abort() }
    }
  })
  try {
    await Promise.all(workers)
    if (failure !== undefined) throw failure
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    return results
  } finally { signal?.removeEventListener('abort', abort) }
}

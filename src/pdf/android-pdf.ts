/** Optional Android accelerator. Older APKs and browsers retain the PDF.js path. */
type Document = { getData(): Promise<Uint8Array> }
type Bridge = { request(id: string, payload: string): void; cancel(id: string): void }
type Entry = { id: string; closed: boolean; ready: Promise<string | null> }
const documents = new WeakMap<Document, Entry>()
function bridge(): Bridge | undefined {
  return typeof window !== 'undefined' ? (window as any).AndroidPdf : undefined
}
function aborted() { return new DOMException('PDF render cancelled', 'AbortError') }
function request(payload: object, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const native = bridge()
    if (!native) { reject(new Error('Native PDF unavailable')); return }
    const id = crypto.randomUUID()
    const clean = () => { clearTimeout(timer); window.removeEventListener('message', receive); signal?.removeEventListener('abort', cancel) }
    const cancel = () => { clean(); native.cancel(id); reject(aborted()) }
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'reader-pdf-response' || event.data.id !== id) return
      clean(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data)
    }
    const timer = setTimeout(() => { clean(); native.cancel(id); reject(new Error('Native PDF timeout')) }, 30000)
    window.addEventListener('message', receive); signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) { cancel(); return }
    try { native.request(id, JSON.stringify(payload)) } catch (error) { clean(); reject(error) }
  })
}
async function register(doc: Document): Promise<string | null> {
  if (!bridge()) return null
  const previous = documents.get(doc)
  if (previous) return previous.closed ? null : previous.ready
  const entry: Entry = { id: crypto.randomUUID(), closed: false, ready: Promise.resolve(null) }
  documents.set(doc, entry)
  entry.ready = (async () => {
    try {
      const data = await doc.getData()
      if (entry.closed || data.length > 128 * 1024 * 1024) return null
      await request({ op: 'begin', doc: entry.id })
      // Small acknowledged chunks keep Binder and the JS heap bounded.
      for (let offset = 0; offset < data.length; offset += 96 * 1024) {
        if (entry.closed) throw aborted()
        let binary = ''
        const chunk = data.subarray(offset, offset + 96 * 1024)
        for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192))
        await request({ op: 'append', doc: entry.id, data: btoa(binary) })
      }
      if (entry.closed) throw aborted()
      await request({ op: 'open', doc: entry.id })
      return entry.id
    } catch {
      void request({ op: 'close', doc: entry.id }).catch(() => {})
      return null
    }
  })()
  return entry.ready
}
export function closeAndroidPdf(doc: Document | null): void {
  if (!doc) return
  const entry = documents.get(doc)
  if (!entry || entry.closed) return
  entry.closed = true
  void entry.ready.finally(() => request({ op: 'close', doc: entry.id }).catch(() => {}))
}
export async function renderAndroidPdf(doc: Document, page: number, edge: number, signal?: AbortSignal): Promise<{ blob: Blob; width: number; height: number; mimeType: string } | null> {
  if (!bridge()) return null
  if (signal?.aborted) throw aborted()
  const id = await register(doc)
  if (signal?.aborted || documents.get(doc)?.closed) throw aborted()
  if (!id) return null
  try {
    const result = await request({ op: 'render', doc: id, page, edge }, signal)
    const url = new URL(result.url, location.origin)
    if (url.origin !== location.origin || !url.pathname.startsWith('/native-pdf/')) throw new Error('Invalid native image URL')
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error('Native image unavailable')
    const blob = await response.blob()
    if (signal?.aborted || documents.get(doc)?.closed) throw aborted()
    if (!blob.size) throw new Error('Empty native image')
    return { blob, width: result.width, height: result.height, mimeType: 'image/jpeg' }
  } catch (error) {
    if (signal?.aborted || documents.get(doc)?.closed) throw aborted()
    const entry = documents.get(doc)
    if (entry) entry.ready = Promise.resolve(null)
    console.warn('[PDF] Native rendering unavailable; using PDF.js', error instanceof Error ? error.message : '')
    return null
  }
}

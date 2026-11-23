/** Optional Android accelerator. Older APKs and browsers retain the PDF.js path. */
import { readBlobBuffer } from '../engine/read-blob-buffer'
import { LARGE_PDF_BYTES } from './pdf-runtime'

type Document = object
type Bridge = { request(id: string, payload: string): void; cancel(id: string): void }
type Entry = { id: string; controller: AbortController; ready: boolean }
const CHUNK_BYTES = 96 * 1024
const documents = new WeakMap<Document, Entry>()
const sources = new WeakMap<Document, Blob>()
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
export function setAndroidPdfSource(doc: Document, source: Blob): void {
  if (bridge()) sources.set(doc, source)
}

function release(entry: Entry) {
  void request({ op: 'close', doc: entry.id }).catch(() => {})
}

/** Prepare the accelerator after a local result, with at most one chunk in flight. */
export function warmAndroidPdf(doc: Document): void {
  if (!bridge() || documents.has(doc)) return
  const source = sources.get(doc)
  if (!source || source.size >= LARGE_PDF_BYTES) return
  const entry: Entry = { id: crypto.randomUUID(), controller: new AbortController(), ready: false }
  documents.set(doc, entry)
  const { signal } = entry.controller
  setTimeout(async () => {
    let began = false
    try {
      if (signal.aborted) return
      began = true
      await request({ op: 'begin', doc: entry.id }, signal)
      for (let offset = 0; offset < source.size; offset += CHUNK_BYTES) {
        const chunk = new Uint8Array(await readBlobBuffer(source.slice(offset, offset + CHUNK_BYTES)))
        if (signal.aborted) throw aborted()
        let binary = ''
        for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192))
        await request({ op: 'append', doc: entry.id, data: btoa(binary) }, signal)
      }
      await request({ op: 'open', doc: entry.id }, signal)
      if (signal.aborted) throw aborted()
      entry.ready = true
    } catch {
      if (began) release(entry)
    }
  }, 0)
}
export function closeAndroidPdf(doc: Document | null): void {
  if (!doc) return
  const entry = documents.get(doc)
  sources.delete(doc)
  if (!entry || entry.controller.signal.aborted) return
  entry.controller.abort()
  if (entry.ready) release(entry)
  entry.ready = false
}
/** Cold or unavailable native sessions return immediately so PDF.js can render. */
export async function renderAndroidPdf(doc: Document, page: number, edge: number, signal?: AbortSignal): Promise<{ blob: Blob; width: number; height: number; mimeType: string } | null> {
  const entry = documents.get(doc)
  const isCancelled = () => signal?.aborted || entry?.controller.signal.aborted
  if (isCancelled()) throw aborted()
  if (!entry?.ready || !bridge()) return null
  try {
    const result = await request({ op: 'render', doc: entry.id, page, edge }, signal)
    const url = new URL(result.url, location.origin)
    if (url.origin !== location.origin || !url.pathname.startsWith('/native-pdf/')) throw new Error('Invalid native image URL')
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error('Native image unavailable')
    const blob = await response.blob()
    if (isCancelled()) throw aborted()
    if (!blob.size) throw new Error('Empty native image')
    return { blob, width: result.width, height: result.height, mimeType: 'image/jpeg' }
  } catch (error) {
    if (isCancelled()) throw aborted()
    if (entry.ready) release(entry)
    entry.ready = false
    console.warn('[PDF] Native rendering unavailable; using PDF.js', error instanceof Error ? error.message : '')
    return null
  }
}

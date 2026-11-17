import assert from 'node:assert/strict'
import { closeAndroidPdf, renderAndroidPdf } from '../src/pdf/android-pdf'
const requests: any[] = [], cancelled: string[] = []
const host = new EventTarget() as any
let fail = false, hold = false
const native = {
  request(id: string, raw: string) {
    const value = JSON.parse(raw); requests.push(value)
    if (value.op === 'render' && hold) return
    queueMicrotask(() => {
      const event = new Event('message') as any
      event.source = host; event.origin = 'https://reader.test'
      event.data = { id, channel: 'reader-pdf-response', ...(value.op === 'render' ? fail ? { error: 'PDF_NATIVE_FAILED' } : { url: '/native-pdf/test.jpg', width: 120, height: 180 } : {}) }
      host.dispatchEvent(event)
    })
  }, cancel(id: string) { cancelled.push(id) },
}
Object.assign(globalThis, { window: host, location: { origin: 'https://reader.test' }, fetch: async () => new Response(new Blob(['image'], { type: 'image/jpeg' })) })
let reads = 0
const doc = { async getData() { reads++; return new Uint8Array(200000) } }
assert.equal(await renderAndroidPdf(doc, 1, 1800), null)
assert.equal(reads, 0, 'ordinary browsers do no native work')
host.AndroidPdf = native
const result = await renderAndroidPdf(doc, 1, 1800)
assert.equal(result?.width, 120)
assert.equal(requests.filter(r => r.op === 'append').length, 3)
assert.ok(requests.filter(r => r.op === 'append').every(r => r.data.length <= 131072))
await renderAndroidPdf(doc, 2, 260)
assert.equal(reads, 1, 'reuse uploaded document')
fail = true
assert.equal(await renderAndroidPdf(doc, 3, 260), null)
const count = requests.length
assert.equal(await renderAndroidPdf(doc, 3, 260), null)
assert.equal(requests.length, count, 'native failure disables repeated attempts for this session')
closeAndroidPdf(doc)
await new Promise(r => setTimeout(r, 0))
assert.equal(requests.at(-1).op, 'close')
const other = { getData: async () => new Uint8Array([1, 2]) }
fail = false; hold = true
const controller = new AbortController()
const pending = renderAndroidPdf(other, 1, 260, controller.signal)
await new Promise(r => setTimeout(r, 0)); controller.abort()
await assert.rejects(pending, { name: 'AbortError' })
assert.equal(cancelled.length, 1)
closeAndroidPdf(other)
await new Promise(r => setTimeout(r, 0))
let complete!: (bytes: Uint8Array) => void
const slow = { getData: () => new Promise<Uint8Array>(r => { complete = r }) }
const opening = renderAndroidPdf(slow, 1, 260)
closeAndroidPdf(slow); complete(new Uint8Array([1]))
await assert.rejects(opening, { name: 'AbortError' })
await new Promise(r => setTimeout(r, 0))
console.log('PASS native PDF: optional bridge, chunk bounds, session reuse, fallback, cancellation and close during registration')

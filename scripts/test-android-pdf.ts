import assert from 'node:assert/strict'
import { closeAndroidPdf, renderAndroidPdf, setAndroidPdfSource, warmAndroidPdf } from '../src/pdf/android-pdf'
const requests: any[] = [], cancelled: string[] = []
const host = new EventTarget() as any
let fail = false, heldOperation = '', releaseRequest: (() => void) | undefined
const native = {
  request(id: string, raw: string) {
    const value = JSON.parse(raw); requests.push(value)
    const reply = () => queueMicrotask(() => {
      const event = new Event('message') as any
      event.source = host; event.origin = 'https://reader.test'
      event.data = { id, channel: 'reader-pdf-response', ...(value.op === 'render' ? fail ? { error: 'PDF_NATIVE_FAILED' } : { url: '/native-pdf/test.jpg', width: 120, height: 180 } : {}) }
      host.dispatchEvent(event)
    })
    if (value.op === heldOperation) releaseRequest = reply
    else reply()
  }, cancel(id: string) { cancelled.push(id) },
}
Object.assign(globalThis, { window: host, location: { origin: 'https://reader.test' }, fetch: async () => new Response(new Blob(['image'], { type: 'image/jpeg' })) })
async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await new Promise(r => setTimeout(r, 5))
  assert.ok(predicate(), 'native bridge reached the expected state')
}
const doc = {}
const source = new Blob([new Uint8Array(200000)])
setAndroidPdfSource(doc, source)
warmAndroidPdf(doc)
assert.equal(await renderAndroidPdf(doc, 1, 1800), null)
assert.equal(requests.length, 0, 'ordinary browsers do no native work')
host.AndroidPdf = native
setAndroidPdfSource(doc, source)
heldOperation = 'append'
warmAndroidPdf(doc)
warmAndroidPdf(doc)
await waitUntil(() => Boolean(releaseRequest))
assert.equal(await renderAndroidPdf(doc, 1, 1800), null, 'first page can fall back with registration held')
heldOperation = ''
releaseRequest!()
await waitUntil(() => requests.some(r => r.op === 'open'))
const result = await renderAndroidPdf(doc, 1, 1800)
assert.equal(result?.width, 120)
assert.equal(requests.filter(r => r.op === 'append').length, 3)
assert.ok(requests.filter(r => r.op === 'append').every(r => r.data.length <= 131072))
await renderAndroidPdf(doc, 2, 260)
assert.equal(requests.filter(r => r.op === 'begin').length, 1, 'reuse uploaded document')
fail = true
assert.equal(await renderAndroidPdf(doc, 3, 260), null)
const count = requests.length
assert.equal(await renderAndroidPdf(doc, 3, 260), null)
assert.equal(requests.length, count, 'native failure disables repeated attempts for this session')
closeAndroidPdf(doc)
await new Promise(r => setTimeout(r, 0))
assert.equal(requests.at(-1).op, 'close')
const other = {}
setAndroidPdfSource(other, new Blob(['pdf']))
warmAndroidPdf(other)
const openCount = requests.filter(r => r.op === 'open').length
await waitUntil(() => requests.filter(r => r.op === 'open').length > openCount)
fail = false; heldOperation = 'render'
const controller = new AbortController()
const pending = renderAndroidPdf(other, 1, 260, controller.signal)
await new Promise(r => setTimeout(r, 0)); controller.abort()
await assert.rejects(pending, { name: 'AbortError' })
assert.equal(cancelled.length, 1)
closeAndroidPdf(other)
await new Promise(r => setTimeout(r, 0))
const slow = {}
heldOperation = 'append'
releaseRequest = undefined
setAndroidPdfSource(slow, new Blob(['pdf']))
warmAndroidPdf(slow)
await waitUntil(() => Boolean(releaseRequest))
closeAndroidPdf(slow)
await waitUntil(() => requests.at(-1).op === 'close')
assert.equal(cancelled.length, 2, 'closing cancels the pending append')
assert.equal(requests.some(r => r.op === 'open' && r.doc === requests.at(-1).doc), false)
console.log('PASS native PDF: optional bridge, chunk bounds, session reuse, fallback, cancellation and close during registration')

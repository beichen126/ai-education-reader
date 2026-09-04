
// Conversation bundle (Markdown + images ZIP) tests (Stage 9.5, Part A2).
import 'fake-indexeddb/auto'
import { unzipSync } from 'fflate'
import { saveFiles } from '../src/engine/attachment-service.ts'
import { saveConversation } from '../src/storage/storage.ts'
import { idbClearAll } from '../src/storage/idb.ts'
import { newStableId } from '../src/engine/types.ts'
import { buildConversationBundle, sanitizeAttachmentName, dedupeNames, ConversationBundleError } from '../src/export/conversation-bundle.ts'
import { type OpfsFileSystem } from '../src/storage/binary-store.ts'

let pass = 0, fail = 0
const assert = (c: boolean, m: string) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// --- sanitize: slash / backslash / NUL / '..' ---
assert(sanitizeAttachmentName('../../etc/passwd.png') === 'etcpasswd.png', 'sanitize strips slashes + dots (got ' + sanitizeAttachmentName('../../etc/passwd.png') + ')')
assert(sanitizeAttachmentName('图 1.png') === '图_1.png', 'sanitize keeps Chinese + replaces spaces (got ' + sanitizeAttachmentName('图 1.png') + ')')
assert(sanitizeAttachmentName('image') === 'image.png', 'sanitize adds default ext')

// --- dedupe collisions: GLOBALLY unique names (blocker 0.5) ---
const uniqueInvariant = (cases: string[][]) => {
  for (const names of cases) {
    const out = dedupeNames(names)
    assert(new Set(out).size === out.length, 'globally unique for [' + names.join(', ') + '] -> [' + out.join(', ') + ']')
  }
}
// figure.png (twice) then an EXPLICIT figure-2.png: the explicit name must never be overwritten.
const dn = dedupeNames(['figure.png', 'figure.png', 'figure-2.png'])
assert(dn.join(',') === 'figure.png,figure-2.png,figure-2-2.png', 'identical + explicit figure-2.png -> figure, figure-2, figure-2-2 (got ' + dn.join(',') + ')')
const dn2 = dedupeNames(['figure.png', 'figure.png', 'figure.png'])
assert(dn2.join(',') === 'figure.png,figure-2.png,figure-3.png', 'three identical -> figure, -2, -3 (got ' + dn2.join(',') + ')')
// Adversarial cases from the RC spec; each result MUST be globally unique.
uniqueInvariant([
  ['a.png', 'a.png', 'a-2.png'],
  ['a.png', 'a-2.png', 'a.png'],
  ['中文图.png', '中文图-2.png', '中文图.png'],
  ['figure.png', 'figure.png', 'figure-2.png'],
])

// clear indexdb (no OPFS mock -> IDB fallback for attachment blobs)
await idbClearAll()

// Save a few attachments (PNG/JPEG/WebP bytes) and a conversation referencing them.
const atts = await saveFiles([
  new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], '中文图.png', { type: 'image/png' }),
  new File([new Uint8Array([255, 216, 255, 4, 5])], 'photo.jpg', { type: 'image/jpeg' }),
  new File([new Uint8Array([82, 73, 70, 70, 6])], 'anim.webp', { type: 'image/webp' }),
  new File([new Uint8Array([9, 9, 9])], '中文图.png', { type: 'image/png' }),
])
const cid = newStableId()
await saveConversation({ id: cid, title: '测试会话 自然地理', createdAt: 1, updatedAt: 1, messages: [
  { id: newStableId(), role: 'user', content: '请看图片', images: [atts[0].id, atts[1].id], createdAt: 1, updatedAt: 1 },
  { id: newStableId(), role: 'assistant', content: '好的', images: [], createdAt: 2, updatedAt: 2 },
  { id: newStableId(), role: 'user', content: '另一张', images: [atts[2].id, atts[3].id], createdAt: 3, updatedAt: 3 },
] } as any)

const bundle = await buildConversationBundle(cid)
const z = unzipSync(new Uint8Array(await bundle.blob.arrayBuffer()))
assert(z['conversation.md'] !== undefined, 'ZIP has conversation.md')
assert(z['images/中文图.png'] !== undefined, 'ZIP has images/中文图.png')
assert(z['images/photo.jpg'] !== undefined, 'ZIP has images/photo.jpg')
assert(z['images/anim.webp'] !== undefined, 'ZIP has images/anim.webp')
// collision: second 中文图.png -> 中文图-2.png
assert(z['images/中文图-2.png'] !== undefined, 'duplicate Chinese name -> 中文图-2.png')
// exact byte roundtrip
const md = new TextDecoder().decode(z['conversation.md'] as Uint8Array)
assert(md.includes('![附件](images/中文图.png)'), 'relative markdown link uses Chinese name')
assert(md.includes('![附件](images/photo.jpg)'), 'relative markdown link photo.jpg')
assert(md.includes('![附件](images/anim.webp)'), 'relative markdown link anim.webp')
// exact byte roundtrip for each image
assert(bytesEqual(z['images/中文图.png'], [137, 80, 78, 71, 1, 2, 3]), '中文图.png bytes exact')
assert(bytesEqual(z['images/photo.jpg'], [255, 216, 255, 4, 5]), 'photo.jpg bytes exact')
assert(bytesEqual(z['images/anim.webp'], [82, 73, 70, 70, 6]), 'anim.webp bytes exact')
assert(bytesEqual(z['images/中文图-2.png'], [9, 9, 9]), '中文图-2.png bytes exact')

// --- missing attachment fails the whole export ---
const cid2 = newStableId()
await saveConversation({ id: cid2, title: 'missing', createdAt: 1, updatedAt: 1, messages: [{ id: newStableId(), role: 'user', content: 'x', images: ['not-an-id'], createdAt: 1, updatedAt: 1 }] } as any)
let threw = false
try { await buildConversationBundle(cid2) } catch (e) { threw = e instanceof ConversationBundleError }
assert(threw, 'missing attachment -> whole ZIP export fails')

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
function bytesEqual(u: Uint8Array | undefined, want: number[]): boolean { if (!u) return false; for (let i = 0; i < want.length; i++) if (u[i] !== want[i]) return false; return true }
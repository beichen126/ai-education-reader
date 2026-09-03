// Stage 9.2A: provenance — same document / different groups + legacy attachments.
import 'fake-indexeddb/auto'
import { saveGeneratedImages, getAttachment } from '../src/engine/attachment-service.ts'
import { buildAttachmentDisplayItems } from '../src/attachments/attachment-display.ts'
import { idbClearAll } from '../src/storage/idb.ts'
import type { Attachment } from '../src/engine/types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
const jpg = (n: number) => new Blob([new Uint8Array(n)], { type: 'image/jpeg' })
const DOC = 'doc-abc', G1 = 'group-1', G2 = 'group-2'

await idbClearAll()
// Group A + Group B: same documentId, DIFFERENT groupId (two adds in one PdfPanel)
const srcA = { type: 'pdf-page' as const, groupId: G1, documentId: DOC, fileName: '教材.pdf', pageNumber: 3, selection: { kind: 'outline' as const, title: '第二章', ranges: [{ startPage: 3, endPage: 5 }], selectedChapterIds: ['1'] } }
const srcB = { type: 'pdf-page' as const, groupId: G2, documentId: DOC, fileName: '教材.pdf', pageNumber: 9, selection: { kind: 'outline' as const, title: '第五章', ranges: [{ startPage: 9, endPage: 10 }], selectedChapterIds: ['4'] } }
const atts = await saveGeneratedImages([
  { blob: jpg(10), name: 'a-p0003.jpg', source: srcA },
  { blob: jpg(10), name: 'a-p0004.jpg', source: srcA },
  { blob: jpg(10), name: 'a-p0009.jpg', source: srcB },
])
const ids = atts.map(a => a.id)

// documentId travels with each page and is identical across BOTH groups
for (const id of ids) {
  const a = await getAttachment(id)
  assert(a!.source!.documentId === DOC, 'page ' + id.slice(0, 6) + ' carries documentId')
}
// groupIds differ — document provenance and group provenance are distinct concepts
const groups = buildAttachmentDisplayItems(ids, atts as Attachment[])
assert(groups.length === 2 && groups[0].groupId === G1 && groups[1].groupId === G2, 'two groups, different groupIds')
assert(groups[0].type === 'pdf-group' && groups[1].type === 'pdf-group', 'both render as pdf-group')

// legacy: no documentId -> displays + passes through unchanged
const legacyAtts = await saveGeneratedImages([
  { blob: jpg(10), name: 'old-p0001.jpg', source: { type: 'pdf-page' as const, groupId: 'G-old', fileName: 'old.pdf', pageNumber: 1, selection: { kind: 'manual' as const, ranges: [{ startPage: 1, endPage: 2 }] } } },
])
const la = await getAttachment(legacyAtts[0].id)
assert(la!.source!.documentId === undefined, 'legacy attachment keeps documentId undefined')
const lg = buildAttachmentDisplayItems([la!.id], [la as Attachment])
assert(lg.length === 1 && lg[0].type === 'pdf-group' && (lg[0] as any).ranges[0].startPage === 1, 'legacy group still displays')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)

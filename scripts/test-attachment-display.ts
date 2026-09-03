// Pure-function tests for buildAttachmentDisplayItems (Stage 5 PDF context group).
import { buildAttachmentDisplayItems, type AttachmentDisplayItem } from '../src/attachments/attachment-display.ts'
import type { Attachment } from '../src/engine/types.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

let seq = 0
function ordinary(name = 'img'): Attachment { seq++; return { id: 'o' + seq, name: name + '.png', mimeType: 'image/png', size: 10, createdAt: 1, updatedAt: 1 } }
function pdfPage(groupId: string, page: number, opts: { fileName?: string; title?: string; kind?: 'outline'|'manual'; start?: number; end?: number } = {}): Attachment {
  seq++
  const start = opts.start ?? page
  const end = opts.end ?? page
  return { id: 'p' + seq, name: 'doc-p' + String(page).padStart(4,'0') + '.jpg', mimeType: 'image/jpeg', size: 10, createdAt: 1, updatedAt: 1, source: { type: 'pdf-page', groupId, fileName: opts.fileName ?? 'doc.pdf', pageNumber: page, selection: { kind: opts.kind ?? 'manual', ...(opts.title ? { title: opts.title } : {}), startPage: start, endPage: end } } }
}
const A = (items: AttachmentDisplayItem[]) => items.map(i => i.type === 'image' ? 'img' : 'grp:' + i.groupId).join(',')

// A: 3 ordinary -> 3 image items
const a = buildAttachmentDisplayItems(['a','b','c'], [ordinary(), ordinary(), ordinary()])
assert(a.length === 3 && a.every(i => i.type === 'image'), 'A: 3 ordinary images -> 3 image items')

// B: 3 contiguous same groupId -> 1 pdf-group
const gB = 'G-B'; const attsB = [pdfPage(gB, 1, {start:1,end:3}), pdfPage(gB, 2, {start:1,end:3}), pdfPage(gB, 3, {start:1,end:3})]
const b = buildAttachmentDisplayItems(attsB.map(x=>x.id), attsB)
assert(b.length === 1 && b[0].type === 'pdf-group' && b[0].attachmentIds.length === 3, 'B: 3 contiguous same group -> 1 pdf-group (3 ids)')
assert((b[0] as any).selectedPageCount === 3 && (b[0] as any).originalPageCount === 3, 'B: selected/original page counts = 3/3')

// C: image / group x3 / image
const gC = 'G-C'; const attsC = [ordinary('A'), pdfPage(gC,1,{start:1,end:3}), pdfPage(gC,2,{start:1,end:3}), pdfPage(gC,3,{start:1,end:3}), ordinary('B')]
const c = buildAttachmentDisplayItems(attsC.map(x=>x.id), attsC)
assert(A(c) === 'img,grp:G-C,img', 'C: image/group/image order (got ' + A(c) + ')')

// D: same fileName, different groupId -> 2 groups
const gD1='G-D1', gD2='G-D2'; const attsD = [pdfPage(gD1,1,{fileName:'book.pdf',start:1,end:2}), pdfPage(gD1,2,{fileName:'book.pdf',start:1,end:2}), pdfPage(gD2,1,{fileName:'book.pdf',start:3,end:4}), pdfPage(gD2,2,{fileName:'book.pdf',start:3,end:4})]
const d = buildAttachmentDisplayItems(attsD.map(x=>x.id), attsD)
assert(d.length === 2 && d[0].type==='pdf-group' && d[1].type==='pdf-group' && d[0].groupId !== d[1].groupId, 'D: same fileName + different groupId -> 2 groups')

// E: same groupId interrupted by ordinary image -> no cross-run merge
const gE='G-E'; const attsE = [pdfPage(gE,1,{start:1,end:3}), ordinary('X'), pdfPage(gE,2,{start:1,end:3})]
const e = buildAttachmentDisplayItems(attsE.map(x=>x.id), attsE)
assert(A(e) === 'grp:G-E,img,grp:G-E', 'E: interrupted group not merged (got ' + A(e) + ')')

// F: old attachment source undefined -> ordinary image
const f = buildAttachmentDisplayItems(['x'], [ordinary()])
assert(f.length === 1 && f[0].type === 'image', 'F: old attachment (no source) -> ordinary image')

// G: group missing one page -> selected/original counts
const gG='G-G'; const full = [pdfPage(gG,1,{start:1,end:3}), pdfPage(gG,2,{start:1,end:3}), pdfPage(gG,3,{start:1,end:3})]
const remaining = [full[0], full[2]] // missing p2
const gg = buildAttachmentDisplayItems(remaining.map(x=>x.id), remaining)
assert(gg.length === 1 && gg[0].type==='pdf-group' && (gg[0] as any).selectedPageCount === 2 && (gg[0] as any).originalPageCount === 3, 'G: missing page -> selected 2 / original 3')

// metadata source intact (legacy single-range selection -> ranges + counts)
const one = buildAttachmentDisplayItems([full[1].id], full)
assert(one[0].type==='pdf-group' && (one[0] as any).ranges.length === 1 && (one[0] as any).ranges[0].startPage === 1 && (one[0] as any).ranges[0].endPage === 3 && (one[0] as any).originalPageCount === 3 && (one[0] as any).fileName === 'doc.pdf', 'legacy source -> display ranges/counts intact')

// H: multi-range (Stage 9.1) selection -> group shows both ranges + deduped count
function pdfPageMulti(groupId: string, page: number, ranges: Array<{ startPage: number; endPage: number }>, title?: string): Attachment {
  seq++
  return { id: 'm' + seq, name: 'book-p' + String(page).padStart(4,'0') + '.jpg', mimeType: 'image/jpeg', size: 10, createdAt: 1, updatedAt: 1, source: { type: 'pdf-page', groupId, fileName: 'book.pdf', pageNumber: page, selection: { kind: 'outline', ...(title ? { title } : {}), ranges, selectedChapterIds: ['c2','c5'] } } }
}
const gH = 'G-H'
const multiAtts = [
  pdfPageMulti(gH, 30, [{ startPage: 30, endPage: 48 }, { startPage: 100, endPage: 118 }], '第二章 数据表示'),
  pdfPageMulti(gH, 31, [{ startPage: 30, endPage: 48 }, { startPage: 100, endPage: 118 }], '第二章 数据表示'),
  pdfPageMulti(gH, 100, [{ startPage: 30, endPage: 48 }, { startPage: 100, endPage: 118 }], '第二章 数据表示'),
]
const hh = buildAttachmentDisplayItems(multiAtts.map(x=>x.id), multiAtts)
const hGroup = hh[0] as any
assert(hh.length === 1 && hGroup.type === 'pdf-group', 'H: multi-range selection -> 1 group')
assert(hGroup.ranges.length === 2 && hGroup.ranges[0].startPage === 30 && hGroup.ranges[0].endPage === 48 && hGroup.ranges[1].startPage === 100 && hGroup.ranges[1].endPage === 118, 'H: group keeps both ranges (no fake span)')
assert(hGroup.originalPageCount === 38 && hGroup.selectedPageCount === 3, 'H: original 38 (deduped) / selected 3')

// I: multi-range with overlap -> normalized single range + deduped count
const gI = 'G-I'
const overlapAtts = [pdfPageMulti(gI, 1, [{ startPage: 1, endPage: 100 }, { startPage: 20, endPage: 40 }], '父章节')]
const ii = buildAttachmentDisplayItems(overlapAtts.map(x=>x.id), overlapAtts)
assert((ii[0] as any).originalPageCount === 100, 'I: parent+child selections display 100 pages, not 121 (got ' + (ii[0] as any).originalPageCount + ')')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)

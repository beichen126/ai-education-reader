// Stage 9.2A: native PDF outline -> persistent ChapterNode model (pure mapping).
import { chapterNodesFromPdfOutline } from '../src/documents/chapter-model.ts'
import type { PdfOutlineItem } from '../src/pdf/pdf-outline.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

const node = (id: string, title: string, depth: number, partial: Partial<PdfOutlineItem> = {}, children: PdfOutlineItem[] = []): PdfOutlineItem => ({
  id, title, depth, path: id.split('.').map(Number), children,
  directStartPage: null, startPage: null, endPage: null, selectable: false, resolution: 'unresolved',
  ...partial,
})

// --- tree order / levels / ids / ranges preserved ---
const tree: PdfOutlineItem[] = [
  node('0', 'Computer Organization', 0, { startPage: 1, endPage: 4, selectable: true, resolution: 'direct' }, [
    node('0.0', '1.1 History', 1, { startPage: 2, endPage: 2, selectable: true, resolution: 'direct' }),
    node('0.1', '1.2 Structure', 1, { startPage: 3, endPage: 3, selectable: true, resolution: 'direct' }),
    node('0.2', '1.3 Metrics', 1, { startPage: 4, endPage: 4, selectable: true, resolution: 'direct' }),
  ]),
  node('1', 'Data Representation', 0, { startPage: 5, endPage: 8, selectable: true, resolution: 'direct' }, [
    node('1.0', '2.1 Number', 1, { startPage: 6, endPage: 6, selectable: true, resolution: 'direct' }),
    node('1.1', '2.2 Encodings', 1, { startPage: 7, endPage: 8, selectable: true, resolution: 'direct' }),
  ]),
]
const chapters = chapterNodesFromPdfOutline(tree)
assert(chapters.length === 2, 'tree order: 2 top chapters')
assert(chapters[0].id === '0' && chapters[1].id === '1', 'ids preserved (Stage 9.1 selectedChapterIds match)')
assert(chapters[0].children.length === 3 && chapters[0].children[0].id === '0.0', 'children order + ids preserved')
assert(chapters[0].level === 1 && chapters[0].children[0].level === 2, 'level = depth + 1')
assert(chapters[1].children[1].startPage === 7 && chapters[1].children[1].endPage === 8, '2.2 Encodings range 7-8 preserved')
assert(chapters[0].children[0].startPage === 2, 'single-page range preserved')
assert(chapters[0].selectable === true && chapters[0].children[0].selectable === true, 'selectable flags preserved')

// --- unresolved nodes keep null pages (never fabricated) + source native ---
const partial: PdfOutlineItem[] = [
  node('0', 'Parent only', 0, { startPage: null, endPage: null, selectable: false, resolution: 'unresolved' }, [
    node('0.0', 'Child real', 1, { startPage: 3, endPage: 4, selectable: true, resolution: 'direct' }),
  ]),
]
const pc = chapterNodesFromPdfOutline(partial)
assert(pc[0].startPage === null && pc[0].endPage === null && pc[0].selectable === false, 'unresolved parent -> null pages, not selectable')
assert(pc[0].children[0].startPage === 3, 'resolved child keeps its page')
assert(pc[0].source === 'native' && pc[0].children[0].source === 'native', 'chapters tagged source=native')

// --- external URL leaf + blank leaf filtered like the outline UI ---
const noisy: PdfOutlineItem[] = [
  node('0', 'URL leaf', 0, { resolution: 'external', selectable: false, startPage: null, endPage: null }),
  node('1', '   ', 0, { resolution: 'unresolved', selectable: false, startPage: 2, endPage: 3 }),
  node('2', 'Real chapter', 0, { startPage: 5, endPage: 9, selectable: true }),
]
const nn = chapterNodesFromPdfOutline(noisy)
assert(nn.length === 1 && nn[0].id === '2', 'external leaf + blank-title leaf filtered, real chapter kept')

// --- no outline -> empty ---
assert(chapterNodesFromPdfOutline([]).length === 0, 'no outline -> []')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)

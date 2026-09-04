
import { writeFileSync } from 'fs'
import { PDFDocument } from 'pdf-lib'
import { writeBookmarkedPdf, findUnresolvedChapters } from '../src/export/pdf-outline-writer.ts'

let pass = 0, fail = 0
const assert = (c: boolean, m: string) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

const src = await PDFDocument.create()
for (let i = 1; i <= 30; i++) src.addPage([595, 842])
const srcBytes = await src.save()
writeFileSync('test/fixtures/tmp-src.pdf', srcBytes)

const chapters = [
  { id: 'c1', title: '第一章 绪论', level: 1, startPage: 3, endPage: 8, selectable: true, source: 'ai-toc', children: [
    { id: 'c1a', title: '第一节 研究对象', level: 2, startPage: 3, endPage: 5, selectable: true, source: 'ai-toc', children: [] },
    { id: 'c1b', title: '第二节 研究方法', level: 2, startPage: 6, endPage: 8, selectable: true, source: 'ai-toc', children: [] },
  ] },
  { id: 'c2', title: '第二章 自然地理', level: 1, startPage: 10, endPage: 12, selectable: true, source: 'ai-toc', children: [
    { id: 'c2a', title: '第一节 要素', level: 2, startPage: 10, endPage: 11, selectable: true, source: 'ai-toc', children: [] },
  ] },
] as any

const bad = findUnresolvedChapters([{ ...chapters[0], children: [{ ...chapters[0].children[0], startPage: null }] }] as any, 30)
assert(bad.length === 1, 'unresolved chapter detected')

let out: Uint8Array
try { out = await writeBookmarkedPdf({ sourceBytes: srcBytes, chapters, pageCount: 30 }) }
catch (e) { console.log('WRITE ERROR: ' + (e && (e as any).message ? (e as any).message : String(e))); if (e && (e as any).stack) console.log((e as any).stack); process.exit(1) }
writeFileSync('test/fixtures/tmp-out.pdf', out)

const doc = await (await import('pdfjs-dist/legacy/build/pdf.mjs')).getDocument({ data: Uint8Array.from(out) }).promise
assert(doc.numPages === 30, 'pageCount preserved (30)')
const outline = await doc.getOutline()
assert(outline && outline.length === 2, 'top-level outline has 2 items (got ' + (outline && outline.length) + ')')
if (outline && outline.length === 2) {
  assert(outline[0].title === '第一章 绪论', 'outline[0].title = 第一章 绪论 (got ' + outline[0].title + ')')
  assert(outline[1].title === '第二章 自然地理', 'outline[1].title = 第二章 自然地理')
  assert(outline[0].items && outline[0].items.length === 2, '第一章 has 2 children')
  const rawDest: any = outline[0].dest
  const dest0 = Array.isArray(rawDest) ? rawDest : await doc.getDestination(rawDest)
  const idx0 = Array.isArray(dest0) ? await doc.getPageIndex(dest0[0]) : -1
  assert(idx0 === 2, '第一章 dest -> page 3 (0-based 2, got ' + idx0 + ')')
}

// ---- content preservation: real-content PDF survives the load/save round-trip ----
{
  const real = new Uint8Array((await (await import('fs')).readFileSync('test/fixtures/outline-sample.pdf')))
  const realSrc = await PDFDocument.load(real)
  const realCount = realSrc.getPageCount()
  const chapters = [ { id: 'x', title: '开始', level: 1, startPage: 1, endPage: 2, selectable: true, source: 'manual', children: [] } ]
  const out = await writeBookmarkedPdf({ sourceBytes: real, chapters, pageCount: realCount })
  const d2 = await (await import('pdfjs-dist/legacy/build/pdf.mjs')).getDocument({ data: Uint8Array.from(out) }).promise
  assert(d2.numPages === realCount, 'real PDF pageCount preserved (' + realCount + ')')
  const p1 = await d2.getPage(1)
  const ops = await p1.getOperatorList()
  assert(ops.fnArray.length > 0, 'real PDF page 1 has content operators (got ' + ops.fnArray.length + ')')
}
console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
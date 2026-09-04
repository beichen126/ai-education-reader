
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFNumber } from 'pdf-lib'
import { unicodePdfString } from './unicode-pdf-string'
import type { ChapterNode } from '../documents/document-types'

export class PdfOutlineError extends Error {
  constructor(message: string) { super(message); this.name = 'PdfOutlineError' }
}

export function findUnresolvedChapters(nodes: ChapterNode[], pageCount: number): string[] {
  const bad: string[] = []
  const walk = (list: ChapterNode[]) => { for (const n of list) { const p = n.startPage; if (p == null || !Number.isInteger(p) || p < 1 || p > pageCount) bad.push(n.title || '(未命名)'); walk(n.children) } }
  walk(nodes)
  return bad
}

export async function writeBookmarkedPdf(opts: {
  sourceBytes: Uint8Array
  chapters: ChapterNode[]
  pageCount: number
}): Promise<Uint8Array> {
  const { sourceBytes, chapters, pageCount } = opts
  const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false, throwOnInvalidObject: false })
  if (doc.getPageCount() !== pageCount) throw new PdfOutlineError('源 PDF 页数与当前目录不一致，无法导出。')
  const unresolved = findUnresolvedChapters(chapters, pageCount)
  if (unresolved.length > 0) throw new PdfOutlineError('当前目录中仍有无法定位页码的章节，请先整理目录后再导出。')

  const ctx = doc.context
  const pages = doc.getPages()

  const build = (list: ChapterNode[]): { ref: PDFRef; node: ChapterNode; children: any[] }[] => {
    const out: { ref: PDFRef; node: ChapterNode; children: any[] }[] = []
    for (const n of list) {
      const pageIndex = (n.startPage as number) - 1
      const dest = PDFArray.withContext(ctx)
      dest.push(pages[pageIndex].ref)
      dest.push(PDFName.of('Fit'))
      const dict = PDFDict.withContext(ctx)
      dict.set(PDFName.of('Title'), unicodePdfString(n.title))
      dict.set(PDFName.of('Dest'), dest)
      const ref = ctx.register(dict)
      const it: any = { ref, node: n, children: build(n.children) }
      out.push(it)
    }
    return out
  }
  const root = build(chapters)

  const link = (list: any[], parent: PDFRef | null) => {
    for (let i = 0; i < list.length; i++) {
      const it = list[i]
      const dict = ctx.lookup(it.ref) as PDFDict
      if (parent) dict.set(PDFName.of('Parent'), parent)
      if (i > 0) dict.set(PDFName.of('Prev'), list[i - 1].ref)
      if (i < list.length - 1) dict.set(PDFName.of('Next'), list[i + 1].ref)
      const kids = it.children
      if (kids.length) {
        link(kids, it.ref)
        dict.set(PDFName.of('First'), kids[0].ref)
        dict.set(PDFName.of('Last'), kids[kids.length - 1].ref)
        dict.set(PDFName.of('Count'), PDFNumber.of(kids.length))
      }
    }
  }
  link(root, null)
  const outlinesRef = ctx.register((() => { const d = PDFDict.withContext(ctx); d.set(PDFName.of('Type'), PDFName.of('Outlines')); if (root.length) { d.set(PDFName.of('First'), root[0].ref); d.set(PDFName.of('Last'), root[root.length - 1].ref); d.set(PDFName.of('Count'), PDFNumber.of(root.length)) } return d })())
  if (root.length) { for (const it of root) (ctx.lookup(it.ref) as PDFDict).set(PDFName.of('Parent'), outlinesRef) }
  const catalog = doc.catalog
  catalog.set(PDFName.of('Outlines'), outlinesRef)
  catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
  return doc.save({ useObjectStreams: false })
}

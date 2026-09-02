import { createRoot } from 'react-dom/client'
import { useEffect, useRef } from 'react'
import { MarkdownBlocks } from '../src/markdown/MarkdownBlocks'
import { buildBlockModels, type BlockModel } from '../src/markdown/block-layer'
import { parseMarkdown } from '../src/markdown/parse'
import { mapSelection } from '../src/annotations/selection-mapper'
import { resolveToRange } from '../src/annotations/range-resolver'

const MID = 'test-msg-1'
const CONTENT = '# 标题\n\n**平均**存储器访问😀时间与[链接](https://x)和*斜体*。\n\n- 项A\n- 项B\n\n> 重要引用\n\n| A列 | B列 |\n|---|---|\n| 甲 | **乙** |\n\n```js\nconst c=1\n```'

function Harness(){
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const rootEl = ref.current as HTMLDivElement
    const msgEl = rootEl.querySelector('[data-message-id]') as Element
    const models = buildBlockModels(parseMarkdown(CONTENT), MID)
    const blocks = new Map<string, BlockModel>(models.map(m => [m.id, m]))
    function leavesIn(blockId: string): { node: Text; cs: number; len: number }[] {
      const blk = msgEl.querySelector('[data-block-id="' + blockId + '"]') as Element
      if (!blk) return []
      const out: { node: Text; cs: number; len: number }[] = []
      blk.querySelectorAll('[data-canonical-start]').forEach((el) => { const n = el.firstChild; if (n && n.nodeType === 3) out.push({ node: n as Text, cs: Number(el.getAttribute('data-canonical-start')) || 0, len: (n.textContent || '').length }) })
      return out.sort((a,b)=>a.cs-b.cs)
    }
    function leavesInCell(tableId: string, row: number, col: number): { node: Text; cs: number; len: number }[] {
      const td = msgEl.querySelector('[data-table-id="' + tableId + '"] td[data-row="' + row + '"][data-col="' + col + '"]') as Element
      if (!td) return []
      const out: { node: Text; cs: number; len: number }[] = []
      td.querySelectorAll('[data-canonical-start]').forEach((el) => { const n = el.firstChild; if (n && n.nodeType === 3) out.push({ node: n as Text, cs: Number(el.getAttribute('data-canonical-start')) || 0, len: (n.textContent || '').length }) })
      return out.sort((a,b)=>a.cs-b.cs)
    }
    // select across 1+ blocks OR cells: segs = {b,s,e} for blocks, {t,row,col,s,e} for cells
    function select(segs: any[]): ReturnType<typeof mapSelection> {
      const range = document.createRange(); let started = false
      for (const seg of segs) {
        const leaves = seg.t != null ? leavesInCell(seg.t, seg.row, seg.col) : leavesIn(seg.b)
        for (const leaf of leaves) { const lo = leaf.cs, hi = leaf.cs + leaf.len; if (!started && seg.s < hi && lo <= seg.e) { range.setStart(leaf.node, Math.max(0, seg.s - lo)); started = true } if (started && seg.e <= hi && seg.e > lo) { range.setEnd(leaf.node, Math.max(0, seg.e - lo)); break } }
      }
      return mapSelection(msgEl, MID, range, (b) => blocks.get(b))
    }
    ;(window as any).__select = (segs: any[]) => JSON.parse(JSON.stringify(select(segs)))
    ;(window as any).__roundTrip = (blockId: string, start: number, end: number) => {
      const target = { type: 'text', anchor: { scope: 'block', blockId }, start, end, quote: { exact: '', prefix: '', suffix: '' } }
      const range = resolveToRange(msgEl, MID, target as any)
      if (!range) return { ok: false, reason: 'no-range' }
      const m = mapSelection(msgEl, MID, range, (b) => blocks.get(b))
      const seg = m.kind === 'text' ? m.segments[0] : undefined
      return { ok: m.kind === 'text' && seg && seg.start === start && seg.end === end, kind: m.kind, seg: seg ? { start: seg.start, end: seg.end, exact: seg.exact } : null }
    }
    ;(window as any).__blocks = Array.from(blocks.values()).map(b => ({ id: b.id, type: b.type, canonical: b.canonicalText, annotatable: b.annotatable, table: b.table ? { id: b.table.id, rows: b.table.rows, cols: b.table.cols, cells: b.table.cells.map(c => ({ row: c.row, col: c.col, canonicalText: c.canonicalText })) } : undefined }))
  }, [])
  return <div ref={ref}><MarkdownBlocks content={CONTENT} messageId={MID} /></div>
}
createRoot(document.getElementById('root')!).render(<Harness />)
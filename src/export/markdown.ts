import { buildBlockModels, tableIdOf, mathIdOf, mathKindOf, startOf, endOf, type BlockModel } from '../markdown/block-layer'
import { parseMarkdown } from '../markdown/parse'
import type { Conversation, Message } from '../engine/types'
import type { Annotation } from '../annotations/annotation-types'
import { indexBlocks, blockMap, type MarkSegment } from './canonical-map'

type Edit = { pos: number; text: string }

function applyEdits(src: string, edits: Edit[]): string {
  const uniq = new Map<string, Edit>()
  for (const e of edits) uniq.set(e.pos + ':' + e.text, e)
  const sorted = [...uniq.values()].sort((a, b) => b.pos - a.pos)
  let out = src
  for (const e of sorted) out = out.slice(0, e.pos) + e.text + out.slice(e.pos)
  return out
}

function indexTables(content: string, messageId: string): Map<string, any> {
  const root = parseMarkdown(content)
  const out = new Map<string, any>()
  const visit = (nodes: any[]): void => {
    for (const n of nodes) {
      if (n.type === 'table') out.set(tableIdOf(messageId, startOf(n), endOf(n)), n)
      if (n.children && Array.isArray(n.children)) visit(n.children)
    }
  }
  visit((root.children as any) || [])
  return out
}

function tableSource(content: string, node: any): string { const a = startOf(node), b = endOf(node); return content.slice(a, b) }
const MARK_MATH_START = '<!-- marked-math:start -->'
const MARK_MATH_END = '<!-- marked-math:end -->'
function indexMath(content: string, messageId: string): Map<string, { node: any; kind: 'inline' | 'block' }> {
  const root = parseMarkdown(content)
  const out = new Map<string, { node: any; kind: 'inline' | 'block' }>()
  const walk = (nodes: any[]): void => { for (const n of nodes) { if (n.type === 'inlineMath' || n.type === 'math') { const kind = mathKindOf(n); out.set(mathIdOf(messageId, kind, startOf(n), endOf(n)), { node: n, kind }) } if (n.children && Array.isArray(n.children)) walk(n.children) } }
  walk((root.children as any) || [])
  return out
}
function mathSource(content: string, node: any): string { return content.slice(startOf(node), endOf(node)) }
function mathMarked(src: string, kind: 'inline' | 'block'): string { return kind === 'inline' ? MARK_MATH_START + src + MARK_MATH_END : MARK_MATH_START + '\n' + src + '\n' + MARK_MATH_END }
const TABLE_START = '<!-- marked-table:start -->'
const TABLE_END = '<!-- marked-table:end -->'

/** Mark the annotated source text of a message with <mark> and table marker comments. */
export function annotateMessageSource(content: string, messageId: string, anns: Annotation[]): string {
  const root = parseMarkdown(content)
  const blocks = indexBlocks(root, messageId)                 // blockId -> node
  const tables = indexTables(content, messageId)              // tableId -> node
  const maths = indexMath(content, messageId)                 // mathId -> node
  const edits: Edit[] = []
  const markedTables = new Set<string>()
  const markedMaths = new Set<string>()

  const markTable = (tableId: string): void => {
    if (markedTables.has(tableId)) return
    const node = tables.get(tableId); if (!node) return
    markedTables.add(tableId)
    const s = startOf(node), e = endOf(node)
    edits.push({ pos: s, text: TABLE_START + '\n' })
    edits.push({ pos: e, text: '\n' + TABLE_END })
  }

  for (const a of anns) {
    const t = a.target
    if (t.type === 'text') {
      if (t.anchor.scope === 'table-cell') { markTable(t.anchor.tableId); continue }
      const node = blocks.get(t.anchor.blockId); if (!node) continue
      const { segs } = blockMap(node)
      const s = t.start, e = t.end
      for (const seg of segs) {
        if (!seg.markable) continue
        const lo = Math.max(s, seg.cStart) - seg.cStart
        const hi = Math.min(e, seg.cEnd) - seg.cStart
        if (hi <= lo) continue
        const so = seg.sStart + lo, eo = seg.sStart + hi
        edits.push({ pos: so, text: '<mark>' })
        edits.push({ pos: eo, text: '</mark>' })
      }
    } else if (t.type === 'table' || t.type === 'table-cells') {
      markTable(t.tableId)
    } else if (t.type === 'math') {
      if (markedMaths.has(t.mathId)) continue
      const entry = maths.get(t.mathId); if (!entry) continue
      markedMaths.add(t.mathId)
      const s = startOf(entry.node), e = endOf(entry.node)
      if (entry.kind === 'inline') { edits.push({ pos: s, text: MARK_MATH_START }); edits.push({ pos: e, text: MARK_MATH_END }) }
      else { edits.push({ pos: s, text: MARK_MATH_START + '\n' }); edits.push({ pos: e, text: '\n' + MARK_MATH_END }) }
    }
  }
  return applyEdits(content, edits)
}

/** Full human/AI-readable Markdown for one conversation. Source content is preserved verbatim; only <mark> + table markers are injected. */
export function conversationMarkdown(conv: Conversation, anns: Annotation[]): string {
  const byMsg = new Map<string, Annotation[]>()
  for (const a of anns) { const l = byMsg.get(a.messageId) || []; l.push(a); byMsg.set(a.messageId, l) }
  const out: string[] = ['# ' + (conv.title || '未命名会话'), '']
  for (const m of conv.messages) {
    const label = m.role === 'assistant' ? 'AI' : '用户'
    const mark = byMsg.get(m.id)
    const body = mark && mark.length ? annotateMessageSource(m.content, m.id, mark) : m.content
    out.push('## ' + label, '', body, '')
  }
  return out.join('\n').replace(/\n+$/, '\n')
}

type Item = { role: string; context: string[]; md: string; blockStart: number; start: number }
function tableModelFor(models: BlockModel[], tableId: string): BlockModel | undefined { return models.find((x) => x.table && x.table.id === tableId) }

export function markedOnlyMarkdown(conv: Conversation, anns: Annotation[]): string {
  const byMsg = new Map<string, Annotation[]>()
  for (const a of anns) { const l = byMsg.get(a.messageId) || []; l.push(a); byMsg.set(a.messageId, l) }
  const out: string[] = ['# ' + (conv.title || '未命名会话'), '']
  for (const m of conv.messages) {
    const list = byMsg.get(m.id)
    if (!list || list.length === 0) continue
    const role = m.role === 'assistant' ? 'AI' : '用户'
    const root = parseMarkdown(m.content)
    const models = buildBlockModels(root, m.id)
    const blocks = indexBlocks(root, m.id)
    const tables = indexTables(m.content, m.id)
    const maths = indexMath(m.content, m.id)
    const items: Item[] = []
    const usedTables = new Set<string>()
    for (const a of list) {
      const t = a.target
      if (t.type === 'text') {
        const anchor = t.anchor
        if (anchor.scope === 'block') {
          const model = models.find((x) => x.id === anchor.blockId)
          const node = blocks.get(anchor.blockId)
          const canon = node ? blockMap(node).canonical : (model?.canonicalText || '')
          const txt = (canon.length ? canon.slice(t.start, t.end) : '') || t.quote.exact || ''
          if (!txt) continue
          items.push({ role, context: model?.headingPath || [], md: '<mark>' + txt + '</mark>', blockStart: model?.sourceStart ?? 0, start: t.start })
        } else if (anchor.scope === 'table-cell') {
          const model = tableModelFor(models, anchor.tableId)
          const node = tables.get(anchor.tableId)
          if (node && !usedTables.has(anchor.tableId)) { usedTables.add(anchor.tableId); items.push({ role, context: model?.headingPath || [], md: TABLE_START + '\n' + tableSource(m.content, node) + '\n' + TABLE_END, blockStart: startOf(node), start: t.start }) }
        }
      } else if (t.type === 'table' || t.type === 'table-cells') {
        const model = tableModelFor(models, t.tableId)
        const node = tables.get(t.tableId)
        if (node && !usedTables.has(t.tableId)) { usedTables.add(t.tableId); items.push({ role, context: model?.headingPath || [], md: TABLE_START + '\n' + tableSource(m.content, node) + '\n' + TABLE_END, blockStart: startOf(node), start: 0 }) }
      } else if (t.type === 'math') {
        const entry = maths.get(t.mathId)
        if (entry) {
          const pos = startOf(entry.node)
          const model = models.find((x) => x.sourceStart <= pos && pos < x.sourceEnd)
          const src = mathSource(m.content, entry.node)
          items.push({ role, context: model?.headingPath || [], md: mathMarked(src, entry.kind), blockStart: pos, start: 0 })
        }
      }
    }
    if (items.length === 0) continue
    items.sort((a, b) => (a.blockStart - b.blockStart) || (a.start - b.start))
    // group by role + context
    const groups = new Map<string, { role: string; context: string[]; mds: string[] }>()
    for (const it of items) {
      const key = it.role + '|' + it.context.join('>')
      const g = groups.get(key); if (g) g.mds.push(it.md); else groups.set(key, { role: it.role, context: it.context, mds: [it.md] })
    }
    for (const g of groups.values()) {
      const ctx = g.context.length ? g.context.join(' > ') : ''
      out.push('## ' + g.role + (ctx ? ' · ' + ctx : ''), '')
      for (const md of g.mds) out.push(md, '')
    }
  }
  return out.join('\n').replace(/\n+$/, '\n')
}

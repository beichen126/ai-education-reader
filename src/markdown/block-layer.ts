
import type { Root, BlockContent, Literal, Text, Table, TableCell, TableRow, Heading, ListItem } from 'mdast'
export type BlockType = 'heading' | 'paragraph' | 'list-item' | 'blockquote' | 'table' | 'code' | 'math'
export type BlockModel = {
  id: string
  messageId: string
  type: BlockType
  sourceStart: number
  sourceEnd: number
  canonicalText: string
  annotatable: boolean
  level?: number
  headingPath: string[]
  table?: { id: string; rows: number; cols: number; cells: { row: number; col: number; canonicalText: string }[] }
}

/** Offset of a node's start in the source markdown (fallback -1). */
export function startOf(node: any): number { return node?.position?.start?.offset ?? -1 }
export function endOf(node: any): number { return node?.position?.end?.offset ?? -1 }

const TYPE_CODE: Record<string, string> = {
  heading: 'h', paragraph: 'p', 'list-item': 'li', blockquote: 'quote', table: 'table', code: 'code', math: 'math',
}
export function blockTypeOf(node: any): BlockType | undefined {
  if (node.type === 'heading') return 'heading'
  if (node.type === 'paragraph') return 'paragraph'
  if (node.type === 'listItem') return 'list-item'
  if (node.type === 'blockquote') return 'blockquote'
  if (node.type === 'table') return 'table'
  if (node.type === 'code') return 'code'
  if (node.type === 'math') return 'math'
  return undefined
}

/** Stable block id: messageId + type + sourceStart + sourceEnd. fingerprint not required as identity. */
export function blockIdOf(messageId: string, type: BlockType, start: number, end: number): string {
  return messageId + '/' + (TYPE_CODE[type] || type) + '-' + start + '-' + end
}
export function tableIdOf(messageId: string, start: number, end: number): string {
  return messageId + '/table-' + start + '-' + end
}
export function mathKindOf(node: any): 'inline' | 'block' { return node.type === 'inlineMath' ? 'inline' : 'block' }
export function mathIdOf(messageId: string, kind: 'inline' | 'block', start: number, end: number): string {
  return messageId + '/math-' + kind + '-' + start + '-' + end
}

/** Flatten an mdast inline/block subtree to its continuous plain text (inline markup excluded). */
export const MATH_ATOM = '\uFFFF'
export function flattenText(node: any): string {
  if (node == null) return ''
  if (node.type === 'break') return '\n'                            // hard/soft break -> one canonical \n
  if (node.type === 'inlineMath') return MATH_ATOM                  // one atomic canonical unit (matches the rendered DOM's math=1 counting)
  if (typeof node.value === 'string') return node.value            // text / code / html literal
  if (node.children) return node.children.map((c: any) => flattenText(c)).join('')
  return ''
}

/** Reading-semantics canonical text for a block, skipping nested block structures (list/quote only take their own text). */
function canonicalOf(node: any): string {
  if (node.type === 'list-item') return flattenText(node)
  if (node.type === 'blockquote') return flattenText(node)
  if (node.type === 'table') return flattenText(node)
  return flattenText(node)
}

/** Build the per-message stable BlockModels from an mdast Root. Pure: no DOM / no persistence. */
export function buildBlockModels(root: Root, messageId: string): BlockModel[] {
  const out: BlockModel[] = []
  const headingPath: string[] = []
  const walk = (nodes: any[]): void => {
    for (const node of nodes) {
      const t = blockTypeOf(node)
      if (t === 'heading') {
        const level = (node as Heading).depth
        // maintain heading path stack (replace deeper headings)
        while (headingPath.length >= level) headingPath.pop()
        headingPath[level - 1] = flattenText(node)
        out.push({ id: blockIdOf(messageId, t, startOf(node), endOf(node)), messageId, type: t, sourceStart: startOf(node), sourceEnd: endOf(node), canonicalText: canonicalOf(node), annotatable: true, level, headingPath: headingPath.filter(Boolean).slice() })
      } else if (t === 'paragraph') {
        out.push({ id: blockIdOf(messageId, t, startOf(node), endOf(node)), messageId, type: t, sourceStart: startOf(node), sourceEnd: endOf(node), canonicalText: canonicalOf(node), annotatable: true, headingPath: headingPath.filter(Boolean).slice() })
      } else if (t === 'list-item') {
        out.push({ id: blockIdOf(messageId, t, startOf(node), endOf(node)), messageId, type: t, sourceStart: startOf(node), sourceEnd: endOf(node), canonicalText: canonicalOf(node), annotatable: true, headingPath: headingPath.filter(Boolean).slice() })
      } else if (t === 'blockquote') {
        out.push({ id: blockIdOf(messageId, t, startOf(node), endOf(node)), messageId, type: t, sourceStart: startOf(node), sourceEnd: endOf(node), canonicalText: canonicalOf(node), annotatable: true, headingPath: headingPath.filter(Boolean).slice() })
        walk((node as any).children || [])
      } else if (t === 'table') {
        const rowsNodes = (node as Table).children
        const rows = rowsNodes.length
        const cols = rows > 0 ? rowsNodes[0].children.length : 0
        const cells: { row: number; col: number; canonicalText: string }[] = []
        rowsNodes.forEach((row, r) => row.children.forEach((cell, c) => cells.push({ row: r, col: c, canonicalText: flattenText(cell) })))
        out.push({ id: blockIdOf(messageId, t, startOf(node), endOf(node)), messageId, type: t, sourceStart: startOf(node), sourceEnd: endOf(node), canonicalText: canonicalOf(node), annotatable: true, headingPath: headingPath.filter(Boolean).slice(), table: { id: tableIdOf(messageId, startOf(node), endOf(node)), rows, cols, cells } })
      } else if (t === 'math') {
        out.push({ id: blockIdOf(messageId, t, startOf(node), endOf(node)), messageId, type: t, sourceStart: startOf(node), sourceEnd: endOf(node), canonicalText: (node as any).value || '', annotatable: false, headingPath: headingPath.filter(Boolean).slice() })
      } else if (t === 'code') {
        out.push({ id: blockIdOf(messageId, t, startOf(node), endOf(node)), messageId, type: t, sourceStart: startOf(node), sourceEnd: endOf(node), canonicalText: (node as any).value || '', annotatable: false, headingPath: headingPath.filter(Boolean).slice() })
      } else {
        // container with children (e.g., list) — recurse into listItem children
        if (node.children && Array.isArray(node.children)) walk(node.children)
      }
    }
  }
  walk(root.children || [])
  return out
}

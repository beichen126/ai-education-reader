import { buildBlockModels, type BlockModel } from '../markdown/block-layer'
import { parseMarkdown } from '../markdown/parse'
import type { TextAnchor } from './annotation-types'
export function buildBlockMap(content: string, messageId: string): { blocks: Map<string, BlockModel>; canonicalOf: (a: TextAnchor) => string } {
  const models = buildBlockModels(parseMarkdown(content), messageId)
  const blocks = new Map(models.map((m) => [m.id, m]))
  const canonicalOf = (anchor: TextAnchor): string => {
    if (!anchor || typeof anchor.scope !== 'string') return ''
    if (anchor.scope === 'block') { const b = blocks.get(anchor.blockId); return b ? b.canonicalText : '' }
    const b = Array.from(blocks.values()).find((x) => x.table && x.table.id === anchor.tableId)
    const cell = b && b.table ? b.table.cells.find((x) => x.row === anchor.row && x.col === anchor.column) : undefined
    return cell ? cell.canonicalText : ''
  }
  return { blocks, canonicalOf }
}
export function makeCanonicalResolver(content: string, messageId: string) { return buildBlockMap(content, messageId).canonicalOf }

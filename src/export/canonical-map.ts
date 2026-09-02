import { parseMarkdown } from '../markdown/parse'
import { blockIdOf, blockTypeOf, startOf, endOf, type BlockModel } from '../markdown/block-layer'
import type { Root, Heading, Table, TableCell, TableRow, Literal, Parent } from 'mdast'
import type { Annotation, TextAnnotationTarget } from '../annotations/annotation-types'

/** DOM-compatible canonical atom for inline math (annotations cannot span it, but its 1-unit shift must be preserved so offsets align). */
const MATH_ATOM = '\uFFFF'

export type MarkSegment = { cStart: number; cEnd: number; sStart: number; sEnd: number; markable: boolean; text: string }

/** Walk an inline/block subtree in source order, producing canonical segments and the canonical string.
 *  Canonical counting matches the rendered DOM (text=length, break=1 newline char, inlineMath=1 atom), so
 *  annotation offsets resolve against this canonical identically to the UI. Non-text tokens (break/math) are
 *  emitted as non-markable segments so offsets stay aligned without ever becoming a mark. */
export function walkTree(node: any, segs: MarkSegment[], canon: string[]): void {
  if (node == null) return
  switch (node.type) {
    case 'text': {
      const v = node.value as string
      const st = canon.length
      canon.push(...v.split(''))
      segs.push({ cStart: st, cEnd: st + v.length, sStart: startOf(node), sEnd: endOf(node), markable: true, text: v })
      return
    }
    case 'break': {
      const st = canon.length
      canon.push('\n')
      segs.push({ cStart: st, cEnd: st + 1, sStart: startOf(node), sEnd: endOf(node), markable: false, text: '\n' })
      return
    }
    case 'inlineMath': {
      const st = canon.length
      canon.push(MATH_ATOM)
      segs.push({ cStart: st, cEnd: st + 1, sStart: startOf(node), sEnd: endOf(node), markable: false, text: MATH_ATOM })
      return
    }
    case 'code':
    case 'html': {
      const v = (node as Literal).value || ''
      const st = canon.length
      canon.push(...v.split(''))
      segs.push({ cStart: st, cEnd: st + v.length, sStart: startOf(node), sEnd: endOf(node), markable: true, text: v })
      return
    }
    default: {
      const children = (node as Parent).children
      if (children) for (const c of children) walkTree(c, segs, canon)
      return
    }
  }
}

export type BlockMap = { canonical: string; segs: MarkSegment[] }
/** Build a block's canonical + segment map from an mdast node. */
export function blockMap(node: any): BlockMap {
  const segs: MarkSegment[] = []
  const canon: string[] = []
  walkTree(node, segs, canon)
  return { canonical: canon.join(''), segs }
}

/** Index mdast block nodes by their stable block id. */
export function indexBlocks(root: Root, messageId: string): Map<string, any> {
  const out = new Map<string, any>()
  const visit = (nodes: any[]): void => {
    for (const n of nodes) {
      const t = blockTypeOf(n)
      if (t) out.set(blockIdOf(messageId, t, startOf(n), endOf(n)), n)
      if ((n as any).children && Array.isArray((n as any).children)) visit((n as any).children)
    }
  }
  visit(root.children as any || [])
  return out
}

export function blockCanonical(blocks: Map<string, any>, blockId: string): BlockMap {
  const node = blocks.get(blockId)
  return node ? blockMap(node) : { canonical: '', segs: [] }
}

export function textAnnotationSlice(ann: TextAnnotationTarget, canon: string): string {
  const s = ann.start, e = ann.end
  if (s < 0 || e > canon.length || s >= e) return ''
  return canon.slice(s, e)
}
export interface BackupAnnotationLike { target: { type: string } }

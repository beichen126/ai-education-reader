
import type { StableId } from '../engine/types'

/** Table rectangle bounds. Row/column are frozen: visual first row (header) = row 0, unified 2D coordinate. */
export type TableBounds = { rowStart: number; rowEnd: number; columnStart: number; columnEnd: number }
export type TableCellsAnnotationTarget = { type: 'table-cells'; tableId: string; bounds: TableBounds }
export type TableAnnotationTarget = { type: 'table'; tableId: string }
export type TextAnchor =
  | { scope: 'block'; blockId: string }
  | { scope: 'table-cell'; tableId: string; row: number; column: number }
export type TextAnnotationTarget = {
  type: 'text'
  anchor: TextAnchor
  start: number
  end: number
  quote: { exact: string; prefix: string; suffix: string }
}
export type MathAnnotationTarget = { type: 'math'; mathId: string; mathKind: 'inline' | 'block' }
export type AnnotationTarget = TextAnnotationTarget | TableCellsAnnotationTarget | TableAnnotationTarget | MathAnnotationTarget
export type Annotation = {
  id: StableId
  conversationId: StableId
  messageId: StableId
  target: AnnotationTarget
  createdAt: number
  updatedAt: number
  version: 1
}
export const ANNOTATION_VERSION = 1 as const

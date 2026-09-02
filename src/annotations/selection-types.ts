
export type TextSelectionSegment = {
  messageId: string
  blockId: string
  blockType?: string
  /** Table cell coordinate when the segment is a same-cell selection. */
  cell?: { tableId: string; row: number; column: number }
  start: number
  end: number
  exact: string
  prefix: string
  suffix: string
}
export type SelectionMapping =
  | { kind: 'text'; segments: TextSelectionSegment[] }
  | { kind: 'table-cross-cell'; tableId: string; startCell: { row: number; column: number }; endCell: { row: number; column: number } }
  | { kind: 'math'; mathId: string; mathKind: 'inline' | 'block' }
  | { kind: 'unsupported'; reason: string }
export const ANCHOR_CONTEXT = 32 // UTF-16 code units of fallback prefix/suffix

// Pure display-model helper: turns a list of attachment ids + their metadata into
// UI units (ordinary image | PDF context group). Recomputes groups ONLY from
// Attachment.source — the ids order stays authoritative, groups are formed on
// contiguous runs (never merging across an interruption, never re-sorting).
import type { Attachment, StableId } from '../engine/types'
import { normalizePdfRanges, countPdfRangePages, type PdfRange } from '../pdf/pdf-types'

export type AttachmentDisplayItem =
  | { type: 'image'; attachmentId: StableId }
  | {
      type: 'pdf-group'
      groupId: StableId
      attachmentIds: StableId[]
      fileName: string
      title?: string
      /** Normalized (sorted/deduped/merged) page ranges of this context group. */
      ranges: PdfRange[]
      selectedPageCount: number
      originalPageCount: number
    }

/** Range list of a stored selection — handles both the current multi-range shape
 * and the pre-Stage-9.1 single-range shape found in existing user data. */
export function selectionRanges(selection: NonNullable<Attachment['source']>['selection']): PdfRange[] {
  if ('ranges' in selection) return normalizePdfRanges(selection.ranges)
  return [{ startPage: selection.startPage, endPage: selection.endPage }]
}

export function isPdfPageAttachment(a: Attachment | undefined): a is Attachment & { source: NonNullable<Attachment['source']> } {
  return !!a && a.source?.type === 'pdf-page'
}

export function buildAttachmentDisplayItems(ids: StableId[], metas: Attachment[]): AttachmentDisplayItem[] {
  const byId = new Map<string, Attachment>(metas.map(m => [m.id, m]))
  const out: AttachmentDisplayItem[] = []
  let i = 0
  while (i < ids.length) {
    const id = ids[i]
    const att = byId.get(id)
    if (isPdfPageAttachment(att)) {
      const gid = att.source.groupId
      const run: StableId[] = []
      let j = i
      while (j < ids.length) {
        const a = byId.get(ids[j])
        if (a && a.source?.type === 'pdf-page' && a.source.groupId === gid) { run.push(ids[j]); j++ } else break
      }
      const first = byId.get(run[0])!
      const ranges = selectionRanges(first.source.selection)
      out.push({
        type: 'pdf-group',
        groupId: gid,
        attachmentIds: [...run],
        fileName: first.source.fileName,
        title: first.source.selection.title,
        ranges,
        selectedPageCount: run.length,
        originalPageCount: countPdfRangePages(ranges),
      })
      i = j
    } else {
      out.push({ type: 'image', attachmentId: id })
      i++
    }
  }
  return out
}

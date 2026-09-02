// Pure display-model helper: turns a list of attachment ids + their metadata into
// UI units (ordinary image | PDF context group). Recomputes groups ONLY from
// Attachment.source — the ids order stays authoritative, groups are formed on
// contiguous runs (never merging across an interruption, never re-sorting).
import type { Attachment, StableId } from '../engine/types'

export type AttachmentDisplayItem =
  | { type: 'image'; attachmentId: StableId }
  | {
      type: 'pdf-group'
      groupId: StableId
      attachmentIds: StableId[]
      fileName: string
      title?: string
      startPage: number
      endPage: number
      selectedPageCount: number
      originalPageCount: number
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
      out.push({
        type: 'pdf-group',
        groupId: gid,
        attachmentIds: [...run],
        fileName: first.source.fileName,
        title: first.source.selection.title,
        startPage: first.source.selection.startPage,
        endPage: first.source.selection.endPage,
        selectedPageCount: run.length,
        originalPageCount: first.source.selection.endPage - first.source.selection.startPage + 1,
      })
      i = j
    } else {
      out.push({ type: 'image', attachmentId: id })
      i++
    }
  }
  return out
}

// PDF context group card: one UI unit for one user PDF selection (a chapter or a
// manual page range). Reuses the existing preview hook for page thumbnails.
// readOnly (sent message) => expandable, no delete. Composer => delete group /
// delete a single page.
import { useState } from 'react'
import type { AttachmentDisplayItem } from '../attachments/attachment-display'
import { useAttachmentPreview } from '../engine/use-attachment-preview'
import { IconCloseOutline16 } from '../dsh/primitives'
import { PDF_GROUP_PREVIEW_BATCH } from '../pdf/pdf-types'
import css from './cockpit.module.css'

type GroupItem = Extract<AttachmentDisplayItem, { type: 'pdf-group' }>

export function PdfContextCard({
  item, readOnly, onDelete, onRemovePage,
}: {
  item: GroupItem
  readOnly?: boolean
  onDelete?: () => void
  onRemovePage?: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [shown, setShown] = useState(PDF_GROUP_PREVIEW_BATCH)
  const large = item.attachmentIds.length > 30
  const visibleIds = large ? item.attachmentIds.slice(0, shown) : item.attachmentIds
  const rangeText = item.startPage === item.endPage
    ? 'PDF 第 ' + item.startPage + ' 页'
    : 'PDF ' + item.startPage + '–' + item.endPage
  const countText = item.selectedPageCount === item.originalPageCount
    ? rangeText + ' · ' + item.originalPageCount + ' 页'
    : rangeText + ' · 已加入 ' + item.selectedPageCount + '/' + item.originalPageCount + ' 页'

  return (
    <div className={css.groupCard} data-testid="pdf-group-card">
      <div className={css.groupInfo}>
        <span className={css.groupFileName}>📄 {item.fileName}</span>
        {item.title && <span className={css.groupTitle}>{item.title}</span>}
        <span className={css.groupRange}>{countText}</span>
      </div>
      <div className={css.groupActions}>
        <button
          type="button"
          className={css.groupBtn}
          data-testid={'pdf-group-expand-' + item.groupId}
          aria-expanded={expanded}
          onClick={() => setExpanded(e => { const next = !e; if (!next) setShown(PDF_GROUP_PREVIEW_BATCH); return next })}
        >
          {expanded ? '收起' : '预览页面'}
        </button>
        {!readOnly && onDelete && (
          <button type="button" className={css.groupBtn + ' ' + css.groupDel} data-testid={'pdf-group-delete-' + item.groupId} onClick={onDelete}>删除</button>
        )}
      </div>
      {expanded && (
        <>
        <div className={css.groupPages}>
          {visibleIds.map(id => (
            <GroupPageThumb key={id} id={id} readOnly={readOnly} onRemove={onRemovePage ? () => onRemovePage(id) : undefined} />
          ))}
        </div>
        {large && shown < item.attachmentIds.length && (
          <button type="button" className={css.groupBtn} data-testid="pdf-group-more" onClick={() => setShown(s => Math.min(s + PDF_GROUP_PREVIEW_BATCH, item.attachmentIds.length))}>
            显示更多 {Math.min(PDF_GROUP_PREVIEW_BATCH, item.attachmentIds.length - shown)} 页
          </button>
        )}
        </>
      )}
    </div>
  )
}

function GroupPageThumb({ id, readOnly, onRemove }: { id: string; readOnly?: boolean; onRemove?: () => void }) {
  const { url } = useAttachmentPreview(id)
  return (
    <span className={css.groupPage}>
      {url ? <img src={url} alt="" /> : <span className={css.photoLoading}>…</span>}
      {!readOnly && onRemove && (
        <button className={css.picDel} data-testid={'pdf-page-del-' + id} onClick={onRemove} aria-label="删除这一页"><IconCloseOutline16 size={12} /></button>
      )}
    </span>
  )
}
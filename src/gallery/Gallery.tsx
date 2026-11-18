import { useEffect, useMemo, useState } from 'react'
import { useSessions } from '../engine/sessions-store'
import { useGallery, galleryActions } from './gallery-store'
import { useAttachmentPreview, useLazyAttachmentPreview } from '../engine/use-attachment-preview'
import { ZoomableImageDialog } from './ZoomableImageDialog'
import { AttachmentPageOcr } from '../documents/PdfOcrControls'
import { clampIndex } from './zoom'
import css from './gallery.module.css'
import { tx } from '../engine/locale'
import { useBackTarget } from '../engine/back-navigation'
import { getAttachment } from '../engine/attachment-service'
import { Modal } from '../dsh/primitives'
import { timestamp, type YoutubeTranscript } from '../youtube/transcript'
import { useBranchChat } from '../cockpit/use-branch-chat'
import { branchThreadKey, useDraftImageIds } from '../engine/draft-store'
import { useAttachmentMetas } from '../engine/use-attachment-metas'

export function Gallery() {
  const g = useGallery(x => x)
  useBackTarget(g.open, galleryActions.close, 10)
  const conv = useSessions(s => s.byId[s.current || ''])
  const convId = conv ? conv.id : undefined
  const { effectiveMessages, activeBranchId, ready } = useBranchChat(g.open ? conv : undefined)
  const draftIds = useDraftImageIds(g.open ? activeBranchId ? branchThreadKey(activeBranchId) : convId || '' : '')
  const draftMetas = useAttachmentMetas(draftIds)
  const imageIds = useMemo(() => {
    const sent = effectiveMessages.flatMap(message => message.role === 'user' ? message.images : [])
    const attached = new Set(sent)
    const transcripts = draftMetas.flatMap(attachment => attachment.transcript && !attached.has(attachment.id) ? [attachment.id] : [])
    return [...sent, ...transcripts]
  }, [effectiveMessages, draftMetas])
  useEffect(() => { if (g.open && g.convId !== convId) galleryActions.close() }, [g.open, g.convId, convId])
  if (!g.open) return null
  const count = imageIds.length
  return (
    <div className={css.overlay} data-testid="gallery">
      <div className={css.head}>
        <div className={css.headInner}>
          <div className={css.heading}>
            <span className={css.title}>{tx('图片', 'Images')}</span>
            <span className={css.count} data-testid="gallery-count">{tx('共 ' + count + ' 张', count + ' total')}</span>
          </div>
          <button type="button" className={css.closeBtn} onClick={galleryActions.close}>{tx('关闭', 'Close')}</button>
        </div>
      </div>
      {(conv && !ready) ? <div className={css.empty} role="status">{tx('正在读取图片资料…', 'Loading images…')}</div> :
        count === 0 ? <div className={css.empty}>{tx('当前会话暂无图片资料', 'No images in this chat')}</div> :
        g.view === 'list' ? (
          <div className={css.galleryScroll}>
            <div className={css.grid} data-testid="gallery-grid" aria-label={tx('当前会话图片，共 ' + count + ' 张', count + ' images in this chat')}>
              {imageIds.map((id, i) => <Thumb key={id} id={id} index={i} />)}
            </div>
          </div>
        ) : (
          <GalleryViewer imageIds={imageIds} index={clampIndex(g.index, count)} />
        )}
    </div>
  )
}
function Thumb({ id, index }: { id: string; index: number }) {
  const { ref, url, error } = useLazyAttachmentPreview(id)
  return (
    <button ref={ref} type="button" className={css.thumb} data-testid="gallery-thumbnail" aria-label={tx('查看第 ' + (index + 1) + ' 张图片', 'View image ' + (index + 1))} onClick={() => galleryActions.openViewer(index)}>
      {url ? <img src={url} alt="" loading="lazy" decoding="async" /> : <span className={css.missing}>{error ? tx('图片已丢失', 'Image missing') : '…'}</span>}
      <span className={css.index} aria-hidden="true">{index + 1}</span>
    </button>
  )
}
function GalleryViewer({ imageIds, index }: { imageIds: string[]; index: number }) {
  const id = imageIds[index]
  const { url } = useAttachmentPreview(id)
  const count = imageIds.length
  return (
    <ZoomableImageDialog
      src={url}
      alt=""
      resetKey={id}
      index={index}
      count={count}
      onPrev={() => galleryActions.goto(clampIndex(index - 1, count))}
      onNext={() => galleryActions.goto(clampIndex(index + 1, count))}
      onBackToList={galleryActions.showList}
      onClose={galleryActions.close}
      headerAction={<GalleryAttachmentAction key={id} id={id} />}
      labels={{ close: tx('关闭', 'Close'), prev: tx('上一张', 'Previous'), next: tx('下一张', 'Next'), backToList: tx('返回列表', 'Back to list'), dialog: tx('图片大图查看', 'Image viewer') }}
    />
  )
}

function GalleryAttachmentAction({ id }: { id: string }) {
  const [attachment, setAttachment] = useState<Awaited<ReturnType<typeof getAttachment>>>()
  useEffect(() => {
    let active = true
    void getAttachment(id).then(value => { if (active) setAttachment(value) }).catch(() => {})
    return () => { active = false }
  }, [id])
  if (attachment?.transcript) return <TranscriptButton transcript={attachment.transcript} />
  return attachment?.source ? <AttachmentPageOcr attachmentId={id} /> : null
}

function TranscriptButton({ transcript }: { transcript: YoutubeTranscript }) {
  const [open, setOpen] = useState(false)
  const text = useMemo(() => open ? transcript.segments.map(segment => '[' + timestamp(segment.start) + '] ' + segment.text).join('\n') : '', [open, transcript])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
      else if (!['ArrowLeft', 'ArrowRight', '+', '-', '='].includes(event.key)) return
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
  return <>
    <button type="button" className={css.transcriptButton} onClick={() => setOpen(true)}>{tx('查看转写稿', 'View transcript')}</button>
    {open && <Modal open onClose={() => setOpen(false)} title={tx('YouTube 转写稿', 'YouTube transcript')} closeLabel={tx('关闭', 'Close')} className={css.transcriptDialog} rootClassName={css.transcriptOverlay}>
      <p className={css.transcriptTitle}>{transcript.title}</p>
      <textarea autoFocus readOnly className={css.transcriptText} aria-label={tx('带时间戳的字幕', 'Timestamped transcript')} value={text} />
    </Modal>}
  </>
}

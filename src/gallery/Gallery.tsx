import { useEffect, useMemo } from 'react'
import { useSessions } from '../engine/sessions-store'
import { useGallery, galleryActions } from './gallery-store'
import { useAttachmentPreview } from '../engine/use-attachment-preview'
import { ZoomableImageDialog } from './ZoomableImageDialog'
import { clampIndex } from './zoom'
import css from './gallery.module.css'
import { tx } from '../engine/locale'

export function Gallery() {
  const g = useGallery(x => x)
  const conv = useSessions(s => s.byId[s.current || ''])
  const convId = conv ? conv.id : undefined
  const imageIds = useMemo(() => { if (!conv) return []; const out: string[] = []; for (const m of conv.messages) if (m.role === 'user') for (const img of m.images) out.push(img); return out }, [conv])
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
      {count === 0 ? <div className={css.empty}>{tx('当前会话暂无图片资料', 'No images in this chat')}</div> :
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
  const { url, error } = useAttachmentPreview(id)
  return (
    <button type="button" className={css.thumb} data-testid="gallery-thumbnail" aria-label={tx('查看第 ' + (index + 1) + ' 张图片', 'View image ' + (index + 1))} onClick={() => galleryActions.openViewer(index)}>
      {url ? <img src={url} alt="" /> : <span className={css.missing}>{error ? tx('图片已丢失', 'Image missing') : '…'}</span>}
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
      labels={{ close: tx('关闭', 'Close'), prev: tx('上一张', 'Previous'), next: tx('下一张', 'Next'), backToList: tx('返回列表', 'Back to list'), dialog: tx('图片大图查看', 'Image viewer') }}
    />
  )
}

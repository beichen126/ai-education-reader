import { useEffect, useMemo } from 'react'
import { useSessions } from '../engine/sessions-store'
import { useGallery, galleryActions } from './gallery-store'
import { useAttachmentPreview } from '../engine/use-attachment-preview'
import { ZoomableImageDialog } from './ZoomableImageDialog'
import { clampIndex } from './zoom'
import css from './gallery.module.css'

export function Gallery() {
  const g = useGallery(x => x)
  const conv = useSessions(s => s.byId[s.current || ''])
  const convId = conv ? conv.id : undefined
  const imageIds = useMemo(() => { if (!conv) return []; const out: string[] = []; for (const m of conv.messages) if (m.role === 'user') for (const img of m.images) out.push(img); return out }, [conv])
  useEffect(() => { if (g.open && g.convId !== convId) galleryActions.close() }, [g.open, g.convId, convId])
  if (!g.open) return null
  const count = imageIds.length
  return (
    <div className={css.overlay}>
      <div className={css.head}><span className={css.title}>图片</span><button className={css.closeBtn} onClick={galleryActions.close}>关闭</button></div>
      {count === 0 ? <div className={css.empty}>当前会话暂无图片资料</div> :
        g.view === 'list' ? (
          <div className={css.grid}>{imageIds.map((id, i) => <Thumb key={id} id={id} index={i} />)}</div>
        ) : (
          <GalleryViewer imageIds={imageIds} index={clampIndex(g.index, count)} />
        )}
    </div>
  )
}
function Thumb({ id, index }: { id: string; index: number }) {
  const { url, error } = useAttachmentPreview(id)
  return <button className={css.thumb} onClick={() => galleryActions.openViewer(index)}>{url ? <img src={url} alt="" /> : <span className={css.missing}>{error ? '图片已丢失' : '…'}</span>}</button>
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
      labels={{ close: '关闭', prev: '上一张', next: '下一张', backToList: '返回列表', dialog: '图片大图查看' }}
    />
  )
}
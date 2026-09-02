import { useEffect, useMemo } from 'react'
import { useSessions } from '../engine/sessions-store'
import { useGallery, galleryActions } from './gallery-store'
import { useAttachmentPreview } from '../engine/use-attachment-preview'
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
      <div className={css.head}><span className={css.title}>资料</span><button className={css.closeBtn} onClick={galleryActions.close}>关闭</button></div>
      {count === 0 ? <div className={css.empty}>当前会话暂无图片资料</div> :
        g.view === 'list' ? (
          <div className={css.grid}>{imageIds.map((id, i) => <Thumb key={id} id={id} index={i} />)}</div>
        ) : (
          <div className={css.viewer}>
            <div className={css.stage}><ImageViewer id={imageIds[g.index]} /></div>
            <div className={css.controls}>
              <button className={css.ctrl} disabled={g.index <= 0} onClick={() => galleryActions.goto(g.index - 1)}>上一张</button>
              <span className={css.counter}>{g.index + 1} / {count}</span>
              <button className={css.ctrl} disabled={g.index >= count - 1} onClick={() => galleryActions.goto(g.index + 1)}>下一张</button>
              <button className={css.ctrl} onClick={galleryActions.showList}>返回列表</button>
              <button className={css.ctrl} onClick={galleryActions.close}>关闭</button>
            </div>
          </div>
        )}
    </div>
  )
}
function Thumb({ id, index }: { id: string; index: number }) {
  const { url, error } = useAttachmentPreview(id)
  return <button className={css.thumb} onClick={() => galleryActions.openViewer(index)}>{url ? <img src={url} alt="" /> : <span className={css.missing}>{error ? '图片已丢失' : '…'}</span>}</button>
}
function ImageViewer({ id }: { id: string | undefined }) {
  const { url, error } = useAttachmentPreview(id || '')
  if (!id) return <div className={css.missing}>无法读取这张图片</div>
  if (error) return <div className={css.missing}>无法读取这张图片</div>
  return <div className={css.stageImg}>{url ? <img src={url} alt="" /> : <div className={css.missing}>…</div>}</div>
}

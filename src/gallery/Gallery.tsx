import { useProjects, updateProject } from '../projects/project-store'
import { ProjectMaterialImport } from '../projects/ProjectMaterialImport'
import { replaceDraftImageSelection } from '../engine/draft-store'
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
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
import { timestamp, type YoutubeTranscript } from '../youtube/transcript'
import { useBranchChat } from '../cockpit/use-branch-chat'
import { branchThreadKey, useDraftImageIds } from '../engine/draft-store'
import { useAttachmentMetas } from '../engine/use-attachment-metas'

export function Gallery() {
  const g = useGallery(x => x)
  useBackTarget(g.open, galleryActions.close, 10)
  const conv = useSessions(s => s.byId[s.current || ''])
  const projects = useProjects()
  const project = projects.find(item => item.id === g.projectId)
  const ownedChat = !!project && conv?.projectId === project.id
  const [projectError, setProjectError] = useState('')
  const [selection, setSelection] = useState<Set<string> | null>(null)
  const [continuous, setContinuous] = useState(false)
  const anchor = useRef<string>()
  const drag = useRef<{ id: string; pointerId: number; before: Set<string>; last: string; moved: boolean }>()
  const suppressClick = useRef(false)
  const convId = conv ? conv.id : undefined
  const { effectiveMessages, activeBranchId, ready } = useBranchChat(g.open ? conv : undefined)
  const draftKey = activeBranchId ? branchThreadKey(activeBranchId) : convId ?? ''
  const draftIds = useDraftImageIds(g.open ? draftKey : '')
  const sent = useMemo(() => [...new Set(effectiveMessages.flatMap(message => message.role === 'user' ? message.images : []))], [effectiveMessages])
  const sharedIds = project?.attachmentIds
  const showChat = !project || (ownedChat && ready)
  const attachmentIds = useMemo(() => [...new Set([...(sharedIds ?? []), ...(showChat ? [...sent, ...draftIds] : [])])], [sharedIds, showChat, sent, draftIds])
  const metas = useAttachmentMetas(attachmentIds)
  const transcriptById = new Map(metas.flatMap(meta => meta.transcript ? [[meta.id, meta.transcript] as const] : []))
  const metaById = new Map(metas.map(meta => [meta.id, meta]))
  const shared = new Set(sharedIds)
  const imageIds = (project ? attachmentIds : sent).filter(id => !transcriptById.has(id))
  const projectImageIds = imageIds.filter(id => shared.has(id))
  const conversationImageIds = imageIds.filter(id => !shared.has(id))
  function endSelection() {
    setSelection(null)
    setContinuous(false)
    anchor.current = undefined
    drag.current = undefined
    suppressClick.current = false
  }
  function selectRange(from: string, to: string, before: Set<string>, remove = false) {
    const start = projectImageIds.indexOf(from), end = projectImageIds.indexOf(to)
    if (start < 0 || end < 0) return
    const next = new Set(before)
    for (const id of projectImageIds.slice(Math.min(start, end), Math.max(start, end) + 1)) {
      if (remove) next.delete(id)
      else next.add(id)
    }
    setSelection(next)
  }
  function selectItem(id: string) {
    if (!selection) return
    if (suppressClick.current) { suppressClick.current = false; return }
    if (continuous && anchor.current && projectImageIds.includes(id)) {
      selectRange(anchor.current, id, selection)
      anchor.current = undefined
      return
    }
    if (continuous && projectImageIds.includes(id)) anchor.current = id
    const next = new Set(selection)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelection(next)
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>, id: string) {
    suppressClick.current = false
    if (!continuous || !selection || !event.isPrimary || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id, pointerId: event.pointerId, before: selection, last: id, moved: false }
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const gesture = drag.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-project-material]')?.dataset.projectMaterial
    if (!target || target === gesture.last || !projectImageIds.includes(target)) return
    gesture.last = target
    gesture.moved = true
    anchor.current = undefined
    selectRange(gesture.id, target, gesture.before, gesture.before.has(gesture.id))
  }
  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return
    suppressClick.current = drag.current.moved && event.type === 'pointerup'
    drag.current = undefined
  }
  function applySelection() {
    if (!ownedChat || !draftKey || !ready || !sharedIds || !selection) return
    replaceDraftImageSelection(draftKey, sharedIds, sharedIds.filter(id => selection.has(id) && metaById.has(id)))
    endSelection()
  }
  const unpin = (id: string) => {
    if (!project) return
    setProjectError('')
    void updateProject(project.id, current => ({ ...current, attachmentIds: current.attachmentIds.filter(item => item !== id) }))
      .catch(() => setProjectError(tx('无法移出项目资料。', 'Could not remove project material.')))
  }
  const removeAction = (id: string) => !selection && (
    <button type="button" className={css.closeBtn + ' ' + css.unpinMaterial} aria-label={tx('移出项目', 'Remove from project')} title={tx('移出项目', 'Remove from project')} onClick={() => unpin(id)}>×</button>
  )
  const renderProjectImage = (id: string) => {
    const meta = metaById.get(id)
    const source = meta?.source
    const chapter = source?.selection.kind === 'outline' ? source.selection.title : undefined
    const name = chapter || source?.fileName || meta?.name
    const chosen = selection ? selection.has(id) : draftIds.includes(id)
    const label = source ? tx('第 ' + source.pageNumber + ' 页', 'Page ' + source.pageNumber) : name || tx('正在读取资料…', 'Loading material…')
    return <article key={id} className={css.projectCard} data-project-material={id} data-selected={chosen || undefined} data-used={sent.includes(id) || undefined}>
    <Thumb id={id} index={imageIds.indexOf(id)} showIndex={false}
      selection={selection ? { label, chosen, continuous, onClick: () => selectItem(id), onPointerDown: event => startDrag(event, id), onPointerMove: moveDrag, onPointerUp: finishDrag, onPointerCancel: finishDrag } : undefined} />
    <div className={css.materialDetails}>
      <div className={css.materialCaption}>
        <strong className={css.materialName} title={source?.fileName ?? name}>{label}</strong>
        {source && name && <span className={css.materialSource} title={source.fileName}>{name}</span>}
        <div className={css.projectCardMeta}>
          {meta?.ocr && <small>{tx('含 OCR', 'OCR available')}</small>}
          {!selection && (chosen ? <small>{tx('本次已选', 'Selected for this question')}</small> : sent.includes(id) && <small>{tx('本会话已用', 'Used in this chat')}</small>)}
        </div>
      </div>
      {removeAction(id)}
    </div>
  </article>
  }
  const transcripts = attachmentIds.flatMap(id => {
    const transcript = transcriptById.get(id)
    return transcript ? [{ id, transcript }] : []
  })
  useEffect(() => { if (g.open && g.convId !== convId) galleryActions.close() }, [g.open, g.convId, convId])
  useEffect(() => setProjectError(''), [g.open, project?.id])
  useEffect(endSelection, [g.open, project?.id, draftKey])
  if (!g.open || g.convId !== convId) return null
  const count = imageIds.length
  return (
    <div className={css.overlay} data-testid="gallery">
      <div className={css.head}>
        <div className={css.headInner}>
          <div className={css.heading}>
            <span className={css.title}>{transcripts.length ? count ? tx('图片与转写稿', 'Images and transcripts') : tx('转写稿', 'Transcripts') : tx('图片', 'Images')}</span>
            {count > 0 && <span className={css.count} data-testid="gallery-count">{tx('共 ' + count + ' 张', count + ' total')}</span>}
          </div>
          <button type="button" className={css.closeBtn} onClick={galleryActions.close}>{tx('关闭', 'Close')}</button>
        </div>
        {project && g.view === 'list' && (selection || (ownedChat && ready && !!sharedIds?.length)) && (
          <div className={css.selectionBar}>
            {selection ? <>
              <span role="status">{tx('已选 ', 'Selected ')}{selection.size}</span>
              <button type="button" className={css.closeBtn} aria-pressed={continuous} onClick={() => { anchor.current = undefined; setContinuous(value => !value) }}>{tx('连续选择', 'Continuous selection')}</button>
              <button type="button" className={css.closeBtn} onClick={endSelection}>{tx('取消', 'Cancel')}</button>
              <button type="button" className={css.selectionApply} onClick={applySelection}>{tx('加入本次提问', 'Add to this question')}</button>
            </> : <button type="button" className={css.closeBtn} onClick={() => setSelection(new Set(draftIds.filter(id => shared.has(id))))}>{tx('选择资料', 'Select materials')}</button>}
          </div>
        )}
      </div>
      {(!project && conv && !ready) ? <div className={css.empty} role="status">{tx('正在读取图片资料…', 'Loading images…')}</div> :
        !project && count === 0 && !transcripts.length ? <div className={css.empty}>{tx('当前会话暂无图片或转写稿', 'No images or transcripts in this chat')}</div> :
        g.view === 'list' || !count ? (
          <div className={css.galleryScroll}>
            {project && <section aria-label={tx('项目资料', 'Project materials')}>
              <div className={css.projectSectionHeader}>
                <h2>{project.name} · {tx('项目资料', 'Project materials')}</h2>
                <p>{tx('选中的资料才会加入这次提问。', 'Only selected materials are added to the current question.')}</p>
                {project.archivedAt === undefined && <div hidden={!!selection}><ProjectMaterialImport key={project.id} projectId={project.id} projectName={project.name} /></div>}
                {projectError && <p role="alert">{projectError}</p>}
              </div>
              {projectImageIds.length > 0 && <div className={css.grid}>{projectImageIds.map(renderProjectImage)}</div>}
              {transcripts.some(item => shared.has(item.id)) && <div className={css.transcriptList}>
                {transcripts.filter(item => shared.has(item.id)).map(({ id, transcript }) => <div className={css.projectCard} key={id} data-project-material={id} data-selected={draftIds.includes(id) || undefined} data-used={sent.includes(id) || undefined}>
                  {selection && <label className={css.transcriptSelect}><input type="checkbox" checked={selection.has(id)} onChange={() => selectItem(id)} />{tx('选择转写稿', 'Select transcript')}</label>}
                  <TranscriptCard transcript={transcript} />
                  {!selection && <div className={css.projectCardActions}>{removeAction(id)}</div>}
                </div>)}
              </div>}
            </section>}
            {project && (conversationImageIds.length > 0 || transcripts.some(item => !shared.has(item.id))) && <h2 className={css.projectSectionHeader}>{tx('本会话附件', 'Chat attachments')}</h2>}
            {transcripts.some(item => !shared.has(item.id)) && <div className={css.transcriptList}>{transcripts.filter(item => !shared.has(item.id)).map(({ id, transcript }) => <TranscriptCard key={id} transcript={transcript} />)}</div>}
            {conversationImageIds.length > 0 && <div className={css.grid} data-testid="gallery-grid" aria-label={tx('当前会话图片，共 ' + count + ' 张', count + ' images in this chat')}>
              {conversationImageIds.map(id => <Thumb key={id} id={id} index={imageIds.indexOf(id)} />)}
            </div>}
          </div>
        ) : (
          <GalleryViewer imageIds={imageIds} index={clampIndex(g.attachmentId ? imageIds.indexOf(g.attachmentId) : g.index, count)} />
        )}
    </div>
  )
}
type ThumbnailSelection = {
  label: string; chosen: boolean; continuous: boolean; onClick: () => void
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void
}
function Thumb({ id, index, showIndex = true, selection }: { id: string; index: number; showIndex?: boolean; selection?: ThumbnailSelection }) {
  const { ref, url, error } = useLazyAttachmentPreview(id)
  return (
    <button ref={ref} type="button" className={css.thumb} data-testid="gallery-thumbnail" data-continuous={selection?.continuous || undefined} aria-pressed={selection?.chosen}
      aria-label={selection ? tx('选择 ', 'Select ') + selection.label : tx('查看第 ' + (index + 1) + ' 张图片', 'View image ' + (index + 1))}
      onClick={selection?.onClick ?? (() => galleryActions.openViewer(index))} onPointerDown={selection?.onPointerDown} onPointerMove={selection?.onPointerMove} onPointerUp={selection?.onPointerUp} onPointerCancel={selection?.onPointerCancel}>
      {url ? <img src={url} alt="" loading="lazy" decoding="async" draggable={false} /> : <span className={css.missing}>{error ? tx('图片已丢失', 'Image missing') : '…'}</span>}
      {selection && <span className={css.selectionMark} aria-hidden="true">{selection.chosen ? '✓' : ''}</span>}
      {showIndex && <span className={css.index} aria-hidden="true">{index + 1}</span>}
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
  return attachment?.source ? <AttachmentPageOcr attachmentId={id} /> : null
}

function TranscriptCard({ transcript }: { transcript: YoutubeTranscript }) {
  const text = useMemo(() => transcript.segments.map(segment => '[' + timestamp(segment.start) + '] ' + segment.text).join('\n'), [transcript])
  return <article className={css.transcriptCard}>
    <h3 className={css.transcriptTitle}>{transcript.title}</h3>
    <pre className={css.transcriptText} aria-label={tx('带时间戳的字幕', 'Timestamped transcript')}>{text}</pre>
  </article>
}

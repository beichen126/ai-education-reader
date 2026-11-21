import { useProjects, updateProject } from '../projects/project-store'
import { ProjectMaterialImport } from '../projects/ProjectMaterialImport'
import { addDraftImages, removeDraftImage } from '../engine/draft-store'
import type { Attachment } from '../engine/types'
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
import { timestamp, type YoutubeTranscript } from '../youtube/transcript'
import { useBranchChat } from '../cockpit/use-branch-chat'
import { branchThreadKey, useDraftImageIds } from '../engine/draft-store'
import { useAttachmentMetas } from '../engine/use-attachment-metas'

export function Gallery() {
  const g = useGallery(x => x)
  useBackTarget(g.open, galleryActions.close, 10)
  const conv = useSessions(s => s.byId[s.current || ''])
  const projects = useProjects()
  const project = projects.find(item => item.id === (g.projectId || conv?.projectId))
  const ownedChat = !!project && conv?.projectId === project.id
  const [projectError, setProjectError] = useState('')
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
  const toggleUse = (id: string) => {
    if (!ownedChat || !draftKey || !ready || !metaById.has(id)) return
    if (draftIds.includes(id)) removeDraftImage(draftKey, id)
    else addDraftImages(draftKey, [id])
  }
  const unpin = (id: string) => {
    if (!project) return
    setProjectError('')
    void updateProject(project.id, current => ({ ...current, attachmentIds: current.attachmentIds.filter(item => item !== id) }))
      .catch(() => setProjectError(tx('无法移出项目资料。', 'Could not remove project material.')))
  }
  const projectActions = (id: string) => <div className={css.projectCardActions}>
    {ownedChat && <button type="button" className={css.closeBtn} aria-pressed={draftIds.includes(id)} disabled={!ready || !metaById.has(id)} onClick={() => toggleUse(id)}>
      {draftIds.includes(id) ? tx('取消本次选择', 'Remove from this draft') : tx('用于本次提问', 'Use in this question')}
    </button>}
    <button type="button" className={css.closeBtn + ' ' + css.unpinMaterial} aria-label={tx('移出项目', 'Remove from project')} title={tx('移出项目', 'Remove from project')} onClick={() => unpin(id)}>×</button>
  </div>
  const renderProjectImage = (id: string) => <article key={id} className={css.projectCard} data-project-material={id} data-selected={draftIds.includes(id) || undefined} data-used={sent.includes(id) || undefined}>
    <Thumb id={id} index={imageIds.indexOf(id)} showIndex={false} />
    <strong>{materialName(metaById.get(id))}</strong>
    <div className={css.projectCardMeta}>
      {metaById.get(id)?.ocr && <small>{tx('含 OCR', 'OCR available')}</small>}
      {draftIds.includes(id) ? <small>{tx('本次已选', 'Selected for this question')}</small> : sent.includes(id) && <small>{tx('本会话已用', 'Used in this chat')}</small>}
    </div>
    {projectActions(id)}
  </article>
  const transcripts = attachmentIds.flatMap(id => {
    const transcript = transcriptById.get(id)
    return transcript ? [{ id, transcript }] : []
  })
  useEffect(() => { if (g.open && g.convId !== convId) galleryActions.close() }, [g.open, g.convId, convId])
  useEffect(() => setProjectError(''), [g.open, project?.id])
  if (!g.open) return null
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
      </div>
      {(!project && conv && !ready) ? <div className={css.empty} role="status">{tx('正在读取图片资料…', 'Loading images…')}</div> :
        !project && count === 0 && !transcripts.length ? <div className={css.empty}>{tx('当前会话暂无图片或转写稿', 'No images or transcripts in this chat')}</div> :
        g.view === 'list' || !count ? (
          <div className={css.galleryScroll}>
            {project && <section aria-label={tx('项目资料', 'Project materials')}>
              <div className={css.projectSectionHeader}>
                <h2>{project.name} · {tx('项目资料', 'Project materials')}</h2>
                <p>{tx('选中的资料才会加入这次提问。', 'Only selected materials are added to the current question.')}</p>
                {project.archivedAt === undefined && <ProjectMaterialImport key={project.id} projectId={project.id} />}
                {projectError && <p role="alert">{projectError}</p>}
              </div>
              {projectImageIds.length > 0 && <div className={css.grid}>{projectImageIds.map(renderProjectImage)}</div>}
              {transcripts.some(item => shared.has(item.id)) && <div className={css.transcriptList}>
                {transcripts.filter(item => shared.has(item.id)).map(({ id, transcript }) => <div className={css.projectCard} key={id} data-project-material={id} data-selected={draftIds.includes(id) || undefined} data-used={sent.includes(id) || undefined}>
                  <TranscriptCard transcript={transcript} />{projectActions(id)}
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
          <GalleryViewer imageIds={imageIds} index={clampIndex(g.index, count)} />
        )}
    </div>
  )
}
function materialName(meta?: Attachment): string {
  if (!meta?.source) return meta?.name ?? tx('正在读取资料…', 'Loading material…')
  const { fileName, pageNumber, selection } = meta.source
  return [fileName, selection.kind === 'outline' ? selection.title : '', tx('第 ' + pageNumber + ' 页', 'Page ' + pageNumber)].filter(Boolean).join(' · ')
}

function Thumb({ id, index, showIndex = true }: { id: string; index: number; showIndex?: boolean }) {
  const { ref, url, error } = useLazyAttachmentPreview(id)
  return (
    <button ref={ref} type="button" className={css.thumb} data-testid="gallery-thumbnail" aria-label={tx('查看第 ' + (index + 1) + ' 张图片', 'View image ' + (index + 1))} onClick={() => galleryActions.openViewer(index)}>
      {url ? <img src={url} alt="" loading="lazy" decoding="async" /> : <span className={css.missing}>{error ? tx('图片已丢失', 'Image missing') : '…'}</span>}
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

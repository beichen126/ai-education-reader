
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useSessions, sessionsActions } from '../engine/sessions-store'
import { useSettings } from '../engine/settings-store'
import { uiActions, useUi } from '../engine/ui-store'
import { saveImagesAndDraft, saveGeneratedImages, saveGeneratedImagesAndBranchDraft, deleteAttachment, attachmentErrorLabel, sumAttachmentBytes, wouldExceedInlineBudget } from '../engine/attachment-service'
import { useDraft, getDraft, setDraftText, addDraftImages, removeDraftImage, clearDraftMemory, updateDraftMemory } from '../engine/draft-store'
import { useAttachmentPreview } from '../engine/use-attachment-preview'
import { t } from '../engine/locale'
import { MessageText, IconCloseOutline16, Button } from '../dsh/primitives'
import { ZoomableImageDialog } from '../gallery/ZoomableImageDialog'
import { AnnotatedMarkdown } from '../annotations/AnnotatedMarkdown'
import { galleryActions } from '../gallery/gallery-store'
import { PdfPanel } from '../pdf/PdfPanel'
import { addPdfContextToDraft } from '../pdf/pdf-context-draft'
import { pdfPageAttachmentName, type PdfAddPayload, type PdfAddResult, type RenderedPdfPage } from '../pdf/pdf-types'
import { newStableId } from '../engine/types'
import { useAttachmentMetas } from '../engine/use-attachment-metas'
import { IconPhoto16 } from './composer-icons'
import { setComposerTriggers, triggerComposerImages, triggerComposerPdf } from '../engine/composer-triggers'
import { DocumentContextPicker } from '../documents/DocumentContextPicker'
import { executeDocumentContext } from '../documents/document-context-service'
import { getSessionsCurrent } from '../engine/sessions-store'
import type { PdfSelection } from '../pdf/pdf-types'
import { buildAttachmentDisplayItems, type AttachmentDisplayItem } from '../attachments/attachment-display'
import { PdfContextCard } from './PdfContextCard'
import { BranchBar } from '../branches/BranchBar'
import { BranchMenu } from '../branches/BranchMenu'
import { ArtifactCreateDialog } from '../artifacts/ArtifactCreateDialog'
import { ArtifactLibrary } from '../artifacts/ArtifactLibrary'
import { ArtifactEditor } from '../artifacts/ArtifactEditor'
import { QuizViewer } from '../artifacts/QuizViewer'
import { createArtifactDraft, removeArtifact, isArtifactSourceLive } from '../artifacts/artifact-service'
import { getArtifact, listArtifacts } from '../artifacts/artifact-store'
import { generateArtifact, ArtifactGenerationError } from '../artifacts/artifact-generation'
import { exportQuizJson, exportQuizMarkdown } from '../artifacts/artifact-export'
import { runBranchReply } from '../engine/branch-thread'
import { branchThreadKey, getBranchDraft, setBranchDraftText, addBranchDraftImages, removeBranchDraftImage, clearBranchDraftMemory } from '../engine/draft-store'
import { useBranchChat } from './use-branch-chat'
import { sendTextChat } from '../api/deepseek'
import type { ArtifactKind, StudyArtifact, QuizDocument } from '../artifacts/artifact-types'
import type { Message as TMessage } from '../engine/types'
import css from './cockpit.module.css'

export function Conversation() {
  const session = useSessions(s => s.byId[s.current || ''])
  const status = useSessions(s => s.status)
  const sendError = useSessions(s => s.sendError)
  const hasKey = useSettings(s => !!s.apiKey)
  const listRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const onScroll = () => { const el = listRef.current; if (!el) return; atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 60 }
  const branchChat = useBranchChat(session)
  const messages = branchChat.effectiveMessages
  const imageOffsetByMsg: Record<string, number> = {}
  { let off = 0; for (const m of messages) { if (m.role === 'user') { imageOffsetByMsg[m.id] = off; off += m.images.length } } }
  const lastMsg = messages[messages.length - 1]
  const sig = messages.length + '|' + (lastMsg ? lastMsg.content : '')
  const lastRef = useRef('')
  useEffect(() => {
    const el = listRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
    lastRef.current = sig
  }, [sig])
  const streaming = status === 'streaming'
  const busy = status === 'sending' || status === 'streaming'
  const lastMsg0 = lastMsg
  const activeStreamingId = busy && lastMsg0 && lastMsg0.role === 'assistant' ? lastMsg0.id : undefined
  const [menuMsgId, setMenuMsgId] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ kind: ArtifactKind; messageId: string } | null>(null)
  const [creatingBusy, setCreatingBusy] = useState(false)
  const [creatingError, setCreatingError] = useState<string | undefined>(undefined)
  const [artView, setArtView] = useState<'library' | null>(null)
  const [openArtifact, setOpenArtifact] = useState<StudyArtifact | null>(null)
  const [libArtifacts, setLibArtifacts] = useState<StudyArtifact[]>([])
  const hasBranches = branchChat.branches.length > 0
  const activeThread = session ? (branchChat.activeBranchId ? { type: 'branch' as const, conversationId: session.id, branchId: branchChat.activeBranchId } : { type: 'root' as const, conversationId: session.id }) : undefined
  async function onCreateArtifact(input: { kind: ArtifactKind; prompt: string; presetId?: string }) {
    if (!session || !creating || creatingBusy) return
    setCreatingBusy(true); setCreatingError(undefined)
    let draftId: string | undefined
    try {
      const a = await createArtifactDraft({ kind: input.kind, conversationId: session.id, branchId: branchChat.activeBranchId, throughMessageId: creating.messageId, prompt: input.prompt, presetId: input.presetId })
      draftId = a.id
      const out = await generateArtifact(a.id, { call: artifactModelCall })
      setCreating(null); setOpenArtifact(out); void branchChat.refresh()
    } catch (e) {
      // A2: never swallow generation errors. The dialog stays open and shows the error.
      setCreatingError(e instanceof ArtifactGenerationError ? e.message : '生成失败：' + String((e as any)?.message ?? e))
      // A1: if the fresh draft was never claimed (busy / pre-flight failure), don't leak it.
      if (draftId) {
        const cur = await getArtifact(draftId)
        if (cur && cur.status === 'draft') await removeArtifact(draftId).catch(() => undefined)
      }
    } finally {
      setCreatingBusy(false)
    }
  }
  function openLibrary() { void listArtifacts().then(setLibArtifacts); setArtView('library') }
  return (
    <div className={css.conversation}>
      {!hasKey && (
        <div className={css.noKeyBanner}>
          <span>本项目使用 BYOK，需要配置你自己的 API Key 才能调用模型。</span>
          <button className={css.noKeyBtn} onClick={uiActions.openSettings}>打开设置</button>
          <a className={css.noKeyLink} href="https://platform.deepseek.com/" target="_blank" rel="noopener noreferrer">获取 DeepSeek API Key</a>
        </div>
      )}
      {busy && (
        <div className={css.sendingBar}>
          <span>{streaming ? '正在生成…' : '正在发送…'}</span>
          {streaming && <button className={css.stopBtn} onClick={sessionsActions.stopGenerating}>停止生成</button>}
        </div>
      )}
      {sendError && !busy && <div className={css.errorBanner}>{sendError}</div>}
      {hasBranches && (<BranchBar conversationId={session?.id} activeBranchId={branchChat.activeBranchId} onSwitch={(id) => { void branchChat.switchBranch(id); setMenuMsgId(null) }} onChanged={() => void branchChat.refresh()} />)}
      {/* Composer sits inside the scroll body, position:sticky bottom:0 (as in DSH), so the
          mobile browser's native focus scroll lifts it above the on-screen keyboard. */}
      <div className={css.messages} ref={listRef} onScroll={onScroll}>
        <div className={css.messagesInner}>
          {!session || messages.length === 0 ? (
            <div className={css.emptyHero}>
              <div className={css.emptyTitle}>AI 学习阅读器</div>
              <div className={css.emptyHint}>还没有学习内容。上传一张图片，或者打开一份 PDF 开始。</div>
              <div className={css.emptyActions}>
                <Button variant="primary" data-testid="empty-add-image" onClick={triggerComposerImages}>添加图片</Button>
                <Button variant="outline" data-testid="empty-open-pdf" onClick={triggerComposerPdf}>打开 PDF</Button>
                {!hasKey && <Button variant="outline" data-testid="empty-configure" onClick={uiActions.openSettings}>配置 API</Button>}
              </div>
              {!hasKey && <div className={css.emptyHint}>开始前，需要配置你自己的 DeepSeek API Key。</div>}
            </div>
          ) : messages.map(m => <MessageRow key={m.id} m={m} streamingId={activeStreamingId} convId={session?.id} imgOffset={imageOffsetByMsg[m.id] || 0} menuOpen={menuMsgId === m.id} onToggleMenu={(open) => setMenuMsgId(open ? m.id : null)} onBranch={(mid) => { void branchChat.branchFrom(mid) }} onArtifact={(kind, mid) => { setCreatingError(undefined); setCreating({ kind, messageId: mid }) }} />)}
        </div>
        <div style={{ padding: '0.25rem 0.75rem', display: 'flex', gap: '0.5rem' }}><Button size="sm" variant="ghost" onClick={openLibrary}>学习成果</Button></div>
        <Composer sessionId={session?.id} busy={busy} thread={activeThread} onBranchSent={() => void branchChat.refresh()} />
      </div>
      {creating && (<div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '12px', padding: '1rem', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}><ArtifactCreateDialog sourceLabel={creatingSourceLabel(session, branchChat.activeBranchId, creating.messageId)} initialKind={creating.kind} busy={creatingBusy} error={creatingError} onSubmit={(i) => void onCreateArtifact(i)} onCancel={() => setCreating(null)} /></div></div>)}
      {artView === 'library' && <ArtifactLibraryOverlay artifacts={libArtifacts} onOpen={(a) => { setOpenArtifact(a); setArtView(null) }} onClose={() => setArtView(null)} />}
      {openArtifact && <ArtifactViewerOverlay artifact={openArtifact} onOpen={setOpenArtifact} onClose={() => setOpenArtifact(null)} onChanged={() => void branchChat.refresh()} />}
    </div>
  )
}

function MessageRow({ m, streamingId, convId, imgOffset, menuOpen, onToggleMenu, onBranch, onArtifact }: { m: any; streamingId?: string; convId?: string; imgOffset: number; menuOpen?: boolean; onToggleMenu?: (open: boolean) => void; onBranch?: (messageId: string) => void; onArtifact?: (kind: ArtifactKind, messageId: string) => void }) {
  if (m.role === 'user') {
    return (
      <div className={css.msg + ' ' + css.msgUser}>
        <div className={css.bubble}><MessageText text={m.content} /></div>
        {m.images.length > 0 && <MessageAttachmentStrip convId={convId} message={m} imgOffset={imgOffset} />}
      </div>
    )
  }
  const isStreaming = m.id === streamingId
  const stable = !isStreaming && m.content
  return (
    <div className={css.msg + ' ' + css.msgAssistant}>
      {isStreaming ? (
        <div className={css.assistantBody}>{m.content}</div>
      ) : m.content ? (
        <div className={css.assistantBody}><AnnotatedMarkdown content={m.content} messageId={m.id} conversationId={convId || ''} /></div>
      ) : (
        <div className={css.assistantBody} data-empty></div>
      )}
      {stable && onToggleMenu && onBranch && onArtifact && (
        <div style={{ position: 'relative' }}>
          <button type="button" aria-label="消息操作" title="从这里分支 / 学习成果" onClick={() => onToggleMenu(!menuOpen)} style={{ appearance: 'none', border: 0, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', fontSize: '0.8rem', padding: '0.1rem 0.375rem', borderRadius: '0.375rem' }}>⋯</button>
          {menuOpen && <BranchMenu conversationId={convId || ''} branchId={undefined} messageId={m.id} onBranch={onBranch} onArtifact={onArtifact} onClose={() => onToggleMenu(false)} />}
        </div>
      )}
    </div>
  )
}

function MessageAttachmentStrip({ message, convId, imgOffset }: { message: any; convId?: string; imgOffset: number }) {
  const metas = useAttachmentMetas(message.images)
  const items = buildAttachmentDisplayItems(message.images, metas)
  let running = imgOffset
  return (
    <div className={css.photoStrip}>
      {items.map((item, idx) => {
        if (item.type === 'image') {
          const off = running; running++
          return <Thumb key={'i' + item.attachmentId} id={item.attachmentId} onOpen={() => galleryActions.open(convId, off, 'viewer')} />
        }
        running += item.attachmentIds.length
        return <PdfContextCard key={'g' + item.groupId + '-' + idx} item={item} readOnly />
      })}
    </div>
  )
}

function Thumb({ id, onOpen }: { id: string; onOpen: () => void }) {
  const { url } = useAttachmentPreview(id)
  return (
    <button className={css.photo} onClick={onOpen}>
      {url ? <img src={url} alt="image" /> : <span className={css.photoLoading}>…</span>}
    </button>
  )
}

function Lightbox({ id, onClose }: { id: string; onClose: () => void }) {
  const { url } = useAttachmentPreview(id)
  return (
    <ZoomableImageDialog src={url} alt="" resetKey={id} onClose={onClose} labels={{ close: t('common.close'), dialog: t('attachment.view') }} />
  )
}

function PendingThumb({ id, onRemove, onOpen }: { id: string; onRemove: () => void; onOpen: () => void }) {
  const { url } = useAttachmentPreview(id)
  return (
    <span className={css.pic}>
      <img src={url} alt="" role="button" tabIndex={0} aria-label="查看图片" onClick={onOpen}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }} />
      <button className={css.picDel} onClick={onRemove}><IconCloseOutline16 size={12} /></button>
    </span>
  )
}

function Composer({ sessionId, busy, thread, onBranchSent }: { sessionId: string | undefined; busy: boolean; thread?: { type: 'root' | 'branch'; conversationId: string; branchId?: string }; onBranchSent?: () => void }) {
  // Draft is keyed by thread (root conversation or branch), so switching A<->B shows each one's own text/images.
  const isBranch = thread?.type === 'branch'
  const key = isBranch ? branchThreadKey(thread!.branchId!) : (sessionId ?? '__none__')
  const draft = useDraft(key)
  const [openId, setOpenId] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState<string | undefined>(undefined)
  const [pdfPanel, setPdfPanel] = useState<{ open: boolean; file?: File }>({ open: false })
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [libPickerOpen, setLibPickerOpen] = useState(false)
  const [libBusy, setLibBusy] = useState<{ done: number; total: number } | null>(null)
  const [libMsg, setLibMsg] = useState<string | null>(null)
  const libGenRef = useRef(0)
  const libCancelledRef = useRef(false)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const pdfInputRef = useRef<HTMLInputElement | null>(null)
  const attachBtnRef = useRef<HTMLButtonElement | null>(null)
  const attachMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    setComposerTriggers({ openImages: () => imageInputRef.current?.click(), openPdf: () => pdfInputRef.current?.click() })
    return () => { setComposerTriggers(null); libCancelledRef.current = true; libGenRef.current++ }
  }, [])
  const addPdfToDraft = async (payload: PdfAddPayload): Promise<PdfAddResult> => {
    // Shared implementation (also used by the Document Reader): budget guard -> one
    // groupId -> saveGeneratedImages -> addDraftImages with full rollback.
    if (!sessionId) return { ok: false, count: 0, error: '没有当前会话，无法加入。' }
    return addPdfContextToDraft(sessionId, payload)
  }
  // Block 0.4: operation ownership + cancellation. Snapshot the operation identity at
  // start; a stale / cancelled op NEVER writes into a conversation that is no longer the
  // active one, and leaves no partial Draft group. Switching conversation aborts the old run.
  const addFromLibrary = async (selection: PdfSelection, docId: string, fileName: string) => {
    if (!sessionId) { setLibMsg('当前没有可加入的对话，请先创建一个会话。'); setLibPickerOpen(false); return }
    const gen = ++libGenRef.current
    libCancelledRef.current = false
    const targetConversationId = sessionId
    // Close the picker; the progress overlay (with cancel) takes over.
    setLibPickerOpen(false)
    setLibBusy({ done: 0, total: 1 }); setLibMsg(null)
    const isCancelled = () => libCancelledRef.current || gen !== libGenRef.current
    const isStale = () => gen !== libGenRef.current || sessionId !== targetConversationId
    try {
      if (isCancelled()) return
      const res = await executeDocumentContext({ targetConversationId, documentId: docId, fileName, pageCount: 0, selection, isCancelled, isStale, onProgress: (p) => { if (gen === libGenRef.current) setLibBusy({ done: p.done, total: p.total }) } })
      if (gen !== libGenRef.current) return
      if (!res.ok && res.error) setLibMsg(res.error)
      else if (res.ok) setLibMsg('已加入当前对话 · ' + res.count + ' 页')
    } catch { if (gen === libGenRef.current) setLibMsg('无法生成上下文。') }
    finally { if (gen === libGenRef.current) setLibBusy(null) }
  }
  const cancelLib = () => { libCancelledRef.current = true; libGenRef.current++ }

  // Reset ephemeral view state (lightbox / error banner) when the active conversation changes.
  const prevSession = useRef(sessionId)
  useEffect(() => {
    if (prevSession.current !== sessionId) {
      setOpenId(null); setPhotoError(undefined)
      setAttachMenuOpen(false)
      // Block 0.4: a conversation switch aborts any in-flight library Context operation.
      libCancelledRef.current = true; libGenRef.current++
      prevSession.current = sessionId
    }
  }, [sessionId])
  // Close the unified attachment menu on Escape or a click outside (A2 popover interaction).
  useEffect(() => {
    if (!attachMenuOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setAttachMenuOpen(false); attachBtnRef.current?.focus() } }
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node | null
      const inside = (el && attachBtnRef.current && attachBtnRef.current.contains(el)) || (el && attachMenuRef.current && attachMenuRef.current.contains(el))
      if (!inside) setAttachMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown) }
  }, [attachMenuOpen])
  const text = draft.text
  const picIds = draft.imageIds
  const metas = useAttachmentMetas(picIds)
  const composerItems = buildAttachmentDisplayItems(picIds, metas)
  const removeGroup = (item: Extract<AttachmentDisplayItem, { type: 'pdf-group' }>) => {
    for (const id of item.attachmentIds) { removeDraftImage(key, id); void deleteAttachment(id) }
  }
  const onFiles = async (files: FileList) => {
    // ATOMIC ordinary-image upload (P0): stage OPFS binaries, then ONE IndexedDB txn commits
    // the attachment metadata rows AND the draft:<conversationId> row together. On failure
    // neither commits, staged OPFS binaries are cleaned, and no durability window exists where
    // attachment metadata is durable but the Draft reference is missing.
    try {
      const draftNow = getDraft(key)
      let atts
      if (isBranch && thread) {
        atts = await saveGeneratedImagesAndBranchDraft([...files].map((f) => ({ blob: f, name: f.name })), { branchId: thread.branchId!, text: draftNow.text, existingImageIds: draftNow.imageIds })
      } else {
        atts = await saveImagesAndDraft([...files], { conversationId: key, text: draftNow.text, existingImageIds: draftNow.imageIds })
      }
      // The durable draft row was already committed in the same txn; update memory WITHOUT a
      // second DB mutation (no duplicate persist).
      updateDraftMemory(key, { text: draftNow.text, imageIds: [...new Set([...draftNow.imageIds, ...atts.map(a => a.id)])] })
      setPhotoError(undefined)
    } catch (e: any) {
      setPhotoError(attachmentErrorLabel(e?.kind || 'read-failed'))
    }
  }
  // User removes a pending draft image explicitly -> the attachment is gone for good.
  const removePic = (id: string) => { removeDraftImage(key, id); void deleteAttachment(id) }
  // Focus drives an immediate jump above the on-screen keyboard (measured once, no polling).
  const onFocusJump = (e: any) => {
    try { e.currentTarget.scrollIntoView({ block: 'nearest', behavior: 'auto' }) } catch {}
    const vv = window.visualViewport
    const inset = vv ? Math.max(0, window.innerHeight - vv.height) : 0
    if (inset > 0) document.documentElement.style.setProperty('--dsw-keyboard-inset', inset + 'px')
  }
  const onBlurReset = () => { document.documentElement.style.setProperty('--dsw-keyboard-inset', '0px') }
  const send = async () => {
    if (busy) return
    if (isBranch && thread) {
      if (!text.trim() && picIds.length === 0) return
      const ok = await runBranchReply(thread.conversationId, thread.branchId!, text.trim(), picIds)
      if (ok) { clearDraftMemory(key); setPhotoError(undefined); setOpenId(null); if (onBranchSent) onBranchSent() }
      return
    }
    if (!sessionId) return
    if (!text.trim() && picIds.length === 0) return
    const ok = await sessionsActions.sendUserMessage(sessionId, text.trim(), picIds)
    // Only clear the draft once the user message is ACCEPTED & persisted; the image ids
    // then belong to the message (ownership transfer), so we must NOT delete them here.
    if (ok) { clearDraftMemory(key); setPhotoError(undefined); setOpenId(null) }
  }
  return (
    <div className={css.composer}>
      {photoError && <div className={css.errorBanner}>{photoError}</div>}
      {picIds.length > 0 && (
        <div className={css.composerPics}>
          {composerItems.map((item, idx) => item.type === 'image' ? (
            <PendingThumb key={'i' + item.attachmentId} id={item.attachmentId} onRemove={() => removePic(item.attachmentId)} onOpen={() => setOpenId(item.attachmentId)} />
          ) : (
            <PdfContextCard key={'g' + item.groupId + '-' + idx} item={item} onDelete={() => removeGroup(item)} onRemovePage={id => removePic(id)} />
          ))}
          <span className={css.picCount}>已添加 {picIds.length} 张图片</span>
        </div>
      )}
      <div className={css.composerBar}>
        {/* ONE unified attachment trigger (A2). Clicking opens a compact menu dispatching to
            the existing image / local-PDF / library actions. The hidden file inputs stay;
            the trigger merely dispatches into them. No domain merge. */}
        <button type="button" ref={attachBtnRef} className={css.attachBtn} role="button" aria-label="添加内容" title="添加内容" data-testid="composer-attach" aria-haspopup="menu" aria-expanded={attachMenuOpen} onClick={() => setAttachMenuOpen(v => !v)}>
          <IconPhoto16 />
        </button>
        {attachMenuOpen && (
          <div className={css.addFileMenu} data-testid="composer-add-file-menu" ref={attachMenuRef}>
            <div className={css.menuTitle}>添加内容</div>
            <button type="button" className={css.menuItem} data-testid="composer-add-image" onClick={() => { setAttachMenuOpen(false); imageInputRef.current?.click() }}>🖼 图片</button>
            <button type="button" className={css.menuItem} data-testid="composer-add-pdf" onClick={() => { setAttachMenuOpen(false); pdfInputRef.current?.click() }}>📄 打开本地 PDF</button>
            <button type="button" className={css.menuItem} data-testid="composer-from-library" onClick={() => { setAttachMenuOpen(false); setLibPickerOpen(true) }}>📚 从文件资料库选择</button>
          </div>
        )}
        <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden onChange={e => { if (e.target.files && e.target.files.length) onFiles(e.target.files); e.target.value = '' }} />
        <input ref={pdfInputRef} type="file" accept=".pdf,application/pdf" hidden onChange={e => { const f = e.target.files?.[0]; if (f) setPdfPanel({ open: true, file: f }); e.target.value = '' }} />
        <textarea className={css.composerText} value={text} placeholder={t('composer.placeholder')} onFocus={onFocusJump} onBlur={onBlurReset}
          onChange={e => setDraftText(key, e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} />
        <button className={css.sendBtn} onClick={send} disabled={busy}>{busy ? '生成中' : '发送'}</button>
      </div>
      {openId && <Lightbox id={openId} onClose={() => setOpenId(null)} />}
      {pdfPanel.open && <PdfPanel initialFile={pdfPanel.file} onClose={() => setPdfPanel({ open: false })} onAddToDraft={addPdfToDraft} />}
      {libPickerOpen && <DocumentContextPicker documentId={undefined} onCancel={() => { setLibPickerOpen(false); setLibMsg(null) }} onAdd={(selection, docId, fileName) => { void addFromLibrary(selection, docId, fileName) }} />}
      {libBusy && (
        <div className={css.ctxHint} data-testid="composer-ctx-progress">
          <span>正在准备 AI Context {libBusy.done} / {libBusy.total} 页</span>
          <button type="button" className={css.ctxCancel} data-testid="composer-ctx-cancel" onClick={cancelLib}>取消</button>
        </div>
      )}
      {libMsg && <div className={css.ctxHint} data-testid="composer-ctx-msg">{libMsg}</div>}
    </div>
  )
}

// --- post-v1 branch/artifact UI helpers (kept additive, not part of v1 rendering path) ---
async function artifactModelCall(args: { apiKey: string; baseUrl: string; model: string; messages: import('../api/deepseek').ApiChatMessage[]; signal: AbortSignal }): Promise<string> {
  return (await sendTextChat({ apiKey: args.apiKey, baseUrl: args.baseUrl, model: args.model, messages: args.messages as any, signal: args.signal })).content
}
function creatingSourceLabel(session: { id: string } | undefined, branchId: string | undefined, messageId: string): string {
  const base = session ? (branchId ? '当前分支 · ' : '当前会话 · ') : '会话'
  return base + '截止「' + messageId.slice(0, 8) + '」'
}
function ArtifactLibraryOverlay({ artifacts, onOpen, onClose }: { artifacts: StudyArtifact[]; onOpen: (a: StudyArtifact) => void; onClose: () => void }) {
  return (<div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}><div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '12px', width: 'min(46rem, 94vw)', maxHeight: '86vh', overflow: 'auto' }}><ArtifactLibrary onOpen={onOpen} /></div></div>)
}
function ArtifactViewerOverlay({ artifact, onOpen, onClose, onChanged }: { artifact: StudyArtifact; onOpen: (a: StudyArtifact) => void; onClose: () => void; onChanged: () => void }) {
  // A11: evaluate source liveness dynamically when the artifact is opened (the frozen
  // source.snapshot.sourceDeleted flag is never trusted after creation).
  const [live, setLive] = useState<boolean | null>(null)
  useEffect(() => { let ok = true; void isArtifactSourceLive(artifact).then((v) => { if (ok) setLive(v) }).catch(() => { if (ok) setLive(false) }); return () => { ok = false } }, [artifact.id])
  const sourceDeleted = live === false
  let body: ReactNode | null = null
  if (artifact.status === 'draft' || artifact.status === 'generating') {
    body = <GeneratingArtifactBody artifact={artifact} onClose={onClose} />
  } else if (artifact.status === 'error') {
    body = <ErrorArtifactBody artifact={artifact} sourceDeleted={sourceDeleted} onClose={onClose} onOpen={onOpen} onChanged={onChanged} />
  } else if (artifact.kind === 'quiz' && artifact.quiz) {
    body = <QuizArtifactBody artifact={artifact} sourceDeleted={sourceDeleted} onClose={onClose} />
  } else {
    body = <ArtifactEditor artifact={artifact} onOpenArtifact={onOpen} onClose={onClose} onChanged={onChanged} sourceDeleted={sourceDeleted} />
  }
  return (<div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}><div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '12px', width: 'min(54rem, 94vw)', height: '86vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{body}</div></div>)
}

function ArtifactPanelChrome({ artifact, sourceDeleted, onClose, actions }: { artifact: StudyArtifact; sourceDeleted: boolean; onClose: () => void; actions?: ReactNode }) {
  return (<div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--dsw-alias-border-l2)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
    <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{artifact.title}</strong>
    <span style={{ fontSize: '0.75rem', color: 'var(--dsw-alias-label-tertiary)' }}>{artifact.source.snapshot.sourceLabel}{sourceDeleted ? ' · 原会话已删除' : ''}</span>
    <div style={{ flex: 1 }} />
    {actions}
    <Button size="sm" variant="outline" aria-label="关闭" onClick={onClose}>关闭</Button>
  </div>)
}

function GeneratingArtifactBody({ artifact, onClose }: { artifact: StudyArtifact; onClose: () => void }) {
  return (<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    <ArtifactPanelChrome artifact={artifact} sourceDeleted={false} onClose={onClose} />
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '0.75rem', padding: '2rem', color: 'var(--dsw-alias-label-secondary)' }}>
      <div className={css.artifactSpinner} aria-hidden="true" />
      <div>{artifact.status === 'generating' ? '正在生成…' : '尚未开始生成'}</div>
      <div style={{ fontSize: '0.8125rem', color: 'var(--dsw-alias-label-tertiary)' }}>生成完成后将在这里显示成果；失败时也可在此查看错误原因。</div>
    </div>
  </div>)
}

function ErrorArtifactBody({ artifact, sourceDeleted, onClose, onOpen, onChanged }: { artifact: StudyArtifact; sourceDeleted: boolean; onClose: () => void; onOpen: (a: StudyArtifact) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [err, setErr] = useState<string | undefined>(undefined)
  async function regenerate() {
    setBusy(true); setErr(undefined)
    try {
      const draft = await createArtifactDraft({ kind: artifact.kind, conversationId: artifact.source.conversationId, branchId: artifact.source.branchId, throughMessageId: artifact.source.throughMessageId, prompt: artifact.prompt, presetId: artifact.presetId })
      try {
        const out = await generateArtifact(draft.id, { call: artifactModelCall })
        onOpen(out)
      } catch (e) {
        const cur = await getArtifact(draft.id)
        if (cur && cur.status === 'draft') await removeArtifact(draft.id).catch(() => undefined)
        setErr(e instanceof ArtifactGenerationError ? e.message : '生成失败：' + String((e as any)?.message ?? e))
      }
    } finally { setBusy(false) }
  }
  async function del() { if (!globalThis.confirm('删除该学习成果？')) return; await removeArtifact(artifact.id); onChanged(); onClose() }
  return (<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    <ArtifactPanelChrome artifact={artifact} sourceDeleted={sourceDeleted} onClose={onClose} actions={<Button size="sm" variant="ghost" aria-label="删除" onClick={() => void del()}>删除</Button>} />
    <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
      <div style={{ color: 'var(--dsw-alias-state-error-primary)', fontWeight: 600, marginBottom: '0.5rem' }}>生成失败</div>
      <p style={{ color: 'var(--dsw-alias-label-secondary)', margin: '0 0 0.75rem' }}>{artifact.error || '未知错误'}</p>
      {err && <p style={{ color: 'var(--dsw-alias-state-error-primary)', margin: '0 0 0.75rem' }}>{err}</p>}
      {artifact.generatedContent !== undefined && (<button type="button" className={css.filterBtn} onClick={() => setShowRaw(!showRaw)}>{showRaw ? '收起原始输出' : '查看原始输出'}</button>)}
      {showRaw && artifact.generatedContent !== undefined && (<pre style={{ marginTop: '0.75rem', maxHeight: '16rem', overflow: 'auto', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '0.5rem', padding: '0.625rem', whiteSpace: 'pre-wrap', fontSize: '0.8125rem', color: 'var(--dsw-alias-label-primary)' }}>{artifact.generatedContent}</pre>)}
    </div>
    <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--dsw-alias-border-l2)', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => void regenerate()}>{busy ? '生成中…' : '重新生成'}</Button>
    </div>
  </div>)
}

function QuizArtifactBody({ artifact, sourceDeleted, onClose }: { artifact: StudyArtifact; sourceDeleted: boolean; onClose: () => void }) {
  const canExport = !!artifact.quiz
  return (<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    <ArtifactPanelChrome artifact={artifact} sourceDeleted={sourceDeleted} onClose={onClose} actions={canExport ? (<><Button size="sm" variant="ghost" aria-label="导出 Markdown" onClick={() => exportQuizMarkdown(artifact)}>导出 Markdown</Button><Button size="sm" variant="ghost" aria-label="导出 JSON" onClick={() => exportQuizJson(artifact)}>导出 JSON</Button></>) : undefined} />
    <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>{artifact.quiz ? <QuizViewer quiz={artifact.quiz} /> : null}</div>
  </div>)
}
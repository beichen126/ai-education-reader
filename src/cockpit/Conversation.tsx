
import { useEffect, useRef, useState } from 'react'
import { useSessions, sessionsActions } from '../engine/sessions-store'
import { useSettings } from '../engine/settings-store'
import { uiActions, useUi } from '../engine/ui-store'
import { saveFiles, saveGeneratedImages, deleteAttachment, attachmentErrorLabel, sumAttachmentBytes, wouldExceedInlineBudget } from '../engine/attachment-service'
import { useDraft, getDraft, setDraftText, addDraftImages, removeDraftImage, clearDraft } from '../engine/draft-store'
import { useAttachmentPreview } from '../engine/use-attachment-preview'
import { t } from '../engine/locale'
import { MessageText, IconCloseOutline16, Button } from '../dsh/primitives'
import { ImageLightbox } from '../dsh/attachment/ImageLightbox'
import { AnnotatedMarkdown } from '../annotations/AnnotatedMarkdown'
import { galleryActions } from '../gallery/gallery-store'
import { PdfPanel, type PdfAddResult } from '../pdf/PdfPanel'
import { pdfPageAttachmentName, type PdfAddPayload, type RenderedPdfPage } from '../pdf/pdf-types'
import { newStableId } from '../engine/types'
import { useAttachmentMetas } from '../engine/use-attachment-metas'
import { setComposerTriggers, triggerComposerImages, triggerComposerPdf } from '../engine/composer-triggers'
import { buildAttachmentDisplayItems, type AttachmentDisplayItem } from '../attachments/attachment-display'
import { PdfContextCard } from './PdfContextCard'
import css from './cockpit.module.css'

export function Conversation() {
  const session = useSessions(s => s.byId[s.current || ''])
  const status = useSessions(s => s.status)
  const sendError = useSessions(s => s.sendError)
  const hasKey = useSettings(s => !!s.apiKey)
  const listRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const onScroll = () => { const el = listRef.current; if (!el) return; atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 60 }
  const messages = session?.messages ?? []
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
  return (
    <div className={css.conversation}>
      {!hasKey && (
        <div className={css.noKeyBanner}>
          <span>尚未配置 API Key，请先在设置中填写，否则无法发送。</span>
          <button className={css.noKeyBtn} onClick={uiActions.openSettings}>打开设置</button>
        </div>
      )}
      {busy && (
        <div className={css.sendingBar}>
          <span>{streaming ? '正在生成…' : '正在发送…'}</span>
          {streaming && <button className={css.stopBtn} onClick={sessionsActions.stopGenerating}>停止生成</button>}
        </div>
      )}
      {sendError && !busy && <div className={css.errorBanner}>{sendError}</div>}
      {/* Composer sits inside the scroll body, position:sticky bottom:0 (as in DSH), so the
          mobile browser's native focus scroll lifts it above the on-screen keyboard. */}
      <div className={css.messages} ref={listRef} onScroll={onScroll}>
        <div className={css.messagesInner}>
          {!session || session.messages.length === 0 ? (
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
          ) : messages.map(m => <MessageRow key={m.id} m={m} streamingId={activeStreamingId} convId={session?.id} imgOffset={imageOffsetByMsg[m.id] || 0} />)}
        </div>
        <Composer sessionId={session?.id} busy={busy} />
      </div>
    </div>
  )
}

function MessageRow({ m, streamingId, convId, imgOffset }: { m: any; streamingId?: string; convId?: string; imgOffset: number }) {
  if (m.role === 'user') {
    return (
      <div className={css.msg + ' ' + css.msgUser}>
        <div className={css.bubble}><MessageText text={m.content} /></div>
        {m.images.length > 0 && <MessageAttachmentStrip convId={convId} message={m} imgOffset={imgOffset} />}
      </div>
    )
  }
  const isStreaming = m.id === streamingId
  return (
    <div className={css.msg + ' ' + css.msgAssistant}>
      {isStreaming ? (
        <div className={css.assistantBody}>{m.content}</div>
      ) : m.content ? (
        <div className={css.assistantBody}><AnnotatedMarkdown content={m.content} messageId={m.id} conversationId={convId || ''} /></div>
      ) : (
        <div className={css.assistantBody} data-empty></div>
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
  const { url, error } = useAttachmentPreview(id)
  if (!url) return null
  return <ImageLightbox src={url} alt="" labels={{ dialog: t('attachment.view'), close: t('common.close') }} onClose={onClose} />
}

function PendingThumb({ id, onRemove, onOpen }: { id: string; onRemove: () => void; onOpen: () => void }) {
  const { url } = useAttachmentPreview(id)
  return (
    <span className={css.pic}>
      <img src={url} alt="" onClick={onOpen} />
      <button className={css.picDel} onClick={onRemove}><IconCloseOutline16 size={12} /></button>
    </span>
  )
}

function Composer({ sessionId, busy }: { sessionId: string | undefined; busy: boolean }) {
  // Draft is keyed by conversation, so switching A<->B shows each one's own text/images.
  const key = sessionId ?? '__none__'
  const draft = useDraft(key)
  const [openId, setOpenId] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState<string | undefined>(undefined)
  const [pdfPanel, setPdfPanel] = useState<{ open: boolean; file?: File }>({ open: false })
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const pdfInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    setComposerTriggers({ openImages: () => imageInputRef.current?.click(), openPdf: () => pdfInputRef.current?.click() })
    return () => setComposerTriggers(null)
  }, [])
  const addPdfToDraft = async (payload: PdfAddPayload): Promise<PdfAddResult> => {
    if (!sessionId) return { ok: false, count: 0, error: '没有当前会话，无法加入。' }
    try {
      // One user PDF selection = one context group (never auto-merged by fileName).
      // Draft early guard: existing draft bytes + this group must fit the 30 MiB budget
      // (final runReplyStream guard stays authoritative; this avoids writing dozens of
      // attachments into IDB just to reject them at send time).
      const existingIds = sessionId ? getDraft(sessionId).imageIds : []
      const existingBytes = await sumAttachmentBytes(existingIds)
      const newBytes = payload.pages.reduce((s, p) => s + p.blob.size, 0)
      if (wouldExceedInlineBudget(existingBytes, newBytes)) {
        return { ok: false, count: 0, error: '当前消息中的图片内容已经较多。加入这一 PDF 范围后可能超过接口请求大小限制。请删除部分图片或减少 PDF 页面后重试。' }
      }
      const groupId = newStableId()
      const inputs = payload.pages.map(p => ({
        blob: p.blob,
        name: pdfPageAttachmentName(payload.fileName, p.pageNumber),
        source: { type: 'pdf-page' as const, groupId, fileName: payload.fileName, pageNumber: p.pageNumber, selection: payload.selection },
      }))
      const atts = await saveGeneratedImages(inputs)
      try {
        addDraftImages(sessionId, atts.map(a => a.id))
      } catch (e) {
        // Roll back this batch so a failed attach step never leaves orphan blobs.
        for (const a of atts) { try { await deleteAttachment(a.id) } catch { /* ignore */ } }
        throw e
      }
      return { ok: true, count: atts.length, error: '' }
    } catch (e) {
      return { ok: false, count: 0, error: '无法将 PDF 页面加入对话。' }
    }
  }
  // Reset ephemeral view state (lightbox / error banner) when the active conversation changes.
  const prevSession = useRef(sessionId)
  useEffect(() => { if (prevSession.current !== sessionId) { setOpenId(null); setPhotoError(undefined); prevSession.current = sessionId } }, [sessionId])
  const text = draft.text
  const picIds = draft.imageIds
  const metas = useAttachmentMetas(picIds)
  const composerItems = buildAttachmentDisplayItems(picIds, metas)
  const removeGroup = (item: Extract<AttachmentDisplayItem, { type: 'pdf-group' }>) => {
    for (const id of item.attachmentIds) { removeDraftImage(key, id); void deleteAttachment(id) }
  }
  const onFiles = async (files: FileList) => {
    try {
      const atts = await saveFiles([...files])
      addDraftImages(key, atts.map(a => a.id))
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
    if (!sessionId || busy) return
    if (!text.trim() && picIds.length === 0) return
    const ok = await sessionsActions.sendUserMessage(sessionId, text.trim(), picIds)
    // Only clear the draft once the user message is ACCEPTED & persisted; the image ids
    // then belong to the message (ownership transfer), so we must NOT delete them here.
    if (ok) { void clearDraft(sessionId); setPhotoError(undefined); setOpenId(null) }
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
        <label className={css.attachBtn} title={t('composer.attach')}>
          <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple hidden onChange={e => { if (e.target.files && e.target.files.length) onFiles(e.target.files); e.target.value = '' }} />
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1a2.5 2.5 0 0 1 2.5 2.5v4a2.5 2.5 0 0 1-5 0v-4A2.5 2.5 0 0 1 8 1zM3 8a5 5 0 0 0 10 0h-1.6a3.4 3.4 0 0 1-6.8 0H3z"/></svg>
        </label>
        <label className={css.attachBtn} title="选择 PDF">
          <input ref={pdfInputRef} type="file" accept=".pdf,application/pdf" hidden onChange={e => { const f = e.target.files?.[0]; if (f) setPdfPanel({ open: true, file: f }); e.target.value = '' }} />
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M3 1h10a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm1 2v10h8V3H4zm2 2h4a.5.5 0 0 1 0 1H6a.5.5 0 0 1 0-1zm0 2h2.5a.5.5 0 0 1 0 1H6a.5.5 0 0 1 0-1z"/></svg>
        </label>
        <textarea className={css.composerText} value={text} placeholder={t('composer.placeholder')} onFocus={onFocusJump} onBlur={onBlurReset}
          onChange={e => setDraftText(key, e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }} />
        <button className={css.sendBtn} onClick={send} disabled={busy}>{busy ? '生成中' : '发送'}</button>
      </div>
      {openId && <Lightbox id={openId} onClose={() => setOpenId(null)} />}
      {pdfPanel.open && <PdfPanel initialFile={pdfPanel.file} onClose={() => setPdfPanel({ open: false })} onAddToDraft={addPdfToDraft} />}
    </div>
  )
}
import { useEffect, useRef, useState } from 'react'
import { Button } from '../dsh/primitives/Button'
import { MarkdownBlocks } from '../markdown/MarkdownBlocks'
import { updateArtifactContent, updateArtifactTitle, removeArtifact, createArtifactDraft } from './artifact-service'
import { generateArtifact, ArtifactGenerationError } from './artifact-generation'
import { getArtifact } from './artifact-store'
import { exportNoteMarkdown } from './artifact-export'
import { useCopyFeedback } from '../dsh/primitives/use-copy-feedback'
import type { StudyArtifact, ArtifactKind } from './artifact-types'
import css from './artifact.module.css'
import { localizedArtifactSourceLabel, localizedArtifactTitle, localizedErrorText, tx } from '../engine/locale'

type Props = {
  artifact: StudyArtifact
  onOpenArtifact: (a: StudyArtifact) => void
  onClose: () => void
  onChanged: () => void
  /** Dynamic source liveness (A11) — when false the live source conversation is gone. */
  sourceDeleted?: boolean
}

type EditorMode = 'edit' | 'split' | 'preview'

const kindLabel: Record<ArtifactKind, string> = { note: '笔记', quiz: '题目', summary: '历史类型 · 总结', 'study-guide': '历史类型 · 学习指南', custom: '历史类型 · 自定义' }
const kindLabelEn: Record<ArtifactKind, string> = { note: 'Note', quiz: 'Quiz', summary: 'Legacy · Summary', 'study-guide': 'Legacy · Study guide', custom: 'Legacy · Custom' }

const MODES: { key: EditorMode; label: string; labelEn: string }[] = [
  { key: 'edit', label: '编辑', labelEn: 'Edit' },
  { key: 'split', label: '分屏', labelEn: 'Split' },
  { key: 'preview', label: '预览', labelEn: 'Preview' },
]

/**
 * Dedicated editable Note-ish workspace (Markdown editor + REAL rendered preview).
 * A8: three explicit modes (edit | split | preview). Preview never shows the editor.
 * A7: preview uses the shared MarkdownBlocks renderer (headings/lists/tables/code/math).
 * A9: one-click Markdown export from the CURRENT edited content.
 * Regenerate (A1/A6) creates a NEW revision draft; failures surface an error, never silently.
 */
export function ArtifactEditor({ artifact, onOpenArtifact, onClose, onChanged, sourceDeleted }: Props) {
  const [title, setTitle] = useState(() => localizedArtifactTitle(artifact.title, artifact.kind))
  const [body, setBody] = useState(artifact.content ?? '')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<EditorMode>('split')
  const [genError, setGenError] = useState<string | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cp = useCopyFeedback(body)
  const mountedRef = useRef(true)
  // Latest unsaved text + the artifact it belongs to. A flush after an artifact switch must
  // still write to the ORIGINAL artifact (never leak into the next open artifact).
  const pendingRef = useRef<{ artId: string; text: string } | null>(null)
  const prevArtIdRef = useRef(artifact.id)

  useEffect(() => {
    // A pending edit belongs to the PREVIOUS artifact when switching; flush it BEFORE the
    // editor resets, so the last keystrokes are never lost on an artifact switch.
    if (prevArtIdRef.current !== artifact.id) flushPendingSave()
    prevArtIdRef.current = artifact.id
    setTitle(localizedArtifactTitle(artifact.title, artifact.kind)); setBody(artifact.content ?? ''); setGenError(undefined)
    // A8: narrow screens default to Edit; desktop defaults to Split.
    setMode(typeof window !== 'undefined' && window.innerWidth < 720 ? 'edit' : 'split')
  }, [artifact.id])

  // Debounced autosave with pending-write ownership: a snapshot is written only after 450ms
  // idle, but an explicit close / unmount / page-hide flushes the last edit through
  // flushPendingSave() (never a fire-and-forget the unmount cleanup then drops).
  function scheduleSave(next: string) {
    setBody(next)
    pendingRef.current = { artId: artifact.id, text: next }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { timer.current = null; void persistPending() }, 450)
  }
  async function persistPending() {
    const p = pendingRef.current
    pendingRef.current = null
    if (!p) return
    await updateArtifactContent(p.artId, p.text)
    if (mountedRef.current) { setSaved(true); setTimeout(() => setSaved(false), 1200) }
    onChanged()
  }
  function flushPendingSave() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    void persistPending()
  }
  const requestClose = () => { flushPendingSave(); onClose() }

  // Unmount: cancel the debounce AND flush any pending edit (covers overlay backdrop close,
  // document switch, artifact navigation, Escape — any path that bypasses requestClose).
  useEffect(() => () => {
    mountedRef.current = false
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    void persistPending()
  }, [])
  // The page can be hidden/unloaded at any time — flush the last edit so a system kill or a
  // quick tab switch within the 450ms window never drops a keystroke.
  useEffect(() => {
    const flush = () => flushPendingSave()
    const onVis = () => { if (document.visibilityState === 'hidden') flushPendingSave() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', onVis) }
  }, [])
  async function commitTitle() { if (title.trim() && title.trim() !== localizedArtifactTitle(artifact.title, artifact.kind)) { await updateArtifactTitle(artifact.id, title); onChanged() } }
  async function doCopy() { cp.onCopy() }
  async function doDelete() { if (!globalThis.confirm(tx('删除该学习成果？', 'Delete this study output?'))) return; await removeArtifact(artifact.id); onChanged(); onClose() }
  function doExport() { exportNoteMarkdown(artifact, body) }
  async function doRegenerate() {
    if (!globalThis.confirm(tx('重新生成将创建一个新版本，当前编辑不会丢失。继续？', 'Regenerating creates a new version and preserves your current edits. Continue?'))) return
    setBusy(true); setGenError(undefined)
    try {
      const draft = await createArtifactDraft({ kind: artifact.kind, conversationId: artifact.source.conversationId, branchId: artifact.source.branchId, throughMessageId: artifact.source.throughMessageId, prompt: artifact.prompt, presetId: artifact.presetId, promptBundle: artifact.promptBundle })
      try {
        const out = await generateArtifact(draft.id, { call: defaultModelCall })
        onOpenArtifact(out)
      } catch (e) {
        // A1: if the fresh draft was never claimed (busy / pre-flight), don't leak it.
        const cur = await getArtifact(draft.id)
        if (cur && cur.status === 'draft') await removeArtifact(draft.id).catch(() => undefined)
        setGenError(genErrorMessage(e))
      }
    } finally { setBusy(false) }
  }

  const showEdit = mode === 'edit' || mode === 'split'
  const showPreview = mode === 'preview' || mode === 'split'

  return (<div className={css.editor}>
    <div className={css.editorHead}>
      <input className={css.titleInput} value={title} aria-label={tx('标题', 'Title')} onChange={(e) => setTitle(e.target.value)} onBlur={() => void commitTitle()} />
      <span className={css.cardKind}>{tx(kindLabel[artifact.kind], kindLabelEn[artifact.kind])}</span>
      {saved && <span className={css.saved}>{tx('已保存', 'Saved')}</span>}
      <div className={css.modeSwitch} role="radiogroup" aria-label={tx('视图模式', 'View mode')}>
        {MODES.map((m) => (<button key={m.key} type="button" className={css.modeBtn + (mode === m.key ? ' ' + css.active : '')} role="radio" aria-checked={mode === m.key} onClick={() => setMode(m.key)}>{tx(m.label, m.labelEn)}</button>))}
      </div>
      <Button size="sm" variant="ghost" aria-label={tx('复制正文', 'Copy content')} onClick={() => void doCopy()}>{tx('复制', 'Copy')}</Button>
      <Button size="sm" variant="ghost" aria-label={tx('导出 Markdown', 'Export Markdown')} onClick={doExport}>{tx('导出 Markdown', 'Export Markdown')}</Button>
      <Button size="sm" variant="ghost" aria-label={tx('重新生成', 'Regenerate')} disabled={busy} onClick={() => void doRegenerate()}>{busy ? tx('生成中…', 'Generating…') : tx('重新生成', 'Regenerate')}</Button>
      <Button size="sm" variant="ghost" aria-label={tx('删除', 'Delete')} onClick={() => void doDelete()}>{tx('删除', 'Delete')}</Button>
      <Button size="sm" variant="outline" aria-label={tx('关闭', 'Close')} onClick={requestClose}>{tx('关闭', 'Close')}</Button>
    </div>
    {genError && <div className={css.error} role="alert">{genError}</div>}
    <div className={css.editorBody + (mode === 'edit' ? ' ' + css.narrow : '') + (mode === 'preview' ? ' ' + css.previewOnly : '')}>
      {showEdit && (<div className={css.pane}><div className={css.paneLabel}>{tx('编辑', 'Edit')}</div><textarea className={css.textarea} aria-label={tx('正文 Markdown', 'Content Markdown')} value={body} onChange={(e) => scheduleSave(e.target.value)} /></div>)}
      {showPreview && (<div className={css.pane}><div className={css.paneLabel}>{tx('预览', 'Preview')}</div><div className={css.preview}><MarkdownBlocks content={body} messageId={'artifact:' + artifact.id} /></div></div>)}
    </div>
    <div className={css.provenance}><strong>{tx('来源', 'Source')}</strong> · {localizedArtifactSourceLabel(artifact.source.snapshot.sourceLabel)}{sourceDeleted ? tx(' · 原会话已删除', ' · Source chat deleted') : ''}</div>
  </div>)
}

function genErrorMessage(e: unknown): string {
  if (e instanceof ArtifactGenerationError) return localizedErrorText(e, 'Unable to generate this study output.')
  const msg = (e as any)?.name === 'AbortError' ? tx('已取消生成', 'Generation cancelled') : String((e as any)?.message ?? e)
  return localizedErrorText(msg, 'Generation failed.')
}

// Regeneration uses the same BYOK model pipeline via the existing non-streaming send.
async function defaultModelCall(args: { apiKey: string; baseUrl: string; model: string; messages: import('../api/deepseek').ApiChatMessage[]; signal: AbortSignal }): Promise<string> {
  const { sendTextChat } = await import('../api/deepseek')
  return (await sendTextChat({ apiKey: args.apiKey, baseUrl: args.baseUrl, model: args.model, messages: args.messages as any, signal: args.signal })).content
}

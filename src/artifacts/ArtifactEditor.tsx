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

type Props = {
  artifact: StudyArtifact
  onOpenArtifact: (a: StudyArtifact) => void
  onClose: () => void
  onChanged: () => void
  /** Dynamic source liveness (A11) — when false the live source conversation is gone. */
  sourceDeleted?: boolean
}

type EditorMode = 'edit' | 'split' | 'preview'

const kindLabel: Record<ArtifactKind, string> = { note: '笔记', quiz: '题目', summary: '总结', 'study-guide': '学习指南', custom: '自定义' }

const MODES: { key: EditorMode; label: string }[] = [
  { key: 'edit', label: '编辑' },
  { key: 'split', label: '分屏' },
  { key: 'preview', label: '预览' },
]

/**
 * Dedicated editable Note-ish workspace (Markdown editor + REAL rendered preview).
 * A8: three explicit modes (edit | split | preview). Preview never shows the editor.
 * A7: preview uses the shared MarkdownBlocks renderer (headings/lists/tables/code/math).
 * A9: one-click Markdown export from the CURRENT edited content.
 * Regenerate (A1/A6) creates a NEW revision draft; failures surface an error, never silently.
 */
export function ArtifactEditor({ artifact, onOpenArtifact, onClose, onChanged, sourceDeleted }: Props) {
  const [title, setTitle] = useState(artifact.title)
  const [body, setBody] = useState(artifact.content ?? '')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<EditorMode>('split')
  const [genError, setGenError] = useState<string | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cp = useCopyFeedback(body)

  useEffect(() => {
    setTitle(artifact.title); setBody(artifact.content ?? ''); setGenError(undefined)
    // A8: narrow screens default to Edit; desktop defaults to Split.
    setMode(typeof window !== 'undefined' && window.innerWidth < 720 ? 'edit' : 'split')
  }, [artifact.id])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  function scheduleSave(next: string) {
    setBody(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void (async () => { await updateArtifactContent(artifact.id, next); setSaved(true); setTimeout(() => setSaved(false), 1200); onChanged() })() }, 450)
  }
  async function commitTitle() { if (title.trim() && title.trim() !== artifact.title) { await updateArtifactTitle(artifact.id, title); onChanged() } }
  async function doCopy() { cp.onCopy() }
  async function doDelete() { if (!globalThis.confirm('删除该学习成果？')) return; await removeArtifact(artifact.id); onChanged(); onClose() }
  function doExport() { exportNoteMarkdown(artifact) }
  async function doRegenerate() {
    if (!globalThis.confirm('重新生成将创建一个新版本，当前编辑不会丢失。继续？')) return
    setBusy(true); setGenError(undefined)
    try {
      const draft = await createArtifactDraft({ kind: artifact.kind, conversationId: artifact.source.conversationId, branchId: artifact.source.branchId, throughMessageId: artifact.source.throughMessageId, prompt: artifact.prompt, presetId: artifact.presetId })
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
      <input className={css.titleInput} value={title} aria-label="标题" onChange={(e) => setTitle(e.target.value)} onBlur={() => void commitTitle()} />
      <span className={css.cardKind}>{kindLabel[artifact.kind]}</span>
      {saved && <span className={css.saved}>已保存</span>}
      <div className={css.modeSwitch} role="radiogroup" aria-label="视图模式">
        {MODES.map((m) => (<button key={m.key} type="button" className={css.modeBtn + (mode === m.key ? ' ' + css.active : '')} role="radio" aria-checked={mode === m.key} onClick={() => setMode(m.key)}>{m.label}</button>))}
      </div>
      <Button size="sm" variant="ghost" aria-label="复制正文" onClick={() => void doCopy()}>复制</Button>
      <Button size="sm" variant="ghost" aria-label="导出 Markdown" onClick={doExport}>导出 Markdown</Button>
      <Button size="sm" variant="ghost" aria-label="重新生成" disabled={busy} onClick={() => void doRegenerate()}>{busy ? '生成中…' : '重新生成'}</Button>
      <Button size="sm" variant="ghost" aria-label="删除" onClick={() => void doDelete()}>删除</Button>
      <Button size="sm" variant="outline" aria-label="关闭" onClick={onClose}>关闭</Button>
    </div>
    {genError && <div className={css.error} role="alert">{genError}</div>}
    <div className={css.editorBody + (mode === 'edit' ? ' ' + css.narrow : '') + (mode === 'preview' ? ' ' + css.previewOnly : '')}>
      {showEdit && (<div className={css.pane}><div className={css.paneLabel}>编辑</div><textarea className={css.textarea} aria-label="正文 Markdown" value={body} onChange={(e) => scheduleSave(e.target.value)} /></div>)}
      {showPreview && (<div className={css.pane}><div className={css.paneLabel}>预览</div><div className={css.preview}><MarkdownBlocks content={body} messageId={'artifact:' + artifact.id} /></div></div>)}
    </div>
    <div className={css.provenance}><strong>来源</strong> · {artifact.source.snapshot.sourceLabel}{sourceDeleted ? ' · 原会话已删除' : ''}</div>
  </div>)
}

function genErrorMessage(e: unknown): string {
  if (e instanceof ArtifactGenerationError) return e.message
  const msg = (e as any)?.name === 'AbortError' ? '已取消生成' : String((e as any)?.message ?? e)
  return '生成失败：' + msg
}

// Regeneration uses the same BYOK model pipeline via the existing non-streaming send.
async function defaultModelCall(args: { apiKey: string; baseUrl: string; model: string; messages: import('../api/deepseek').ApiChatMessage[]; signal: AbortSignal }): Promise<string> {
  const { sendTextChat } = await import('../api/deepseek')
  return (await sendTextChat({ apiKey: args.apiKey, baseUrl: args.baseUrl, model: args.model, messages: args.messages as any, signal: args.signal })).content
}

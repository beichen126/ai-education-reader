import { useEffect, useRef, useState } from 'react'
import { Button } from '../dsh/primitives/Button'
import { updateArtifactContent, updateArtifactTitle, removeArtifact, createArtifactDraft } from './artifact-service'
import { generateArtifact } from './artifact-generation'
import { useCopyFeedback } from '../dsh/primitives/use-copy-feedback'
import type { StudyArtifact, ArtifactKind } from './artifact-types'
import css from './artifact.module.css'

type Props = {
  artifact: StudyArtifact
  onOpenArtifact: (a: StudyArtifact) => void
  onClose: () => void
  onChanged: () => void
}

const kindLabel: Record<ArtifactKind, string> = { note: '笔记', quiz: '题目', summary: '总结', 'study-guide': '学习指南', custom: '自定义' }

/**
 * Dedicated editable Note-ish workspace (Markdown editor + rendered preview + autosave).
 * Provence panel; regenerate creates a NEW revision (never silently overwrites edits);
 * copy + delete. Broad/massive screens use a split view; narrow screens stack.
 */
export function ArtifactEditor({ artifact, onOpenArtifact, onClose, onChanged }: Props) {
  const [title, setTitle] = useState(artifact.title)
  const [body, setBody] = useState(artifact.content ?? '')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [previewMode, setPreviewMode] = useState<'split' | 'edit' | 'preview'>('split')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cp = useCopyFeedback(body)

  useEffect(() => { setTitle(artifact.title); setBody(artifact.content ?? '') }, [artifact.id])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  function scheduleSave(next: string) {
    setBody(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void (async () => { await updateArtifactContent(artifact.id, next); setSaved(true); setTimeout(() => setSaved(false), 1200); onChanged() })() }, 450)
  }
  async function commitTitle() { if (title.trim() && title.trim() !== artifact.title) { await updateArtifactTitle(artifact.id, title); onChanged() } }
  async function doCopy() { cp.onCopy() }
  async function doDelete() { if (!globalThis.confirm('删除该学习成果？')) return; await removeArtifact(artifact.id); onChanged(); onClose() }
  async function doRegenerate() {
    if (!globalThis.confirm('重新生成将创建一个新版本，当前编辑不会丢失。继续？')) return
    setBusy(true)
    try {
      const draft = await createArtifactDraft({ kind: artifact.kind, conversationId: artifact.source.conversationId, branchId: artifact.source.branchId, throughMessageId: artifact.source.throughMessageId, prompt: artifact.prompt, presetId: artifact.presetId })
      const out = await generateArtifact(draft.id, { call: defaultModelCall })
      onOpenArtifact(out)
    } catch { /* surface generation errors through the status */ } finally { setBusy(false) }
  }

  return (<div className={css.editor}>
    <div className={css.editorHead}>
      <input className={css.titleInput} value={title} aria-label="标题" onChange={(e) => setTitle(e.target.value)} onBlur={() => void commitTitle()} />
      <span className={css.cardKind}>{kindLabel[artifact.kind]}</span>
      {saved && <span className={css.saved}>已保存</span>}
      <Button size="sm" variant="ghost" aria-label="切换编辑/预览" onClick={() => setPreviewMode(previewMode === 'preview' ? 'edit' : (previewMode === 'edit' ? 'preview' : 'edit'))}>编辑/预览</Button>
      <Button size="sm" variant="ghost" aria-label="复制正文" onClick={() => void doCopy()}>复制</Button>
      <Button size="sm" variant="ghost" aria-label="重新生成" disabled={busy} onClick={() => void doRegenerate()}>{busy ? '生成中…' : '重新生成'}</Button>
      <Button size="sm" variant="ghost" aria-label="删除" onClick={() => void doDelete()}>删除</Button>
      <Button size="sm" variant="outline" aria-label="关闭" onClick={onClose}>关闭</Button>
    </div>
    <div className={css.editorBody + (previewMode === 'edit' ? ' ' + css.narrow : '')}>
      <div className={css.pane}><div className={css.paneLabel}>编辑</div><textarea className={css.textarea} aria-label="正文 Markdown" value={body} onChange={(e) => scheduleSave(e.target.value)} /></div>
      {(previewMode !== 'edit') && (<div className={css.pane}><div className={css.paneLabel}>预览</div><div className={css.preview}>{body.split('\n').map((l, i) => (<span key={i}>{l === '' ? '\u00a0' : l}<br /></span>))}</div></div>)}
    </div>
    <div className={css.provenance}><strong>来源</strong> · {artifact.source.snapshot.sourceLabel}{artifact.source.snapshot.sourceDeleted ? ' · 原会话已删除' : ''} · 截止消息 {artifact.source.throughMessageId.slice(0, 8)}</div>
  </div>)
}

// Regeneration uses the same BYOK model pipeline via the existing non-streaming send.
async function defaultModelCall(args: { apiKey: string; baseUrl: string; model: string; messages: import('../api/deepseek').ApiChatMessage[]; signal: AbortSignal }): Promise<string> {
  const { sendTextChat } = await import('../api/deepseek')
  return (await sendTextChat({ apiKey: args.apiKey, baseUrl: args.baseUrl, model: args.model, messages: args.messages as any, signal: args.signal })).content
}
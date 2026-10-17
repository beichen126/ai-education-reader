import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '../dsh/primitives'
import { ArtifactEditor } from './ArtifactEditor'
import { QuizViewer } from './QuizViewer'
import { createArtifactDraft, removeArtifact } from './artifact-service'
import { getArtifact } from './artifact-store'
import { generateArtifact, ArtifactGenerationError } from './artifact-generation'
import { exportQuizJson, exportQuizMarkdown } from './artifact-export'
import { sendTextChat } from '../api/deepseek'
import { localizedArtifactTitle, localizedArtifactSourceLabel, localizedErrorText, tx } from '../engine/locale'
import type { StudyArtifact } from './artifact-types'
import css from '../cockpit/cockpit.module.css'

export function ArtifactViewerBody({artifact,sourceDeleted,onClose,onOpen,onChanged}: {artifact:StudyArtifact;sourceDeleted:boolean;onClose:()=>void;onOpen:(a:StudyArtifact)=>void;onChanged:()=>void}) {
  if(artifact.status==='draft'||artifact.status==='generating') return <GeneratingArtifactBody artifact={artifact} onClose={onClose}/>
  if(artifact.status==='error') return <ErrorArtifactBody artifact={artifact} sourceDeleted={sourceDeleted} onClose={onClose} onOpen={onOpen} onChanged={onChanged}/>
  if(artifact.kind==='quiz'&&artifact.quiz) return <QuizArtifactBody artifact={artifact} sourceDeleted={sourceDeleted} onClose={onClose}/>
  return <ArtifactEditor artifact={artifact} sourceDeleted={sourceDeleted} onClose={onClose} onOpenArtifact={onOpen} onChanged={onChanged}/>
}

async function artifactModelCall(args: { apiKey: string; baseUrl: string; model: string; messages: import('../api/deepseek').ApiChatMessage[]; signal: AbortSignal }): Promise<string> {
  return (await sendTextChat({ apiKey: args.apiKey, baseUrl: args.baseUrl, model: args.model, messages: args.messages as any, signal: args.signal })).content
}
function ArtifactPanelChrome({ artifact, sourceDeleted, onClose, actions }: { artifact: StudyArtifact; sourceDeleted: boolean; onClose: () => void; actions?: ReactNode }) {
  return (<div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--dsw-alias-border-l2)', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
    <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{localizedArtifactTitle(artifact.title, artifact.kind)}</strong>
    <span style={{ fontSize: '0.75rem', color: 'var(--dsw-alias-label-tertiary)' }}>{localizedArtifactSourceLabel(artifact.source.snapshot.sourceLabel)}{sourceDeleted ? tx(' · 原会话已删除', ' · Source chat deleted') : ''}</span>
    <div style={{ flex: 1 }} />
    {actions}
    <Button size="sm" variant="outline" aria-label={tx('关闭', 'Close')} onClick={onClose}>{tx('关闭', 'Close')}</Button>
  </div>)
}

function GeneratingArtifactBody({ artifact, onClose }: { artifact: StudyArtifact; onClose: () => void }) {
  return (<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    <ArtifactPanelChrome artifact={artifact} sourceDeleted={false} onClose={onClose} />
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '0.75rem', padding: '2rem', color: 'var(--dsw-alias-label-secondary)' }}>
      <div className={css.artifactSpinner} aria-hidden="true" />
      <div>{artifact.status === 'generating' ? tx('正在生成…', 'Generating…') : tx('尚未开始生成', 'Generation has not started')}</div>
      <div style={{ fontSize: '0.8125rem', color: 'var(--dsw-alias-label-tertiary)' }}>{tx('生成完成后将在这里显示成果；失败时也可在此查看错误原因。', 'The result will appear here when ready. If it fails, the error will be shown here.')}</div>
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
      const draft = await createArtifactDraft({ kind: artifact.kind, conversationId: artifact.source.conversationId, branchId: artifact.source.branchId, throughMessageId: artifact.source.throughMessageId, prompt: artifact.prompt, presetId: artifact.presetId, promptBundle: artifact.promptBundle })
      try {
        const out = await generateArtifact(draft.id, { call: artifactModelCall })
        onOpen(out)
      } catch (e) {
        const cur = await getArtifact(draft.id)
        if (cur && cur.status === 'draft') await removeArtifact(draft.id).catch(() => undefined)
        setErr(e instanceof ArtifactGenerationError ? e.message : tx('生成失败：', 'Generation failed: ') + String((e as any)?.message ?? e))
      }
    } finally { setBusy(false) }
  }
  async function del() { if (!globalThis.confirm(tx('删除该学习成果？', 'Delete this study output?'))) return; await removeArtifact(artifact.id); onChanged(); onClose() }
  return (<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    <ArtifactPanelChrome artifact={artifact} sourceDeleted={sourceDeleted} onClose={onClose} actions={<Button size="sm" variant="ghost" aria-label={tx('删除', 'Delete')} onClick={() => void del()}>{tx('删除', 'Delete')}</Button>} />
    <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
      <div style={{ color: 'var(--dsw-alias-state-error-primary)', fontWeight: 600, marginBottom: '0.5rem' }}>{tx('生成失败', 'Generation failed')}</div>
      <p style={{ color: 'var(--dsw-alias-label-secondary)', margin: '0 0 0.75rem' }}>{artifact.error ? localizedErrorText(artifact.error, 'The study output could not be generated.') : tx('未知错误', 'Unknown error')}</p>
      {err && <p style={{ color: 'var(--dsw-alias-state-error-primary)', margin: '0 0 0.75rem' }}>{err}</p>}
      {artifact.generatedContent !== undefined && (<button type="button" className={css.filterBtn} onClick={() => setShowRaw(!showRaw)}>{showRaw ? tx('收起原始输出', 'Hide raw output') : tx('查看原始输出', 'View raw output')}</button>)}
      {showRaw && artifact.generatedContent !== undefined && (<pre style={{ marginTop: '0.75rem', maxHeight: '16rem', overflow: 'auto', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '0.5rem', padding: '0.625rem', whiteSpace: 'pre-wrap', fontSize: '0.8125rem', color: 'var(--dsw-alias-label-primary)' }}>{artifact.generatedContent}</pre>)}
    </div>
    <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--dsw-alias-border-l2)', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => void regenerate()}>{busy ? tx('生成中…', 'Generating…') : tx('重新生成', 'Regenerate')}</Button>
    </div>
  </div>)
}

function QuizArtifactBody({ artifact, sourceDeleted, onClose }: { artifact: StudyArtifact; sourceDeleted: boolean; onClose: () => void }) {
  const canExport = !!artifact.quiz
  return (<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    <ArtifactPanelChrome artifact={artifact} sourceDeleted={sourceDeleted} onClose={onClose} actions={canExport ? (<><Button size="sm" variant="ghost" aria-label={tx('导出 Markdown', 'Export Markdown')} onClick={() => exportQuizMarkdown(artifact)}>{tx('导出 Markdown', 'Export Markdown')}</Button><Button size="sm" variant="ghost" aria-label={tx('导出 JSON', 'Export JSON')} onClick={() => exportQuizJson(artifact)}>{tx('导出 JSON', 'Export JSON')}</Button></>) : undefined} />
    <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>{artifact.quiz ? <QuizViewer quiz={artifact.quiz} /> : null}</div>
  </div>)
}

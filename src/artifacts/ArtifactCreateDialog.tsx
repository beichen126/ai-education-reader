import { useEffect, useMemo, useState } from 'react'
import { Button } from '../dsh/primitives/Button'
import { listPromptCatalog, getPromptDefinition, saveAsArtifactPromptDefinition } from '../prompts/prompt-service'
import { capturePromptSnapshot } from '../prompts/prompt-resolution'
import { getBuiltinArtifactPrompt } from '../prompts/prompt-registry'
import type { ArtifactPrompt, ArtifactPromptSnapshot, ProtocolPrompt, ProtocolPromptSnapshot, PromptDefinition } from '../prompts/prompt-types'
import type { ArtifactKind, CreateArtifactKind } from './artifact-types'
import css from './artifact.module.css'

type Props = {
  sourceLabel: string
  onSubmit: (input: { kind: CreateArtifactKind; prompt: string; presetId?: string; promptBundle: { template: ArtifactPromptSnapshot; userPrompt: string; protocol?: ProtocolPromptSnapshot; resolvedAt: number } }) => void
  onCancel: () => void
  busy?: boolean
  initialKind?: ArtifactKind
  error?: string
}

// Artifact templates inside each mode come from the Prompt catalog; the prompt
// text below is a run-local edit. Legacy kinds are intentionally not creatable.
const MODE_KINDS: readonly CreateArtifactKind[] = ['note', 'quiz']

function preferredTemplate(candidates: ArtifactPrompt[], kind: CreateArtifactKind): ArtifactPrompt | undefined {
  return candidates.find((item) => item.source === 'builtin' && item.id === 'builtin-artifact-' + kind)
    ?? candidates.find((item) => item.source === 'builtin')
    ?? candidates[0]
}

export function ArtifactCreateDialog({ sourceLabel, onSubmit, onCancel, busy, initialKind, error: genError }: Props) {
  const initKind: CreateArtifactKind = initialKind === 'quiz' ? 'quiz' : 'note'
  const initialBuiltin = getBuiltinArtifactPrompt(initKind)
  const [kind, setKind] = useState<CreateArtifactKind>(initKind)
  const [catalog, setCatalog] = useState<PromptDefinition[]>([])
  const [protocols, setProtocols] = useState<PromptDefinition[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(initialBuiltin?.id)
  // The catalog is durable/async, but opening the established dialog should not
  // briefly erase its canonical prompt while IndexedDB is loading.
  const [prompt, setPrompt] = useState(initialBuiltin?.userPrompt ?? '')
  const [saveAsName, setSaveAsName] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    void Promise.all([listPromptCatalog('artifact'), listPromptCatalog('protocol')]).then(([artifactRows, protocolRows]) => {
      if (!active) return
      setCatalog(artifactRows)
      setProtocols(protocolRows)
    }).catch((e) => { if (active) setError(e instanceof Error ? e.message : '提示词目录读取失败') })
    return () => { active = false }
  }, [])

  const templates = useMemo(() => catalog.filter((item): item is ArtifactPrompt => item.kind === 'artifact' && item.artifactKind === kind && item.enabled), [catalog, kind])
  const selectedTemplate = templates.find((item) => item.id === selectedId) ?? preferredTemplate(templates, kind)
  const protocolsById = useMemo(() => new Map(protocols.filter((item): item is ProtocolPrompt => item.kind === 'protocol').map((item) => [item.id, item])), [protocols])

  // Catalog load and kind changes choose a template once; later text edits never
  // mutate that template or write it back to the catalog.
  useEffect(() => {
    if (!selectedTemplate) return
    if (selectedId !== selectedTemplate.id) {
      setSelectedId(selectedTemplate.id)
      setPrompt(selectedTemplate.userPrompt)
      setSaveAsName(selectedTemplate.name + '（我的）')
      setNotice(undefined)
    }
  }, [selectedTemplate, selectedId])

  function selectKind(next: CreateArtifactKind) {
    const builtin = getBuiltinArtifactPrompt(next)
    setKind(next); setSelectedId(builtin?.id); setPrompt(builtin?.userPrompt ?? ''); setSaveAsName(''); setError(undefined); setNotice(undefined)
  }

  function selectTemplate(template: ArtifactPrompt) {
    setSelectedId(template.id)
    setPrompt(template.userPrompt)
    setSaveAsName(template.name + '（我的）')
    setError(undefined); setNotice(undefined)
  }

  async function protocolSnapshotFor(template: ArtifactPrompt, capturedAt: number): Promise<ProtocolPromptSnapshot | undefined> {
    if (!template.protocolId) return undefined
    const protocol = protocolsById.get(template.protocolId) ?? await getPromptDefinition(template.protocolId)
    if (!protocol || protocol.kind !== 'protocol') throw new Error('所选模板的 protocol 不存在。')
    return capturePromptSnapshot(protocol, capturedAt) as ProtocolPromptSnapshot
  }

  async function submit() {
    if (!selectedTemplate) { setError('正在读取可用提示词，请稍候。'); return }
    if (!prompt.trim()) { setError('本次要求不能为空'); return }
    setError(undefined); setNotice(undefined)
    const resolvedAt = Date.now()
    try {
      const protocol = await protocolSnapshotFor(selectedTemplate, resolvedAt)
      const template = capturePromptSnapshot(selectedTemplate, resolvedAt) as ArtifactPromptSnapshot
      const userPrompt = prompt.trim()
      onSubmit({ kind, prompt: userPrompt, presetId: selectedTemplate.id, promptBundle: { template, userPrompt, ...(protocol ? { protocol } : {}), resolvedAt } })
    } catch (e) { setError(e instanceof Error ? e.message : '提示词解析失败') }
  }

  async function saveAs() {
    if (!selectedTemplate) { setError('尚未选择模板'); return }
    if (!prompt.trim()) { setError('本次要求不能为空'); return }
    if (!saveAsName.trim()) { setError('另存为名称不能为空'); return }
    setSaving(true); setError(undefined); setNotice(undefined)
    try {
      const result = await saveAsArtifactPromptDefinition(selectedTemplate.id, { name: saveAsName, userPrompt: prompt.trim() })
      const nextCatalog = await listPromptCatalog('artifact')
      setCatalog(nextCatalog)
      setSelectedId(result.definition.id)
      setPrompt(result.definition.kind === 'artifact' ? result.definition.userPrompt : prompt)
      setNotice(result.warnings.length ? result.warnings.map((item) => item.message).join(' ') : '已另存为提示词。')
    } catch (e) { setError(e instanceof Error ? e.message : '另存为失败') }
    finally { setSaving(false) }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy && !saving) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, busy, saving])

  return (<div className={css.dialog} role="dialog" aria-modal="true" aria-label="创建学习成果">
    <h3 className={css.dialogTitle}>创建学习成果</h3>
    <div><div className={css.fieldLabel}>来源</div><div className={css.sourceLine}>{sourceLabel}</div></div>
    <div>
      <div className={css.fieldLabel}>类型</div>
      <div className={css.kindRow} role="radiogroup" aria-label="类型">
        {MODE_KINDS.map((item) => {
          const labels = { note: '整理成笔记', quiz: '生成题目' } as const
          return <button key={item} type="button" data-testid={'artifact-kind-' + item} disabled={busy || saving} className={css.filterBtn + (kind === item ? ' ' + css.active : '')} role="radio" aria-checked={kind === item} onClick={() => selectKind(item)}>{labels[item]}</button>
        })}
      </div>
    </div>
    <div>
      <div className={css.fieldLabel}>模板</div>
      <div className={css.opList} role="listbox" aria-label="Artifact 模板">
        {templates.map((template) => <button key={template.id} type="button" role="option" aria-selected={selectedTemplate?.id === template.id} disabled={busy || saving} className={css.filterBtn + (selectedTemplate?.id === template.id ? ' ' + css.active : '')} onClick={() => selectTemplate(template)}>{template.name}</button>)}
        {catalog.length > 0 && templates.length === 0 && <span className={css.cardMeta}>没有可用的已启用模板，请在提示词管理中启用一个。</span>}
      </div>
      {selectedTemplate && <div className={css.cardMeta} style={{ marginTop: '0.375rem' }}>模板：{selectedTemplate.name} · revision {selectedTemplate.revision} · {selectedTemplate.source === 'builtin' ? 'canonical' : '本地自定义'}</div>}
    </div>
    <div>
      <div className={css.fieldLabel}>本次要求 <span className={css.cardMeta}>（只影响本次生成，不会修改模板）</span></div>
      <textarea className={css.promptArea} value={prompt} aria-label="本次要求" disabled={busy || saving} onChange={(event) => { setPrompt(event.target.value); setNotice(undefined) }} />
    </div>
    <div className={css.customArea}>
      <div className={css.fieldLabel}>另存为提示词</div>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <input className={css.actionName} value={saveAsName} disabled={busy || saving || !selectedTemplate} aria-label="另存为名称" placeholder="提示词名称" onChange={(event) => setSaveAsName(event.target.value)} />
        <Button variant="ghost" onClick={() => void saveAs()} disabled={busy || saving || !selectedTemplate}>{saving ? '保存中…' : '另存为提示词'}</Button>
      </div>
    </div>
    {genError && <div className={css.error} role="alert">{genError}</div>}
    {error && <div className={css.error} role="alert">{error}</div>}
    {notice && <div className={css.cardMeta} role="status">{notice}</div>}
    <div className={css.dialogFoot}>
      <Button variant="ghost" onClick={onCancel} disabled={busy || saving}>取消</Button>
      <Button variant="primary" data-testid="artifact-generate" onClick={() => void submit()} disabled={busy || saving || !selectedTemplate}>{busy ? '生成中…' : '生成'}</Button>
    </div>
  </div>)
}

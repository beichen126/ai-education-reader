import { useEffect, useState } from 'react'
import { Button } from '../dsh/primitives/Button'
import { TRANSFORMATION_PRESETS } from './artifact-prompts'
import type { ArtifactKind } from './artifact-types'
import css from './artifact.module.css'

type Props = {
  sourceLabel: string
  onSubmit: (input: { kind: ArtifactKind; prompt: string; presetId?: string }) => void
  onCancel: () => void
  busy?: boolean
  initialKind?: ArtifactKind
  /** Generation errors surfaced from the caller (A2 — never silently swallowed). */
  error?: string
}

// A10: the DEFAULT creation surface is Note / Quiz / Custom. summary + study-guide are
// still valid kinds (history artifacts remain readable) but are no longer offered here.
const DEFAULT_KIND_SET = new Set<ArtifactKind>(['note', 'quiz', 'custom'])

/**
 * Artifact creation dialog. Mode + editable prompt + source line. No token-consuming
 * auto-preview. The custom kind requires a non-empty prompt. Default prompts come from
 * the registry (never hard-coded in JSX); the user may edit or fully replace them.
 */
export function ArtifactCreateDialog({ sourceLabel, onSubmit, onCancel, busy, initialKind, error: genError }: Props) {
  // Initialize the mode + prompt from the menu action's kind (e.g. 'quiz' via 生成题目),
  // defaulting to 'note'. The prompt is user-editable from here. If the initial kind is
  // not in the default set (legacy action), fall back to 'note'.
  const initKind: ArtifactKind = initialKind && DEFAULT_KIND_SET.has(initialKind) ? initialKind : 'note'
  const [kind, setKind] = useState<ArtifactKind>(initKind)
  const [prompt, setPrompt] = useState(TRANSFORMATION_PRESETS.find((p) => p.kind === initKind)?.defaultPrompt ?? '')
  const [error, setError] = useState<string | undefined>(undefined)
  const preset = TRANSFORMATION_PRESETS.find((p) => p.kind === kind)

  function selectKind(k: ArtifactKind) {
    const p = TRANSFORMATION_PRESETS.find((x) => x.kind === k)
    setKind(k)
    setPrompt(p ? p.defaultPrompt : '')
    setError(undefined)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  function submit() {
    if (!prompt.trim()) { setError('提示词不能为空'); return }
    onSubmit({ kind, prompt: prompt.trim(), presetId: preset?.id })
  }

  return (<div className={css.dialog} role="dialog" aria-modal="true" aria-label="创建学习成果">
    <h3 className={css.dialogTitle}>创建学习成果</h3>
    <div>
      <div className={css.fieldLabel}>来源</div>
      <div className={css.sourceLine}>{sourceLabel}</div>
    </div>
    <div>
      <div className={css.fieldLabel}>模式</div>
      <div className={css.kindRow} role="radiogroup" aria-label="模式">
        {TRANSFORMATION_PRESETS.filter((p) => DEFAULT_KIND_SET.has(p.kind)).map((p) => (
          <button key={p.kind} type="button" disabled={busy} className={css.filterBtn + (kind === p.kind ? ' ' + css.active : '')} role="radio" aria-checked={kind === p.kind} onClick={() => selectKind(p.kind)}>{p.label}</button>
        ))}
      </div>
      {preset && <div className={css.cardMeta} style={{ marginTop: '0.375rem' }}>{preset.description}</div>}
    </div>
    <div>
      <div className={css.fieldLabel}>提示词</div>
      <textarea className={css.promptArea} value={prompt} aria-label="提示词" disabled={busy} onChange={(e) => setPrompt(e.target.value)} />
    </div>
    {genError && <div className={css.error} role="alert">{genError}</div>}
    {error && <div className={css.error}>{error}</div>}
    <div className={css.dialogFoot}>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>取消</Button>
      <Button variant="primary" onClick={submit} disabled={busy}>{busy ? '生成中…' : '生成'}</Button>
    </div>
  </div>)
}

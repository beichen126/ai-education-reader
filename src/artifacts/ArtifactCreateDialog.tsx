import { useEffect, useState } from 'react'
import { Button } from '../dsh/primitives/Button'
import { TRANSFORMATION_PRESETS } from './artifact-prompts'
import { listCustomActions, createCustomAction, updateCustomAction, deleteCustomAction } from './custom-action-store'
import type { ArtifactKind, CustomArtifactAction } from './artifact-types'
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

// A10: the DEFAULT creation surface is Note / Quiz / Custom. summary + study-guide are still
// valid kinds (history artifacts remain readable) but are no longer top-level modes. They are
// offered INSIDE the custom "常用操作" list and still use their original default prompts.
const MODE_KINDS: ArtifactKind[] = ['note', 'quiz', 'custom']
// Built-in presets surfaced inside the custom surface (总结 / 学习指南). They are READ-ONLY:
// the user can base a generation on one, or 另存为自定义操作, but cannot delete them.
const BUILTIN_CUSTOM_PRESET_IDS = ['summary', 'study-guide']

/** A selectable custom-surface operation: either a READ-ONLY built-in preset or a saved action. */
type CustomOp = { kind: 'builtin' | 'saved'; key: string; name: string; prompt: string; action?: CustomArtifactAction }

export function ArtifactCreateDialog({ sourceLabel, onSubmit, onCancel, busy, initialKind, error: genError }: Props) {
  const initKind: ArtifactKind = MODE_KINDS.includes(initialKind!) && initialKind ? initialKind! : 'note'
  const [kind, setKind] = useState<ArtifactKind>(initKind)
  const [actions, setActions] = useState<CustomArtifactAction[]>([])
  const [selectedKey, setSelectedKey] = useState<string>('custom')            // builtin id / action id / 'custom'(blank)
  const [name, setName] = useState('')
  // Initialize the editable prompt from the selected mode's default preset (note/quiz/custom),
  // so note/quiz open pre-filled exactly as before; custom lets the user pick a saved op.
  const [prompt, setPrompt] = useState(TRANSFORMATION_PRESETS.find((p) => p.kind === initKind)?.defaultPrompt ?? '')
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => { void listCustomActions().then(setActions) }, [])

  // Prompt presets for the 'note'/'quiz' modes (unchanged). custom mode uses the op list.
  const preset = TRANSFORMATION_PRESETS.find((p) => p.kind === kind)

  function builtinOps(): CustomOp[] {
    return BUILTIN_CUSTOM_PRESET_IDS
      .map((id) => TRANSFORMATION_PRESETS.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => ({ kind: 'builtin' as const, key: p.id, name: p.label, prompt: p.defaultPrompt }))
  }
  function savedOps(): CustomOp[] {
    return actions.map((a) => ({ kind: 'saved' as const, key: a.id, name: a.name, prompt: a.prompt, action: a }))
  }
  const customOps: CustomOp[] = [...builtinOps(), ...savedOps()]

  function selectKind(k: ArtifactKind) {
    setKind(k); setError(undefined)
    const p = TRANSFORMATION_PRESETS.find((x) => x.kind === k)
    setPrompt(p ? p.defaultPrompt : '')
    setName(''); setSelectedKey('custom'); setSaved(false)
  }

  function selectOp(op: CustomOp | null) {
    if (!op) { setSelectedKey('custom'); setName(''); setPrompt(''); setSaved(false); return }
    setSelectedKey(op.key)
    setName(op.name)
    setPrompt(op.prompt)
    setSaved(op.kind === 'saved')
  }

  function newAction() {
    setSelectedKey('custom'); setName(''); setPrompt(''); setSaved(false); setError(undefined)
  }

  function submit() {
    if (!prompt.trim()) { setError('提示词不能为空'); return }
    onSubmit({ kind, prompt: prompt.trim(), presetId: preset?.id })
  }

  async function saveAction() {
    if (!name.trim()) { setError('操作名称不能为空'); return }
    if (!prompt.trim()) { setError('提示词不能为空'); return }
    setError(undefined)
    // Distinguish the three operation classes (v1.2.0):
    //  - saved action  -> UPDATE it ("保存修改")
    //  - builtin preset（总结/学习指南）-> 另存为自定义操作 (CREATE)
    //  - new ('custom') -> CREATE
    const op = selectedKey !== 'custom' ? customOps.find((o) => o.key === selectedKey) : null
    setSaving(true)
    try {
      if (op && op.kind === 'saved') {
        await updateCustomAction(op.key, { name, prompt })
      } else {
        const created = await createCustomAction({ name, prompt })
        setSelectedKey(created.id)
      }
      setActions(await listCustomActions())
      setSaved(true)
    } catch (e) {
      // Never swallow: surface a clear error and keep the entered values (no "已保存").
      setSaved(false)
      setError(e instanceof Error ? e.message : '保存操作失败，请重试。')
    } finally {
      setSaving(false)
    }
  }

  async function removeAction() {
    if (selectedKey === 'custom') return
    const op = customOps.find((o) => o.key === selectedKey)
    if (!op || op.kind !== 'saved' || !op.action) return
    if (!globalThis.confirm('确认删除操作「' + op.name + '」？')) return
    await deleteCustomAction(op.action.id)
    setActions(await listCustomActions())
    setSelectedKey('custom'); setName(''); setPrompt(''); setSaved(false)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const selectedOp = customOps.find((o) => o.key === selectedKey) || null

  return (<div className={css.dialog} role="dialog" aria-modal="true" aria-label="创建学习成果">
    <h3 className={css.dialogTitle}>创建学习成果</h3>
    <div>
      <div className={css.fieldLabel}>来源</div>
      <div className={css.sourceLine}>{sourceLabel}</div>
    </div>
    <div>
      <div className={css.fieldLabel}>模式</div>
      <div className={css.kindRow} role="radiogroup" aria-label="模式">
        {TRANSFORMATION_PRESETS.filter((p) => MODE_KINDS.includes(p.kind)).map((p) => (
          <button key={p.kind} type="button" data-testid={'artifact-kind-' + p.kind} disabled={busy} className={css.filterBtn + (kind === p.kind ? ' ' + css.active : '')} role="radio" aria-checked={kind === p.kind} onClick={() => selectKind(p.kind)}>{p.label}</button>
        ))}
      </div>
      {kind !== 'custom' && preset && <div className={css.cardMeta} style={{ marginTop: '0.375rem' }}>{preset.description}</div>}
    </div>

    {kind === 'custom' ? (
      <div className={css.customArea}>
        <div className={css.fieldLabel}>操作</div>
        <div className={css.opList}>
          {customOps.map((o) => (
            <button key={o.key} type="button" disabled={busy} className={css.filterBtn + (selectedKey === o.key ? ' ' + css.active : '')} onClick={() => selectOp(o)}>{o.name}</button>
          ))}
          <button type="button" disabled={busy} className={css.filterBtn + (selectedKey === 'custom' ? ' ' + css.active : '')} onClick={newAction}>+ 新建操作</button>
        </div>
        <div className={css.fieldLabel}>操作名称</div>
        <input className={css.actionName} value={name} disabled={busy} aria-label="操作名称" placeholder="操作名称（例如：解释得更简单）" onChange={(e) => setName(e.target.value)} />
        <div className={css.fieldLabel}>提示词</div>
        <textarea className={css.promptArea} value={prompt} aria-label="提示词" disabled={busy} onChange={(e) => setPrompt(e.target.value)} />
      </div>
    ) : (
      <div>
        <div className={css.fieldLabel}>提示词</div>
        <textarea className={css.promptArea} value={prompt} aria-label="提示词" disabled={busy} onChange={(e) => setPrompt(e.target.value)} />
      </div>
    )}

    {genError && <div className={css.error} role="alert">{genError}</div>}
    {error && <div className={css.error}>{error}</div>}
    <div className={css.dialogFoot}>
      {kind === 'custom' && (
        <>
          <Button variant="ghost" onClick={removeAction} disabled={busy || (selectedOp?.kind !== 'saved')}>删除</Button>
          <Button variant="ghost" onClick={saveAction} disabled={busy || saving}>{saving ? '保存中…' : (saved ? '保存修改' : '保存为操作')}</Button>
        </>
      )}
      <Button variant="ghost" onClick={onCancel} disabled={busy}>取消</Button>
      <Button variant="primary" data-testid="artifact-generate" onClick={submit} disabled={busy}>{busy ? '生成中…' : '生成'}</Button>
    </div>
  </div>)
}

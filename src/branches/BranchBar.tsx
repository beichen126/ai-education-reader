import { useEffect, useRef, useState } from 'react'
import { Button } from '../dsh/primitives/Button'
import { deleteBranchSubtree, renameBranch } from './branch-service'
import { resolveBranchLineage, descendantBranchIds } from './branch-path'
import type { ConversationBranch } from './branch-types'
import { branchThreadKey, useDraft } from '../engine/draft-store'
import { getPromptPreferences } from '../prompts/prompt-preferences'
import { capturePromptSnapshot } from '../prompts/prompt-resolution'
import { listConversationModeDefinitions, promptSnapshotNeedsApply, samePromptSnapshot, switchConversationMode } from '../prompts/prompt-mode-service'
import type { ConversationModePrompt, PromptTransition } from '../prompts/prompt-types'
import css from './branch.module.css'

type Props = {
  conversationId: string
  branches: ConversationBranch[]
  activeBranchId?: string
  effectiveMessageCount: number
  effectiveTransitions: PromptTransition[]
  busy: boolean
  onSwitch: (branchId: string | undefined) => Promise<void> | void
  onChanged: () => void
  onModeChanged: () => Promise<void> | void
}

type OpenMenu = 'route' | 'mode' | null

/** Route + mode context for the active thread. The route controls remain independent from mode history. */
export function BranchBar({ conversationId, branches, activeBranchId, effectiveMessageCount, effectiveTransitions, busy, onSwitch, onChanged, onModeChanged }: Props) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [modes, setModes] = useState<ConversationModePrompt[]>([])
  const [defaultModeId, setDefaultModeId] = useState('builtin-conversation-default')
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [modeError, setModeError] = useState<string | null>(null)
  const modeTriggerRef = useRef<HTMLButtonElement | null>(null)
  const modeItemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const draft = useDraft(activeBranchId ? branchThreadKey(activeBranchId) : conversationId)

  useEffect(() => {
    let cancelled = false
    void Promise.all([listConversationModeDefinitions(), getPromptPreferences()]).then(([definitions, preferences]) => {
      if (cancelled) return
      setModes(definitions)
      setDefaultModeId(preferences.defaultConversationModeId)
    }).catch(() => { if (!cancelled) setModeError('无法加载会话模式。') })
    return () => { cancelled = true }
  }, [conversationId])

  useEffect(() => {
    if (!openMenu) { setEditId(null); return }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpenMenu(null)
      if (openMenu === 'mode') modeTriggerRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [openMenu])

  const lineage = activeBranchId ? resolveBranchLineage(branches, activeBranchId) : null
  const activeTransition = effectiveTransitions[effectiveTransitions.length - 1]
  const activeSnapshot = activeTransition?.snapshot
  const legacy = effectiveMessageCount > 0 && !activeTransition
  const selectedDefinition = activeSnapshot?.profileId ? modes.find((mode) => mode.id === activeSnapshot.profileId) : modes.find((mode) => mode.id === defaultModeId)
  const activeModeName = legacy ? '模式未记录（来自 v1.x）' : (activeSnapshot?.name || selectedDefinition?.name || '默认')
  const hasNewRevision = !!activeSnapshot && !!selectedDefinition && promptSnapshotNeedsApply(activeSnapshot, selectedDefinition)
  const draftNonEmpty = draft.text.trim().length > 0 || draft.imageIds.length > 0
  const disabledReason = busy ? '发送或生成中，停止后才能切换模式' : switchingId ? '正在应用会话模式' : undefined

  async function go(branchId: string | undefined) {
    setOpenMenu(null)
    await onSwitch(branchId)
  }

  async function saveRename() {
    if (editId && editTitle.trim()) {
      await renameBranch(editId, editTitle)
      setEditId(null)
      onChanged()
    }
  }

  async function removeBranch(branchId: string) {
    const descendants = descendantBranchIds(branches, branchId).length
    const message = '删除该分支及其所有子分支？' + (descendants > 0 ? '（含 ' + descendants + ' 个子分支）' : '')
    if (!globalThis.confirm(message)) return
    await deleteBranchSubtree(branchId)
    setOpenMenu(null)
    onChanged()
    if (activeBranchId === branchId) await onSwitch(undefined)
  }

  async function applyMode(definition: ConversationModePrompt) {
    if (busy || switchingId) return
    const snapshotAtBoundary = activeSnapshot
    const exact = snapshotAtBoundary && samePromptSnapshot(snapshotAtBoundary, capturePromptSnapshot(definition, snapshotAtBoundary.capturedAt))
    if (exact) { setOpenMenu(null); return }
    const history = effectiveMessageCount > 0
    const draftNote = draftNonEmpty ? '\n当前草稿将在新模式下发送。' : ''
    const confirmation = history ? `从下一条消息开始使用「${definition.name}」？${draftNote}` : `使用「${definition.name}」作为当前模式？`
    if (history && !globalThis.confirm(confirmation)) return
    setSwitchingId(definition.id)
    setModeError(null)
    try {
      await switchConversationMode({ conversationId, branchId: activeBranchId, modeId: definition.id })
      setOpenMenu(null)
      await onModeChanged()
    } catch (error) {
      setModeError(error instanceof Error ? error.message : '无法切换会话模式。')
    } finally {
      setSwitchingId(null)
    }
  }

  function handleModeMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = modeItemRefs.current.filter((item): item is HTMLButtonElement => !!item && !item.disabled)
    if (event.key === 'Escape') { event.preventDefault(); setOpenMenu(null); modeTriggerRef.current?.focus(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div className={css.bar} role="navigation" aria-label="会话上下文">
      <div className={css.contextRow}>
        <span className={css.contextLabel}>当前路线</span>
        <span className={css.crumb}>
          <button type="button" className={css.branchItem + (!activeBranchId ? ' ' + css.active : '')} onClick={() => void go(undefined)} aria-label="切换到主线">主线</button>
          {activeBranchId && lineage ? lineage.map((id, index) => {
            const branch = branches.find((item) => item.id === id)
            return <span key={id} className={css.path}><span className={css.sep}>›</span><button type="button" className={css.branchItem + (id === activeBranchId ? ' ' + css.active : '')} onClick={() => void go(id)}>{branch ? branch.title : ('分支 ' + (index + 1))}</button></span>
          }) : null}
        </span>
        {branches.length > 0 && <div className={css.switcher}>
          <Button size="sm" variant="outline" aria-haspopup="menu" aria-expanded={openMenu === 'route'} aria-label="切换路线" onClick={() => setOpenMenu(openMenu === 'route' ? null : 'route')}>切换 ▾</Button>
          {openMenu === 'route' && <div className={css.menu} role="menu" aria-label="路线">
            <button type="button" className={css.menuItem + (!activeBranchId ? ' ' + css.active : '')} role="menuitem" onClick={() => void go(undefined)}>主线</button>
            {branches.map((branch) => <div key={branch.id}>
              <div className={css.menuLine}><button type="button" className={css.menuItem + (branch.id === activeBranchId ? ' ' + css.active : '')} role="menuitem" onClick={() => void go(branch.id)}>{branch.title}</button></div>
              <div className={css.menuActions}>
                {editId === branch.id ? <input className={css.editInput} value={editTitle} autoFocus aria-label="分支名称" onChange={(event) => setEditTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveRename(); if (event.key === 'Escape') setEditId(null) }} /> : <>
                  <button type="button" className={css.menuItem} role="menuitem" aria-label={'重命名 ' + branch.title} onClick={() => { setEditId(branch.id); setEditTitle(branch.title) }}>✎ 重命名</button>
                  <button type="button" className={css.menuItem + ' ' + css.danger} role="menuitem" aria-label={'删除 ' + branch.title} onClick={() => void removeBranch(branch.id)}>🗑 删除</button>
                </>}
              </div>
            </div>)}
          </div>}
        </div>}
      </div>

      <div className={css.contextRow}>
        <span className={css.contextLabel}>模式</span>
        <span className={css.activeMode} data-testid="active-conversation-mode" aria-live="polite">{activeModeName}</span>
        {legacy && <span className={css.legacyHint} data-testid="legacy-mode-hint">模式未记录</span>}
        {hasNewRevision && selectedDefinition && <><span className={css.revisionHint}>有新版本</span><button type="button" className={css.applyButton} disabled={!!disabledReason} onClick={() => void applyMode(selectedDefinition)}>应用新版本</button></>}
        <div className={css.switcher}>
          <Button ref={modeTriggerRef} size="sm" variant="outline" disabled={!!disabledReason} aria-haspopup="menu" aria-expanded={openMenu === 'mode'} aria-label="切换对话模式" title={disabledReason} onClick={() => setOpenMenu(openMenu === 'mode' ? null : 'mode')}>切换 ▾</Button>
          {openMenu === 'mode' && <div className={css.menu + ' ' + css.modeMenu} role="menu" aria-label="模式" onKeyDown={handleModeMenuKeyDown}>
            <div className={css.menuHeading}>模式</div>
            {modes.map((mode, index) => {
              const selected = mode.id === activeSnapshot?.profileId || (!activeSnapshot && mode.id === defaultModeId)
              return <button key={mode.id} ref={(node) => { modeItemRefs.current[index] = node }} type="button" className={css.menuItem + (selected ? ' ' + css.active : '')} role="menuitemradio" aria-checked={selected} disabled={!!disabledReason} onClick={() => void applyMode(mode)}>{mode.name}{selected ? ' · 当前' : ''}</button>
            })}
            {disabledReason && <div className={css.disabledHint} role="status">{disabledReason}</div>}
          </div>}
        </div>
        {disabledReason && <span className={css.disabledHint} data-testid="mode-disabled-reason">{disabledReason}</span>}
      </div>
      {modeError && <div className={css.modeError} role="alert">{modeError}</div>}
    </div>
  )
}

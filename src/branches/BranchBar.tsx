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
  const routeTriggerRef = useRef<HTMLButtonElement | null>(null)
  const modeTriggerRef = useRef<HTMLButtonElement | null>(null)
  const focusFrameRef = useRef<number | null>(null)
  const draft = useDraft(activeBranchId ? branchThreadKey(activeBranchId) : conversationId)
  const routeMenuId = 'conversation-route-menu-' + conversationId
  const modeMenuId = 'conversation-mode-menu-' + conversationId
  const initialMenuFocus = useRef<'selected' | 'first' | 'last'>('selected')

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
    const menuId = openMenu === 'mode' ? modeMenuId : routeMenuId
    const menu = document.getElementById(menuId)
    const items = menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')).filter((item) => !(item as HTMLButtonElement).disabled) : []
    if (items.length === 0) return
    const selected = items.findIndex((item) => item.getAttribute('aria-checked') === 'true' || item.getAttribute('data-selected') === 'true')
    const focusIndex = initialMenuFocus.current === 'first'
      ? 0
      : initialMenuFocus.current === 'last'
        ? items.length - 1
        : selected >= 0 ? selected : 0
    initialMenuFocus.current = 'selected'
    items[focusIndex]?.focus()
  }, [openMenu, modeMenuId, routeMenuId, modes, branches, activeBranchId, defaultModeId])

  const lineage = activeBranchId ? resolveBranchLineage(branches, activeBranchId) : null
  const activeTransition = effectiveTransitions[effectiveTransitions.length - 1]
  const activeSnapshot = activeTransition?.snapshot
  const legacy = effectiveMessageCount > 0 && !activeTransition
  const selectedDefinition = activeSnapshot?.profileId ? modes.find((mode) => mode.id === activeSnapshot.profileId) : modes.find((mode) => mode.id === defaultModeId)
  const activeModeName = legacy ? '模式未记录（来自 v1.x）' : (activeSnapshot?.name || selectedDefinition?.name || '默认')
  const hasNewRevision = !!activeSnapshot && !!selectedDefinition && promptSnapshotNeedsApply(activeSnapshot, selectedDefinition)
  const draftNonEmpty = draft.text.trim().length > 0 || draft.imageIds.length > 0
  const disabledReason = busy ? '发送或生成中，停止后才能切换模式' : switchingId ? '正在应用会话模式' : undefined

  function focusTrigger(kind: OpenMenu): void {
    if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current)
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null
      const trigger = kind === 'mode' ? modeTriggerRef.current : routeTriggerRef.current
      trigger?.focus()
    })
  }

  function cancelPendingFocus(): void {
    if (focusFrameRef.current === null) return
    window.cancelAnimationFrame(focusFrameRef.current)
    focusFrameRef.current = null
  }

  function closeMenu(kind: OpenMenu, returnFocus = true): void {
    setOpenMenu(null)
    if (returnFocus && kind) focusTrigger(kind)
  }

  function toggleMenu(kind: Exclude<OpenMenu, null>): void {
    if (openMenu === kind) closeMenu(kind)
    else {
      cancelPendingFocus()
      initialMenuFocus.current = 'selected'
      setOpenMenu(kind)
    }
  }

  function openMenuFromTrigger(kind: Exclude<OpenMenu, null>, direction: 'first' | 'last'): void {
    cancelPendingFocus()
    initialMenuFocus.current = direction
    setOpenMenu(kind)
  }

  function handleTriggerKeyDown(kind: Exclude<OpenMenu, null>, event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    openMenuFromTrigger(kind, event.key === 'ArrowDown' ? 'first' : 'last')
  }

  function handleMenuKeyDown(kind: Exclude<OpenMenu, null>, event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu(kind)
      return
    }
    if (event.key === 'Tab') {
      // Let the browser move focus out of the menu; do not create a focus trap.
      setOpenMenu(null)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const menuId = kind === 'mode' ? modeMenuId : routeMenuId
    const menu = document.getElementById(menuId)
    const items = menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')).filter((item) => !(item as HTMLButtonElement).disabled) : []
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  async function go(branchId: string | undefined) {
    closeMenu('route')
    try { await onSwitch(branchId) } finally { focusTrigger('route') }
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
    closeMenu('route')
    onChanged()
    if (activeBranchId === branchId) await onSwitch(undefined)
  }

  async function applyMode(definition: ConversationModePrompt) {
    if (busy || switchingId) return
    const snapshotAtBoundary = activeSnapshot
    const exact = snapshotAtBoundary && samePromptSnapshot(snapshotAtBoundary, capturePromptSnapshot(definition, snapshotAtBoundary.capturedAt))
    if (exact) { closeMenu('mode'); return }
    const history = effectiveMessageCount > 0
    const draftNote = draftNonEmpty ? '\n当前草稿将在新模式下发送。' : ''
    const confirmation = history ? `从下一条消息开始使用「${definition.name}」？${draftNote}` : `使用「${definition.name}」作为当前模式？`
    if (history && !globalThis.confirm(confirmation)) return
    setSwitchingId(definition.id)
    setModeError(null)
    try {
      await switchConversationMode({ conversationId, branchId: activeBranchId, modeId: definition.id })
      closeMenu('mode')
      await onModeChanged()
      focusTrigger('mode')
    } catch (error) {
      setModeError(error instanceof Error ? error.message : '无法切换会话模式。')
      closeMenu('mode')
    } finally {
      setSwitchingId(null)
    }
  }

  return (
    <div className={css.bar} role="navigation" aria-label="会话上下文">
      <div className={css.contextRow} data-testid="conversation-context-row">
        <span className={css.contextLabel}>当前路线</span>
        <span className={css.crumb}>
          <button type="button" className={css.branchItem + (!activeBranchId ? ' ' + css.active : '')} onClick={() => void go(undefined)} aria-label="切换到主线">主线</button>
          {activeBranchId && lineage ? lineage.map((id, index) => {
            const branch = branches.find((item) => item.id === id)
            return <span key={id} className={css.path}><span className={css.sep}>›</span><button type="button" className={css.branchItem + (id === activeBranchId ? ' ' + css.active : '')} onClick={() => void go(id)}>{branch ? branch.title : ('分支 ' + (index + 1))}</button></span>
          }) : null}
        </span>
        {branches.length > 0 && <div className={css.switcher}>
          <Button ref={routeTriggerRef} size="sm" variant="outline" aria-haspopup="menu" aria-expanded={openMenu === 'route'} aria-controls={routeMenuId} aria-label="切换路线" onKeyDown={(event) => handleTriggerKeyDown('route', event)} onClick={() => toggleMenu('route')}>切换 ▾</Button>
          {openMenu === 'route' && <div id={routeMenuId} className={css.menu} role="menu" aria-label="路线" onKeyDown={(event) => handleMenuKeyDown('route', event)}>
            <button type="button" className={css.menuItem + (!activeBranchId ? ' ' + css.active : '')} role="menuitem" data-selected={!activeBranchId ? 'true' : undefined} onClick={() => void go(undefined)}>主线</button>
            {branches.map((branch) => <div key={branch.id}>
              <div className={css.menuLine}><button type="button" className={css.menuItem + (branch.id === activeBranchId ? ' ' + css.active : '')} role="menuitem" data-selected={branch.id === activeBranchId ? 'true' : undefined} onClick={() => void go(branch.id)}>{branch.title}</button></div>
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

      <div className={css.contextRow} data-testid="conversation-context-row">
        <span className={css.contextLabel}>模式</span>
        <span className={css.activeMode} data-testid="active-conversation-mode" aria-live="polite">{activeModeName}</span>
        {legacy && <span className={css.legacyHint} data-testid="legacy-mode-hint">模式未记录</span>}
        {hasNewRevision && selectedDefinition && <><span className={css.revisionHint}>有新版本</span><button type="button" className={css.applyButton} disabled={!!disabledReason} onClick={() => void applyMode(selectedDefinition)}>应用新版本</button></>}
        <div className={css.switcher}>
          <Button ref={modeTriggerRef} size="sm" variant="outline" disabled={!!disabledReason} aria-haspopup="menu" aria-expanded={openMenu === 'mode'} aria-controls={modeMenuId} aria-label="切换对话模式" title={disabledReason} onKeyDown={(event) => handleTriggerKeyDown('mode', event)} onClick={() => toggleMenu('mode')}>切换 ▾</Button>
          {openMenu === 'mode' && <div id={modeMenuId} className={css.menu + ' ' + css.modeMenu} role="menu" aria-label="模式" onKeyDown={(event) => handleMenuKeyDown('mode', event)}>
            <div className={css.menuHeading}>模式</div>
            {modes.map((mode) => {
              const selected = mode.id === activeSnapshot?.profileId || (!activeSnapshot && mode.id === defaultModeId)
              return <button key={mode.id} type="button" className={css.menuItem + (selected ? ' ' + css.active : '')} role="menuitemradio" aria-checked={selected} disabled={!!disabledReason} onClick={() => void applyMode(mode)}>{mode.name}{selected ? ' · 当前' : ''}</button>
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

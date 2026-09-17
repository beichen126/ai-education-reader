import { useEffect, useRef, useState } from 'react'
import { Button } from '../dsh/primitives/Button'
import { deleteBranchSubtree, renameBranch } from './branch-service'
import { resolveBranchLineage, descendantBranchIds } from './branch-path'
import type { ConversationBranch } from './branch-types'
import { branchThreadKey, useDraft } from '../engine/draft-store'
import { getPromptPreferences } from '../prompts/prompt-preferences'
import { capturePromptSnapshot } from '../prompts/prompt-resolution'
import { listConversationModeDefinitions, promptSnapshotNeedsApply, samePromptSnapshot, switchConversationMode } from '../prompts/prompt-mode-service'
import { PROMPT_CATALOG_CHANGED_EVENT } from '../prompts/prompt-service'
import type { ConversationModePrompt, PromptTransition } from '../prompts/prompt-types'
import { promptDisplayName } from '../prompts/prompt-display'
import { localizedBranchTitle, localizedErrorText, tx } from '../engine/locale'
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

/** Route context for the active thread, including the mode used by future messages. */
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
  const routeMenuId = 'conversation-route-menu-' + conversationId
  const modeMenuId = 'conversation-mode-menu-' + conversationId
  const initialMenuFocus = useRef<'selected' | 'first' | 'last'>('selected')
  const draft = useDraft(activeBranchId ? branchThreadKey(activeBranchId) : conversationId)

  const loadModes = () => {
    let cancelled = false
    void Promise.all([listConversationModeDefinitions(), getPromptPreferences()]).then(([definitions, preferences]) => {
      if (cancelled) return
      setModes(definitions)
      setDefaultModeId(preferences.defaultConversationModeId)
      setModeError(null)
    }).catch(() => { if (!cancelled) setModeError(tx('无法加载会话模式。', 'Unable to load chat modes.')) })
    return () => { cancelled = true }
  }

  useEffect(() => {
    let cleanup = loadModes()
    const refresh = () => { cleanup(); cleanup = loadModes() }
    window.addEventListener(PROMPT_CATALOG_CHANGED_EVENT, refresh)
    return () => { cleanup(); window.removeEventListener(PROMPT_CATALOG_CHANGED_EVENT, refresh) }
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
  }, [openMenu, modeMenuId, routeMenuId, branches, activeBranchId, modes, defaultModeId])

  const lineage = activeBranchId ? resolveBranchLineage(branches, activeBranchId) : null

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
    const message = tx(
      '删除该分支及其所有子分支？' + (descendants > 0 ? '（含 ' + descendants + ' 个子分支）' : ''),
      'Delete this branch and all of its child branches?' + (descendants > 0 ? ' (' + descendants + ' child branches)' : ''),
    )
    if (!globalThis.confirm(message)) return
    await deleteBranchSubtree(branchId)
    closeMenu('route')
    onChanged()
    if (activeBranchId === branchId) await onSwitch(undefined)
  }

  const activeTransition = effectiveTransitions[effectiveTransitions.length - 1]
  const activeSnapshot = activeTransition?.snapshot
  const legacy = effectiveMessageCount > 0 && !activeTransition
  const selectedDefinition = activeSnapshot?.profileId
    ? modes.find((mode) => mode.id === activeSnapshot.profileId)
    : modes.find((mode) => mode.id === defaultModeId)
  const modeName = (name: string | undefined, id?: string) => promptDisplayName(name, id) || tx('默认', 'Default')
  const branchName = (title: string) => localizedBranchTitle(title)
  const activeModeName = legacy ? tx('模式未记录（来自 v1.x）', 'Mode not recorded (from v1.x)') : modeName(activeSnapshot?.name || selectedDefinition?.name, activeSnapshot?.profileId || selectedDefinition?.id)
  const hasNewRevision = !!activeSnapshot && !!selectedDefinition && promptSnapshotNeedsApply(activeSnapshot, selectedDefinition)
  const draftNonEmpty = draft.text.trim().length > 0 || draft.imageIds.length > 0
  const disabledReason = busy ? tx('发送或生成中，停止后才能切换模式', 'Stop the current send or response before switching modes') : switchingId ? tx('正在应用会话模式', 'Applying chat mode') : undefined

  async function applyMode(definition: ConversationModePrompt) {
    if (busy || switchingId) return
    const snapshotAtBoundary = activeSnapshot
    const exact = snapshotAtBoundary && samePromptSnapshot(snapshotAtBoundary, capturePromptSnapshot(definition, snapshotAtBoundary.capturedAt))
    if (exact) { closeMenu('mode'); return }
    const history = effectiveMessageCount > 0
    const displayName = modeName(definition.name, definition.id)
    const draftNote = draftNonEmpty ? tx('\n当前草稿将在新模式下发送。', '\nThe current draft will be sent under the new mode.') : ''
    const confirmation = history
      ? tx(`从下一条消息开始使用「${displayName}」？${draftNote}`, `Use “${displayName}” from the next message?${draftNote}`)
      : tx(`使用「${displayName}」作为当前模式？`, `Use “${displayName}” as the current mode?`)
    if (history && !globalThis.confirm(confirmation)) return
    setSwitchingId(definition.id)
    setModeError(null)
    try {
      await switchConversationMode({ conversationId, branchId: activeBranchId, modeId: definition.id })
      closeMenu('mode')
      await onModeChanged()
      focusTrigger('mode')
    } catch (error) {
      setModeError(localizedErrorText(error, 'Unable to switch chat mode.'))
      closeMenu('mode')
    } finally {
      setSwitchingId(null)
    }
  }

  return (
    <div className={css.bar} role="navigation" aria-label={tx('会话上下文', 'Chat context')}>
      <div className={css.contextRow} data-testid="conversation-context-row">
        <span className={css.contextLabel}>{tx('当前路线', 'Current route')}</span>
        <span className={css.crumb}>
          <button type="button" className={css.branchItem + (!activeBranchId ? ' ' + css.active : '')} onClick={() => void go(undefined)} aria-label={tx('切换到主线', 'Switch to Main')}>{tx('主线', 'Main')}</button>
          {activeBranchId && lineage ? lineage.map((id, index) => {
            const branch = branches.find((item) => item.id === id)
            return <span key={id} className={css.path}><span className={css.sep}>›</span><button type="button" className={css.branchItem + (id === activeBranchId ? ' ' + css.active : '')} onClick={() => void go(id)}>{branch ? branchName(branch.title) : tx('分支 ', 'Branch ') + (index + 1)}</button></span>
          }) : null}
        </span>
        {branches.length > 0 && <div className={css.switcher}>
          <Button ref={routeTriggerRef} size="sm" variant="outline" aria-haspopup="menu" aria-expanded={openMenu === 'route'} aria-controls={routeMenuId} aria-label={tx('切换路线', 'Switch route')} onKeyDown={(event) => handleTriggerKeyDown('route', event)} onClick={() => toggleMenu('route')}>{tx('切换', 'Switch')} ▾</Button>
          {openMenu === 'route' && <div id={routeMenuId} className={css.menu} role="menu" aria-label={tx('路线', 'Routes')} onKeyDown={(event) => handleMenuKeyDown('route', event)}>
            <button type="button" className={css.menuItem + (!activeBranchId ? ' ' + css.active : '')} role="menuitem" data-selected={!activeBranchId ? 'true' : undefined} onClick={() => void go(undefined)}>{tx('主线', 'Main')}</button>
            {branches.map((branch) => <div key={branch.id}>
              <div className={css.menuLine}><button type="button" className={css.menuItem + (branch.id === activeBranchId ? ' ' + css.active : '')} role="menuitem" data-selected={branch.id === activeBranchId ? 'true' : undefined} onClick={() => void go(branch.id)}>{branchName(branch.title)}</button></div>
              <div className={css.menuActions}>
                {editId === branch.id ? <input className={css.editInput} value={editTitle} autoFocus aria-label={tx('分支名称', 'Branch name')} onChange={(event) => setEditTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveRename(); if (event.key === 'Escape') setEditId(null) }} /> : <>
                  <button type="button" className={css.menuItem} role="menuitem" aria-label={tx('重命名 ', 'Rename ') + branchName(branch.title)} onClick={() => { setEditId(branch.id); setEditTitle(branchName(branch.title)) }}>✎ {tx('重命名', 'Rename')}</button>
                  <button type="button" className={css.menuItem + ' ' + css.danger} role="menuitem" aria-label={tx('删除 ', 'Delete ') + branchName(branch.title)} onClick={() => void removeBranch(branch.id)}>🗑 {tx('删除', 'Delete')}</button>
                </>}
              </div>
            </div>)}
          </div>}
        </div>}
      </div>

      <div className={css.contextRow} data-testid="conversation-context-row">
        <span className={css.contextLabel}>{tx('模式', 'Mode')}</span>
        <span className={css.activeMode} data-testid="active-conversation-mode" aria-live="polite">{activeModeName}</span>
        {legacy && <span className={css.legacyHint} data-testid="legacy-mode-hint">{tx('模式未记录', 'Mode not recorded')}</span>}
        {hasNewRevision && selectedDefinition && <><span className={css.revisionHint}>{tx('有新版本', 'Update available')}</span><button type="button" className={css.applyButton} disabled={!!disabledReason} onClick={() => void applyMode(selectedDefinition)}>{tx('应用新版本', 'Apply update')}</button></>}
        <div className={css.switcher}>
          <Button ref={modeTriggerRef} size="sm" variant="outline" disabled={!!disabledReason} aria-haspopup="menu" aria-expanded={openMenu === 'mode'} aria-controls={modeMenuId} aria-label={tx('切换对话模式', 'Switch chat mode')} title={disabledReason} onKeyDown={(event) => handleTriggerKeyDown('mode', event)} onClick={() => toggleMenu('mode')}>{tx('切换', 'Switch')} ▾</Button>
          {openMenu === 'mode' && <div id={modeMenuId} className={css.menu + ' ' + css.modeMenu} role="menu" aria-label={tx('模式', 'Modes')} onKeyDown={(event) => handleMenuKeyDown('mode', event)}>
            <div className={css.menuHeading}>{tx('模式', 'Modes')}</div>
            {modes.map((mode) => {
              const selected = mode.id === activeSnapshot?.profileId || (!activeSnapshot && mode.id === defaultModeId)
              return <button key={mode.id} type="button" className={css.menuItem + (selected ? ' ' + css.active : '')} role="menuitemradio" aria-checked={selected} disabled={!!disabledReason} onClick={() => void applyMode(mode)}>{modeName(mode.name, mode.id)}{selected ? tx(' · 当前', ' · Current') : ''}</button>
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

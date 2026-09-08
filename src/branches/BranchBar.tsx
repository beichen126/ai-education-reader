import { useEffect, useRef, useState } from 'react'
import { Button } from '../dsh/primitives/Button'
import { deleteBranchSubtree, renameBranch } from './branch-service'
import { resolveBranchLineage, descendantBranchIds } from './branch-path'
import type { ConversationBranch } from './branch-types'
import css from './branch.module.css'

type Props = {
  conversationId: string
  branches: ConversationBranch[]
  activeBranchId?: string
  onSwitch: (branchId: string | undefined) => Promise<void> | void
  onChanged: () => void
}

type OpenMenu = 'route' | null

/** Route context for the active thread. Conversation mode is now a static default entry. */
export function BranchBar({ conversationId, branches, activeBranchId, onSwitch, onChanged }: Props) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const routeTriggerRef = useRef<HTMLButtonElement | null>(null)
  const focusFrameRef = useRef<number | null>(null)
  const routeMenuId = 'conversation-route-menu-' + conversationId
  const initialMenuFocus = useRef<'selected' | 'first' | 'last'>('selected')

  useEffect(() => {
    if (!openMenu) { setEditId(null); return }
    const menuId = routeMenuId
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
  }, [openMenu, routeMenuId, branches, activeBranchId])

  const lineage = activeBranchId ? resolveBranchLineage(branches, activeBranchId) : null

  function focusTrigger(): void {
    if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current)
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null
      routeTriggerRef.current?.focus()
    })
  }

  function cancelPendingFocus(): void {
    if (focusFrameRef.current === null) return
    window.cancelAnimationFrame(focusFrameRef.current)
    focusFrameRef.current = null
  }

  function closeMenu(kind: OpenMenu, returnFocus = true): void {
    setOpenMenu(null)
    if (returnFocus && kind) focusTrigger()
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
    const menu = document.getElementById(routeMenuId)
    const items = menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')).filter((item) => !(item as HTMLButtonElement).disabled) : []
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  async function go(branchId: string | undefined) {
    closeMenu('route')
    try { await onSwitch(branchId) } finally { focusTrigger() }
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
        <span className={css.activeMode} data-testid="active-conversation-mode" aria-live="polite">默认</span>
      </div>
    </div>
  )
}

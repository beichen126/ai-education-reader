import { useEffect, useState } from 'react'
import { Button } from '../dsh/primitives/Button'
import { listBranchesByConversation, getActiveBranch, setActiveBranch } from './branch-store'
import { renameBranch, deleteBranchSubtree } from './branch-service'
import { resolveBranchLineage, descendantBranchIds } from './branch-path'
import type { ConversationBranch } from './branch-types'
import css from './branch.module.css'

type Props = {
  conversationId: string
  activeBranchId?: string
  onSwitch: (branchId: string | undefined) => void
  onChanged: () => void
}

/**
 * Lightweight branch switcher. Shows the current path (主线 › 分支2 › …) and lets the
 * user switch among Main / any branch / nested branches, rename, or delete a subtree.
 * Never requires hunting for the original fork message to return to Main.
 */
export function BranchBar({ conversationId, activeBranchId, onSwitch, onChanged }: Props) {
  const [branches, setBranches] = useState<ConversationBranch[]>([])
  const [open, setOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  useEffect(() => { void reload() }, [conversationId])
  async function reload() {
    try {
      const bs = await listBranchesByConversation(conversationId)
      setBranches(bs)
    } catch { /* never crash on a bad branch list */ }
  }
  useEffect(() => { if (!open) setEditId(null) }, [open])

  const lineage = activeBranchId ? resolveBranchLineage(branches, activeBranchId) : null
  const active = activeBranchId ? branches.find((b) => b.id === activeBranchId) : undefined

  async function go(branchId: string | undefined) {
    setOpen(false)
    try { await setActiveBranch(conversationId, branchId) } catch { /* best-effort */ }
    onSwitch(branchId)
  }
  async function saveRename() {
    if (editId && editTitle.trim()) { await renameBranch(editId, editTitle); setEditId(null); onChanged() }
  }
  async function removeBranch(branchId: string) {
    const b = branches.find((x) => x.id === branchId)
    const descendants = descendantBranchIds(branches, branchId).length
    const msg = '删除该分支及其所有子分支？' + (descendants > 0 ? '（含 ' + descendants + ' 个子分支）' : '')
    if (!globalThis.confirm(msg)) return
    await deleteBranchSubtree(branchId)
    setOpen(false)
    onChanged()
    if (activeBranchId === branchId) onSwitch(undefined)
  }

  return (<div className={css.bar} role="navigation" aria-label="分支切换">
    <span className={css.label}>当前路线：</span>
    <span className={css.crumb}>
      <button type="button" className={css.branchItem + (activeBranchId ? '' : ' ' + css.active)} onClick={() => go(undefined)} aria-label="切换到主线">主线</button>
      {activeBranchId && lineage ? lineage.slice(1).map((id, i) => {
        const b = branches.find((x) => x.id === id)
        return (<span key={id} className={css.path}><span className={css.sep}>›</span><button type="button" className={css.branchItem + (id === activeBranchId ? ' ' + css.active : '')} onClick={() => go(id)}>{b ? b.title : ('分支 ' + (i + 2))}</button></span>)
      }) : null}
    </span>
    {branches.length > 0 && (<div style={{ position: 'relative' }} className={css.switcher}>
      <Button size="sm" variant="outline" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>切换 ▾</Button>
      {open && (<div className={css.menu} role="menu">
        <button type="button" className={css.menuItem + (activeBranchId ? '' : ' ' + css.active)} role="menuitem" onClick={() => go(undefined)}>主线</button>
        {branches.map((b) => (<div key={b.id}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <button type="button" className={css.menuItem + (b.id === activeBranchId ? ' ' + css.active : '')} role="menuitem" onClick={() => go(b.id)}>{b.title}</button>
            {editId === b.id ? (<input className={css.editInput} value={editTitle} autoFocus aria-label="分支名称" onChange={(e) => setEditTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveRename(); if (e.key === 'Escape') setEditId(null) }} />) : null}
          </div>
          <div style={{ display: 'flex', gap: '0.25rem', paddingLeft: '0.75rem' }}>
            <button type="button" className={css.menuItem} role="menuitem" aria-label={'重命名 ' + b.title} onClick={() => { setEditId(b.id); setEditTitle(b.title) }}>✎ 重命名</button>
            <button type="button" className={css.menuItem + ' ' + css.danger} role="menuitem" aria-label={'删除 ' + b.title} onClick={() => void removeBranch(b.id)}>🗑 删除</button>
          </div>
        </div>))}
      </div>)}
    </div>)}
  </div>)
}

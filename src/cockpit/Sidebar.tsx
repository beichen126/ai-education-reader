import { useEffect, useState } from 'react'
import { useSessions, sessionsActions, type ChatSession } from '../engine/sessions-store'
import { t } from '../engine/locale'
import { uiActions } from '../engine/ui-store'
import { galleryActions } from '../gallery/gallery-store'
import { layoutStore, useLayoutStore } from '../engine/layout-store'
import { NEW_TITLE } from '../engine/types'
import { displayTitle, sanitizeTitle, MAX_TITLE_LEN } from '../engine/session-title'
import { Button, IconNewChatOutline16, IconSearchOutline16, IconSettingsOutline16, Input } from '../dsh/primitives'
import css from './cockpit.module.css'

function useFullscreen() {
  const [fs, setFs] = useState(false)
  useEffect(() => { const on = () => setFs(!!document.fullscreenElement); document.addEventListener('fullscreenchange', on); return () => document.removeEventListener('fullscreenchange', on) }, [])
  const toggle = () => { const el = document.documentElement as any; if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}) } else if (el && el.requestFullscreen) { const p = el.requestFullscreen({ navigationUI: 'hide' }); if (p && p.catch) p.catch(() => { el.requestFullscreen().catch(() => {}) }) } }
  return { fs, toggle }
}

export function Sidebar({ collapsed, width }: { collapsed: boolean; width: number }) {
  const sessions = useSessions(s => s.list)
  const current = useSessions(s => s.current)
  const currentConv = useSessions(s => s.byId[s.current || ''])
  const status = useSessions(s => s.status)
  const busy = status === 'sending' || status === 'streaming'
  const [q, setQ] = useState('')
  const { fs, toggle } = useFullscreen()
  // Search the same text the user sees (displayTitle), so auto/manual titles are findable.
  const filtered = q ? sessions.filter(s => displayTitle(s).toLowerCase().includes(q.toLowerCase())) : sessions
  const fsTitle = fs ? '退出全屏' : '全屏'
  const narrow = useLayoutStore(s => s.narrow)
  const openHistory = () => { if (narrow) layoutStore.actions.openNarrowSidebar(); else layoutStore.actions.toggleSidebar() }
  const collapseSidebar = () => { if (narrow) layoutStore.actions.closeNarrowSidebar(); else layoutStore.actions.toggleSidebar() }
  if (collapsed) {
    return <div className={css.sideRail} style={{ width }}>
      <Button aria-label="新建会话" title="新建会话" icon={<IconNewChatOutline16 />} onClick={() => sessionsActions.newChat()} />
      <Button aria-label="历史" title="历史会话" onClick={openHistory}><span className={css.railText}>历</span></Button>
      <Button aria-label="资料" title="资料" onClick={() => galleryActions.open(currentConv?.id, 0)}><span className={css.railText}>图</span></Button>
      <Button aria-label="全屏" title={fsTitle} onClick={toggle}><span className={css.railText}>全</span></Button>
      <Button aria-label="设置" title="设置" icon={<IconSettingsOutline16 />} onClick={uiActions.openSettings} />
    </div>
  }
  return (
    <div className={css.sidebar} style={{ width }}>
      <div className={css.sidebarHead}>
        <div className={css.sidebarTitle}>会话</div>
        <div className={css.sidebarHeadBtns}>
          <Button title="收起侧栏" onClick={collapseSidebar}><span aria-hidden className={css.railText}>‹ 收起</span></Button>
          <Button size="sm" title="资料" onClick={() => galleryActions.open(currentConv?.id, 0)}>资料</Button>
          <Button icon={<IconSettingsOutline16 />} onClick={uiActions.openSettings} />
          <Button onClick={toggle}>{fsTitle}</Button>
          <Button icon={<IconNewChatOutline16 />} onClick={() => sessionsActions.newChat()}>{t('sidebar.newChat')}</Button>
        </div>
      </div>
      <div className={css.sidebarSearch}><Input icon={<IconSearchOutline16 />} value={q} onChange={e => setQ(e.target.value)} placeholder={t('sidebar.search')} /></div>
      <div className={css.sidebarList}>
        {filtered.map(s => <SessionRow key={s.id} session={s} active={s.id === current} busy={busy} narrow={narrow} />)}
        {filtered.length === 0 && <div className={css.sidebarEmpty}>暂无会话</div>}
      </div>
    </div>
  )
}

function SessionRow({ session, active, busy, narrow }: { session: ChatSession; active: boolean; busy: boolean; narrow: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [confirming, setConfirming] = useState(false)
  const onOpen = () => { if (busy) { window.alert('正在生成，请先停止生成'); return } sessionsActions.open(session.id); if (narrow) layoutStore.actions.closeNarrowSidebar() }
  const startRename = () => { setMenuOpen(false); setConfirming(false); setRenameVal(displayTitle(session)); setRenaming(true) }
  const commitRename = () => {
    const v = sanitizeTitle(renameVal)
    // Empty/whitespace-only title is never saved; a no-op rename just exits.
    if (v && v !== displayTitle(session)) void sessionsActions.setTitle(session.id, v)
    setRenaming(false)
  }
  const cancelRename = () => setRenaming(false)
  const onDeleteClick = () => { setMenuOpen(false); setConfirming(true) }
  const doDelete = () => { if (confirming) { sessionsActions.remove(session.id); setConfirming(false) } }

  if (renaming) {
    return (
      <div className={css.sessionRowWrap + (active ? ' ' + css.sessionRowWrapActive : '')}>
        <div className={css.rowRename}>
          <input className={css.rowRenameInput} autoFocus value={renameVal} maxLength={MAX_TITLE_LEN}
            onChange={e => setRenameVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitRename() } else if (e.key === 'Escape') { e.preventDefault(); cancelRename() } }}
            onBlur={cancelRename}
          />
          <button className={css.rowRenameBtn} onMouseDown={e => e.preventDefault()} onClick={commitRename}>确定</button>
          <button className={css.rowRenameBtn} onMouseDown={e => e.preventDefault()} onClick={cancelRename}>取消</button>
        </div>
      </div>
    )
  }
  return (
    <div className={css.sessionRowWrap + (active ? ' ' + css.sessionRowWrapActive : '')}>
      <button className={css.sessionRow} onClick={onOpen}>
        <span className={css.sessionDot} data-state={active ? 'done' : 'idle'} />
        <span className={css.sessionTitle}>{displayTitle(session)}</span>
        <span className={css.sessionCount}>{session.messages.length}</span>
      </button>
      <button className={css.rowMenu} title="操作" onClick={() => setMenuOpen(o => !o)}><span className={css.rowMenuDots}>⋯</span></button>
      {menuOpen && (
        <div className={css.rowMenuPopup}>
          <button className={css.rowMenuItem} onClick={startRename}>重命名</button>
          <button className={css.rowMenuItem} onClick={onDeleteClick} data-danger>删除</button>
        </div>
      )}
      {confirming && (
        <div className={css.rowConfirm}><span>删除这个会话？</span><button onClick={doDelete}>删除</button><button onClick={() => setConfirming(false)}>取消</button></div>
      )}
    </div>
  )
}


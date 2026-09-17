import { useEffect, useState } from 'react'
import { useSessions, sessionsActions, type ChatSession } from '../engine/sessions-store'
import { localizedConversationTitle, t, tx } from '../engine/locale'
import { uiActions } from '../engine/ui-store'
import { galleryActions } from '../gallery/gallery-store'
import { documentUiActions } from '../documents/document-ui-store'
import { layoutStore, persistSidebarLayout, useLayoutStore } from '../engine/layout-store'
import { SIDEBAR_COMPACT_THRESHOLD } from '../dsh/layout/columns'
import { displayTitle, sanitizeTitle, MAX_TITLE_LEN } from '../engine/session-title'
import { IconNewChatOutline16, IconSearchOutline16, IconSettingsOutline16, IconClockOutline16, IconFullscreenOutline16, IconFolderOpenOutline16, IconListPenOutline16, IconQuestionOutline14, Input } from '../dsh/primitives'
import { learningUiActions } from '../study-cards/learning-ui-store'
import { IconPhoto16 } from './composer-icons'
import css from './cockpit.module.css'

function useFullscreen() {
  const [fs, setFs] = useState(false)
  useEffect(() => { const on = () => setFs(!!document.fullscreenElement); document.addEventListener('fullscreenchange', on); return () => document.removeEventListener('fullscreenchange', on) }, [])
  const toggle = () => { const el = document.documentElement as any; if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}) } else if (el && el.requestFullscreen) { const p = el.requestFullscreen({ navigationUI: 'hide' }); if (p && p.catch) p.catch(() => { el.requestFullscreen().catch(() => {}) }) } }
  return { fs, toggle }
}

function localizedSessionTitle(session: ChatSession): string {
  return localizedConversationTitle(displayTitle(session))
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
  const filtered = q ? sessions.filter(s => localizedSessionTitle(s).toLowerCase().includes(q.toLowerCase())) : sessions
  const fsTitle = fs ? tx('退出全屏', 'Exit full screen') : tx('全屏', 'Full screen')
  const narrow = useLayoutStore(s => s.narrow)
  const toggleDesktopSidebar = () => {
    layoutStore.actions.toggleSidebar()
    void persistSidebarLayout().catch(error => console.warn('sidebar layout persistence failed', error))
  }
  const openHistory = () => { if (narrow) layoutStore.actions.openNarrowSidebar(); else toggleDesktopSidebar() }
  const collapseSidebar = () => { if (narrow) layoutStore.actions.closeNarrowSidebar(); else toggleDesktopSidebar() }
  const compact = !narrow && width < SIDEBAR_COMPACT_THRESHOLD

  if (collapsed) {
    return (
      <div className={css.sideRail} style={{ width }}>
        <button type="button" className={css.railBtn} data-testid="rail-history" aria-label={tx('历史会话', 'Chat history')} title={tx('历史会话', 'Chat history')} onClick={openHistory}><IconClockOutline16 /></button>
        <button type="button" className={css.railBtn} data-testid="rail-new-chat" aria-label={t('sidebar.newChat')} title={t('sidebar.newChat')} onClick={() => sessionsActions.newChat()}><IconNewChatOutline16 /></button>
        <button type="button" className={css.railBtn} data-testid="rail-images" aria-label={tx('图片资料', 'Images')} title={tx('图片资料', 'Images')} onClick={() => galleryActions.open(currentConv?.id, 0)}><IconPhoto16 /></button>
        <button type="button" className={css.railBtn} data-testid="rail-files" aria-label={tx('本地文件', 'Local files')} title={tx('本地文件', 'Local files')} onClick={() => documentUiActions.openLibrary()}><IconFolderOpenOutline16 /></button>
        <button type="button" className={css.railBtn} data-testid="rail-cards" aria-label={tx('学习卡片', 'Study cards')} title={tx('学习卡片', 'Study cards')} onClick={() => learningUiActions.openLibrary('cards')}><IconListPenOutline16 /></button>
        <div className={css.railSpacer} />
        <button type="button" className={css.railBtn} data-testid="rail-fullscreen" aria-label={fsTitle} title={fsTitle} onClick={toggle}><IconFullscreenOutline16 /></button>
        <button type="button" className={css.railBtn} data-testid="rail-settings" aria-label={tx('设置', 'Settings')} title={tx('设置', 'Settings')} onClick={uiActions.openSettings}><IconSettingsOutline16 /></button>
        <button type="button" className={css.railBtn} data-testid="rail-help" aria-label={tx('帮助', 'Help')} title={tx('帮助', 'Help')} onClick={uiActions.openProductGuide}><IconQuestionOutline14 size={16} /></button>
      </div>
    )
  }
  return (
    <div className={css.sidebar} style={{ width }} data-testid={narrow ? 'mobile-history-drawer' : 'sidebar'} data-compact={compact || undefined} role={narrow ? 'navigation' : undefined} aria-label={narrow ? tx('主导航', 'Main navigation') : undefined}>
      <div className={css.sidebarHead}>
        <div className={css.sidebarTitle}>{t('brand.localBuild')}</div>
        <div className={css.sidebarHeadBtns}>
          <button type="button" className={css.collapseBtn} data-testid="sidebar-collapse" aria-label={tx('收起侧栏', 'Collapse sidebar')} title={tx('收起侧栏', 'Collapse sidebar')} onClick={collapseSidebar}><span aria-hidden="true">‹</span></button>
        </div>
      </div>
      <div className={css.sidebarNew}>
        <button type="button" className={css.newChatBtn} data-testid="sidebar-new-chat" onClick={() => sessionsActions.newChat()}>
          <IconNewChatOutline16 /> {t('sidebar.newChat')}
        </button>
      </div>
      <div className={css.sidebarSection}>{tx('资料', 'Materials')}</div>
      <div className={css.sidebarEntries}>
        <button type="button" className={css.entryBtn} data-testid="sidebar-entry-images" onClick={() => galleryActions.open(currentConv?.id, 0)}>
          <IconPhoto16 /> <span>{tx('图片', 'Images')}</span>
        </button>
        <button type="button" className={css.entryBtn} data-testid="sidebar-entry-files" onClick={() => documentUiActions.openLibrary()}>
          <IconFolderOpenOutline16 /> <span>{tx('文件', 'Files')}</span>
        </button>
      </div>
      <div className={css.sidebarSection}>{tx('学习', 'Study')}</div>
      <div className={css.sidebarEntries}>
        <button type="button" className={css.entryBtn} data-testid="sidebar-entry-cards" onClick={() => learningUiActions.openLibrary('cards')}>
          <IconListPenOutline16 /> <span>{tx('学习卡片', 'Study cards')}</span>
        </button>
      </div>
      <div className={css.sidebarSection}>{tx('会话', 'Chats')}</div>
      <div className={css.sidebarSearch}><Input icon={<IconSearchOutline16 />} value={q} onChange={e => setQ(e.target.value)} placeholder={t('sidebar.search')} /></div>
      <div className={css.sidebarList}>
        {filtered.map(s => <SessionRow key={s.id} session={s} active={s.id === current} busy={busy} narrow={narrow} />)}
        {filtered.length === 0 && <div className={css.sidebarEmpty}>{tx('暂无会话', 'No chats')}</div>}
      </div>
      <div className={css.sidebarFoot}>
        <button type="button" className={css.footBtn} data-testid="sidebar-fullscreen" onClick={toggle}><IconFullscreenOutline16 /> <span>{fsTitle}</span></button>
        <button type="button" className={css.footBtn} data-testid="sidebar-settings" onClick={uiActions.openSettings}><IconSettingsOutline16 /> <span>{tx('设置', 'Settings')}</span></button>
        <button type="button" className={css.footBtn + ' ' + css.footBtnQuiet} data-testid="help-product-guide" onClick={uiActions.openProductGuide}><IconQuestionOutline14 size={16} /> <span>{tx('帮助', 'Help')}</span></button>
      </div>
    </div>
  )
}

function SessionRow({ session, active, busy, narrow }: { session: ChatSession; active: boolean; busy: boolean; narrow: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [confirming, setConfirming] = useState(false)
  const onOpen = () => { if (busy) { window.alert(tx('正在生成，请先停止生成', 'A response is being generated. Stop it first.')); return } sessionsActions.open(session.id); if (narrow) layoutStore.actions.closeNarrowSidebar() }
  const startRename = () => { setMenuOpen(false); setConfirming(false); setRenameVal(localizedSessionTitle(session)); setRenaming(true) }
  const commitRename = () => {
    const v = sanitizeTitle(renameVal)
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
          <input className={css.rowRenameInput} data-testid="session-rename-input" autoFocus value={renameVal} maxLength={MAX_TITLE_LEN}
            onChange={e => setRenameVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitRename() } else if (e.key === 'Escape') { e.preventDefault(); cancelRename() } }}
            onBlur={cancelRename}
          />
          <button className={css.rowRenameBtn} data-testid="session-rename-confirm" onMouseDown={e => e.preventDefault()} onClick={commitRename}>{tx('确定', 'Save')}</button>
          <button className={css.rowRenameBtn} onMouseDown={e => e.preventDefault()} onClick={cancelRename}>{tx('取消', 'Cancel')}</button>
        </div>
      </div>
    )
  }
  return (
    <div className={css.sessionRowWrap + (active ? ' ' + css.sessionRowWrapActive : '')}>
      <button className={css.sessionRow} data-testid="history-session" onClick={onOpen}>
        <span className={css.sessionDot} data-state={active ? 'done' : 'idle'} />
        <span className={css.sessionTitle}>{localizedSessionTitle(session)}</span>
        <span className={css.sessionCount}>{session.messages.length}</span>
      </button>
      <button className={css.rowMenu} title={tx('操作', 'Actions')} onClick={() => setMenuOpen(o => !o)}><span className={css.rowMenuDots}>⋯</span></button>
      {menuOpen && (
        <div className={css.rowMenuPopup}>
          <button className={css.rowMenuItem} onClick={startRename}>{tx('重命名', 'Rename')}</button>
          <button className={css.rowMenuItem} onClick={onDeleteClick} data-danger>{tx('删除', 'Delete')}</button>
        </div>
      )}
      {confirming && (
        <div className={css.rowConfirm}><span>{tx('删除这个会话？', 'Delete this chat?')}</span><button onClick={doDelete}>{tx('删除', 'Delete')}</button><button onClick={() => setConfirming(false)}>{tx('取消', 'Cancel')}</button></div>
      )}
    </div>
  )
}

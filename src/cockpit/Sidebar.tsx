import { useProjects } from '../projects/project-store'
import { ProjectList } from '../projects/ProjectList'
import type { ReaderProject } from '../projects/project-records'
import { generationRegistry } from '../engine/generation-registry'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useSessions, sessionsActions, type ChatSession } from '../engine/sessions-store'
import { localizedConversationTitle, t, tx } from '../engine/locale'
import { uiActions } from '../engine/ui-store'
import { galleryActions } from '../gallery/gallery-store'
import { documentUiActions } from '../documents/document-ui-store'
import { layoutStore, persistSidebarLayout, useLayoutStore } from '../engine/layout-store'
import { SIDEBAR_COMPACT_THRESHOLD } from '../dsh/layout/columns'
import { displayTitle, sanitizeTitle, MAX_TITLE_LEN } from '../engine/session-title'
import { IconNewChatOutline16, IconSearchOutline16, IconSettingsOutline16, IconClockOutline16, IconFullscreenOutline16, IconFolderOpenOutline16, IconListPenOutline16, IconArchiveOutline20, Input } from '../dsh/primitives'
import { learningUiActions } from '../study-cards/learning-ui-store'
import { IconPhoto16 } from './composer-icons'
import css from './cockpit.module.css'
import { useFullscreen } from '../engine/use-fullscreen'
import { isAndroidReader } from '../engine/platform'

function localizedSessionTitle(session: ChatSession): string {
  return localizedConversationTitle(displayTitle(session))
}

export function Sidebar({ collapsed, width }: { collapsed: boolean; width: number }) {
  const sessions = useSessions(s => s.list)
  const current = useSessions(s => s.current)
  const currentConv = useSessions(s => s.byId[s.current || ''])
  const projects = useProjects()
  const [projectMode, setProjectMode] = useState(false)
  const [projectScope, setProjectScope] = useState('')
  const project = projectMode ? projects.find(item => item.id === projectScope) : undefined
  const [q, setQ] = useState('')
  const [showArchive, setShowArchive] = useState(false)
  const [organizationError, setOrganizationError] = useState(false)
  const { fs, toggle } = useFullscreen()
  const query = q.trim().toLowerCase()
  const projectRows = projects.filter(item => (item.archivedAt !== undefined) === showArchive && item.name.toLowerCase().includes(query))
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.createdAt - a.createdAt)
  const filtered = sessions.filter(session => (!project || session.projectId === project.id) &&
    (session.archivedAt !== undefined) === showArchive && localizedSessionTitle(session).toLowerCase().includes(query))
  filtered.sort((a, b) => showArchive
    ? (b.archivedAt ?? 0) - (a.archivedAt ?? 0)
    : (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0))
  const toggleArchive = () => { setShowArchive(value => !value); setQ(''); setOrganizationError(false) }
  const openProject = (selected: ReaderProject) => {
    setProjectScope(selected.id); setProjectMode(true); setShowArchive(false); setQ('')
    const existing = sessions.find(session => session.projectId === selected.id && session.archivedAt === undefined)
    if (existing) void sessionsActions.open(existing.id).catch(() => setOrganizationError(true))
  }
  const createChat = () => {
    setShowArchive(false); setQ('')
    if (project?.archivedAt !== undefined) return
    void sessionsActions.newChat(project?.id).catch(() => setOrganizationError(true))
  }
  const openImages = () => galleryActions.open(currentConv?.id, 0, 'list', project?.id)
  const openFiles = () => documentUiActions.openLibrary(project?.id)
  const fsTitle = fs ? tx('退出全屏', 'Exit full screen') : tx('全屏', 'Full screen')
  const narrow = useLayoutStore(s => s.narrow)
  const toggleDesktopSidebar = () => {
    layoutStore.actions.toggleSidebar()
    void persistSidebarLayout().catch(error => console.warn('sidebar layout persistence failed', error))
  }
  const openHistory = () => { if (narrow) layoutStore.actions.openNarrowSidebar(); else toggleDesktopSidebar() }
  const collapseSidebar = () => { if (narrow) layoutStore.actions.closeNarrowSidebar(); else toggleDesktopSidebar() }
  const compact = !narrow && width < SIDEBAR_COMPACT_THRESHOLD
  const drawerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!narrow || collapsed) return
    const opener = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => drawerRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || Array.from(document.querySelectorAll('[role="dialog"]')).some(dialog => dialog.getClientRects().length)) return
      event.preventDefault(); layoutStore.actions.closeNarrowSidebar()
    }
    document.addEventListener('keydown', onEscape)
    return () => { document.removeEventListener('keydown', onEscape); cancelAnimationFrame(frame); if (opener?.isConnected && opener.getClientRects().length) opener.focus() }
  }, [narrow, collapsed])

  if (collapsed) {
    return (
      <div className={css.sideRail} style={{ width }}>
        <button type="button" className={css.railBtn} data-testid="rail-history" aria-label={tx('历史会话', 'Chat history')} title={tx('历史会话', 'Chat history')} onClick={openHistory}><IconClockOutline16 /></button>
        <button type="button" className={css.railBtn} data-testid="rail-new-chat" aria-label={t('sidebar.newChat')} title={t('sidebar.newChat')} onClick={createChat}><IconNewChatOutline16 /></button>
        <button type="button" className={css.railBtn} data-testid="rail-images" aria-label={tx('图片资料', 'Images')} title={tx('图片资料', 'Images')} onClick={openImages}><IconPhoto16 /></button>
        <button type="button" className={css.railBtn} data-testid="rail-files" aria-label={tx('资料库', 'Library')} title={tx('资料库', 'Library')} onClick={openFiles}><IconFolderOpenOutline16 /></button>
        <button type="button" className={css.railBtn} data-testid="rail-cards" aria-label={tx('学习中心', 'Learning center')} title={tx('学习中心', 'Learning center')} onClick={() => learningUiActions.openLibrary('cards')}><IconListPenOutline16 /></button>
        <div className={css.railSpacer} />
        {!isAndroidReader() && <button type="button" className={css.railBtn} data-testid="rail-fullscreen" aria-label={fsTitle} title={fsTitle} onClick={toggle}><IconFullscreenOutline16 /></button>}
        <button type="button" className={css.railBtn} data-testid="rail-settings" aria-label={tx('设置', 'Settings')} title={tx('设置', 'Settings')} onClick={uiActions.openSettings}><IconSettingsOutline16 /></button>
      </div>
    )
  }
  return (
    <div ref={drawerRef} id={narrow ? 'mobile-navigation' : undefined} className={css.sidebar} style={{ width }} data-testid={narrow ? 'mobile-history-drawer' : 'sidebar'} data-compact={compact || undefined} role={narrow ? 'navigation' : undefined} aria-label={narrow ? tx('主导航', 'Main navigation') : undefined} onKeyDown={event => { if (narrow && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); layoutStore.actions.closeNarrowSidebar(); document.querySelector<HTMLButtonElement>('[data-testid="mobile-menu-toggle"]')?.focus() } }}>
      <div className={css.sidebarHead}>
        <div className={css.sidebarTitle}>{t('brand.localBuild')}</div>
        <div className={css.sidebarHeadBtns}>
          <button type="button" className={css.collapseBtn} data-testid="sidebar-collapse" aria-label={tx('收起侧栏', 'Collapse sidebar')} title={tx('收起侧栏', 'Collapse sidebar')} onClick={collapseSidebar}><span aria-hidden="true">‹</span></button>
        </div>
      </div>
      <div className={css.sidebarNew}>
        <button type="button" className={css.newChatBtn} data-testid="sidebar-new-chat" disabled={project?.archivedAt !== undefined} onClick={createChat}>
          <IconNewChatOutline16 /> {t('sidebar.newChat')}
        </button>
      </div>
      <div className={css.sidebarSection}>{tx('资料', 'Materials')}</div>
      <div className={css.sidebarEntries}>
        <button type="button" className={css.entryBtn} data-testid="sidebar-entry-images" onClick={openImages}>
          <IconPhoto16 /> <span>{tx('图片', 'Images')}</span>
        </button>
        <button type="button" className={css.entryBtn} data-testid="sidebar-entry-files" onClick={openFiles}>
          <IconFolderOpenOutline16 /> <span>{tx('资料库', 'Library')}</span>
        </button>
      </div>
      <div className={css.sidebarSection}>{tx('学习', 'Study')}</div>
      <div className={css.sidebarEntries}>
        <button type="button" className={css.entryBtn} data-testid="sidebar-entry-cards" onClick={() => learningUiActions.openLibrary('cards')}>
          <IconListPenOutline16 /> <span>{tx('学习中心', 'Learning center')}</span>
        </button>
      </div>
      <div className={css.sidebarSection + ' ' + css.historyHeading}>
        <span>{projectMode && !project ? tx('项目', 'Projects') : showArchive ? tx('已归档会话', 'Archived chats') : tx('会话', 'Chats')}</span>
        <div className={css.historyActions}>
        <button type="button" className={css.archiveToggle} data-testid="sidebar-projects" aria-pressed={projectMode} onClick={() => {
          setProjectMode(value => !value); setProjectScope(''); setQ(''); setShowArchive(false)
        }}><IconFolderOpenOutline16 size={15} /> {tx('项目', 'Projects')}</button>
        <button type="button" className={css.archiveToggle} aria-pressed={showArchive} onClick={toggleArchive}>
          <IconArchiveOutline20 size={15} /> {tx('归档', 'Archive')}
        </button>
        </div>
      </div>
      <div className={css.sidebarSearch}><Input icon={<IconSearchOutline16 />} value={q} onChange={e => setQ(e.target.value)} placeholder={projectMode && !project ? tx('搜索项目…', 'Search projects…') : showArchive ? tx('搜索归档…', 'Search archive…') : t('sidebar.search')} /></div>
      {project && <div className={css.projectHeading} data-testid="project-heading">
        <button className={css.archiveToggle} type="button" aria-label={tx('返回项目', 'Back to projects')} onClick={() => { setProjectMode(true); setProjectScope(''); setQ(''); setShowArchive(false) }}>‹</button>
        <strong className={css.sessionTitle}>{project.name}</strong>
      </div>}
      {organizationError && <div className={css.sidebarEmpty} role="alert">{tx('会话状态未能保存，请重试。', 'Could not update the chat. Try again.')}</div>}
      <div className={css.sidebarList}>
        {projectMode && !project ? <ProjectList projects={projectRows} archived={showArchive} onOpen={openProject} onError={setOrganizationError} /> : <>
        {filtered.map(s => <SessionRow key={s.id} session={s} active={s.id === current} narrow={narrow} onOrganizationError={setOrganizationError} />)}
        {filtered.length === 0 && <div className={css.sidebarEmpty}>{query ? tx('没有匹配的会话', 'No matching chats') : showArchive ? tx('暂无归档会话', 'No archived chats') : tx('暂无会话', 'No chats')}</div>}
        </>}
      </div>
      <div className={css.sidebarFoot}>
        {!isAndroidReader() && <button type="button" className={css.footBtn} data-testid="sidebar-fullscreen" onClick={toggle}><IconFullscreenOutline16 /> <span>{fsTitle}</span></button>}
        <button type="button" className={css.footBtn} data-testid="sidebar-settings" onClick={uiActions.openSettings}><IconSettingsOutline16 /> <span>{tx('设置', 'Settings')}</span></button>
      </div>
    </div>
  )
}

function SessionRow({ session, active, narrow, onOrganizationError }: { session: ChatSession; active: boolean; narrow: boolean; onOrganizationError: (error: boolean) => void }) {
  const busy = useSyncExternalStore(generationRegistry.subscribe, () => !!generationRegistry.keyForConversation(session.id))
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [confirming, setConfirming] = useState(false)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const archived = session.archivedAt !== undefined
  const pinned = session.pinnedAt !== undefined
  const onOpen = () => { setMenuOpen(false); void sessionsActions.open(session.id); if (narrow) layoutStore.actions.closeNarrowSidebar() }
  const organize = async (action: Parameters<typeof sessionsActions.organize>[1]) => {
    setMenuOpen(false)
    menuTrigger.current?.focus()
    onOrganizationError(false)
    try { if (!(await sessionsActions.organize(session.id, action))) onOrganizationError(true) }
    catch { onOrganizationError(true) }
  }
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
    <div className={css.sessionRowWrap + (active ? ' ' + css.sessionRowWrapActive : '')} onBlur={event => {
      if (menuOpen && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false)
    }} onKeyDown={event => {
      if (!menuOpen || event.key !== 'Escape') return
      event.preventDefault()
      setMenuOpen(false)
      menuTrigger.current?.focus()
    }}>
      <button className={css.sessionRow} data-testid="history-session" aria-current={active ? 'true' : undefined} onClick={onOpen}>
        {pinned ? <span className={css.pinnedLabel} title={tx('已置顶', 'Pinned')}>{tx('置顶', 'Pinned')}</span> : <span className={css.sessionDot} data-state={active ? 'done' : 'idle'} />}
        <span className={css.sessionTitle}>{localizedSessionTitle(session)}</span>
        <span className={css.sessionCount}>{busy ? tx('生成中', 'Generating') : session.messages.length}</span>
      </button>
      <button ref={menuTrigger} className={css.rowMenu} title={tx('操作', 'Actions')} aria-label={tx('操作', 'Actions')} aria-expanded={menuOpen} onClick={() => setMenuOpen(o => !o)}><span className={css.rowMenuDots}>⋯</span></button>
      {menuOpen && (
        <div className={css.rowMenuPopup}>
          {!archived && <button className={css.rowMenuItem} onClick={() => void organize(pinned ? 'unpin' : 'pin')}>{pinned ? tx('取消置顶', 'Unpin') : tx('置顶', 'Pin')}</button>}
          <button className={css.rowMenuItem} onClick={() => void organize(archived ? 'restore' : 'archive')}>{archived ? tx('恢复会话', 'Restore chat') : tx('归档会话', 'Archive chat')}</button>
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

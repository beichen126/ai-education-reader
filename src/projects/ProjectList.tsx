import { useState } from 'react'
import { MAX_TITLE_LEN, sanitizeTitle } from '../engine/session-title'
import { tx } from '../engine/locale'
import css from '../cockpit/cockpit.module.css'
import type { ReaderProject } from './project-records'
import { createProject, deleteProject, updateProject } from './project-store'

export function ProjectList({ projects, archived, onOpen, onError }: {
  projects: ReaderProject[]
  archived: boolean
  onOpen: (project: ReaderProject) => void
  onError: (value: boolean) => void
}) {
  const [editing, setEditing] = useState<string>()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<string>()
  const [confirming, setConfirming] = useState<string>()
  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    onError(false)
    try { await action() } catch { onError(true) }
    finally { setBusy(false) }
  }
  function submit() {
    const title = sanitizeTitle(name)
    if (!title) return
    void run(async () => {
      if (editing) await updateProject(editing, project => ({ ...project, name: title }))
      else onOpen(await createProject(title))
      setEditing(undefined)
    })
  }
  function edit(project?: ReaderProject) {
    setEditing(project?.id ?? '')
    setName(project?.name ?? '')
    setMenu(undefined)
  }
  return <>
    {!archived && <button className={css.archiveToggle + ' ' + css.projectCreate} type="button" data-testid="project-create" onClick={() => edit()}>{tx('＋ 新建项目', '＋ New project')}</button>}
    {editing !== undefined && <form className={css.rowRename} onSubmit={event => { event.preventDefault(); submit() }}>
      <input autoFocus className={css.rowRenameInput} aria-label={tx('项目名称', 'Project name')} value={name} maxLength={MAX_TITLE_LEN} onChange={event => setName(event.target.value)} />
      <button className={css.rowRenameBtn} disabled={busy || !name.trim()}>{tx('保存', 'Save')}</button>
      <button className={css.rowRenameBtn} type="button" disabled={busy} onClick={() => setEditing(undefined)}>{tx('取消', 'Cancel')}</button>
    </form>}
    {projects.map(project => <div key={project.id} className={css.sessionRowWrap}>
      <button className={css.sessionRow} data-testid="project-row" type="button" onClick={() => onOpen(project)}>
        {project.pinnedAt !== undefined && <span className={css.pinnedLabel}>{tx('置顶', 'Pinned')}</span>}
        <span className={css.sessionTitle}>{project.name}</span>
        <span className={css.sessionCount}>{project.attachmentIds.length}</span>
      </button>
      <button className={css.rowMenu} type="button" aria-label={tx('项目操作', 'Project actions')} aria-expanded={menu === project.id} onClick={() => setMenu(menu === project.id ? undefined : project.id)}>⋯</button>
      {menu === project.id && <div className={css.rowMenuPopup} onKeyDown={event => { if (event.key === 'Escape') setMenu(undefined) }}>
        {!archived && <button className={css.rowMenuItem} disabled={busy} onClick={() => void run(async () => {
          await updateProject(project.id, current => ({ ...current, pinnedAt: current.pinnedAt === undefined ? Date.now() : undefined }))
          setMenu(undefined)
        })}>{project.pinnedAt === undefined ? tx('置顶', 'Pin') : tx('取消置顶', 'Unpin')}</button>}
        <button className={css.rowMenuItem} disabled={busy} onClick={() => void run(async () => {
          await updateProject(project.id, current => ({ ...current, archivedAt: archived ? undefined : Date.now() }))
          setMenu(undefined)
        })}>{archived ? tx('恢复项目', 'Restore project') : tx('归档项目', 'Archive project')}</button>
        <button className={css.rowMenuItem} onClick={() => edit(project)}>{tx('重命名', 'Rename')}</button>
        <button className={css.rowMenuItem} data-danger onClick={() => { setMenu(undefined); setConfirming(project.id) }}>{tx('删除', 'Delete')}</button>
      </div>}
      {confirming === project.id && <div className={css.rowConfirm}>
        <span>{tx('删除项目？项目内会话会保留。', 'Delete the project? Its chats will be kept.')}</span>
        <button disabled={busy} onClick={() => void run(async () => { await deleteProject(project.id); setConfirming(undefined) })}>{tx('删除', 'Delete')}</button>
        <button onClick={() => setConfirming(undefined)}>{tx('取消', 'Cancel')}</button>
      </div>}
    </div>)}
    {archived && projects.length === 0 && <div className={css.sidebarEmpty}>{tx('暂无归档项目', 'No archived projects')}</div>}
  </>
}

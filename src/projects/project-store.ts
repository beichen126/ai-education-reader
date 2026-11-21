import { useSyncExternalStore } from 'react'
import { idbUpdateOrInsert } from '../storage/idb'
import { getSetting } from '../storage/storage'
import { sanitizeTitle } from '../engine/session-title'
import { newStableId } from '../engine/types'
import { PROJECTS_KEY, readProjectRecords, type ReaderProject } from './project-records'

let projects: ReaderProject[] = []
let revision = 0
const subscribers = new Set<() => void>()
function subscribe(listener: () => void) {
  subscribers.add(listener)
  return () => { subscribers.delete(listener) }
}
function publish(next: ReaderProject[]) {
  projects = next
  subscribers.forEach(listener => listener())
}
export function useProjects() {
  return useSyncExternalStore(subscribe, () => projects)
}
export async function reloadProjects() {
  const current = revision
  const next = readProjectRecords(await getSetting(PROJECTS_KEY))
  if (revision === current) publish(next)
}

async function update(change: (records: ReaderProject[]) => ReaderProject[]) {
  revision++
  const row = await idbUpdateOrInsert<{ key: string; value: ReaderProject[] }>('settings', PROJECTS_KEY,
    { key: PROJECTS_KEY, value: [] }, current => ({ key: PROJECTS_KEY, value: change(readProjectRecords(current.value)) }))
  revision++
  publish(row.value)
}

export async function createProject(name: string) {
  const title = sanitizeTitle(name)
  if (!title) throw new Error('请输入项目名称。')
  const project: ReaderProject = { id: newStableId(), name: title, createdAt: Date.now(), attachmentIds: [] }
  await update(list => [project, ...list])
  return project
}

export async function updateProject(id: string, change: (project: ReaderProject) => ReaderProject) {
  await update(list => {
    if (!list.some(project => project.id === id)) throw new Error('项目已删除。')
    return list.map(project => project.id === id ? change(project) : project)
  })
}

export function deleteProject(id: string) {
  return update(list => list.filter(project => project.id !== id))
}

export function addProjectAttachments(id: string, ids: string[]) {
  return updateProject(id, project => ({
    ...project, attachmentIds: [...new Set([...project.attachmentIds, ...ids])],
  }))
}

export const PROJECTS_KEY = 'reader-projects'

export type ReaderProject = {
  id: string
  name: string
  createdAt: number
  pinnedAt?: number
  archivedAt?: number
  attachmentIds: string[]
}

export function isReaderProject(value: unknown): value is ReaderProject {
  if (typeof value !== 'object' || value === null) return false
  const project = value as Partial<ReaderProject>
  return typeof project.id === 'string' && !!project.id &&
    typeof project.name === 'string' && !!project.name.trim() &&
    Number.isSafeInteger(project.createdAt) &&
    (project.pinnedAt === undefined || Number.isSafeInteger(project.pinnedAt)) &&
    (project.archivedAt === undefined || Number.isSafeInteger(project.archivedAt)) &&
    Array.isArray(project.attachmentIds) && project.attachmentIds.every(id => typeof id === 'string' && !!id)
}

export function readProjectRecords(value: unknown): ReaderProject[] {
  return Array.isArray(value) ? value.filter(isReaderProject) : []
}

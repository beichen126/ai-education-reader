import { useSyncExternalStore } from 'react'
export type GalleryView = 'list' | 'viewer'
type G = { open: boolean; view: GalleryView; index: number; convId: string | undefined; projectId?: string; attachmentId?: string }
let s: G = { open: false, view: 'list', index: 0, convId: undefined }
const subs = new Set<() => void>()
function notify() { subs.forEach(f => f()) }
function useGallery<T>(sel: (s: G) => T): T { return useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn) } }, () => sel(s)) }
export const galleryActions = {
  isOpenFor(convId: string | undefined, projectId: string | undefined) { return s.open && s.convId === convId && s.projectId === projectId },
  open(convId: string | undefined, index = 0, view: GalleryView = 'list', projectId?: string) { s = { open: true, view, index, convId, projectId }; notify() },
  openAttachment(convId: string | undefined, attachmentId: string) { s = { open: true, view: 'viewer', index: 0, convId, attachmentId }; notify() },
  openViewer(index: number) { if (!s.open) return; s = { ...s, view: 'viewer', index, attachmentId: undefined }; notify() },
  showList() { if (!s.open) return; s = { ...s, view: 'list' }; notify() },
  goto(i: number) { galleryActions.openViewer(i) },
  close() { s = { open: false, view: 'list', index: 0, convId: undefined }; notify() },
}
export { useGallery }

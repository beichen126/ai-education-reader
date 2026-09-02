import { useSyncExternalStore } from 'react'
export type GalleryView = 'list' | 'viewer'
type G = { open: boolean; view: GalleryView; index: number; convId: string | undefined }
let s: G = { open: false, view: 'list', index: 0, convId: undefined }
const subs = new Set<() => void>()
function notify() { subs.forEach(f => f()) }
function useGallery<T>(sel: (s: G) => T): T { return useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn) } }, () => sel(s)) }
export const galleryActions = {
  open(convId: string | undefined, index = 0, view: GalleryView = 'list') { s = { open: true, view, index, convId }; notify() },
  openViewer(index: number) { if (!s.open) return; s = { ...s, view: 'viewer', index }; notify() },
  showList() { if (!s.open) return; s = { ...s, view: 'list' }; notify() },
  goto(i: number) { if (!s.open) return; s = { ...s, view: 'viewer', index: i }; notify() },
  close() { s = { open: false, view: 'list', index: 0, convId: undefined }; notify() },
}
export { useGallery }
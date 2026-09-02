
import { useSyncExternalStore } from 'react'
export type UiState = { settingsOpen: boolean }
let s: UiState = { settingsOpen: false }
const subs = new Set<() => void>()
function notify() { subs.forEach(f => f()) }
function useUi<T>(sel: (s: UiState) => T): T { return useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn) } }, () => sel(s)) }
export const uiActions = {
  openSettings() { s = { settingsOpen: true }; notify() },
  closeSettings() { s = { settingsOpen: false }; notify() },
}
export { useUi }

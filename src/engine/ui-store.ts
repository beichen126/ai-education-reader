
import { useSyncExternalStore } from 'react'
export type UiState = { settingsOpen: boolean; promptManagerOpen: boolean }
let s: UiState = { settingsOpen: false, promptManagerOpen: false }
const subs = new Set<() => void>()
function notify() { subs.forEach(f => f()) }
function useUi<T>(sel: (s: UiState) => T): T { return useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn) } }, () => sel(s)) }
export const uiActions = {
  openSettings() { s = { ...s, settingsOpen: true, promptManagerOpen: false }; notify() },
  closeSettings() { s = { ...s, settingsOpen: false }; notify() },
  openPromptManager() { s = { ...s, promptManagerOpen: true, settingsOpen: false }; notify() },
  closePromptManager() { s = { ...s, promptManagerOpen: false }; notify() },
}
export { useUi }

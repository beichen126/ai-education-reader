
import { useSyncExternalStore } from 'react'
import type { PromptKind } from '../prompts/prompt-types'
export type UiState = { settingsOpen: boolean; promptManagerOpen: boolean; promptManagerCategory?: PromptKind; productGuideOpen: boolean }
let s: UiState = { settingsOpen: false, promptManagerOpen: false, productGuideOpen: false }
const subs = new Set<() => void>()
function notify() { subs.forEach(f => f()) }
function useUi<T>(sel: (s: UiState) => T): T { return useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn) } }, () => sel(s)) }
export const uiActions = {
  openSettings() { s = { ...s, settingsOpen: true, promptManagerOpen: false, productGuideOpen: false, promptManagerCategory: undefined }; notify() },
  closeSettings() { s = { ...s, settingsOpen: false }; notify() },
  openPromptManager(category?: PromptKind) { s = { ...s, promptManagerOpen: true, settingsOpen: false, productGuideOpen: false, promptManagerCategory: category }; notify() },
  closePromptManager() { s = { ...s, promptManagerOpen: false, promptManagerCategory: undefined }; notify() },
  openProductGuide() { s = { ...s, productGuideOpen: true, settingsOpen: false, promptManagerOpen: false, promptManagerCategory: undefined }; notify() },
  closeProductGuide() { s = { ...s, productGuideOpen: false }; notify() },
}
export { useUi }


import { useSyncExternalStore } from 'react'
import type { PromptKind } from '../prompts/prompt-types'

/**
 * Where a closing overlay should return focus. Prompt Manager can be opened from
 * Settings, from a message-level quick follow-up bar, or from a stable app control;
 * the origin is recorded explicitly instead of being guessed by querying selectors
 * that may no longer exist.
 */
export type OverlayReturnTarget =
  | { kind: 'settings'; controlId: string }
  | { kind: 'message'; conversationId: string; messageId: string }
  | { kind: 'app-control'; testId: string }

export type UiState = {
  settingsOpen: boolean
  promptManagerOpen: boolean
  promptManagerCategory?: PromptKind
  promptManagerReturnTarget?: OverlayReturnTarget
  productGuideOpen: boolean
}
let s: UiState = { settingsOpen: false, promptManagerOpen: false, productGuideOpen: false }
const subs = new Set<() => void>()
function notify() { subs.forEach(f => f()) }
function useUi<T>(sel: (s: UiState) => T): T { return useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn) } }, () => sel(s)) }
export const uiActions = {
  openSettings() { s = { ...s, settingsOpen: true, promptManagerOpen: false, productGuideOpen: false, promptManagerCategory: undefined, promptManagerReturnTarget: undefined }; notify() },
  closeSettings() { s = { ...s, settingsOpen: false }; notify() },
  openPromptManager(category?: PromptKind, returnTarget?: OverlayReturnTarget) {
    s = { ...s, promptManagerOpen: true, settingsOpen: false, productGuideOpen: false, promptManagerCategory: category, promptManagerReturnTarget: returnTarget }
    notify()
  },
  /** Closing the manager restores the surface it was opened from (Settings re-opens) so
   *  the user lands back where they started with the origin control focused. */
  closePromptManager() {
    const target = s.promptManagerReturnTarget
    s = {
      ...s,
      promptManagerOpen: false,
      promptManagerCategory: undefined,
      promptManagerReturnTarget: undefined,
      settingsOpen: target?.kind === 'settings' ? true : s.settingsOpen,
    }
    notify()
  },
  openProductGuide() { s = { ...s, productGuideOpen: true, settingsOpen: false, promptManagerOpen: false, promptManagerCategory: undefined, promptManagerReturnTarget: undefined }; notify() },
  closeProductGuide() { s = { ...s, productGuideOpen: false }; notify() },
}
export { useUi }

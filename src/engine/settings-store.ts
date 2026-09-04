import { useSyncExternalStore } from 'react'
import { getSetting, setSetting, saveSettingsAtomic } from '../storage/storage'
import { DEFAULT_APPEARANCE, writeAppearanceHint, type AppearanceMode } from '../theme/theme'
import { type VisionCapability } from '../api/deepseek'

export type { VisionCapability }
export type Settings = { apiBaseUrl: string; apiKey: string; model: string; customSystemPrompt: string; customSystemPromptEnabled: boolean; appearance: AppearanceMode; visionCapability: VisionCapability }
export const DEFAULT_SETTINGS: Settings = { apiBaseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash-vision-exp', customSystemPrompt: '', customSystemPromptEnabled: false, appearance: DEFAULT_APPEARANCE, visionCapability: 'auto' }

let state: Settings = { ...DEFAULT_SETTINGS }
const subs = new Set<() => void>()
function set(next: Settings) { state = next; subs.forEach(f => f()) }
function useSettings<T>(sel: (s: Settings) => T): T { return useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn) } }, () => sel(state)) }
export function getSettingsSnapshot(): Settings { return state }
export async function initSettings(): Promise<void> {
  const [base, key, model, sys, sysOn, appearance, visionCapability] = await Promise.all([getSetting('apiBaseUrl'), getSetting('apiKey'), getSetting('model'), getSetting('customSystemPrompt'), getSetting('customSystemPromptEnabled'), getSetting('appearance'), getSetting('visionCapability')])
  const resolvedAppearance: AppearanceMode = (appearance === 'light' || appearance === 'dark') ? appearance : DEFAULT_APPEARANCE
  const resolvedVision: VisionCapability = (visionCapability === 'supports-image' || visionCapability === 'text-only') ? visionCapability : 'auto'
  set({ apiBaseUrl: base || DEFAULT_SETTINGS.apiBaseUrl, apiKey: key || '', model: model || DEFAULT_SETTINGS.model, customSystemPrompt: sys || '', customSystemPromptEnabled: sysOn ? sysOn === 'true' : false, appearance: resolvedAppearance, visionCapability: resolvedVision })
  writeAppearanceHint(resolvedAppearance)
}
export async function saveSettings(next: Settings): Promise<void> {
  // Commit ALL settings keys in ONE IndexedDB transaction (P1). A partial failure can no
  // longer leave a mixed configuration after reload. Durable values commit first, then we
  // publish them as the saved state.
  await saveSettingsAtomic({
    apiBaseUrl: next.apiBaseUrl, apiKey: next.apiKey, model: next.model,
    customSystemPrompt: next.customSystemPrompt, customSystemPromptEnabled: String(next.customSystemPromptEnabled),
    appearance: next.appearance, visionCapability: next.visionCapability,
  })
  set(next)
}
export type SetAppearanceResult = { ok: boolean }
/** Reactive single source for the appearance mode (blocker 0.6): updates the store AND
 *  persists it. The theme hook re-resolves from this store; Setting's radio is JUST this. */
export async function setAppearance(appearance: AppearanceMode): Promise<void> {
  set({ ...state, appearance })
  writeAppearanceHint(appearance)
  await setSetting('appearance', appearance)
}
export { useSettings }
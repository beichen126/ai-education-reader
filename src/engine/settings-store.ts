import { useSyncExternalStore } from 'react'
import { getSetting, setSetting } from '../storage/storage'

export type Settings = { apiBaseUrl: string; apiKey: string; model: string; customSystemPrompt: string; customSystemPromptEnabled: boolean }
export const DEFAULT_SETTINGS: Settings = { apiBaseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash-vision-exp', customSystemPrompt: '', customSystemPromptEnabled: false }

let state: Settings = { ...DEFAULT_SETTINGS }
const subs = new Set<() => void>()
function set(next: Settings) { state = next; subs.forEach(f => f()) }
function useSettings<T>(sel: (s: Settings) => T): T { return useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn) } }, () => sel(state)) }
export function getSettingsSnapshot(): Settings { return state }
export async function initSettings(): Promise<void> {
  const [base, key, model, sys, sysOn] = await Promise.all([getSetting('apiBaseUrl'), getSetting('apiKey'), getSetting('model'), getSetting('customSystemPrompt'), getSetting('customSystemPromptEnabled')])
  set({ apiBaseUrl: base || DEFAULT_SETTINGS.apiBaseUrl, apiKey: key || '', model: model || DEFAULT_SETTINGS.model, customSystemPrompt: sys || '', customSystemPromptEnabled: sysOn ? sysOn === 'true' : false })
}
export async function saveSettings(next: Settings): Promise<void> {
  set(next)
  await Promise.all([setSetting('apiBaseUrl', next.apiBaseUrl), setSetting('apiKey', next.apiKey), setSetting('model', next.model), setSetting('customSystemPrompt', next.customSystemPrompt), setSetting('customSystemPromptEnabled', String(next.customSystemPromptEnabled))])
}
export { useSettings }
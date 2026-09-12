import { useSyncExternalStore } from 'react'
import { getSetting, saveSettingsAtomic } from '../storage/storage'
import { DEFAULT_APPEARANCE, writeAppearanceHint, type AppearanceMode } from '../theme/theme'
import { type VisionCapability } from '../api/deepseek'
import { DEFAULT_PDF_NAVIGATION_MODE, normalizePdfNavigationMode, type PdfNavigationMode } from './pdf-navigation-settings'

export type { VisionCapability }
export type { PdfNavigationMode }
export type Settings = { apiBaseUrl: string; apiKey: string; model: string; customSystemPrompt: string; customSystemPromptEnabled: boolean; appearance: AppearanceMode; visionCapability: VisionCapability; pdfNavigationMode: PdfNavigationMode }
export const DEFAULT_SETTINGS: Settings = { apiBaseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-v4-flash-vision-exp', customSystemPrompt: '', customSystemPromptEnabled: false, appearance: DEFAULT_APPEARANCE, visionCapability: 'auto', pdfNavigationMode: DEFAULT_PDF_NAVIGATION_MODE }

/** A partial settings change. Every mutation goes through {@link patchSettings}. */
export type SettingsPatch = Partial<Pick<Settings, 'apiBaseUrl' | 'apiKey' | 'model' | 'customSystemPrompt' | 'customSystemPromptEnabled' | 'appearance' | 'visionCapability' | 'pdfNavigationMode'>>

let state: Settings = { ...DEFAULT_SETTINGS }
const subs = new Set<() => void>()
function set(next: Settings) { state = next; subs.forEach(f => f()) }

/** Durable mutation outcome, observable by any surface (the Settings dialog can be closed
 *  while a write is still in flight, and a later open must still be able to show the
 *  failure and the real committed value). */
export type SettingsMutationState = { status: 'idle' | 'pending' | 'error'; error: string | null; revision: number }
let mutationState: SettingsMutationState = { status: 'idle', error: null, revision: 0 }
const mutationSubs = new Set<() => void>()
function setMutation(status: SettingsMutationState['status'], error: string | null) {
  mutationState = { status, error, revision: mutationState.revision + 1 }
  mutationSubs.forEach(f => f())
}
export function getSettingsMutationSnapshot(): SettingsMutationState { return mutationState }
export function useSettingsMutation(): SettingsMutationState {
  return useSyncExternalStore(
    fn => { mutationSubs.add(fn); return () => { mutationSubs.delete(fn) } },
    () => mutationState,
  )
}

function useSettings<T>(sel: (s: Settings) => T): T { return useSyncExternalStore(fn => { subs.add(fn); return () => { subs.delete(fn) } }, () => sel(state)) }
export function getSettingsSnapshot(): Settings { return state }

/** Validate + normalize a whole settings object. Legacy/foreign values never leak in. */
export function normalizeSettings(input: Settings): Settings {
  const appearance: AppearanceMode = (input.appearance === 'light' || input.appearance === 'dark') ? input.appearance : DEFAULT_APPEARANCE
  const visionCapability: VisionCapability = (input.visionCapability === 'supports-image' || input.visionCapability === 'text-only') ? input.visionCapability : 'auto'
  return {
    apiBaseUrl: typeof input.apiBaseUrl === 'string' ? input.apiBaseUrl : DEFAULT_SETTINGS.apiBaseUrl,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : '',
    model: typeof input.model === 'string' ? input.model : DEFAULT_SETTINGS.model,
    customSystemPrompt: typeof input.customSystemPrompt === 'string' ? input.customSystemPrompt : '',
    customSystemPromptEnabled: input.customSystemPromptEnabled === true,
    appearance,
    visionCapability,
    pdfNavigationMode: normalizePdfNavigationMode(input.pdfNavigationMode),
  }
}

export async function initSettings(): Promise<void> {
  const [base, key, model, sys, sysOn, appearance, visionCapability, pdfNavigationMode] = await Promise.all([getSetting('apiBaseUrl'), getSetting('apiKey'), getSetting('model'), getSetting('customSystemPrompt'), getSetting('customSystemPromptEnabled'), getSetting('appearance'), getSetting('visionCapability'), getSetting('pdfNavigationMode')])
  const resolvedAppearance: AppearanceMode = (appearance === 'light' || appearance === 'dark') ? appearance : DEFAULT_APPEARANCE
  const resolvedVision: VisionCapability = (visionCapability === 'supports-image' || visionCapability === 'text-only') ? visionCapability : 'auto'
  set({ apiBaseUrl: base || DEFAULT_SETTINGS.apiBaseUrl, apiKey: key || '', model: model || DEFAULT_SETTINGS.model, customSystemPrompt: sys || '', customSystemPromptEnabled: sysOn ? sysOn === 'true' : false, appearance: resolvedAppearance, visionCapability: resolvedVision, pdfNavigationMode: normalizePdfNavigationMode(pdfNavigationMode) })
  writeAppearanceHint(resolvedAppearance)
}

/**
 * Serial mutation queue. Every settings write runs inside it, reading the LATEST committed
 * state when it finally executes and committing the merged result in ONE IndexedDB
 * transaction. Two properties matter:
 *   - last-intent-wins: A then B always leaves B durable, whatever the commit latencies;
 *   - a failed mutation is reported to its caller and never poisons later mutations.
 * The committed value is published only AFTER the transaction commits.
 */
let queue: Promise<unknown> = Promise.resolve()

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error ?? '未知错误')
}

async function commitPatch(patch: SettingsPatch): Promise<Settings> {
  const base = state
  const next = normalizeSettings({ ...base, ...patch })
  setMutation('pending', null)
  try {
    await saveSettingsAtomic({
      apiBaseUrl: next.apiBaseUrl, apiKey: next.apiKey, model: next.model,
      customSystemPrompt: next.customSystemPrompt, customSystemPromptEnabled: String(next.customSystemPromptEnabled),
      appearance: next.appearance, visionCapability: next.visionCapability, pdfNavigationMode: next.pdfNavigationMode,
    })
  } catch (error) {
    // The transaction did not commit: the previously committed state stays published
    // and the caller learns about the failure. The queue itself stays healthy.
    setMutation('error', describeError(error))
    throw error instanceof Error ? error : new Error(describeError(error))
  }
  set(next)
  if (next.appearance !== base.appearance) writeAppearanceHint(next.appearance)
  setMutation('idle', null)
  return next
}

export function patchSettings(patch: SettingsPatch): Promise<Settings> {
  const run = queue.then(() => commitPatch(patch), () => commitPatch(patch))
  queue = run.then(() => undefined, () => undefined)
  return run
}

/** Persist a whole settings object through the same serial queue.
 *  Kept for callers that already hold a complete Settings value; the merge base is still
 *  the latest committed state, so a stale snapshot can never resurrect an old PDF mode. */
export function saveSettings(next: Settings): Promise<Settings> {
  return patchSettings(next)
}

export type SetAppearanceResult = { ok: boolean }
/** Reactive single source for the appearance mode (blocker 0.6): updates the store AND
 *  persists it through the shared mutation queue, so an appearance write can never race a
 *  PDF/API write. */
export async function setAppearance(appearance: AppearanceMode): Promise<void> {
  await patchSettings({ appearance })
}

/** Immediately persist the user's PDF navigation choice. No extra "save" click is needed. */
export async function setPdfNavigationMode(mode: PdfNavigationMode): Promise<Settings> {
  return patchSettings({ pdfNavigationMode: normalizePdfNavigationMode(mode) })
}

export { useSettings }

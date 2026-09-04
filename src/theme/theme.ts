
// Appearance / theme applier (Stage 9.5, Part B). mode = 'system' | 'light' | 'dark'.
// The design token layer already keys off body[data-ds-dark-theme]; this module resolves
// the effective theme (system via matchMedia) and writes BOTH documentElement.dataset.theme
// (per spec) and the existing body attr so components using --dsw-alias-* flip automatically.
import { getSetting, setSetting } from '../storage/storage'

export type AppearanceMode = 'system' | 'light' | 'dark'
const APPEARANCE_KEY = 'appearance'
export const DEFAULT_APPEARANCE: AppearanceMode = 'system'

/** Resolve the EFFECTIVE theme ('light' | 'dark') for a given mode + system preference. */
export function resolveAppearance(mode: AppearanceMode, systemDark: boolean): 'light' | 'dark' {
  if (mode === 'light') return 'light'
  if (mode === 'dark') return 'dark'
  return systemDark ? 'dark' : 'light'
}

export function systemPrefersDark(): boolean {
  try { return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return false }
}

/** Apply the effective theme to the document (both the spec attr and the token-layer attr). */
export function applyTheme(effective: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = effective
  if (effective === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
  else document.body.removeAttribute('data-ds-dark-theme')
}

export async function getAppearanceMode(): Promise<AppearanceMode> {
  const v = await getSetting(APPEARANCE_KEY)
  return (v === 'light' || v === 'dark') ? v : 'system'
}
export async function setAppearanceMode(mode: AppearanceMode): Promise<void> {
  await setSetting(APPEARANCE_KEY, mode)
  const dark = systemPrefersDark()
  applyTheme(resolveAppearance(mode, dark))
}

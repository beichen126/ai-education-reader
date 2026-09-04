// Appearance / theme applier (Stage 9.5, Part B). mode = 'system' | 'light' | 'dark'.
// The design token layer already keys off body[data-ds-dark-theme]; this module resolves
// the effective theme (system via matchMedia) and writes BOTH documentElement.dataset.theme
// (per spec) and the existing body attr so components using --dsw-alias-* flip automatically.

export type AppearanceMode = 'system' | 'light' | 'dark'
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

// Block 0.8 first-paint: a single LOCALSTORAGE hint (theme mode ONLY — no API key, model,
// chat, or other settings ever go to localStorage) lets the inline <body> script apply the
// stored theme synchronously BEFORE React mounts, avoiding an obvious white flash.
export function writeAppearanceHint(mode: AppearanceMode): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('dsh-appearance-mode', mode) } catch { /* ignore */ }
}
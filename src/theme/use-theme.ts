
import { useEffect, useRef } from 'react'
import { useSettings } from '../engine/settings-store'
import { applyTheme, resolveAppearance, systemPrefersDark } from './theme'

/** React hook: the appearance mode comes from the Settings store — ONE reactive authority
 *  (blocker 0.6). When mode=system it re-applies on `prefers-color-scheme` changes; when the
 *  user explicitly selects light/dark there is NO system listener (so a later system change
 *  can never override a deliberate choice). Returns nothing callers need to manage. */
export function useTheme() {
  const appearance = useSettings(s => s.appearance)
  // Re-resolve & apply whenever appearance OR the system preference changes.
  useEffect(() => {
    const dark = systemPrefersDark()
    applyTheme(resolveAppearance(appearance, dark))
    if (appearance !== 'system') return
    const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null
    if (!mq) return
    const on = () => applyTheme(resolveAppearance('system', mq.matches))
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [appearance])
  return { appearance }
}
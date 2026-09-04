
import { useEffect, useState } from 'react'
import { getAppearanceMode, applyTheme, resolveAppearance, systemPrefersDark, setAppearanceMode, type AppearanceMode } from './theme'

/** React hook: applies the appearance setting to the document, re-applies on system change
 *  when mode=system, and exposes the current mode + a setter. */
export function useTheme() {
  const [mode, setMode] = useState<AppearanceMode>('system')
  useEffect(() => { void getAppearanceMode().then(m => setMode(m)) }, [])
  useEffect(() => {
    const dark = systemPrefersDark()
    applyTheme(resolveAppearance(mode, dark))
    if (mode !== 'system') return
    const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null
    if (!mq) return
    const on = () => applyTheme(resolveAppearance('system', mq.matches))
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [mode])
  return { mode, setMode: async (m: AppearanceMode) => { setMode(m); await setAppearanceMode(m) } }
}

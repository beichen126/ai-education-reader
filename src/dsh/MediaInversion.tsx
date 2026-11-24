import { useSyncExternalStore } from 'react'
import { tx } from '../engine/locale'
import css from './media-inversion.module.css'

const STORAGE_KEY = 'reader-media-inverted'
const listeners = new Set<() => void>()
let inverted = readPreference()

function readPreference() {
  try { return localStorage.getItem(STORAGE_KEY) === 'true' } catch { return false }
}

function notify() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY && event.key !== null) return
    inverted = readPreference()
    notify()
  })
}

export function useMediaInversion() {
  const value = useSyncExternalStore(subscribe, () => inverted, () => false)
  return { inverted: value, mediaClass: value ? css.inverted : undefined }
}

export function MediaInvertButton({ pressed, className }: { pressed: boolean; className?: string }) {
  return <button
    type="button"
    className={[className, css.toggle].filter(Boolean).join(' ')}
    data-testid="media-invert"
    aria-pressed={pressed}
    onClick={() => {
      inverted = !inverted
      try { localStorage.setItem(STORAGE_KEY, String(inverted)) } catch { /* In-memory preference stays available. */ }
      notify()
    }}
  >{tx('反色', 'Invert')}</button>
}

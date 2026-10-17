import { useFullscreen } from '../engine/use-fullscreen'
import { tx } from '../engine/locale'
import css from './cockpit.module.css'

export function FullscreenButton() {
  const { fs, toggle } = useFullscreen()
  const label = fs ? tx('退出全屏', 'Exit full screen') : tx('全屏', 'Full screen')
  return <button type="button" className={css.headerFullscreen} data-testid="header-fullscreen" aria-label={label} title={label} aria-pressed={fs} onClick={() => void toggle()}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={fs ? 'M3 9h6V3M15 3v6h6M21 15h-6v6M9 21v-6H3' : 'M9 3H3v6M15 3h6v6M21 15v6h-6M9 21H3v-6'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
  </button>
}

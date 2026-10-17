import { useEffect, useRef, useState } from 'react'
import { tx } from './locale'

type FullscreenDocument = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void | Promise<void> }
type FullscreenRoot = HTMLElement & { webkitRequestFullscreen?: () => void | Promise<void> }

/** Native fullscreen is transient browser state, never a persisted layout preference. */
export function useFullscreen() {
  const doc = document as FullscreenDocument
  const current = () => !!(doc.fullscreenElement || doc.webkitFullscreenElement)
  const [fs, setFs] = useState(current)
  const pending = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    const changed = () => setFs(current())
    doc.addEventListener('fullscreenchange', changed)
    doc.addEventListener('webkitfullscreenchange', changed)
    changed()
    return () => {
      mounted.current = false
      doc.removeEventListener('fullscreenchange', changed)
      doc.removeEventListener('webkitfullscreenchange', changed)
    }
  }, [])
  const toggle = async () => {
    if (pending.current) return
    const root = doc.documentElement as FullscreenRoot
    const exit = doc.exitFullscreen || doc.webkitExitFullscreen
    const enter = root.requestFullscreen || root.webkitRequestFullscreen
    if (current() ? !exit : !enter) {
      window.alert(tx('此浏览器不支持页面全屏。你仍可使用浏览器的全屏或“添加到主屏幕”功能。', 'This browser does not support page fullscreen. You can still use the browser’s fullscreen or Add to Home Screen option.'))
      return
    }
    pending.current = true
    try {
      // Keep the native call inside the click gesture; awaiting first loses activation.
      if (current()) await exit!.call(doc)
      else await enter!.call(root)
    } catch {
      if (mounted.current) window.alert(tx('浏览器未允许切换全屏，请重试或使用浏览器的全屏功能。', 'The browser did not allow fullscreen. Please try again or use the browser’s fullscreen option.'))
    } finally { pending.current = false }
  }
  return { fs, toggle }
}

import { useLayoutEffect, useRef, type RefObject, type MutableRefObject } from 'react'
import { captureReadingPosition, loadReadingPosition, messageElements, readingPositionEpoch, readingPositionKey, restoreReadingPosition, saveReadingPosition, type ReadingPosition } from '../engine/reading-position'
import { getSettingsSnapshot } from '../engine/settings-store'

export function useReadingPosition({rootRef,atBottomRef,enabled,conversationId,branchId,ready,messageCount,navigationPending}: {
  rootRef: RefObject<HTMLDivElement | null>; atBottomRef: MutableRefObject<boolean>; enabled: boolean
  conversationId?: string; branchId?: string; ready: boolean; messageCount: number; navigationPending: boolean
}): void {
  const rowsRef=useRef<HTMLElement[]>([])
  const navigationRef=useRef(navigationPending)
  navigationRef.current=navigationPending
  const context=conversationId ? readingPositionKey(conversationId,branchId) : undefined
  const initialized=useRef<string | undefined>(undefined)
  const lastEnabled=useRef(enabled)
  const skipRestore=useRef(false)
  const stopRestoreRef=useRef<(()=>void) | undefined>(undefined)
  useLayoutEffect(()=>{
    rowsRef.current=enabled && rootRef.current ? messageElements(rootRef.current) : []
  },[rootRef,enabled,context,ready,messageCount])
  useLayoutEffect(()=>{
    if(navigationPending)stopRestoreRef.current?.()
  },[navigationPending])
  useLayoutEffect(()=>{
    const justEnabled=enabled && !lastEnabled.current
    lastEnabled.current=enabled
    if(!enabled) {initialized.current=undefined;return}
    // Turning it on starts tracking the current view; do not unexpectedly jump
    // to an old checkpoint while the user is changing the setting.
    if(justEnabled)skipRestore.current=true
    const root=rootRef.current
    if(!root || !context || !ready)return
    const epoch=readingPositionEpoch()
    let snapshot: ReadingPosition | null=null
    const capture=()=>{const next=captureReadingPosition(root,rowsRef.current);if(next)snapshot=next}
    const persist=()=>{
      if(snapshot && epoch===readingPositionEpoch() && getSettingsSnapshot().rememberReadingPosition===true)saveReadingPosition(context,snapshot)
    }
    let restoring=false, observer: ResizeObserver | undefined, timeout: number | undefined
    const stopRestore=()=>{
      restoring=false;observer?.disconnect()
      if(timeout!==undefined)window.clearTimeout(timeout)
    }
    stopRestoreRef.current=stopRestore
    if(initialized.current!==context) {
      initialized.current=context
      const saved=!skipRestore.current && !navigationRef.current ? loadReadingPosition(context) : undefined
      skipRestore.current=false
      if(saved) {
        restoring=true
        const restore=()=>{
          if(!restoring || navigationRef.current)return
          restoreReadingPosition(root,rowsRef.current,saved)
          atBottomRef.current=saved.atBottom
          capture()
        }
        restore()
        // Nearby images decode asynchronously. Re-anchor only during initial
        // settling; any user input immediately gives control back to the reader.
        if(typeof ResizeObserver!=='undefined') {
          observer=new ResizeObserver(restore)
          const inner=root.querySelector('[data-markdown-copy-scope]')
          if(inner)observer.observe(inner)
        }
        timeout=window.setTimeout(stopRestore,5000)
      } else if(!navigationRef.current && !justEnabled) {
        root.scrollTop=root.scrollHeight;atBottomRef.current=true
      } else if(navigationRef.current) atBottomRef.current=false
    }
    capture()
    const onScroll=()=>capture()
    const saveNow=()=>{capture();persist()}
    const onVisibility=()=>{if(document.visibilityState==='hidden')saveNow()}
    root.addEventListener('scroll',onScroll,{passive:true})
    document.addEventListener('pointerdown',stopRestore,true)
    document.addEventListener('keydown',stopRestore,true)
    document.addEventListener('touchstart',stopRestore,{passive:true,capture:true})
    document.addEventListener('wheel',stopRestore,{passive:true,capture:true})
    document.addEventListener('visibilitychange',onVisibility)
    window.addEventListener('pagehide',saveNow)
    const interval=window.setInterval(saveNow,10000)
    return()=>{
      // DOM may already belong to another thread: save the last captured
      // snapshot, never query the replacement DOM under the old thread key.
      persist();stopRestore();stopRestoreRef.current=undefined
      window.clearInterval(interval)
      root.removeEventListener('scroll',onScroll)
      document.removeEventListener('pointerdown',stopRestore,true)
      document.removeEventListener('keydown',stopRestore,true)
      document.removeEventListener('touchstart',stopRestore,true)
      document.removeEventListener('wheel',stopRestore,true)
      document.removeEventListener('visibilitychange',onVisibility)
      window.removeEventListener('pagehide',saveNow)
    }
  },[rootRef,atBottomRef,enabled,context,ready])
}

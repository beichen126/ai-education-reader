import { useLayoutEffect, useRef } from 'react'
import { setDraftText, useDraftText } from '../engine/draft-store'
import { t, tx } from '../engine/locale'
import css from './cockpit.module.css'
import { pastedImages } from './composer-file-input'

export function ComposerInput({ draftKey, onSend, onPasteImages }: { draftKey: string; onSend: () => void; onPasteImages: (files: File[]) => void }) {
  const text = useDraftText(draftKey)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const scheduleResize = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    const viewport = window.visualViewport
    const clearInset = () => {
      if (document.activeElement === input) document.documentElement.style.removeProperty('--dsw-keyboard-inset')
    }
    if (CSS.supports('field-sizing', 'content')) {
      const updateLimit = () => {
        if (viewport) input.style.setProperty('--composer-height-limit', Math.max(44, viewport.height / 4) + 'px')
      }
      updateLimit()
      viewport?.addEventListener('resize', updateLimit)
      return () => { viewport?.removeEventListener('resize', updateLimit); clearInset() }
    }
    let frame = 0
    let width = 0
    const resize = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const maxHeight = Math.max(44, (viewport?.height ?? window.innerHeight) / 4)
        const scrollTop = input.scrollTop
        input.style.height = '44px'
        const preferredHeight = input.scrollHeight + 2
        input.style.height = Math.min(preferredHeight, maxHeight) + 'px'
        input.style.overflowY = preferredHeight > maxHeight ? 'auto' : 'hidden'
        if (scrollTop) input.scrollTop = scrollTop
      })
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return
      width = entry.contentRect.width
      resize()
    }) : undefined
    observer?.observe(input)
    window.addEventListener('resize', resize)
    viewport?.addEventListener('resize', resize)
    scheduleResize.current = resize
    resize()
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      viewport?.removeEventListener('resize', resize)
      scheduleResize.current = null
      clearInset()
    }
  }, [])
  useLayoutEffect(() => { scheduleResize.current?.() }, [text])

  return <textarea ref={inputRef} rows={1} className={css.composerText} value={text}
    aria-label={tx('输入消息', 'Message')} placeholder={t('composer.placeholder')}
    onFocus={event => {
      event.currentTarget.scrollIntoView({ block: 'nearest' })
      const viewport = window.visualViewport
      if (viewport && viewport.height < window.innerHeight) {
        document.documentElement.style.setProperty('--dsw-keyboard-inset', (window.innerHeight - viewport.height) + 'px')
      }
    }}
    onBlur={() => { composing.current = false; document.documentElement.style.removeProperty('--dsw-keyboard-inset') }}
    onCompositionStart={() => { composing.current = true }}
    onCompositionEnd={() => { composing.current = false }}
    onChange={event => setDraftText(draftKey, event.target.value)}
    onPaste={event => {
      const files = pastedImages(event.clipboardData)
      if (!files.length) return
      event.preventDefault()
      onPasteImages(files)
    }}
    onKeyDown={event => {
      if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
      event.preventDefault()
      onSend()
    }} />
}

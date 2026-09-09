import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BookmarkRangeEndMode, BookmarkRangePresentation } from '../pdf/bookmark-range'
import css from './chapter-range-mode-control.module.css'

type Props = {
  chapterId: string
  chapterTitle: string
  mode: BookmarkRangeEndMode
  presentation: BookmarkRangePresentation
  onChange: (mode: BookmarkRangeEndMode) => void
}

type Position = {
  left: number
  top: number
}

const OPTIONS: readonly BookmarkRangeEndMode[] = ['exclusive', 'inclusive']

function optionLabel(mode: BookmarkRangeEndMode, presentation: BookmarkRangePresentation): string {
  return mode === 'exclusive'
    ? '左闭右开 · ' + presentation.exclusive.label
    : '左闭右闭 · ' + presentation.inclusive.label
}

export function ChapterRangeModeControl({ chapterId, chapterTitle, mode, presentation, onChange }: Props) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<Record<BookmarkRangeEndMode, HTMLButtonElement | null>>({ exclusive: null, inclusive: null })
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<Position | null>(null)
  const popupId = 'doc-context-range-menu-' + chapterId

  const focusOption = (nextMode: BookmarkRangeEndMode) => {
    window.requestAnimationFrame(() => optionRefs.current[nextMode]?.focus())
  }

  const close = (returnFocus = true) => {
    setOpen(false)
    if (returnFocus) window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const updatePosition = () => {
    const trigger = triggerRef.current
    const popup = popupRef.current
    if (!trigger) return
    const triggerRect = trigger.getBoundingClientRect()
    const popupWidth = popup?.getBoundingClientRect().width || Math.max(triggerRect.width, 140)
    const popupHeight = popup?.getBoundingClientRect().height || 64
    const gutter = 8
    const left = Math.min(Math.max(gutter, triggerRect.left), Math.max(gutter, window.innerWidth - popupWidth - gutter))
    const below = triggerRect.bottom + 4
    const top = below + popupHeight <= window.innerHeight - gutter
      ? below
      : Math.max(gutter, triggerRect.top - popupHeight - 4)
    setPosition({ left, top })
  }

  useLayoutEffect(() => {
    if (!open) return
    updatePosition()
    const frame = window.requestAnimationFrame(updatePosition)
    const reposition = () => updatePosition()
    window.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('resize', reposition)
    document.addEventListener('scroll', reposition, true)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('resize', reposition)
      document.removeEventListener('scroll', reposition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !popupRef.current?.contains(target)) close(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const openMenu = (focus: BookmarkRangeEndMode = mode) => {
    setPosition(null)
    setOpen(true)
    focusOption(focus)
  }

  const select = (nextMode: BookmarkRangeEndMode) => {
    onChange(nextMode)
    close()
  }

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openMenu(event.key === 'ArrowUp' ? 'inclusive' : mode)
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      close()
    }
  }

  const handleOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, option: BookmarkRangeEndMode) => {
    const index = OPTIONS.indexOf(option)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = event.key === 'ArrowDown' ? OPTIONS[(index + 1) % OPTIONS.length] : OPTIONS[(index - 1 + OPTIONS.length) % OPTIONS.length]
      focusOption(next)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusOption(event.key === 'Home' ? OPTIONS[0] : OPTIONS[OPTIONS.length - 1])
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      select(option)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'Tab') {
      close(false)
    }
  }

  const popup = open && createPortal(
    <div
      ref={popupRef}
      id={popupId}
      className={css.popup}
      role="listbox"
      aria-label={chapterTitle + ' 范围'}
      style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {OPTIONS.map(option => (
        <button
          key={option}
          ref={element => { optionRefs.current[option] = element }}
          type="button"
          className={css.option}
          role="option"
          aria-selected={mode === option}
          onClick={() => select(option)}
          onKeyDown={event => handleOptionKeyDown(event, option)}
        >
          {optionLabel(option, presentation)}
        </button>
      ))}
    </div>,
    document.body,
  )

  return (
    <span className={css.root}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        data-testid={'doc-context-mode-' + chapterId}
        aria-label={chapterTitle + ' 范围'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={popupId}
        aria-describedby={'doc-context-range-help-' + chapterId}
        onClick={() => open ? close(false) : openMenu()}
        onKeyDown={handleTriggerKeyDown}
      >
        {presentation[mode].label} <span className={css.chevron} aria-hidden="true">▾</span>
      </button>
      {popup}
    </span>
  )
}

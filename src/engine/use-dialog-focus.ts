import { useEffect, useRef, type RefObject } from 'react'

const dialogs: HTMLElement[] = []
const focusable = 'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]'

export function useDialogFocus(ref: RefObject<HTMLElement>, open: boolean, onClose: () => void) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const dialog = ref.current
    if (!open || !dialog) return
    const opener = document.activeElement
    dialogs.push(dialog)
    const stops = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusable)).filter(element =>
      element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[inert]') &&
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
    )
    const focus = (element: HTMLElement = dialog) => element.focus({ preventScroll: true })
    if (!dialog.contains(document.activeElement)) focus(stops()[0])
    const keydown = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== dialog || !dialog.getClientRects().length || event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close.current()
      } else if (event.key === 'Tab') {
        const candidates = stops()
        const from = candidates.indexOf(document.activeElement as HTMLElement)
        if (from < 0 || (event.shiftKey ? from === 0 : from === candidates.length - 1)) {
          event.preventDefault()
          focus(event.shiftKey ? candidates.at(-1) : candidates[0])
        }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      const top = dialogs.at(-1) === dialog
      dialogs.splice(dialogs.indexOf(dialog), 1)
      if (top && opener instanceof HTMLElement && opener.isConnected) focus(opener)
    }
  }, [ref, open])
}

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBackTarget } from '../engine/back-navigation'
import { tx } from '../engine/locale'
import { closePdfSession, openPdfSession, type PdfSession } from '../pdf/pdf-session'
import { normalizePdfRanges, type PdfRange } from '../pdf/pdf-types'
import { readDocumentSourceBlob } from './document-service'
import { TocPagePicker } from './TocPagePicker'
import css from './toc-page-picker.module.css'

export function PdfAttachmentPagePicker({ source, onCancel, onSelect }: {
  source: Blob | string
  onCancel: () => void
  onSelect: (ranges: PdfRange[]) => void
}) {
  const [session, setSession] = useState<PdfSession>()
  const [failed, setFailed] = useState(false)
  const loadingCancel = useRef<HTMLButtonElement>(null)
  useBackTarget(true, onCancel, 80)
  useEffect(() => {
    const opener = document.activeElement
    loadingCancel.current?.focus()
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus() }
  }, [])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onCancel()
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [onCancel])
  useEffect(() => {
    let active = true
    let owned: PdfSession | undefined
    void (async () => {
      try {
        const blob = typeof source === 'string' ? await readDocumentSourceBlob(source) : source
        if (!active) return
        const opened = await openPdfSession(blob)
        owned = opened.session
        if (active) setSession(owned)
        else await closePdfSession(owned)
      } catch { if (active) setFailed(true) }
    })()
    return () => {
      active = false
      if (owned) void closePdfSession(owned)
    }
  }, [source])
  return createPortal(session ? <TocPagePicker forAttachment session={session} pageCount={session.documentProxy.numPages} onCancel={onCancel}
    onStart={pages => onSelect(normalizePdfRanges(pages.map(page => ({ startPage: page, endPage: page }))))} /> : <div className={css.overlay + ' ' + css.attachmentOverlay}>
    <div className={css.panel}><div className={css.header}>
      <span role="status">{failed ? tx('无法读取 PDF 页面。', 'Unable to load PDF pages.') : tx('正在打开 PDF…', 'Opening PDF…')}</span>
      <button ref={loadingCancel} type="button" className={css.btn} onClick={onCancel}>{tx('取消', 'Cancel')}</button>
    </div></div>
  </div>, document.body)
}

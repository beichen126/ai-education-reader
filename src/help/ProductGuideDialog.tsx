import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownBlocks } from '../markdown/MarkdownBlocks'
import guideContent from './product-guide.md?raw'
import css from './product-guide-dialog.module.css'

type GuideAction = () => void

function guideHeadings(content: string): string[] {
  return content.split('\n').filter(line => /^## /.test(line)).map(line => line.slice(3).trim())
}

export function ProductGuideDialog({
  open,
  onClose,
  onImportPdf,
  onOpenLibrary,
  onConfigureApi,
}: {
  open: boolean
  onClose: () => void
  onImportPdf: GuideAction
  onOpenLibrary: GuideAction
  onConfigureApi: GuideAction
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const headings = useMemo(() => guideHeadings(guideContent), [])

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const scroll = scrollRef.current
    if (scroll) scroll.scrollTop = 0
    const headingNodes = Array.from(scroll?.querySelectorAll('h2') ?? [])
    headingNodes.forEach((node, index) => { node.id = `product-guide-section-${index}` })
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter(el => el.offsetParent !== null)
    const first = focusables()[0]
    window.setTimeout(() => first?.focus(), 0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const current = document.activeElement
      const index = items.indexOf(current as HTMLElement)
      if (event.shiftKey && (index <= 0 || index < 0)) { event.preventDefault(); items[items.length - 1].focus() }
      else if (!event.shiftKey && (index === items.length - 1 || index < 0)) { event.preventDefault(); items[0].focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const previous = previousFocusRef.current
      previousFocusRef.current = null
      if (previous?.isConnected) previous.focus()
    }
  }, [open, onClose])

  if (!open) return null

  const scrollToHeading = (index: number) => {
    const node = dialogRef.current?.querySelector<HTMLElement>(`#product-guide-section-${index}`)
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const finish = (action: GuideAction) => { onClose(); action() }

  return createPortal((
    <div className={css.root} data-testid="product-guide-overlay">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        className={css.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-guide-title"
        data-testid="product-guide"
      >
        <header className={css.header}>
          <div>
            <h2 id="product-guide-title" className={css.title}>先了解一下 AI Education Reader</h2>
            <p className={css.subtitle}>不用先配置 API，也可以先看懂它能做什么。</p>
          </div>
          <button type="button" className={css.close} data-testid="product-guide-close" aria-label="稍后再看" onClick={onClose}>×</button>
        </header>
        <div className={css.actions} aria-label="开始使用">
          <button type="button" className={css.primaryAction} data-testid="product-guide-import" onClick={() => finish(onImportPdf)}>导入 PDF</button>
          <button type="button" className={css.action} data-testid="product-guide-library" onClick={() => finish(onOpenLibrary)}>打开资料库</button>
          <button type="button" className={css.action} data-testid="product-guide-settings" onClick={() => finish(onConfigureApi)}>配置 API</button>
        </div>
        <div className={css.guideLayout}>
          <nav className={css.toc} aria-label="说明目录">
            <div className={css.tocTitle}>这份说明</div>
            {headings.map((heading, index) => (
              <button key={heading} type="button" className={css.tocItem} data-testid={`product-guide-toc-${index}`} onClick={() => scrollToHeading(index)}>{heading}</button>
            ))}
          </nav>
          <div ref={scrollRef} className={css.scroll} data-testid="product-guide-scroll">
            <MarkdownBlocks content={guideContent} messageId="product-guide" />
            <button type="button" className={css.backTop} data-testid="product-guide-top" onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}>回到顶部</button>
          </div>
        </div>
        <footer className={css.footer}>
          <span>可以先关闭，之后随时从侧栏“帮助”再次打开。</span>
          <button type="button" className={css.later} data-testid="product-guide-later" onClick={onClose}>稍后再看</button>
        </footer>
      </div>
    </div>
  ), document.body)
}

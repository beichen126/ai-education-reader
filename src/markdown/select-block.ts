/** Explicit double-click/tap selects a semantic unit without scrolling or copying. */
export function selectMarkdownBlock(root: HTMLElement, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || target.closest('button,a,input,textarea,select,[contenteditable="true"]')) return false
  const block = target.closest<HTMLElement>('[data-math-id],table,p,pre,h1,h2,h3,h4,h5,h6,li,blockquote')
  if (!block || !root.contains(block)) return false
  const range = document.createRange()
  // Select visible KaTeX only; its accessibility MathML duplicates the text.
  range.selectNodeContents(block.matches('[data-math-id]') ? block.querySelector('.katex-html') ?? block : block)
  if (range.collapsed) return false
  const selection = window.getSelection()
  if (!selection) return false
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return true
}

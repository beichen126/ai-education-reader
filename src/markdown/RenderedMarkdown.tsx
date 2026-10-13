import { memo, type ClipboardEvent } from 'react'
import { MarkdownBlocks } from './MarkdownBlocks'
import { markdownSourceForRange } from './source-copy'

/** Read-only Markdown with source-preserving partial copy, without study marks. */
export const RenderedMarkdown = memo(function RenderedMarkdown({ content, messageId }: { content: string; messageId: string }) {
  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return
    const source = markdownSourceForRange(event.currentTarget, content, selection.getRangeAt(0))
    if (source === null) return
    try {
      event.clipboardData.setData('text/plain', source)
      try { event.clipboardData.setData('text/markdown', source) } catch {}
      event.preventDefault()
    } catch { /* Fall back to the browser's rendered-text copy. */ }
  }
  return <div onCopy={onCopy}><MarkdownBlocks content={content} messageId={messageId} exposeMessageId={false} /></div>
})

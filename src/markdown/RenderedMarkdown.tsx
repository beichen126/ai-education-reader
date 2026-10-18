import { memo } from 'react'
import { MarkdownBlocks } from './MarkdownBlocks'

/** Read-only Markdown with source-preserving partial copy, without study marks. */
export const RenderedMarkdown = memo(function RenderedMarkdown({ content, messageId }: { content: string; messageId: string }) {
  return <div data-user-markdown=""><MarkdownBlocks content={content} messageId={messageId} exposeMessageId={false} /></div>
})

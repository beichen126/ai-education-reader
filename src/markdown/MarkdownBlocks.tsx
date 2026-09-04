import { createElement, useMemo } from 'react'
import type { ReactNode } from 'react'
import { renderToString as katexRenderString } from 'katex'
import { parseMarkdown } from './parse'
import 'katex/dist/katex.min.css'
import { blockIdOf, tableIdOf, mathIdOf, mathKindOf, startOf, endOf } from './block-layer'
import { sanitizeMarkdownHref, isExternalHref } from './link-security'
import type { Annotation } from '../annotations/annotation-types'
import css from './markdown.module.css'
import type { Root } from 'mdast'

type Cur = { v: number }
type RenderCtx = { messageId: string; annotations?: Annotation[]; onMathAction?: (mathId: string, kind: 'inline' | 'block') => void }
function kathRender(tex: string, display: boolean): string { try { return katexRenderString(tex, { displayMode: display, throwOnError: false, trust: false }) } catch { return tex } }

function isMathHl(annotations: Annotation[] | undefined, mathId: string): boolean { return !!(annotations && annotations.some((a: any) => a.target && a.target.type === 'math' && a.target.mathId === mathId)) }

function inline(node: any, cur: Cur, ctx: RenderCtx): ReactNode {
  switch (node.type) {
    case 'text': {
      const st = cur.v; cur.v += node.value.length
      return <span data-canonical-start={st} data-canonical-end={cur.v}>{node.value}</span>
    }
    case 'break': {
      const st = cur.v; cur.v += 1
      return <br data-canonical-start={st} data-canonical-end={cur.v} />
    }
    case 'strong': return <strong>{node.children ? node.children.map((c: any) => inline(c, cur, ctx)) : ''}</strong>
    case 'emphasis': return <em>{node.children ? node.children.map((c: any) => inline(c, cur, ctx)) : ''}</em>
    case 'link': {
      const safe = sanitizeMarkdownHref(typeof node.url === 'string' ? node.url : '')
      const children = node.children ? node.children.map((c: any) => inline(c, cur, ctx)) : ''
      if (safe === null) return <span>{children}</span>
      return <a href={safe} {...(isExternalHref(safe) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>
    }
    case 'inlineMath': {
      const st = cur.v; cur.v += 1
      const mathId = mathIdOf(ctx.messageId, 'inline', startOf(node), endOf(node))
      const hl = isMathHl(ctx.annotations, mathId)
      return <span data-canonical-start={st} data-canonical-end={cur.v} data-math data-math-id={mathId} data-math-kind="inline" data-annotatable="false" className={(css.mathInline || '') + (hl ? ' ' + css.studyMathHighlighted : '')} dangerouslySetInnerHTML={{ __html: kathRender(node.value || '', false) }} onClick={(e) => { e.stopPropagation(); if (ctx.onMathAction) ctx.onMathAction(mathId, 'inline') }}></span>
    }
    case 'inlineCode': { const st = cur.v; cur.v += (node.value || '').length; return <code data-canonical-start={st} data-canonical-end={cur.v}>{node.value}</code> }
    default: return node.children ? node.children.map((c: any) => inline(c, cur, ctx)) : (typeof node.value === 'string' ? node.value : '')
  }
}
function inlineList(nodes: any[] | undefined, cur: Cur, ctx: RenderCtx): ReactNode { return nodes ? nodes.map((n, i) => <span key={i}>{inline(n, cur, ctx)}</span>) : null }

function innerBlock(node: any, cur: Cur, ctx: RenderCtx): ReactNode {
  if (node.type === 'paragraph') return <p>{inlineList(node.children, cur, ctx)}</p>
  if (node.type === 'list') { const rows = node.children || []; return node.ordered ? <ol>{rows.map((li: any, i: number) => <li key={i}>{innerList(li, cur, ctx)}</li>)}</ol> : <ul>{rows.map((li: any, i: number) => <li key={i}>{innerList(li, cur, ctx)}</li>)}</ul> }
  if (node.type === 'listItem') return <li>{innerList(node, cur, ctx)}</li>
  if (node.type === 'blockquote') return <blockquote>{innerNodes(node.children || [], cur, ctx)}</blockquote>
  return inlineList(node.children, cur, ctx)
}
function innerNodes(nodes: any[], cur: Cur, ctx: RenderCtx): ReactNode { return nodes.map((n, i) => <span key={i}>{innerBlock(n, cur, ctx)}</span>) }
function innerList(li: any, cur: Cur, ctx: RenderCtx): ReactNode { return innerNodes(li.children || [], cur, ctx) }

function blockEl(node: any, ctx: RenderCtx, onTableAction?: (tableId: string) => void): ReactNode {
  const messageId = ctx.messageId
  const annotations = ctx.annotations
  const t = node.type
  const typeCode = t === 'heading' ? 'heading' : t === 'paragraph' ? 'paragraph' : t === 'listItem' ? 'list-item' : t === 'blockquote' ? 'blockquote' : t === 'table' ? 'table' : t === 'code' ? 'code' : t === 'math' ? 'math' : 'paragraph'
  const bid = blockIdOf(messageId, typeCode as any, startOf(node), endOf(node))
  const cur: Cur = { v: 0 }
  if (t === 'heading') { const level = node.depth; return createElement('h' + Math.min(6, Math.max(1, level)), { 'data-block-id': bid, 'data-block-type': 'heading' }, inlineList(node.children, cur, ctx)) }
  if (t === 'paragraph') return <p data-block-id={bid} data-block-type='paragraph'>{inlineList(node.children, cur, ctx)}</p>
  if (t === 'list') { const rows = node.children || []; return node.ordered ? <ol>{rows.map((li: any, i: number) => <span key={i}>{blockEl(li, ctx)}</span>)}</ol> : <ul>{rows.map((li: any, i: number) => <span key={i}>{blockEl(li, ctx)}</span>)}</ul> }
  if (t === 'listItem') return <li data-block-id={bid} data-block-type='list-item'>{innerNodes(node.children || [], cur, ctx)}</li>
  if (t === 'blockquote') return <blockquote data-block-id={bid} data-block-type='blockquote'>{innerNodes(node.children || [], cur, ctx)}</blockquote>
  if (t === 'table') {
    const tid = tableIdOf(messageId, startOf(node), endOf(node))
    const rows: any[] = node.children || []
    const whole = !!annotations && annotations.some((a: any) => a.target && a.target.type === 'table' && a.target.tableId === tid)
    const coveredRect = (r: number, c: number) => { if (!annotations) return false; return annotations.some((a: any) => a.target && a.target.type === 'table-cells' && a.target.tableId === tid && r >= a.target.bounds.rowStart && r <= a.target.bounds.rowEnd && c >= a.target.bounds.columnStart && c <= a.target.bounds.columnEnd) }
    return (<div className={css.tableScroll + (whole ? ' ' + css.studyTableHighlighted : '')} data-table-id={tid} data-block-id={bid} data-block-type='table'>{onTableAction && <button className={css.tableAction} data-table-action={tid} onClick={(e) => { e.stopPropagation(); onTableAction(tid) }}>⋯</button>}<table><tbody>{rows.map((row: any, r: number) => (<tr key={r}>{row.children.map((cell: any, c: number) => { const ccur: Cur = { v: 0 }; const hit = whole || coveredRect(r, c); return <td key={c} data-row={r} data-col={c} className={hit ? css.studyCellHighlighted : undefined}>{inlineList(cell.children, ccur, ctx)}</td> })}</tr>))}</tbody></table></div>)
  }
  if (t === 'math') {
    const mathId = mathIdOf(messageId, 'block', startOf(node), endOf(node))
    const hl = isMathHl(annotations, mathId)
    return <div data-block-id={bid} data-block-type='math' data-math-id={mathId} data-math-kind="block" data-annotatable='false' className={(css.mathBlock || '') + (hl ? ' ' + css.studyMathHighlighted : '')} dangerouslySetInnerHTML={{ __html: kathRender(node.value || '', true) }} onClick={(e) => { e.stopPropagation(); if (ctx.onMathAction) ctx.onMathAction(mathId, 'block') }}></div>
  }
  if (t === 'code') return <pre data-block-id={bid} data-block-type='code' data-annotatable='false'><code>{node.value || ''}</code></pre>
  return null
}

export function MarkdownBlocks({ content, messageId, annotations, onTableAction, onMathAction }: { content: string; messageId: string; annotations?: Annotation[]; onTableAction?: (tableId: string) => void; onMathAction?: (mathId: string, kind: 'inline' | 'block') => void }) {
  const root = useMemo<Root>(() => parseMarkdown(content), [content])
  const children = (root.children || []) as any[]
  const ctx: RenderCtx = { messageId, annotations, onMathAction }
  return <div className={css.markdown} data-message-id={messageId}>{children.map((n, i) => <span key={i}>{blockEl(n, ctx, onTableAction)}</span>)}</div>
}

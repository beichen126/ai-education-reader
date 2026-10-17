import { useEffect, useMemo, useState } from 'react'
import { buildBlockMap } from '../annotations/canonical'
import { AnnotatedMarkdown } from '../annotations/AnnotatedMarkdown'
import { useMessageAnnotations, refreshMessageAnnotations } from '../annotations/annotation-store'
import type { StudyCard } from './study-card-types'
import { markContext } from './mark-context'
import { tx } from '../engine/locale'
import css from './study-card.module.css'

export function MarkedPassage({card}: {card:StudyCard}) {
  const [index,setIndex] = useState(0)
  const [full,setFull] = useState(false)
  const liveMarks = useMessageAnnotations(card.source.conversationId,card.source.assistantMessageId)
  const [loaded,setLoaded] = useState(false)
  useEffect(()=>{
    let active=true
    void refreshMessageAnnotations(card.source.conversationId,card.source.assistantMessageId).then(()=>{if(active)setLoaded(true)}).catch(()=>{})
    return()=>{active=false}
  },[card.source.conversationId,card.source.assistantMessageId])
  const marks = loaded ? liveMarks : card.annotations ?? []
  const currentIndex=Math.min(index,Math.max(0,marks.length-1))
  const annotation = marks[currentIndex]
  const models = useMemo(()=>buildBlockMap(card.bodyMarkdown,card.source.assistantMessageId),[card.bodyMarkdown,card.source.assistantMessageId])
  const passage = useMemo(()=>{
    if (!annotation || annotation.target.type!=='text') return null
    const target = annotation.target
    if(target.quote.exact.includes('\uFFFF')) return null
    const local = models.canonicalOf(target.anchor)
    let start = target.start, end = target.end
    if(local.slice(start,end)!==target.quote.exact) {
      start=local.indexOf(target.quote.exact)
      if(start<0 || local.indexOf(target.quote.exact,start+1)>=0) return null
      end=start+target.quote.exact.length
    }
    // Surrounding blocks supply context when the mark is at a paragraph edge.
    const blocks=[...models.blocks.values()]
    const anchor=target.anchor
    const ownerIndex=anchor.scope==='block' ? blocks.findIndex(block=>block.id===anchor.blockId) : blocks.findIndex(block=>block.table?.id===anchor.tableId)
    if(ownerIndex<0) return null
    const before=blocks.slice(0,Math.max(0,ownerIndex)).map(block=>block.canonicalText).join('\n\n')
    const after=blocks.slice(ownerIndex+1).map(block=>block.canonicalText).join('\n\n')
    const text=(before?before+'\n\n':'')+local+(after?'\n\n'+after:'')
    const offset=before?before.length+2:0
    return markContext(text,offset+start,offset+end)
  },[annotation,models])
  if(loaded && marks.length===0) return <p data-testid="mark-reader-empty">{tx('此处的标记已移除。','The marks here have been removed.')}</p>
  return <div className={css.markReading} data-testid="mark-reader">
    <div className={css.markControls}>
      <button type="button" className={css.small} data-testid="mark-previous" disabled={currentIndex===0} onClick={()=>setIndex(currentIndex-1)}>{tx('上一处','Previous mark')}</button>
      <span>{Math.min(currentIndex+1,marks.length)} / {marks.length}</span>
      <button type="button" className={css.small} data-testid="mark-next" disabled={currentIndex>=marks.length-1} onClick={()=>setIndex(currentIndex+1)}>{tx('下一处','Next mark')}</button>
      <button type="button" className={css.small} data-testid="mark-toggle-full" onClick={()=>setFull(v=>!v)}>{full?tx('聚焦标记','Focus mark'):tx('查看全文','View full response')}</button>
    </div>
    {!full&&passage ? <div className={css.markFocus} data-testid="mark-context">
      <p className={css.markSurrounding} data-testid="mark-context-before">{passage.before.replaceAll('\uFFFF',' [∑] ')}</p>
      <mark className={css.markExact} data-testid="mark-context-exact">{passage.exact.replaceAll('\uFFFF',' [∑] ')}</mark>
      <p className={css.markSurrounding} data-testid="mark-context-after">{passage.after.replaceAll('\uFFFF',' [∑] ')}</p>
    </div> : <div className={css.markFull}>
      {!full && <p>{tx('此标记为公式、表格或旧锚点，显示原文以避免截错上下文。','This mark is a formula, table, or legacy anchor. Showing the original response to avoid incorrect context.')}</p>}
      <AnnotatedMarkdown content={card.bodyMarkdown} messageId={card.source.assistantMessageId} conversationId={card.source.conversationId} branchId={card.source.branchId} focusAnnotation={annotation}/>
    </div>}
  </div>
}

import { useId, useMemo, useState, useRef, useLayoutEffect } from 'react'
import { DiagramNode as NativeDiagram } from 'reader-genui-diagram-original'
import { diagramRanks, type ReadableDiagramSpec } from './readable-diagram-layout'
import { tx } from '../engine/locale'
import css from './readable-diagram.module.css'

type Props = { node: ReadableDiagramSpec; answers?: { fields: Record<string, string>; setField: (id: string, value: string) => void } }
export function DiagramNode(props: Props) {
  const rows = useMemo(() => diagramRanks(props.node), [props.node])
  if (!rows) return <div className={css.native}><NativeDiagram {...props} /></div>
  return <CardDiagram {...props} rows={rows} />
}

function CardDiagram({ node, answers, rows }: Props & { rows: NonNullable<ReturnType<typeof diagramRanks>> }) {
  const marker = 'arrow-' + useId().replace(/:/g, ''), [zoom, setZoom] = useState(1), [localSelection, setLocalSelection] = useState('')
  const viewport = useRef<HTMLDivElement>(null), [availableWidth, setAvailableWidth] = useState(640)
  useLayoutEffect(() => { const el = viewport.current; if (!el) return; const observer = new ResizeObserver(() => setAvailableWidth(el.clientWidth)); observer.observe(el); return () => observer.disconnect() }, [])
  const selected = (node.id ? answers?.fields[node.id] : undefined) || localSelection
  const selectedNode = node.nodes.find(n => n.id === selected)
  // Use HTML text at 18/14px. Never shrink the graph to a fixed-height thumbnail.
  const cols = Math.max(...rows.map(r => r.length)), width = Math.max(640, availableWidth, cols * 280 + (cols - 1) * 24 + 32)
  const height = rows.length * 132 - 28
  const positions = new Map(rows.flatMap((row, rank) => {
    const cardWidth = (width - 32 - (row.length - 1) * 24) / row.length
    const rowWidth = row.length * cardWidth + (row.length - 1) * 24
    return row.map((n, col) => [n.id, { x: (width - rowWidth) / 2 + col * (cardWidth + 24), y: rank * 132 + 8, w: cardWidth, h: 88 }] as const)
  }))
  return <figure className={css.figure} data-genui-diagram data-reader-diagram>
    <div className={css.heading}><figcaption>{node.title || tx('流程与架构', 'Flow and architecture')}</figcaption><div className={css.zoom} aria-label={tx('图解缩放', 'Diagram zoom')}><button type="button" aria-label={tx('缩小图解', 'Zoom out diagram')} disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z - .25))}>−</button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label={tx('放大图解', 'Zoom in diagram')} disabled={zoom >= 2} onClick={() => setZoom(z => Math.min(2, z + .25))}>＋</button></div></div>
    <div ref={viewport} className={css.viewport} tabIndex={0} aria-label={tx('可滚动图解', 'Scrollable diagram')}>
      <div style={{ width: width * zoom, height: height * zoom, minWidth: '100%' }}>
        <div className={css.canvas} style={{ width, height, transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
          <svg className={css.edges} width={width} height={height} aria-hidden="true"><defs><marker id={marker} markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M1 1 L6 4 L1 7" fill="none" stroke="currentColor" strokeWidth="1.5" /></marker></defs>
            {(node.edges || []).map((edge, i) => {
              const a = positions.get(edge.from)!, b = positions.get(edge.to)!, x1 = a.x + a.w / 2, y1 = a.y + a.h + 5, x2 = b.x + b.w / 2, y2 = b.y - 7, mid = (y1 + y2) / 2
              return <g key={i}><path d={`M${x1},${y1} V${mid} H${x2} V${y2}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray={edge.kind === 'dashed' ? '5 5' : undefined} markerEnd={`url(#${marker})`} />{edge.label && <text x={(x1 + x2) / 2 + 8} y={mid - 7} fontSize="13" fill="currentColor">{edge.label}</text>}</g>
            })}
          </svg>
          {node.nodes.map(item => {
            const pos = positions.get(item.id)!
            return <button key={item.id} type="button" className={css.node + (item.type === 'focal' ? ' ' + css.focal : '')} style={{ left: pos.x, top: pos.y, width: pos.w, height: pos.h }} aria-pressed={selected === item.id} onClick={() => { setLocalSelection(item.id); if (node.id) answers?.setField(node.id, item.id) }}>
              {item.tag && <small>{item.tag}</small>}<strong>{item.label}</strong>{item.sub && <span>{item.sub}</span>}
            </button>
          })}
        </div>
      </div>
    </div>
    <small className={css.hint}>{tx('可横向查看或放大，点击节点查看详情。', 'Scroll or zoom; select a node for details.')}</small>
    {selectedNode && <div className={css.details} role="status"><strong>{selectedNode.label}</strong><p>{selectedNode.description || selectedNode.sub || tx('此节点没有补充说明。', 'No additional details for this node.')}</p></div>}
  </figure>
}

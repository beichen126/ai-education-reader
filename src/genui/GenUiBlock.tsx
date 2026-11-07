import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { parseGenUi, type UiNode } from './schema'
import './genui.css'
export const GenUiActions = createContext<((text: string) => Promise<void>) | null>(null)
const str = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? String(v) : ''
export function GenUiBlock({ source }: { source: string }) {
  const result = useMemo(() => { try { return { nodes: parseGenUi(source) } } catch (e) { return { error: String(e) } } }, [source])
  return <section className="genui" data-annotatable="false" aria-label="GenUI"><GenUiContent key={source} source={source} nodes={result.nodes} error={result.error} /></section>
}
function GenUiContent({ source, nodes, error }: { source: string; nodes?: UiNode[]; error?: string }) {
  const send = useContext(GenUiActions)
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    function collect(items: UiNode[]) { for (const n of items) {
      if (['input','select','slider'].includes(n.type)) initial[n.id] = str(n.value)
      if (['card','stack','row','grid'].includes(n.type)) collect(n.items ?? [])
      if (n.type === 'accordion') n.items.forEach((g: any) => collect(g.items ?? []))
      if (n.type === 'tabs') n.tabs.forEach((g: any) => collect(g.items ?? []))
    } }
    collect(nodes ?? []); return initial
  })
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  async function action(n: UiNode) {
    if (!send || busy) return
    setBusy(true); setStatus('')
    try { await send('[genui-action]\n' + JSON.stringify({ action: n.action, fields })); setStatus('已发送') }
    catch (e) { setStatus(e instanceof Error ? e.message : '发送失败，请重试') }
    finally { setBusy(false) }
  }
  function render(n: UiNode, key: number): ReactNode {
    const children = () => (n.items ?? []).map(render)
    const title = str(n.title || n.label)
    switch (n.type) {
      case 'text': return <p key={key}>{str(n.content)}</p>
      case 'heading': return <h3 key={key}>{str(n.text || n.content)}</h3>
      case 'card': case 'stack': case 'row': case 'grid': return <div key={key} className={'genui-' + n.type}>{title && <strong>{title}</strong>}{children()}</div>
      case 'callout': return <aside key={key}><strong>{title}</strong><p>{str(n.content)}</p></aside>
      case 'badge': return <span key={key} className="genui-badge">{str(n.text || n.label)}</span>
      case 'stat': return <div key={key} className="genui-stat"><small>{title}</small><strong>{str(n.value)}</strong></div>
      case 'progress': return <label key={key}>{title}<progress max={100} value={Math.max(0, Math.min(100, Number(n.value) || 0))} /></label>
      case 'list': case 'steps': { const Tag = n.type === 'steps' ? 'ol' : 'ul'; return <Tag key={key}>{n.items.map((i: any, j: number) => <li key={j}><strong>{str(i?.title ?? i)}</strong>{i?.desc && <p>{str(i.desc)}</p>}</li>)}</Tag> }
      case 'quiz': return <Quiz key={key} node={n} />
      case 'table': return <UiTable key={key} node={n} />
      case 'chart': { const data = n.data ?? n.items; const max = Math.max(1, ...data.map((d: any) => Math.abs(Number(d?.value) || 0))); return <figure key={key}><figcaption>{title}</figcaption>{data.map((d: any, j: number) => <div className="genui-bar" key={j}><span>{str(d?.label)}</span><meter min={0} max={max} value={Math.abs(Number(d?.value) || 0)} /><b>{str(d?.value)}</b></div>)}</figure> }
      case 'input': case 'select': case 'slider': { const id = str(n.id); return <label key={key}>{title}{n.type === 'select' ? <select value={fields[id] ?? ''} onChange={e => setFields({ ...fields, [id]: e.target.value })}><option value="">请选择…</option>{n.options.map((o: unknown, j: number) => <option key={j}>{str(o)}</option>)}</select> : <input type={n.type === 'slider' ? 'range' : 'text'} min={Number(n.min) || 0} max={Number(n.max) || 100} step={Number(n.step) || 1} value={fields[id] ?? str(n.value)} onChange={e => setFields({ ...fields, [id]: e.target.value })} />}{n.type === 'slider' && <output>{fields[id] ?? str(n.value)}</output>}</label> }
      case 'button': case 'submit': return <button key={key} type="button" disabled={!send || busy || !n.action} onClick={() => void action(n)}>{title || '继续'}</button>
      case 'tabs': return <Tabs key={key} node={n} render={render} />
      case 'accordion': return <div key={key}>{n.items.map((i: any, j: number) => <details key={j}><summary>{str(i.title)}</summary>{i.items.map(render)}</details>)}</div>
      default: return null
    }
  }
  return <>{error ? <p role="status">UI 尚未完成或格式不受支持，可查看源码。</p> : nodes?.map(render)}{status && <p role="status">{status}</p>}<details className="genui-source"><summary>查看 UI 源码</summary><pre>{source}</pre></details></>
}
function Quiz({ node: n }: { node: UiNode }) {
  const [answer, setAnswer] = useState<number | null>(null)
  return <fieldset><legend>{str(n.question)}</legend>{n.options.map((o: any, i: number) => <button type="button" key={i} aria-pressed={answer === i} onClick={() => setAnswer(i)}>{str(o?.label)}</button>)}{answer !== null && <p role="status">{n.options[answer]?.correct ? '✓ 回答正确' : '再想一想'} {str(n.options[answer]?.feedback || n.explanation)}</p>}</fieldset>
}
function Tabs({ node, render }: { node: UiNode; render: (n: UiNode, key: number) => ReactNode }) {
  const [index, setIndex] = useState(0)
  return <div><div className="genui-row">{node.tabs.map((t: any, i: number) => <button type="button" key={i} aria-pressed={i === index} onClick={() => setIndex(i)}>{str(t.label)}</button>)}</div>{node.tabs[index]?.items.map(render)}</div>
}
function UiTable({ node }: { node: UiNode }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ col: number; dir: number }>({ col: -1, dir: 1 })
  const rows = node.rows.filter((r: unknown[]) => r.some(v => str(v).toLowerCase().includes(query.toLowerCase()))).slice()
  if (sort.col >= 0) rows.sort((a: unknown[], b: unknown[]) => str(a[sort.col]).localeCompare(str(b[sort.col]), undefined, { numeric: true }) * sort.dir)
  return <div className="genui-table"><input aria-label="筛选表格" placeholder="筛选表格…" value={query} onChange={e => setQuery(e.target.value)} /><table><thead><tr>{node.columns.map((c: unknown, i: number) => <th key={i}><button type="button" onClick={() => setSort({ col: i, dir: sort.col === i ? -sort.dir : 1 })}>{str(c)} {sort.col === i ? sort.dir === 1 ? '↑' : '↓' : '↕'}</button></th>)}</tr></thead><tbody>{rows.map((r: unknown[], i: number) => <tr key={i}>{r.map((v, j) => <td key={j}>{str(v)}</td>)}</tr>)}</tbody></table></div>
}

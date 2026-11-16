export type DiagramItem = { id: string; label: string; sub?: string; description?: string; type?: string; tag?: string }
export type DiagramEdge = { from: string; to: string; label?: string; kind?: string }
export type ReadableDiagramSpec = { id?: string; title?: string; kind: string; nodes: DiagramItem[]; edges?: DiagramEdge[]; zones?: unknown[] }
/** Topological ranks preserve forks and joins; cycles retain the native diagram renderer. */
export function diagramRanks(node: ReadableDiagramSpec): DiagramItem[][] | null {
  if (!['architecture', 'flowchart', 'data-flow', 'process', 'high-level', 'layers', 'tree', 'org-chart'].includes(node.kind) || node.zones?.length || !node.nodes.length || node.nodes.length > 40) return null
  const byId = new Map(node.nodes.map(n => [n.id, n]))
  if (byId.size !== node.nodes.length) return null
  const edges = node.edges || []
  if (!edges.length && node.nodes.length > 1) return null
  if (edges.some(e => !byId.has(e.from) || !byId.has(e.to))) return null
  const incoming = new Map(node.nodes.map(n => [n.id, 0])), rank = new Map(node.nodes.map(n => [n.id, 0]))
  for (const edge of edges) incoming.set(edge.to, incoming.get(edge.to)! + 1)
  const queue = node.nodes.filter(n => incoming.get(n.id) === 0), result: DiagramItem[][] = []
  let count = 0
  while (queue.length) {
    const item = queue.shift()!, level = rank.get(item.id)!
    ;(result[level] ||= []).push(item); count++
    for (const edge of edges.filter(e => e.from === item.id)) {
      rank.set(edge.to, Math.max(rank.get(edge.to)!, level + 1))
      incoming.set(edge.to, incoming.get(edge.to)! - 1)
      if (incoming.get(edge.to) === 0) queue.push(byId.get(edge.to)!)
    }
  }
  return count === node.nodes.length ? result : null
}

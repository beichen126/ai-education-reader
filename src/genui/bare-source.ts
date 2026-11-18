import { GENUI_SOURCE_LIMIT } from './limits.js'

// Recover plain JSON with a recognizable UI root. Explicit Markdown code blocks
// are handled separately, so examples and requested JSON code remain copyable.
const rootFields = new Set(['title', 'items', 'gap', 'panel', 'append', 'computed', 'schema', 'scheme'])
const layoutTypes = new Set(['card', 'grid', 'accordion', 'steps', 'chart', 'echart', 'plot', 'slider', 'choices', 'scene3d', 'vocabulary', 'image', 'image-group'])

export function isBareGenUi(source: string): boolean {
  if (source.length > GENUI_SOURCE_LIMIT || !source.startsWith('{') || !source.endsWith('}')) return false
  try {
    const { items, ...root } = JSON.parse(source)
    return Array.isArray(items) && items.length > 0
      && Object.keys(root).every(field => rootFields.has(field))
      && items.every(node => node && typeof node.type === 'string')
      && items.some(node => layoutTypes.has(node.type.trim().toLowerCase()))
  } catch {
    return false
  }
}

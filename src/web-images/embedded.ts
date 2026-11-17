import {parseImageQueries} from './protocol'
const PREFIX = 'https://reader.invalid/web-image#'
/** Host-only marker: the renderer consumes it locally, never as a network URL. */
export function embeddedImageSource(node: unknown): string {return PREFIX + encodeURIComponent(JSON.stringify(node))}
export function embeddedImagePayload(src: string): string | undefined {
  if (!src.startsWith(PREFIX)) return
  try {const source = decodeURIComponent(src.slice(PREFIX.length)); parseImageQueries(source); return source} catch {return}
}
export function prepareEmbeddedImages(spec: any): any {
  let count = 0
  function walk(value: any, depth: number): any {
    if (!value || typeof value !== 'object' || depth > 12 || ++count > 300) return value
    if ((value.type === 'image' && typeof value.query === 'string') || (value.type === 'image-group' && Array.isArray(value.items) && value.items.some((i: any) => typeof i?.query === 'string'))) {
      parseImageQueries(JSON.stringify(value))
      return {type:'image',src:embeddedImageSource(value),alt:typeof value.alt === 'string' ? value.alt : '网络配图'}
    }
    const out = {...value}
    if (!value.type || ['card','col','row','grid','blocks','hero','accordion'].includes(value.type)) {
      if (Array.isArray(value.items)) out.items = value.items.map((item: any) => walk(item,depth+1))
    }
    if (value.type === 'tabs' && Array.isArray(value.tabs)) out.tabs = value.tabs.map((item: any) => walk(item,depth+1))
    return out
  }
  return walk(spec,0)
}

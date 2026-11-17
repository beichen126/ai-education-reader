import {ImageNode as OriginalImageNode} from 'reader-genui-image-original'
import {WebImageBlock} from './WebImageBlock'
import {embeddedImagePayload} from './embedded'
export function ImageNode({node}: {node: any}) {
  const source = embeddedImagePayload(String(node.src || ''))
  return source ? <WebImageBlock source={source}/> : <OriginalImageNode node={node}/>
}

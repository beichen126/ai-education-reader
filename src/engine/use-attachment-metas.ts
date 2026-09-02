// Loads attachment METADATA (not blobs) for a list of ids, for grouping/display.
import { useEffect, useState } from 'react'
import type { Attachment, StableId } from './types'
import { getAttachments } from './attachment-service'

export function useAttachmentMetas(ids: StableId[]): Attachment[] {
  const [metas, setMetas] = useState<Attachment[]>([])
  const sig = ids.join('|')
  useEffect(() => {
    let alive = true
    void getAttachments(ids).then(m => { if (alive) setMetas(m) }).catch(() => { if (alive) setMetas([]) })
    return () => { alive = false }
    // keyed by the id signature; the array identity changes on every draft update
  }, [sig])
  return metas
}

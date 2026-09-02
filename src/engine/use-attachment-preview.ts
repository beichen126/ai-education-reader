
import { useEffect, useState } from 'react'
import { ensurePreviewUrl, releasePreviewUrl, attachmentErrorLabel } from './attachment-service'
/** UI-facing preview hook: all objectURL/IndexedDB logic stays in the attachment service. */
export function useAttachmentPreview(id: string) {
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    let alive = true
    ensurePreviewUrl(id).then(u => { if (alive) setUrl(u) }).catch((e: any) => { if (alive) setError(attachmentErrorLabel(e?.kind || 'read-failed')) })
    return () => { alive = false; releasePreviewUrl(id) }
  }, [id])
  return { url, error }
}

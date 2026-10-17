
import { useEffect, useRef, useState } from 'react'
import { ensurePreviewUrl, releasePreviewUrl, attachmentErrorLabel } from './attachment-service'
/** UI-facing preview hook: all objectURL/IndexedDB logic stays in the attachment service. */
export function useAttachmentPreview(id: string, enabled = true) {
  const [preview, setPreview] = useState<{ id: string; url?: string; error?: string }>()
  useEffect(() => {
    if (!enabled) return
    let alive = true
    ensurePreviewUrl(id).then(url => { if (alive) setPreview({ id, url }) }).catch((e: any) => { if (alive) setPreview({ id, error: attachmentErrorLabel(e?.kind || 'read-failed') }) })
    return () => { alive = false; releasePreviewUrl(id) }
  }, [id, enabled])
  return enabled && preview?.id === id ? { url: preview.url, error: preview.error } : { url: undefined, error: undefined }
}

/** Defer binary reads too, not just <img> decode: native loading=lazy alone still
 * reads every IndexedDB/OPFS Blob when all preview hooks mount at once. */
export function useLazyAttachmentPreview(id: string) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const [visibleId, setVisibleId] = useState<string>()
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === 'undefined') { setVisibleId(id); return }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisibleId(id); observer.disconnect() }
    }, { rootMargin: '300px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [id])
  return { ref, ...useAttachmentPreview(id, visibleId === id) }
}

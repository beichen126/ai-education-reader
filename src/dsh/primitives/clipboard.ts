// Host clipboard write shared by Web UI copy controls. Success feedback stays
// with each control; this helper only reports whether the host accepted a write.

/**
 * Write text to the host clipboard, preferring the async Clipboard API and
 * falling back to `execCommand('copy')` on hosts (jsdom, insecure contexts)
 * that omit it.
 * @param text - the exact text to place on the clipboard.
 * @returns true only when the host accepted the write.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  const native = (window as Window & { ReaderClipboard?: EventTarget & { postMessage(value: string): void } }).ReaderClipboard
  if (native) {
    const copied = await new Promise<boolean>(resolve => {
      const id = crypto.randomUUID()
      const finish = (ok: boolean) => {
        clearTimeout(timer)
        native.removeEventListener('message', receive)
        resolve(ok)
      }
      const receive = (event: Event) => {
        try {
          const reply = JSON.parse((event as MessageEvent).data)
          if (reply.id === id) finish(reply.ok === true)
        } catch { /* Ignore unrelated responses. */ }
      }
      const timer = setTimeout(() => finish(false), 3000)
      native.addEventListener('message', receive)
      try { native.postMessage(JSON.stringify({id, text})) } catch { finish(false) }
    })
    if (copied) return true
  }
  // lib.dom types clipboard non-optional, but insecure contexts omit it —
  // that runtime gap is exactly what this guard detects.
  /* oxlint-disable-next-line typescript/no-unnecessary-condition */
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // WebView may expose the API but reject the write. Try the selection path below.
    }
  }
  // jsdom and older hosts: best-effort execCommand path when present.
  // execCommand('copy') is the only clipboard fallback where the async API
  // is missing; deprecated but deliberately retained.
  /* oxlint-disable typescript/no-deprecated */
  const exec = typeof document.execCommand === 'function'
    ? document.execCommand.bind(document)
    : undefined
  if (exec === undefined) return false
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.focus({preventScroll:true})
  el.select()
  el.setSelectionRange(0, text.length)
  try {
    return exec('copy')
  } catch {
    return false
  } finally {
    el.remove()
  }
  /* oxlint-enable typescript/no-deprecated */
}

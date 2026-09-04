// Markdown link security (P1). Model-authored Markdown is untrusted content; do NOT
// render an arbitrary node.url as an anchor href. Sanitize against an explicit allowlist.

/** Allowed URL schemes for markdown links. Everything else is rejected and rendered inert. */
const ALLOWED_SCHEMES = new Set(['https:', 'http:', 'mailto:'])

/**
 * Return a safe href for a markdown link, or null when the URL must be rendered inert.
 * Rejects javascript:, data:, vbscript: (and whitespace/case/encoded-prefix variants that
 * URL normalization collapses). Relative/hash URLs (no scheme) are allowed as local refs.
 * `mailto:` is allowed. Anything else (or a URL that cannot be parsed) returns null so the
 * caller can render its label as inert text rather than a navigable dangerous link.
 */
export function sanitizeMarkdownHref(input: string): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (raw === '') return null
  // Reject a URL whose ENCODED form decodes to a dangerous scheme (e.g. javascript%3A...):
  // the browser may decode during navigation. Defense in depth against encoded-prefix tricks.
  const decoded = (() => { try { return decodeURIComponent(raw) } catch { return raw } })()
  const decodedSchemeMatch = /^\s*([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(decoded)
  if (decodedSchemeMatch) {
    const ds = decodedSchemeMatch[1].toLowerCase()
    if (!ALLOWED_SCHEMES.has(ds + ':')) return null
  }
  // A URL with no scheme (relative or hash) is safe to render as-is.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw
  let url: URL
  try { url = new URL(raw) } catch { return null }
  const scheme = url.protocol.toLowerCase()
  if (ALLOWED_SCHEMES.has(scheme)) return url.href
  return null
}

/** True when `href` is an external (http/https) link — used to add rel=noopener noreferrer. */
export function isExternalHref(href: string): boolean {
  try { const p = new URL(href); return p.protocol === 'http:' || p.protocol === 'https:' } catch { return false }
}
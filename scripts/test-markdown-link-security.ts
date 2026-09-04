import { sanitizeMarkdownHref, isExternalHref } from '../src/markdown/link-security.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// --- allowlisted schemes ---
assert(sanitizeMarkdownHref('https://example.com/x') === 'https://example.com/x', 'https allowed')
assert(sanitizeMarkdownHref('http://example.com') === 'http://example.com/', 'http allowed (normalized)')
assert(sanitizeMarkdownHref('mailto:a@b.com') === 'mailto:a@b.com', 'mailto allowed')

// --- relative / hash (no scheme) allowed ---
assert(sanitizeMarkdownHref('#section') === '#section', 'hash link allowed')
assert(sanitizeMarkdownHref('/docs/guide') === '/docs/guide', 'relative link allowed')
assert(sanitizeMarkdownHref('docs/x.md') === 'docs/x.md', 'bare relative allowed')

// --- dangerous schemes rejected (null) ---
assert(sanitizeMarkdownHref('javascript:alert(1)') === null, 'javascript rejected')
assert(sanitizeMarkdownHref('JaVaScRiPt:alert(1)') === null, 'javascript case-variant rejected')
assert(sanitizeMarkdownHref('javascript%3Aalert(1)') === null, 'encoded javascript rejected')
assert(sanitizeMarkdownHref('  javascript:alert(1)') === null, 'leading-whitespace javascript rejected')
assert(sanitizeMarkdownHref('data:text/html,<script>') === null, 'data rejected')
assert(sanitizeMarkdownHref('vbscript:msgbox') === null, 'vbscript rejected')
assert(sanitizeMarkdownHref('file:///etc/passwd') === null, 'file rejected')

// --- edge cases ---
assert(sanitizeMarkdownHref('') === null, 'empty rejected')
assert(sanitizeMarkdownHref(undefined as any) === null, 'undefined rejected')
assert(sanitizeMarkdownHref('not a url') === 'not a url', 'scheme-less text kept as relative')

// --- external detection ---
assert(isExternalHref('https://x.com') === true, 'https is external')
assert(isExternalHref('#a') === false, 'hash is not external')
assert(isExternalHref('mailto:x@y') === false, 'mailto is not external')

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
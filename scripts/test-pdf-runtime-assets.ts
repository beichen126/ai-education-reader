// Static gate: the committed public/pdfjs runtime assets MUST match the installed
// pdfjs-dist auxiliary assets (byte-for-byte). Prevents a silent vendor drift where
// a pdfjs-dist upgrade (or reinstall) changes wasm / cmaps / fonts / iccs files but
// public/pdfjs still ships the old ones — which would silently reintroduce the
// real-world blank-page bug (missing/openjpeg.wasm etc. under the app base path).
//
// Comparison: relativePath + byte size + SHA-256 of every vendor file must be
// present, identical, in public/pdfjs/<dir>. Any vendor file missing from public
// or differing in size/hash FAILS. Extra public-only files are allowed (Vite copy
// may carry additions) but are logged; there are none today.
//
// Run: npx tsx scripts/test-pdf-runtime-assets.ts   (node_modules + public both required)
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }
function sha256(buf: Buffer): string { return createHash('sha256').update(buf).digest('hex') }
function listFiles(dir: string, rel = ''): string[] {
  let out: string[] = []
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) out = out.concat(listFiles(dir, r))
    else out.push(r)
  }
  return out
}

const cwd = process.cwd()
const VENDOR_ROOT = join(cwd, 'node_modules/pdfjs-dist')
const PUBLIC_ROOT = join(cwd, 'public/pdfjs')
const DIRS = ['wasm', 'cmaps', 'standard_fonts', 'iccs']

assert(existsSync(VENDOR_ROOT), 'pdfjs-dist vendor root exists (node_modules/pdfjs-dist)')
assert(existsSync(PUBLIC_ROOT), 'public/pdfjs exists')

for (const dir of DIRS) {
  const vendorDir = join(VENDOR_ROOT, dir)
  const publicDir = join(PUBLIC_ROOT, dir)
  if (!existsSync(vendorDir)) { assert(false, dir + ': vendor dir exists'); continue }
  if (!existsSync(publicDir)) { assert(false, dir + ': public dir exists'); continue }
  const vendorFiles = listFiles(vendorDir)
  assert(vendorFiles.length > 0, dir + ': vendor has files (' + vendorFiles.length + ')')
  let inDir = 0
  for (const rel of vendorFiles) {
    const vs = statSync(join(vendorDir, rel))
    const pub = join(publicDir, rel)
    if (!existsSync(pub)) { assert(false, dir + '/' + rel + ': present in public'); inDir++; continue }
    const ps = statSync(pub)
    const vHash = sha256(readFileSync(join(vendorDir, rel)))
    const pHash = sha256(readFileSync(pub))
    if (ps.size === vs.size && vHash === pHash) { inDir++; if (inDir <= 3) { /* only log first few */ } }
    else { assert(false, dir + '/' + rel + ': size ' + vs.size + ' vs public ' + ps.size + ' / hash mismatch') }
  }
  // all vendor files in this dir matched?
  const mismatched = vendorFiles.filter(rel => {
    const pub = join(publicDir, rel)
    if (!existsSync(pub)) return true
    return statSync(pub).size !== statSync(join(vendorDir, rel)).size || sha256(readFileSync(join(vendorDir, rel))) !== sha256(readFileSync(pub))
  })
  assert(mismatched.length === 0, dir + ': all ' + vendorFiles.length + ' vendor files byte-identical in public' + (mismatched.length ? ' (mismatch: ' + mismatched.join(', ') + ')' : ''))
  // public-only extras (informational; none expected)
  const publicFiles = listFiles(publicDir)
  const vendorSet = new Set(vendorFiles)
  const extra = publicFiles.filter(f => !vendorSet.has(f))
  if (extra.length) console.log('  note: ' + dir + ' has ' + extra.length + ' public-only file(s): ' + extra.join(', '))
}

// global: every vendor file across all dirs must be byte-identical in public
const ALL_DIRS = DIRS
let total = 0, matched = 0
for (const dir of ALL_DIRS) {
  const vDir = join(VENDOR_ROOT, dir)
  if (!existsSync(vDir)) continue
  for (const rel of listFiles(vDir)) {
    total++
    const pub = join(PUBLIC_ROOT, dir, rel)
    if (existsSync(pub) && statSync(pub).size === statSync(join(vDir, rel)).size && sha256(readFileSync(join(vDir, rel))) === sha256(readFileSync(pub))) matched++
  }
}
assert(total > 0, 'vendor asset set non-empty (' + total + ' files)')
assert(matched === total, 'all ' + total + ' vendor asset files byte-identical in public (matched ' + matched + ')')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)

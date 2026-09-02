// Generate a small PDF with a real Outline (bookmarks) for Stage 3 integration tests.
// 8 pages; outline: 第一章(2 subs, explicit+2 named), 第二章(2 subs, explicit).
// No deps. Usage: node scripts/make-outline-pdf.mjs <out> [pages]
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
const out = process.argv[2]
const N = parseInt(process.argv[3] || '8', 10)

function enc(s) { return Buffer.byteLength(s, 'latin1') }
let buf = ''; let pos = 0
const offsets = []
function write(s) { buf += s; pos += enc(s) }
write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')

const fontId = 11
const pageId = (i) => 11 + i            // page i (1-based) => 12..11+N
const contentId = (i) => 11 + N + i     // 12+N .. 11+2N
const namesId = 11 + 2 * N + 1
const destsId = 11 + 2 * N + 2
const ids = { cat: 1, pages: 2, outlineRoot: 3, names: namesId, dests: destsId }

function writeObj(id, body) { const s = id + ' 0 obj\n' + body + '\nendobj\n'; while (offsets.length < id) offsets.push(-1); offsets[id] = pos; write(s) }

const kids = []
for (let i = 1; i <= N; i++) kids.push(pageId(i) + ' 0 R')

// Catalog links outline + names
writeObj(ids.cat, '<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R /Names ' + ids.names + ' 0 R /PageMode /UseOutlines >>')
// Pages
writeObj(ids.pages, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + N + ' >>')
// Outline root
writeObj(ids.outlineRoot, '<< /Type /Outlines /First 4 0 R /Last 8 0 R /Count 6 >>')
// 第一章 (explicit -> page1), children 1.1(named),1.2(named),1.3(explicit page4)
writeObj(4, '<< /Title (Computer Organization) /Parent 3 0 R /Next 8 0 R /First 5 0 R /Last 7 0 R /Count 3 /Dest [' + pageId(1) + ' 0 R /XYZ 0 0 null] >>')
writeObj(5, '<< /Title (1.1 History) /Parent 4 0 R /Next 6 0 R /Dest /sec11 >>')
writeObj(6, '<< /Title (1.2 Structure) /Parent 4 0 R /Prev 5 0 R /Next 7 0 R /Dest /sec12 >>')
writeObj(7, '<< /Title (1.3 Metrics) /Parent 4 0 R /Prev 6 0 R /Dest [' + pageId(4) + ' 0 R /XYZ 0 0 null] >>')
// 第二章 (explicit -> page5), children 2.1(page6), 2.2(page7)
writeObj(8, '<< /Title (Data Representation) /Parent 3 0 R /Prev 4 0 R /First 9 0 R /Last 10 0 R /Count 2 /Dest [' + pageId(5) + ' 0 R /XYZ 0 0 null] >>')
writeObj(9, '<< /Title (2.1 Number) /Parent 8 0 R /Next 10 0 R /Dest [' + pageId(6) + ' 0 R /XYZ 0 0 null] >>')
writeObj(10, '<< /Title (2.2 Encodings) /Parent 8 0 R /Prev 9 0 R /Dest [' + pageId(7) + ' 0 R /XYZ 0 0 null] >>')
// Font
writeObj(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
// Pages + content
for (let i = 1; i <= N; i++) {
  writeObj(pageId(i), '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ' + fontId + ' 0 R >> >> /Contents ' + contentId(i) + ' 0 R >>')
}
for (let i = 1; i <= N; i++) {
  // Rich-but-synthetic page content: title, body-line placeholders, a figure block,
  // footer — so page thumbnails / viewer render something visible (no private data).
  let s = ['BT', '/F1 28 Tf', '72 760 Td', '(Page ' + i + ') Tj', 'ET']
  s.push('q 0.88 0.9 0.93 rg 72 712 451 4 re f Q')
  s.push('BT /F1 13 Tf 72 682 Td (Sample chapter page \u2014 synthetic fixture) Tj ET')
  for (let k = 0; k < 12; k++) s.push('q 0.86 0.88 0.91 rg 72 ' + (658 - k * 24) + ' 451 9 re f Q')
  s.push('q 0.42 0.6 0.86 rg 320 290 190 130 re f Q')
  s.push('BT /F1 16 Tf 0.06 0.07 0.12 rg 372 350 Td (Figure) Tj ET')
  s.push('BT /F1 10 Tf 0.45 0.46 0.5 rg 72 40 Td (draft of the reader) Tj ET')
  const stream = s.join('\n')
  const body = '<< /Length ' + enc(stream) + ' >>\nstream\n' + stream + '\nendstream'
  writeObj(contentId(i), body)
}
// Names + Dests name tree
writeObj(ids.names, '<< /Dests ' + ids.dests + ' 0 R >>')
writeObj(ids.dests, '<< /Names [ (sec11) [' + pageId(2) + ' 0 R /XYZ 0 0 null] (sec12) [' + pageId(3) + ' 0 R /XYZ 0 0 null] ] >>')

const xrefPos = pos
const total = ids.dests
let xref = 'xref\n0 ' + (total + 1) + '\n0000000000 65535 f \n'
for (let i = 1; i <= total; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
write(xref)
write('trailer\n<< /Size ' + (total + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF')

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, buf, 'latin1')
console.log('wrote', out, 'pages=', N, 'bytes=', buf.length)
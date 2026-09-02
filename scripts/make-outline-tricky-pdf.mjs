// Generate a small PDF with a "tricky" outline for Stage 4 UI tests:
//  - 第一章 (no own dest => derived-from-child, selectable) with 2 children
//  - Resources (external URL, not selectable, expandable) with 1 child (Appendix A)
// 4 pages. No deps. Usage: node scripts/make-outline-tricky-pdf.mjs <out>
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
const out = process.argv[2]
function enc(s) { return Buffer.byteLength(s, 'latin1') }
let buf = ''; let pos = 0; const offsets = []
function write(s) { buf += s; pos += enc(s) }
write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
const fontId = 9
const pageId = (i) => 9 + i      // 10..13
const contentId = (i) => 13 + i   // 14..17
function writeObj(id, body) { const s = id + ' 0 obj\n' + body + '\nendobj\n'; while (offsets.length < id) offsets.push(-1); offsets[id] = pos; write(s) }
const kids = []
for (let i = 1; i <= 4; i++) kids.push(pageId(i) + ' 0 R')
writeObj(1, '<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R /PageMode /UseOutlines >>')
writeObj(2, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count 4 >>')
writeObj(3, '<< /Type /Outlines /First 4 0 R /Last 7 0 R /Count 5 >>')
// 第一章 derived-from-child (no dest)
writeObj(4, '<< /Title (Chapter One) /Parent 3 0 R /Next 7 0 R /First 5 0 R /Last 6 0 R /Count 2 >>')
writeObj(5, '<< /Title (1.1 Intro) /Parent 4 0 R /Next 6 0 R /Dest [' + pageId(1) + ' 0 R /XYZ 0 0 null] >>')
writeObj(6, '<< /Title (1.2 Detail) /Parent 4 0 R /Prev 5 0 R /Dest [' + pageId(2) + ' 0 R /XYZ 0 0 null] >>')
// Resources external (url) with child Appendix A
writeObj(7, '<< /Title (Resources) /Parent 3 0 R /Prev 4 0 R /First 8 0 R /Last 8 0 R /Count 1 /A << /S /URI /URI (https://example.com/resources) >> >>')
writeObj(8, '<< /Title (Appendix A) /Parent 7 0 R /Dest [' + pageId(3) + ' 0 R /XYZ 0 0 null] >>')
writeObj(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
for (let i = 1; i <= 4; i++) writeObj(pageId(i), '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ' + fontId + ' 0 R >> >> /Contents ' + contentId(i) + ' 0 R >>')
for (let i = 1; i <= 4; i++) { const s = 'BT\n/F1 32 Tf\n72 700 Td\n(Page ' + i + ') Tj\nET'; writeObj(contentId(i), '<< /Length ' + enc(s) + ' >>\nstream\n' + s + '\nendstream') }
const xrefPos = pos; const total = contentId(4)
let xref = 'xref\n0 ' + (total + 1) + '\n0000000000 65535 f \n'
for (let i = 1; i <= total; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
write(xref); write('trailer\n<< /Size ' + (total + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, buf, 'latin1')
console.log('wrote', out, 'bytes=', buf.length)

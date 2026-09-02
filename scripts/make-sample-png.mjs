// Generates scripts/sample.png — a real, decodeable synthetic "textbook page"
// fixture (white page, text lines, a figure block). Pure Node, no deps.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
const W = 1280, H = 800
const px = new Uint8Array(W * H * 3)
const set = (x, y, r, g, b) => { const i = (y * W + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b }
const fill = (x0, y0, x1, y1, r, g, b) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, r, g, b) }
// white page
fill(0, 0, W, H, 255, 255, 255)
// page frame
fill(40, 40, W - 40, 44, 60, 60, 90)
fill(40, H - 44, W - 40, H - 40, 60, 60, 90)
fill(40, 40, 44, H - 40, 60, 60, 90)
fill(W - 44, 40, W - 40, H - 40, 60, 60, 90)
// heading + text lines
const line = (x0, y0, x1, r, g, b) => { for (let y = y0; y < y0 + 10; y++) fill(x0, y, x1, y + 1, r, g, b) }
line(90, 90, 640, 40, 40, 90)
for (let y = 170; y < 500; y += 28) line(90, y, 1180, 150, 150, 160)
// figure block (blue) with caption line
fill(340, 540, 940, 700, 120, 170, 230)
line(340, 720, 700, 90, 90, 110)
// orange accent
fill(90, 560, 120, 590, 230, 140, 60)
// encode
const crcTable = []
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const raw = Buffer.alloc(H * (W * 3 + 1))
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0
  Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])
writeFileSync('scripts/sample.png', png)
console.log('written scripts/sample.png bytes =', png.length)

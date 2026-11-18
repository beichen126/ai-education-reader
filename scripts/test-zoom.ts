import { clampScale, clampPan, zoomAtPoint, resetTransform, clampIndex, MIN_SCALE, MAX_SCALE } from '../src/gallery/zoom.ts'
let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

assert(clampScale(0.5) === MIN_SCALE, 'clamp 0.5 -> 1 (min)')
assert(clampScale(1) === 1, 'clamp 1 -> 1')
assert(clampScale(3) === 3, 'clamp 3 -> 3')
assert(clampScale(7) === MAX_SCALE, 'clamp 7 -> 6 (max)')
assert(clampScale(NaN) === MIN_SCALE, 'clamp NaN -> 1')

const z1 = zoomAtPoint(1, 2, 500, 400, 500, 400, 0, 0)
assert(z1.tx === 0 && z1.ty === 0, 'center zoom -> no pan')
const px = 650, py = 320, cx = 500, cy = 400, s = 1, ns = 2.5, tx = -40, ty = 60
const z2 = zoomAtPoint(s, ns, px, py, cx, cy, tx, ty)
const imgLocalX = (px - cx - tx) / s
const imgLocalY = (py - cy - ty) / s
const backX = cx + z2.tx + imgLocalX * ns
const backY = cy + z2.ty + imgLocalY * ns
assert(Math.abs(backX - px) < 1e-6 && Math.abs(backY - py) < 1e-6, 'pointer-centered zoom keeps point fixed')

// A page can be smaller than the viewport and still have its last line centered.
for (const scale of [1, 1.31, 3]) {
  const halfHeight = 500 * scale / 2
  const bottom = clampPan(0, -9000, scale, 390, 844, 390, 500)
  const top = clampPan(0, 9000, scale, 390, 844, 390, 500)
  assert(bottom.ty === -halfHeight && top.ty === halfHeight, 'either page edge reaches center at '+scale)
  assert(clampPan(0,-40,scale,390,844,390,500).ty === -40, 'short vertical drag follows finger')
  const horizontal = (390 * scale - 390) / 2
  assert(clampPan(9000,0,scale,390,844,390,500).tx === horizontal, 'horizontal coverage at '+scale)
  assert(clampPan(-9000,0,scale,390,844,390,500).tx === -horizontal, 'left bound at '+scale)
}
const r = resetTransform()
assert(r.scale === MIN_SCALE && r.tx === 0 && r.ty === 0, 'reset -> 1 / 0 / 0')

assert(clampIndex(5, 3) === 2, 'clampIndex 5/3 -> 2')
assert(clampIndex(-1, 3) === 0, 'clampIndex -1/3 -> 0')
assert(clampIndex(1, 3) === 1, 'clampIndex 1/3 -> 1')
assert(clampIndex(0, 0) === 0, 'clampIndex 0/0 -> 0')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)

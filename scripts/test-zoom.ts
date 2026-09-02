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

const c1 = clampPan(100, -200, 1, 800, 600, 400, 300)
assert(c1.tx === 0 && c1.ty === 0, 'scale=1 smaller than stage -> centered')
// scale=3 -> scaled 1200x900 > stage(800x600); pan range x:[ -400,0 ], y:[ -300,0 ]
const c3 = clampPan(999, -999, 3, 800, 600, 400, 300)
assert(c3.tx === 0 && c3.ty === -300, 'pan clamped: tx=999 -> 0, ty=-999 -> -300 (got ' + c3.tx + ',' + c3.ty + ')')
const c4 = clampPan(-999, -999, 3, 800, 600, 400, 300)
assert(c4.tx === -400 && c4.ty === -300, 'pan clamped: tx=-999 -> -400, ty=-999 -> -300 (got ' + c4.tx + ',' + c4.ty + ')')
const c5 = clampPan(-100, -50, 3, 800, 600, 400, 300)
assert(c5.tx === -100 && c5.ty === -50, 'pan inside range passes through (got ' + c5.tx + ',' + c5.ty + ')')

const r = resetTransform()
assert(r.scale === MIN_SCALE && r.tx === 0 && r.ty === 0, 'reset -> 1 / 0 / 0')

assert(clampIndex(5, 3) === 2, 'clampIndex 5/3 -> 2')
assert(clampIndex(-1, 3) === 0, 'clampIndex -1/3 -> 0')
assert(clampIndex(1, 3) === 1, 'clampIndex 1/3 -> 1')
assert(clampIndex(0, 0) === 0, 'clampIndex 0/0 -> 0')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
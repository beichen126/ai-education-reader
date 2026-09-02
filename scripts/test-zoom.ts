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

// ---- clampPan: center-coordinate model, symmetric bounds ----
// The scaled image is CENTERED on the stage; tx/ty are offsets from that center.
// overflowX = (baseW*scale - stageW)/2 per side when the scaled image is larger.

// Case A: image smaller than the stage on both axes -> locked to center.
const a1 = clampPan(999, -999, 1, 800, 600, 400, 300)
assert(a1.tx === 0 && a1.ty === 0, 'A: smaller image -> centered despite large input (got ' + a1.tx + ',' + a1.ty + ')')
const a2 = clampPan(-500, 500, 1.5, 800, 600, 400, 300)
assert(a2.tx === 0 && a2.ty === 0, 'A: scale 1.5 still smaller -> centered (got ' + a2.tx + ',' + a2.ty + ')')

// Case B: horizontal overflow only. stageW=1000, scaledW=1600 -> overflowX=300.
const bIn = [-500, -200, 0, 200, 500]
const bOut = [-300, -200, 0, 200, 300]
for (let i = 0; i < bIn.length; i++) {
  const r = clampPan(bIn[i], 123, 2, 1000, 600, 800, 150) // scaledH=300 < stageH -> ty locked
  assert(r.tx === bOut[i], 'B: tx=' + bIn[i] + ' -> ' + bOut[i] + ' (got ' + r.tx + ')')
  assert(r.ty === 0, 'B: vertical axis stays centered (ty ' + r.ty + ')')
}

// Case C: vertical overflow only. stageH=1000, scaledH=700 -> overflowY=150.
const cIn = [-500, -70, 0, 150]
const cOut = [-150, -70, 0, 150]
for (let i = 0; i < cIn.length; i++) {
  const r = clampPan(321, cIn[i], 2, 600, 1000, 200, 650) // scaledW=400 < stageW; scaledH=1300 > stageH
  assert(r.ty === cOut[i], 'C: ty=' + cIn[i] + ' -> ' + cOut[i] + ' (got ' + r.ty + ')')
  assert(r.tx === 0, 'C: horizontal axis stays centered (tx ' + r.tx + ')')
}

// Case D: both axes overflow -> perfectly symmetric bounds.
// stage 800x600, base 400x300, scale 3 -> scaled 1200x900 -> bounds x ±200, y ±150.
const d1 = clampPan(999, -999, 3, 800, 600, 400, 300)
assert(d1.tx === 200 && d1.ty === -150, 'D: (999,-999) -> (200,-150) (got ' + d1.tx + ',' + d1.ty + ')')
const d2 = clampPan(-999, 999, 3, 800, 600, 400, 300)
assert(d2.tx === -200 && d2.ty === 150, 'D: (-999,999) -> (-200,150) (got ' + d2.tx + ',' + d2.ty + ')')
const d3 = clampPan(500, 500, 3, 800, 600, 400, 300)
assert(d3.tx === 200 && d3.ty === 150, 'D: (500,500) -> (200,150) (got ' + d3.tx + ',' + d3.ty + ')')
const d4 = clampPan(-500, -500, 3, 800, 600, 400, 300)
assert(d4.tx === -200 && d4.ty === -150, 'D: (-500,-500) -> (-200,-150) (got ' + d4.tx + ',' + d4.ty + ')')
const d5 = clampPan(-100, -50, 3, 800, 600, 400, 300)
assert(d5.tx === -100 && d5.ty === -50, 'D: inside range passes through (got ' + d5.tx + ',' + d5.ty + ')')
const d6 = clampPan(0, 0, 3, 800, 600, 400, 300)
assert(d6.tx === 0 && d6.ty === 0, 'D: center stays at origin')
// symmetry: max reach on both sides identical
const dL = clampPan(-5000, 0, 3, 800, 600, 400, 300)
const dR = clampPan(5000, 0, 3, 800, 600, 400, 300)
assert(dL.tx === -dR.tx, 'D: left/right bounds symmetric (' + dL.tx + ' vs ' + dR.tx + ')')
const dT = clampPan(0, -5000, 3, 800, 600, 400, 300)
const dB = clampPan(0, 5000, 3, 800, 600, 400, 300)
assert(dT.ty === -dB.ty, 'D: top/bottom bounds symmetric (' + dT.ty + ' vs ' + dB.ty + ')')

const r = resetTransform()
assert(r.scale === MIN_SCALE && r.tx === 0 && r.ty === 0, 'reset -> 1 / 0 / 0')

assert(clampIndex(5, 3) === 2, 'clampIndex 5/3 -> 2')
assert(clampIndex(-1, 3) === 0, 'clampIndex -1/3 -> 0')
assert(clampIndex(1, 3) === 1, 'clampIndex 1/3 -> 1')
assert(clampIndex(0, 0) === 0, 'clampIndex 0/0 -> 0')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)

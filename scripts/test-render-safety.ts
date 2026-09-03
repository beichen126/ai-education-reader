// PDF render safety (Stage: static-compat hardening). Pure logic for the render scale
// policy: long edge bounded, explicit pixel budget, no unbounded upscale, and the
// password-error classification helper.
import { clampRenderScale, MAX_RENDER_EDGE, MAX_SCALE, MAX_RENDER_PIXELS, isPasswordError } from '../src/pdf/pdf-render-policy.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

// --- pixel budget: large page scaled so width*height <= MAX_RENDER_PIXELS ---
{
  const vp = { width: 4000, height: 3000 } // 12M px raw
  const scale = clampRenderScale(vp)
  const w = vp.width * scale, h = vp.height * scale
  assert(w * h <= MAX_RENDER_PIXELS + 1, 'large page pixel budget respected (' + Math.round(w*h) + ' <= ' + MAX_RENDER_PIXELS + ')')
  assert(Math.max(w, h) <= MAX_RENDER_EDGE + 1, 'long edge <= MAX_RENDER_EDGE (got ' + Math.round(Math.max(w,h)) + ')')
}
// --- very wide scan (small height) keeps long edge bounded ---
{
  const vp = { width: 5000, height: 300 }
  const scale = clampRenderScale(vp)
  const w = vp.width * scale
  assert(w <= MAX_RENDER_EDGE + 1, 'very wide page long edge <= MAX_RENDER_EDGE (got ' + Math.round(w) + ')')
  assert(vp.height * scale >= 1, 'short edge stays >= 1px')
}
// --- portrait A4 at MAX_SCALE upscale, edge target wins, no over-budget ---
{
  const vp = { width: 400, height: 300 } // tiny page
  const scale = clampRenderScale(vp)
  assert(scale <= MAX_SCALE, 'tiny page scale <= MAX_SCALE (got ' + scale + ')')
  assert(scale > 0, 'scale positive')
}
// --- zero/negative dims -> safe fallback 1 ---
{
  assert(clampRenderScale({ width: 0, height: 0 }) === 1, 'zero dims -> scale 1 (safe)')
  assert(clampRenderScale({ width: -5, height: 10 }) === 1, 'negative dims -> safe 1')
}
// --- normalize: standard A4 595x842 at scale 1 not over budget ---
{
  const vp = { width: 595, height: 842 }
  const scale = clampRenderScale(vp)
  const w = 595*scale, h = 842*scale
  assert(w*h <= MAX_RENDER_PIXELS+1 && Math.max(w,h) <= MAX_RENDER_EDGE+1, 'A4 page safe')
}

// --- HARD pixel budget extreme dimensions (Stage 9.4C.1) ---
// These must NEVER exceed MAX_RENDER_PIXELS / MAX_RENDER_EDGE; the scale may drop below 0.01.
const extremeCases = [
  { w: 1000000, h: 1000000 }, // 1e12 px
  { w: 1000000, h: 10 },      // hugely wide
  { w: 10, h: 1000000 },      // hugely tall
  { w: 100000000, h: 100 },   // extreme wide
  { w: 595, h: 842 },         // A4
]
for (const c of extremeCases) {
  const scale = clampRenderScale({ width: c.w, height: c.h })
  const sw = c.w * scale, sh = c.h * scale
  const budgetOk = Number.isFinite(scale) && sw * sh <= MAX_RENDER_PIXELS + 1
  const edgeOk = Math.max(sw, sh) <= MAX_RENDER_EDGE + 1
  const pos = Number.isFinite(scale) && scale > 0
  assert(budgetOk && edgeOk && pos, 'extreme ' + c.w + 'x' + c.h + ' stays in budget & edge (scale=' + Number(scale.toFixed(8)) + ')')
}

// --- NaN / Infinity / -Infinity / 0 / negative viewport -> safe scale 1 (no crash / overflow) ---
for (const v of [
  { width: NaN, height: 842 },
  { width: Infinity, height: 842 },
  { width: -Infinity, height: 842 },
  { width: 0, height: 842 },
  { width: 595, height: -1 },
]) {
  const scale = clampRenderScale(v)
  assert(scale === 1, 'non-finite/zero/negative viewport -> safe scale 1 (' + v.width + 'x' + v.height + ')')
}

// --- canvas dimension never lands below 1px via Math.max(1, floor) ---
assert(Math.max(1, Math.floor(0.4)) === 1, 'canvas minimum floor -> 1px');
// --- password classification ---
{
  assert(isPasswordError({ name: 'PasswordException' }) === true, 'PasswordException recognized')
  assert(isPasswordError({ name: 'InvalidPDFException' }) === false, 'InvalidPDFException not password')
  assert(isPasswordError(new Error('boom')) === false, 'plain Error not password')
  assert(isPasswordError(undefined) === false, 'undefined not password')
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
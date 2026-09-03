// Edge (Windows / local) acceptance e2e for the unified zoomable image viewer.
// Stage 9.3: transient zoom HUD — no persistent zoom toolbar; the percent shows
// only while zooming and auto-hides ~3s after the last effective zoom input.
//
// Run:
//   1) npm run build && npm run preview -- --port 5299
//   2) node scripts/e2e-viewer-edge.mjs              # local build
//      E2E_BASE=https://beichen126.github.io/ai-education-reader/ node scripts/e2e-viewer-edge.mjs   # live Pages
//
// Uses REAL Microsoft Edge via playwright-core channel: 'msedge' (not in CI;
// the Linux Pages gate keeps npm ci + typecheck + test:all + build).
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PIN = 'scripts/sample.png'
const PDF = 'test/fixtures/outline-sample.pdf'
const results = []
const errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)

console.log('launching Microsoft Edge (channel msedge)… BASE=' + BASE)
const browser = await chromium.launch({ channel: 'msedge', headless: true })
console.log('Edge launched OK')

async function newPage(w = 1440, h = 900, hasTouch = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch })
  const page = await ctx.newPage()
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
  return { ctx, page }
}
const DIAG = '[role="dialog"][aria-modal="true"]'
const HUD = '[data-testid="viewer-zoom-hud"]'
const hudCount = p => p.locator(HUD).count()
const hudText = p => p.locator(HUD).textContent()
const zstyle = p => p.locator('[data-testid="viewer-image"]').getAttribute('style')
const counter = p => p.locator('span[class*="counter"]').textContent()
const translate = p => p.locator('[data-testid="viewer-image"]').evaluate(el => {
  const m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(el.style.transform)
  return { tx: parseFloat(m[1]), ty: parseFloat(m[2]) }
})
const closeFocused = p => p.evaluate(() => document.activeElement === document.querySelector('[role="dialog"][aria-modal="true"] > button'))
const wheel = async (p, dy) => {
  const box = await p.locator('[data-testid="viewer-stage"]').boundingBox()
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await p.mouse.move(cx, cy)
  await p.mouse.wheel(0, dy)
  await p.waitForTimeout(120)
  return { cx, cy }
}
async function drag(p, dx, dy) {
  const box = await p.locator('[data-testid="viewer-stage"]').boundingBox()
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await p.mouse.move(cx, cy)
  await p.mouse.down()
  await p.mouse.move(cx + dx, cy + dy, { steps: 24 })
  await p.mouse.up()
  await p.waitForTimeout(100)
  return translate(p)
}

// ============ A. sent image -> Gallery viewer + HUD behavior ============
{
  const { ctx, page } = await newPage()
  const imgInput = page.locator('input[type="file"][accept*="image/"]')
  await imgInput.setInputFiles([PIN, PIN])
  await page.getByText('已添加 2 张图片').waitFor({ state: 'visible', timeout: 20000 })
  await page.locator('textarea').fill('请描述图片')
  await page.getByRole('button', { name: '发送' }).click()
  await page.waitForTimeout(800)
  const thumbs = page.locator('button[class*="photo"] img[alt="image"]')
  assert(await thumbs.count() === 2, 'A: message has 2 image thumbs (got ' + await thumbs.count() + ')')
  await thumbs.first().click()
  await page.locator(DIAG).waitFor({ state: 'visible', timeout: 10000 })
  assert(await closeFocused(page), 'A: initial focus lands on viewer close button')
  assert(await hudCount(page) === 0, 'A: initial state has NO persistent zoom HUD/toolbar')
  const s0 = await zstyle(page)
  assert(s0.includes('scale(1)') && s0.includes('translate3d(0px, 0px, 0'), 'A: initial transform fit')
  assert(await page.locator('span[class*="counter"]').count() === 1, 'A: nav bar (counter) present')
  assert(await page.locator('[data-testid="viewer-prev"]').count() === 1, 'A: prev kept')
  await wheel(page, -600)
  const h1 = (await hudText(page)).trim()
  assert(h1 !== '100%', 'A: HUD visible on wheel zoom (' + h1 + ')')

  // ---- four-direction pan limits (center-coordinate model) ----
  const geo = await page.evaluate(() => {
    const img = document.querySelector('[data-testid="viewer-image"]')
    const m = /scale\(([\d.]+)\)/.exec(img.style.transform)
    const r = document.querySelector('[data-testid="viewer-stage"]').getBoundingClientRect()
    return { scale: parseFloat(m[1]), w: parseFloat(img.style.width), h: parseFloat(img.style.height), sw: r.width, sh: r.height }
  })
  const ox = Math.max(0, (geo.w * geo.scale - geo.sw) / 2)
  const oy = Math.max(0, (geo.h * geo.scale - geo.sh) / 2)
  assert(ox > 0 && oy > 0, 'A: zoomed image overflows both axes (ox=' + ox.toFixed(1) + ' oy=' + oy.toFixed(1) + ')')
  const right = await drag(page, ox * 2 + 800, 0)
  assert(right.tx > 0 && Math.abs(right.tx - ox) < 2, 'A: right limit reachable tx=' + right.tx.toFixed(1) + ' ~ +' + ox.toFixed(1))
  const left = await drag(page, -(ox * 2 + 800), 0)
  assert(left.tx < 0 && Math.abs(left.tx + ox) < 2, 'A: left limit reachable tx=' + left.tx.toFixed(1) + ' ~ -' + ox.toFixed(1))
  const bottom = await drag(page, 0, oy * 2 + 800)
  assert(bottom.ty > 0 && Math.abs(bottom.ty - oy) < 2, 'A: bottom limit reachable ty=' + bottom.ty.toFixed(1) + ' ~ +' + oy.toFixed(1))
  const top = await drag(page, 0, -(oy * 2 + 800))
  assert(top.ty < 0 && Math.abs(top.ty + oy) < 2, 'A: top limit reachable ty=' + top.ty.toFixed(1) + ' ~ -' + oy.toFixed(1))
  assert(Math.abs(Math.abs(left.tx) - right.tx) < 2, 'A: horizontal bounds symmetric')
  assert(Math.abs(Math.abs(top.ty) - bottom.ty) < 2, 'A: vertical bounds symmetric')

  // ---- wheel down back to fit (HUD still a live zoom) ----
  await wheel(page, 600)
  assert((await hudText(page)).trim() === '100%' && (await zstyle(page)).includes('scale(1)'), 'A: wheel down -> fit, HUD 100%')

  // ---- keyboard zoom: +/-/0 each show the HUD ----
  await page.keyboard.press('+')
  await page.waitForTimeout(80)
  assert((await hudText(page)).trim() === '125%', 'A: + key -> HUD 125%')
  await page.keyboard.press('-')
  await page.waitForTimeout(80)
  assert((await hudText(page)).trim() === '100%', 'A: - key -> HUD 100%')
  await page.keyboard.press('+')
  await page.waitForTimeout(80)
  assert(await hudCount(page) === 1, 'A: + again keeps HUD visible')
  await page.keyboard.press('0')
  await page.waitForTimeout(80)
  const sZero = await zstyle(page)
  assert((await hudText(page)).trim() === '100%' && sZero.includes('translate3d(0px, 0px, 0'), 'A: 0 key -> fit + HUD 100%')

  // ---- Case D: double click toggles 200% <-> 100% ----
  const box = await page.locator('[data-testid="viewer-stage"]').boundingBox()
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await page.mouse.dblclick(cx, cy)
  await page.waitForTimeout(80)
  assert((await hudText(page)).trim() === '200%', 'A: dblclick -> HUD 200%')
  await page.mouse.dblclick(cx, cy)
  await page.waitForTimeout(80)
  assert((await hudText(page)).trim() === '100%', 'A: dblclick again -> HUD 100%')

  // ---- Case B: auto-hide ~3s after last zoom ----
  await wheel(page, -600)
  assert(await hudCount(page) === 1, 'A: HUD visible before auto-hide')
  await page.waitForTimeout(3400)
  assert(await hudCount(page) === 0, 'A: HUD auto-hidden after ~3s')

  // ---- Case F: pure pan never re-triggers the HUD (scale>1, HUD already hidden) ----
  const pan0 = await drag(page, -120, -60)
  assert(pan0.tx < 0 && Math.abs(pan0.tx + 120) < 3, 'A: pan works while HUD hidden (' + pan0.tx + ')')
  assert(await hudCount(page) === 0, 'A: pan does NOT trigger the HUD')

  // ---- Case C: timer resets on new zoom input ----
  // zoom 2 must be an EFFECTIVE zoom (here back towards 100%): a wheel that is
  // already clamped at MIN/MAX scale is correctly ignored (no HUD refresh).
  await wheel(page, -600)
  assert(await hudCount(page) === 1, 'A: zoom 1 shows HUD')
  await page.waitForTimeout(2000)
  await wheel(page, 300)
  assert(await hudCount(page) === 1, 'A: zoom 2 keeps HUD')
  await page.waitForTimeout(2000) // 4s since zoom 1 (old 3s timer would have fired)
  assert(await hudCount(page) === 1, 'A: HUD still visible after old timer would have fired (timer reset)')
  await page.waitForTimeout(1400)
  assert(await hudCount(page) === 0, 'A: HUD hidden after reset timer elapses')

  // ---- prev/next reset (Case G) ----
  await page.keyboard.press('0')
  await page.waitForTimeout(80)
  await page.keyboard.press('+')
  await page.waitForTimeout(80)
  assert(await hudCount(page) === 1, 'A: HUD visible before next')
  assert(await page.locator('[data-testid="viewer-prev"]').isDisabled(), 'A: prev disabled at index 0')
  assert((await counter(page)).trim() === '1 / 2', 'A: counter 1 / 2')
  await page.locator('[data-testid="viewer-next"]').click()
  await page.waitForTimeout(250)
  const s3 = await zstyle(page)
  assert(s3.includes('scale(1)') && s3.includes('translate3d(0px, 0px, 0'), 'A: next resets to fit')
  assert(await hudCount(page) === 0, 'A: next hides the HUD (no inheritance from image 1)')
  assert((await counter(page)).trim() === '2 / 2', 'A: counter 2 / 2')
  assert(await page.locator('[data-testid="viewer-next"]').isDisabled(), 'A: next disabled at end')
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(200)
  assert((await counter(page)).trim() === '1 / 2', 'A: ArrowLeft -> 1 / 2')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)
  assert((await counter(page)).trim() === '2 / 2', 'A: ArrowRight -> 2 / 2')
  // Escape + exact opener restore (click-opened)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  assert(await page.locator(DIAG).count() === 0, 'A: Escape closes viewer')
  const backToThumb = await page.evaluate(() => document.activeElement === document.querySelectorAll('button[class*="photo"]')[0])
  assert(backToThumb, 'A: click-opened: focus restored to the exact opener thumb')

  // keyboard-opened roundtrip: thumb focus -> Enter -> close focus -> Escape -> same thumb
  await thumbs.first().focus()
  await page.keyboard.press('Enter')
  await page.locator(DIAG).waitFor({ state: 'visible', timeout: 10000 })
  assert(await closeFocused(page), 'A: keyboard-opened: initial focus close button')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const backToThumb2 = await page.evaluate(() => document.activeElement === document.querySelectorAll('button[class*="photo"]')[0])
  assert(backToThumb2, 'A: keyboard-opened: focus restored to the exact opener thumb')

  // ============ B. Gallery list flow ============
  await page.locator('[data-testid="sidebar-entry-images"], [data-testid="rail-images"]').first().click()
  await page.waitForTimeout(250)
  const galThumbs = page.locator('button[class*="thumb"] img')
  assert(await galThumbs.count() === 2, 'B: gallery list shows 2 thumbs (got ' + await galThumbs.count() + ')')
  await galThumbs.first().click()
  await page.locator(DIAG).waitFor({ state: 'visible', timeout: 10000 })
  assert(await hudCount(page) === 0, 'B: gallery viewer opens with HUD hidden')
  assert((await counter(page)).trim() === '1 / 2', 'B: gallery viewer counter 1 / 2')
  await page.getByRole('button', { name: '返回列表' }).click()
  await page.waitForTimeout(250)
  assert(await page.locator(DIAG).count() === 0, 'B: back-to-list closes viewer')
  assert(await page.locator('button[class*="thumb"]').count() === 2, 'B: gallery list still visible')
  await page.getByRole('button', { name: '关闭' }).click()
  await page.waitForTimeout(250)
  assert(await page.locator('button[class*="thumb"]').count() === 0, 'B: gallery closed')
  await ctx.close()
}

// ============ C. composer draft viewer + focus ============
{
  const { ctx, page } = await newPage()
  const imgInput = page.locator('input[type="file"][accept*="image/"]')
  await imgInput.setInputFiles(PIN)
  await page.getByText('已添加 1 张图片').waitFor({ state: 'visible', timeout: 20000 })
  const draftImg = page.locator('img[role="button"][aria-label="查看图片"]')
  await draftImg.click()
  await page.locator(DIAG).waitFor({ state: 'visible', timeout: 10000 })
  assert(await closeFocused(page), 'C: draft viewer initial focus close button')
  assert(await hudCount(page) === 0, 'C: draft viewer HUD hidden on open')
  await wheel(page, -600)
  assert(await hudCount(page) === 1, 'C: draft viewer HUD on wheel zoom')
  const cs = await drag(page, -90, -40)
  assert(cs.tx < 0 && Math.abs(cs.tx + 90) < 3, 'C: draft viewer drag pan (' + JSON.stringify(cs) + ')')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  assert(await page.locator(DIAG).count() === 0, 'C: draft viewer Escape')
  assert(await page.getByText('已添加 1 张图片').count() === 1, 'C: draft image preserved after viewer')
  const draftBack = await page.evaluate(() => document.activeElement === document.querySelector('img[role="button"][aria-label="查看图片"]'))
  assert(draftBack, 'C: click-opened draft: focus restored to the draft thumb')
  // keyboard-opened draft roundtrip
  await draftImg.focus()
  await page.keyboard.press('Enter')
  await page.locator(DIAG).waitFor({ state: 'visible', timeout: 10000 })
  assert(await closeFocused(page), 'C: keyboard-opened draft: initial focus close button')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  const draftBack2 = await page.evaluate(() => document.activeElement === document.querySelector('img[role="button"][aria-label="查看图片"]'))
  assert(draftBack2, 'C: keyboard-opened draft: focus restored to the draft thumb')

  // ============ D. PDF page viewer (Case H) + focus ============
  await page.locator('[data-testid="composer-attach-pdf"] input[type="file"]').setInputFiles(PDF)
  await page.locator('[data-testid="pdf-mode-chapter"]').waitFor({ state: 'visible', timeout: 25000 })
  await page.locator('[data-testid="pdf-mode-manual"]').click()
  await page.locator('[data-testid="pdf-start"]').waitFor({ state: 'visible', timeout: 25000 })
  await page.locator('[data-testid="pdf-start"]').fill('2')
  await page.locator('[data-testid="pdf-end"]').fill('4')
  await page.locator('[data-testid="pdf-generate"]').click()
  await page.locator('[data-testid="pdf-page"]').first().waitFor({ state: 'visible', timeout: 40000 })
  await page.locator('[data-testid="pdf-add"]').click()
  await page.locator('[data-testid="pdf-add-msg"]').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {})
  await page.locator('[data-testid="pdf-done"]').click()
  await page.locator('[data-testid="pdf-group-card"]').first().waitFor({ state: 'visible', timeout: 20000 })
  await page.locator('[data-testid^="pdf-group-expand-"]').first().click()
  await page.waitForTimeout(500)
  const pageBtns = page.locator('[data-testid^="pdf-page-open-"]')
  assert(await pageBtns.count() === 3, 'D: group expand shows 3 page buttons (got ' + await pageBtns.count() + ')')
  await pageBtns.first().click()
  await page.locator(DIAG).waitFor({ state: 'visible', timeout: 10000 })
  assert(await closeFocused(page), 'D: pdf viewer initial focus close button')
  assert(await hudCount(page) === 0, 'D: pdf viewer HUD hidden on open')
  assert((await counter(page)).trim() === '1 / 3', 'D: pdf viewer counter 1 / 3')
  await wheel(page, -600)
  assert(await hudCount(page) === 1, 'D: pdf viewer HUD on wheel zoom (same as images)')
  await page.locator('[data-testid="viewer-next"]').click()
  await page.waitForTimeout(250)
  assert((await counter(page)).trim() === '2 / 3', 'D: next -> 2 / 3')
  const d2 = await zstyle(page)
  assert(d2.includes('scale(1)') && d2.includes('translate3d(0px, 0px, 0'), 'D: page switch resets zoom')
  assert(await hudCount(page) === 0, 'D: HUD hidden after pdf page switch')
  await page.locator('[data-testid="viewer-prev"]').click()
  await page.waitForTimeout(250)
  assert((await counter(page)).trim() === '1 / 3', 'D: prev -> 1 / 3')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  assert(await page.locator(DIAG).count() === 0, 'D: pdf viewer Escape')
  const pdfBack = await page.evaluate(() => document.activeElement === document.querySelectorAll('[data-testid^="pdf-page-open-"]')[0])
  assert(pdfBack, 'D: click-opened pdf page: focus restored to the page button')
  await pageBtns.nth(1).focus()
  await page.keyboard.press('Enter')
  await page.locator(DIAG).waitFor({ state: 'visible', timeout: 10000 })
  assert((await counter(page)).trim() === '2 / 3', 'D: keyboard-opened pdf page -> 2 / 3')
  assert(await closeFocused(page), 'D: keyboard-opened pdf: initial focus close button')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  const pdfBack2 = await page.evaluate(() => document.activeElement === document.querySelectorAll('[data-testid^="pdf-page-open-"]')[1])
  assert(pdfBack2, 'D: keyboard-opened pdf page: focus restored to the page button')

  // ============ F. responsive: HUD overlay stays inside the viewport ============
  const vpCheck = async (w, h, tag) => {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(200)
    await pageBtns.nth(1).click()
    await page.locator(DIAG).waitFor({ state: 'visible', timeout: 10000 })
    const sb = await page.locator('[data-testid="viewer-stage"]').boundingBox()
    assert(sb && sb.width >= 60 && sb.height >= 60, tag + ': stage visible ' + JSON.stringify(sb))
    await wheel(page, -600)
    const hb = await page.locator(HUD).boundingBox()
    assert(hb && hb.x >= -1 && hb.x + hb.width <= w + 1 && hb.y >= 0 && hb.y + hb.height <= h + 1, tag + ': zoom HUD inside viewport (' + JSON.stringify(hb) + ')')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
  await vpCheck(1440, 900, 'F1440')
  await vpCheck(1024, 768, 'F1024')
  await vpCheck(768, 1024, 'F768')
  await ctx.close()
}

// ============ E. touch pinch (live HUD) + single-finger pan at 390x844 ============
{
  const { ctx, page } = await newPage(390, 844, true)
  const imgInput = page.locator('input[type="file"][accept*="image/"]')
  await imgInput.setInputFiles(PIN)
  await page.getByText('已添加 1 张图片').waitFor({ state: 'visible', timeout: 20000 })
  await page.locator('span[class*="pic"] > img[alt=""]').click()
  await page.locator(DIAG).waitFor({ state: 'visible', timeout: 10000 })
  assert(await hudCount(page) === 0, 'E: touch viewer HUD hidden on open')
  const box = await page.locator('[data-testid="viewer-stage"]').boundingBox()
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }] })
  for (let i = 1; i <= 8; i++) {
    const d = 30 + i * 10
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - d, y: cy }, { x: cx + d, y: cy }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(200)
  const e1 = (await hudText(page)).trim()
  assert(e1 !== '100%', 'E: pinch shows live HUD (' + e1 + ')')
  const hb = await page.locator(HUD).boundingBox()
  assert(hb && hb.x >= -1 && hb.x + hb.width <= 391, 'E: HUD inside 390 viewport (' + JSON.stringify(hb) + ')')
  await page.waitForTimeout(3400)
  assert(await hudCount(page) === 0, 'E: HUD auto-hidden after pinch')
  const sa = await zstyle(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] })
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - i * 15, y: cy - i * 5 }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await page.waitForTimeout(200)
  const sb = await zstyle(page)
  assert(sa !== sb, 'E: single-finger drag pans (' + sb + ')')
  assert(await hudCount(page) === 0, 'E: single-finger pan does NOT trigger the HUD')
  const ta = await page.locator('[data-testid="viewer-stage"]').evaluate(el => getComputedStyle(el).touchAction)
  assert(ta === 'none', 'E: stage touch-action none (' + ta + ')')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  assert(await page.locator(DIAG).count() === 0, 'E: Escape on touch context')
  assert(await page.getByText('已添加 1 张图片').count() === 1, 'E: draft preserved after touch viewer')
  await ctx.close()
}

console.log('--------')
console.log(results.join('\n'))
const pe = errors.filter(e => e.startsWith('pageerror:'))
console.log('PAGEERRORS:', pe.length ? pe.join(' | ') : '(none)')
const passed = results.filter(r => r.startsWith('PASS')).length
console.log('SUMMARY ' + passed + '/' + results.length + ' passed')
await browser.close()
process.exit(results.some(r => r.startsWith('FAIL')) || pe.length ? 1 : 0)

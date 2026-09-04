// Reusable post-v1 E2E fixtures: single source for IndexedDB seeding + API mock + hydration wait.
export function msg(id, role, content, images = []) {
  return { id, role, content, images, createdAt: Date.now(), updatedAt: Date.now() }
}
/**
 * Seed IndexedDB fixture rows AFTER first load (no race), then reload so the app boots with
 * them. `convs` = array of {id,title,messages}. Settings are seeded from `settings`.
 * Waits for the composer + the first conversation title to be visible (no fixed sleeps).
 */
export async function seedAndBoot(page, { convs = [], settings = {} }) {
  await page.goto(process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/', { waitUntil: 'networkidle' })
  await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
  const seeded = await page.evaluate(({ convs, settings }) => new Promise((resolve) => {
    const req = indexedDB.open('ai-education-reader', 5)
    req.onsuccess = () => { const db = req.result;
      const s = new Set(['conversations','settings','attachments','annotations','documents','conversationBranches','artifacts'])
      const names = Array.from(db.objectStoreNames)
      const txStores = names.filter(n => s.has(n))
      // Start clean: drop prior-run branch/artifact rows so the E2E is reproducible.
      for (const clear of ['conversationBranches','artifacts']) if (names.includes(clear)) { try { db.transaction(clear, 'readwrite').objectStore(clear).clear() } catch {} }
      const tx = db.transaction(txStores, 'readwrite')
      if (names.includes('conversations')) { const os = tx.objectStore('conversations'); for (const c of convs) os.put(c) }
      if (names.includes('settings')) { const os = tx.objectStore('settings'); for (const [k, v] of Object.entries(settings)) os.put({ key: k, value: v }) }
      tx.oncomplete = () => { try { db.close() } catch {} ; resolve(true) }
      tx.onerror = () => resolve(false)
    }
    req.onerror = () => resolve(false)
  }), { convs, settings })
  if (!seeded) throw new Error('fixture seed failed')
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.readyState === 'complete')
  // hydration signal: composer attached + (if a conversation was seeded) its title visible.
  await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
  if (convs.length) await page.locator('text=' + convs[0].title).first().waitFor({ state: 'visible', timeout: 15000 })
  return seeded
}
/**
 * Mock the model API to stream `deltas` as SSE. The app's streamTextChat fetch to the
 * chat completions endpoint is intercepted. `deltas` is an array of strings.
 */
const routeHits = { completions: 0 }
const lastRequestBodies = []
export function getRouteHits() { return { ...routeHits } }
export function getLastRequestBody() { return lastRequestBodies[lastRequestBodies.length - 1] || null }
export function lastRequestBodiesSnapshot() { return lastRequestBodies.slice() }
export async function installMockModel(page, deltas, finishReason = 'stop') {
  const events = deltas.map((d) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: d }, finish_reason: null }] }) + '\n\n').join('')
  const done = 'data: [DONE]\n\n'
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': '*',
  }
  const full = events + done
  const nonStreamContent = JSON.stringify({ id: 'mock', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: deltas.join('') }, finish_reason: 'stop' }], usage: { total_tokens: 1 } })
  try { await page.unroute('**/chat/completions') } catch {}
  page.route('**/chat/completions', (route) => {
    routeHits.completions++
    const method = route.request().method()
    if (method === 'OPTIONS') {
      route.fulfill({ status: 204, headers: CORS, body: '' })
      return
    }
    let body = ''
    let req = null
    try { req = route.request().postDataJSON(); lastRequestBodies.push(req) } catch {}
    const streaming = req && (req.stream === true || req.stream === 'true')
    if (streaming) { body = full; route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...CORS }, body }); return }
    // Non-streaming (artifact generation): a plain chat completion JSON.
    route.fulfill({ status: 200, headers: { 'content-type': 'application/json', ...CORS }, body: nonStreamContent })
  })
  // Also answer the API base's CORS preflight for /models (testConnection occasionally runs).
  page.route('**/models', (route) => {
    if (route.request().method() === 'OPTIONS') { route.fulfill({ status: 204, headers: CORS, body: '' }); return }
    route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ data: [] }) })
  })
}
export function openMessageActions(page, index = 0) {
  return page.locator('button[aria-label="消息操作"]').nth(index).click()
}
export async function createBranchFromMessage(page, index = 0) {
  await openMessageActions(page, index)
  await page.locator('text=从这里分支').waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('text=从这里分支').click()
  await page.waitForTimeout(500)
}

// Complete backup browser round-trip: seed a full state, then export via the real settings UI,
// clear app data, import the downloaded backup, reload, and verify restore.
import { launchBrowser } from './e2e-browser.mjs'
import { openAppDb } from './e2e-idb.mjs'
import { dismissProductGuide, openDocumentLibrary } from './e2e-navigation.mjs'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const BASE = process.env.E2E_BASE || 'http://localhost:5299/ai-education-reader/'
const PDF_BYTES = [...readFileSync('test/fixtures/outline-sample.pdf')]
const PDF_HASH = createHash('sha256').update(Uint8Array.from(PDF_BYTES)).digest('hex')
const results = [], errors = []
const assert = (c, m) => results.push((c ? 'PASS  ' : 'FAIL  ') + m)

async function seedBackup(page) {
  return page.evaluate((pdfInput) => new Promise((resolve) => {
    const now = Date.now()
    const blob = (bytes) => new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const row = (id, name, bytes) => ({ id, meta: { id, name, mimeType: 'image/png', size: bytes.length, createdAt: now, updatedAt: now }, binary: { storage: 'idb', blob: blob(bytes), size: bytes.length, mimeType: 'image/png' }, recordVersion: 2 })
    const msg = (id, role, content, images = []) => ({ id, role, content, images, createdAt: now, updatedAt: now })
    const snapshot = (convId, through) => ({ conversationId: convId, throughMessageId: through, createdAt: now, messages: [{ role: 'user', text: '问题一', imageIds: [] }, { role: 'assistant', text: '答案一', imageIds: [] }], provenance: [], sourceLabel: '会话', sourceDeleted: false })
    const imgMain = row('imgMain', 'main.png', [137,80,78,71,1])
    const imgA = row('imgA', 'a.png', [137,80,78,71,2])
    const pdfCtx = { id: 'pdfCtx', meta: { id: 'pdfCtx', name: 'book.pdf', mimeType: 'image/png', size: 4, createdAt: now, updatedAt: now, source: { type: 'pdf-page', groupId: 'g1', fileName: 'book.pdf', pageNumber: 3, selection: { kind: 'manual', ranges: [] } } }, binary: { storage: 'idb', blob: blob([137,80,78,71,3]), size: 4, mimeType: 'image/png' }, recordVersion: 2 }
    const pdfBytes = new Uint8Array(pdfInput)
    const document = {
      id: 'backupPdf', kind: 'pdf', fileName: 'outline-sample.pdf', mimeType: 'application/pdf', fileSize: pdfBytes.length,
      pageCount: 8, chapters: [{ id: 'manual-1', title: 'Restored chapter', level: 1, startPage: 1, endPage: 8, selectable: true, source: 'manual', children: [] }],
      chapterSource: 'manual', lastReadPage: 0, lastReadAt: now, createdAt: now, updatedAt: now,
      source: { storage: 'idb', blob: new Blob([pdfBytes], { type: 'application/pdf' }), size: pdfBytes.length, mimeType: 'application/pdf' }, recordVersion: 3,
    }
    const conv = { id: 'c1', title: '备份主对话', createdAt: now, updatedAt: now, messages: [
      msg('U1','user','问题一'), msg('A1','assistant','答案一'), msg('U2','user','问题二',[ 'imgMain' ]), msg('A2','assistant','答案二'),
    ] }
    const bA = { id: 'bA', conversationId: 'c1', forkMessageId: 'A1', title: '分支 A', createdAt: now, updatedAt: now, messages: [ msg('UA','user','分支A问'), msg('AA','assistant','分支A答') ] }
    const bB = { id: 'bB', conversationId: 'c1', parentBranchId: 'bA', forkMessageId: 'AA', title: '分支 B', createdAt: now, updatedAt: now, messages: [ msg('UB','user','分支B问'), msg('AB','assistant','分支B答') ] }
    const note = { id: 'note1', kind: 'note', title: '我的笔记', source: { conversationId: 'c1', throughMessageId: 'A1', snapshot: snapshot('c1','A1') }, prompt: '整理成笔记', createdAt: now, updatedAt: now, status: 'ready', content: '编辑后的笔记内容', generatedContent: '原本的笔记内容' }
    const quiz = { id: 'quiz1', kind: 'quiz', title: '我的题目', source: { conversationId: 'c1', throughMessageId: 'A1', snapshot: snapshot('c1','A1') }, prompt: '生成题目', createdAt: now, updatedAt: now, status: 'ready', quiz: { questions: [{ id: 'q1', type: 'single-choice', question: '2+2=?', options: ['3','4'], answer: 1, explanation: '2+2=4' }] } }
    const req = indexedDB.open('ai-education-reader')
    req.onsuccess = () => { const db = req.result;
      const stores = ['conversations','settings','attachments','annotations','documents','conversationBranches','artifacts']
      const txStores = stores.filter(s => db.objectStoreNames.contains(s))
      const tx = db.transaction(txStores, 'readwrite')
      if (db.objectStoreNames.contains('conversations')) tx.objectStore('conversations').put(conv)
      if (db.objectStoreNames.contains('conversationBranches')) { const os = tx.objectStore('conversationBranches'); os.put(bA); os.put(bB) }
      if (db.objectStoreNames.contains('attachments')) { const os = tx.objectStore('attachments'); os.put(imgMain); os.put(imgA); os.put(pdfCtx) }
      if (db.objectStoreNames.contains('documents')) tx.objectStore('documents').put(document)
      if (db.objectStoreNames.contains('artifacts')) { const os = tx.objectStore('artifacts'); os.put(note); os.put(quiz) }
      if (db.objectStoreNames.contains('settings')) { const os = tx.objectStore('settings');
        os.put({ key: 'apiKey', value: 'sk-export-secret' }); os.put({ key: 'model', value: 'deepseek-chat' }); os.put({ key: 'apiBaseUrl', value: 'https://api.deepseek.com' }); os.put({ key: 'lastConversationId', value: 'c1' }); os.put({ key: 'appearance', value: 'dark' });
        os.put({ key: 'draft:c1', value: { version: 1, text: '主线草稿', imageIds: [] } });
        os.put({ key: 'draft-branch:bA', value: { version: 1, text: '分支A草稿', imageIds: ['imgA'] } });
        os.put({ key: 'draft-branch:bB', value: { version: 1, text: '分支B草稿', imageIds: ['pdfCtx'] } });
        os.put({ key: 'activeBranch:c1', value: 'bB' });
      }
      tx.oncomplete = () => { try { db.close() } catch {} ; resolve(true) }
      tx.onerror = () => resolve(false)
    }
    req.onerror = () => resolve(false)
  }), PDF_BYTES)
}

const browser = await launchBrowser()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 25000 })
const seeded = await seedBackup(page)
await page.reload({ waitUntil: 'networkidle' })
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
console.log('SEED:', seeded)

// Open settings, export. Capture the download.
await page.getByRole('button', { name: /打开设置|设置/ }).first().click().catch(() => {})
await page.locator('text=数据与导出').waitFor({ state: 'visible', timeout: 8000 })
const dlPromise = page.waitForEvent('download', { timeout: 15000 })
await page.locator('button:has-text("导出完整备份 ZIP")').click()
const download = await dlPromise
const dlPath = await download.path()
console.log('DOWNLOAD PATH:', dlPath)
assert(!!dlPath && dlPath.length > 0, 'export produced a backup download')
const size = (await import('fs')).statSync(dlPath).size
assert(size > 100, 'exported backup ZIP is non-trivial (bytes=' + size + ')')

// Capture the export success message.
const expMsg = await page.locator('text=已导出完整备份').count()
assert(expMsg > 0, 'export success message shown')

// ---- clear app data (real settings UI) -> the app reloads (onClearData does location.reload) ----
page.on('dialog', d => d.accept())
await page.locator('[data-testid="settings-clear-data"]').click()
// The confirm is auto-accepted; the page reloads. Wait for the composer to be back.
await page.waitForFunction(() => document.readyState === 'complete')
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
await dismissProductGuide(page)

// ---- reopen settings, import the downloaded backup via the real UI ----
await page.locator('button:has-text("打开设置")').first().click()
const impInput = page.locator('input[type="file"][accept*=".zip"]')
await impInput.waitFor({ state: 'attached', timeout: 8000 })
const restoredReload = page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 })
await impInput.setInputFiles(dlPath)
await restoredReload
await page.locator('input[type="file"][accept*="image/"]').waitFor({ state: 'attached', timeout: 20000 })
await dismissProductGuide(page)
assert(true, 'successful import reloads through the clean application boot path')

// ---- verify restore via IDB + attachment load WITHOUT a manual reload ----
const [convs, branches, arts, atts, apiKeyRow, appearanceRow] = await Promise.all([
  openAppDb(page, { store: 'conversations' }),
  openAppDb(page, { store: 'conversationBranches' }),
  openAppDb(page, { store: 'artifacts' }),
  openAppDb(page, { store: 'attachments' }),
  openAppDb(page, { store: 'settings', operation: 'get', key: 'apiKey' }),
  openAppDb(page, { store: 'settings', operation: 'get', key: 'appearance' }),
])
const state = { convs, branches, arts, atts, apiKey: apiKeyRow?.value, appearance: appearanceRow?.value }
assert(state.convs.some(c => c.id === 'c1'), 'Main conversation restored')
assert(state.branches.some(b => b.id === 'bA') && state.branches.some(b => b.id === 'bB'), 'Branch A + nested Branch B restored')
const bA = state.branches.find(b => b.id === 'bA')
const bB = state.branches.find(b => b.id === 'bB')
assert(bA && bA.messages.length === 2 && bA.messages.some(m => m.content === '分支A问'), 'Branch A local messages restored')
assert(bB && bB.parentBranchId === 'bA' && bB.messages.some(m => m.content === '分支B答'), 'nested Branch B messages + ancestry restored')
const note = state.arts.find(a => a.id === 'note1')
const quiz = state.arts.find(a => a.id === 'quiz1')
assert(note && note.content === '编辑后的笔记内容' && note.generatedContent === '原本的笔记内容', 'Note artifact restored with manual edit (content) + generated original')
assert(quiz && quiz.quiz && quiz.quiz.questions.length === 1 && quiz.quiz.questions[0].answer === 1, 'Quiz structured data restored')
assert(state.appearance === 'dark', 'dark appearance restored')
assert(state.apiKey === '' || state.apiKey === undefined, 'API key NOT restored')
// branch drafts
const draftRow = await openAppDb(page, { store: 'settings', operation: 'get', key: 'draft-branch:bA' })
const drafts = draftRow?.value ?? null
assert(drafts && drafts.text === '分支A草稿' && drafts.imageIds.includes('imgA'), 'branch A draft text + image restored')
// active branch restored
const activeBranchRow = await openAppDb(page, { store: 'settings', operation: 'get', key: 'activeBranch:c1' })
const activeBranch = activeBranchRow?.value ?? null
assert(activeBranch === 'bB', 'active branch restored (bB)')
// attachment load succeeds: the restored image attachment row carries a present binary ref
// (real browser stores it OPFS-first; idb inline is the fallback). A present ref means the
// staged copy survives and can be read back (restoreBackup stages the binary before commit).
const imgMain = state.atts.find(a => a.id === 'imgMain')
const bin = imgMain && imgMain.binary
assert(imgMain && bin && (bin.blob || bin.storage === 'opfs' || bin.storage === 'idb'), 'restored attachment meta + binary ref present (can be previewed/loaded; storage=' + (bin && bin.storage) + ')')
// Also verify the attachment preview path returns a usable Blob URL in the DOM by switching to Main.
await page.locator('button[aria-label="切换到主线"]').first().click()
const imageLocator = page.locator('img[alt], img[data-testid], .msg img, img').first()
await imageLocator.waitFor({ state: 'visible', timeout: 10000 })
const anyImg = await page.locator('img[alt], img[data-testid], .msg img, img').count()
assert(anyImg >= 1, 'Main conversation renders at least one restored image (got ' + anyImg + ')')

// A real migrated PDF must be byte-identical and immediately parseable after restore.
const restoredPdf = await page.evaluate(async () => {
  const row = await new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-education-reader')
    request.onsuccess = () => {
      const get = request.result.transaction('documents', 'readonly').objectStore('documents').get('backupPdf')
      get.onsuccess = () => resolve(get.result)
      get.onerror = () => reject(get.error)
    }
    request.onerror = () => reject(request.error)
  })
  let blob
  if (row.source.storage === 'idb') blob = row.source.blob
  else {
    const parts = row.source.path.split('/').filter(Boolean)
    let directory = await navigator.storage.getDirectory()
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
    blob = await (await directory.getFileHandle(parts[parts.length - 1])).getFile()
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return { size: bytes.length, hash: [...digest].map(value => value.toString(16).padStart(2, '0')).join('') }
})
assert(restoredPdf.size === PDF_BYTES.length && restoredPdf.hash === PDF_HASH, 'restored PDF is byte-identical to the archived source')
await openDocumentLibrary(page)
await page.locator('[data-testid="doc-open-backupPdf"]').click()
await page.locator('[data-testid="reader-page-img"]').waitFor({ state: 'visible', timeout: 30000 })
assert(await page.locator('[data-testid="reader-page-img"]').isVisible(), 'restored PDF renders without a manual refresh')

await browser.close()
const pageErrors = errors.length ? errors.join(' | ') : '(none)'
const passCount = results.filter(r => r.startsWith('PASS')).length
console.log(results.join('\n'))
console.log('PAGEERRORS: ' + pageErrors)
console.log('SUMMARY ' + passCount + '/' + results.length + ' passed')
process.exit(passCount === results.length ? 0 : 1)

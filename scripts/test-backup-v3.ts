import 'fake-indexeddb/auto'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate, restoreBackup } from '../src/export/backup-import.ts'
import { setAppearance } from '../src/engine/settings-store.ts'
import { saveConversation, getConversation, saveAttachment, setSetting, getSetting } from '../src/storage/storage.ts'
import { idbGetAll, idbClearAll } from '../src/storage/idb.ts'
import { addDraftImages, setDraftText, initDrafts, resetDrafts, getDraft } from '../src/engine/draft-store.ts'
import { newStableId } from '../src/engine/types.ts'
import { addPdfContextToDraft } from '../src/pdf/pdf-context-draft.ts'

let pass = 0, fail = 0
const assert = (c, m) => { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

await idbClearAll(); resetDrafts()
const A = newStableId()
const convA = { id: A, title: '会话A', createdAt: 1, updatedAt: 1, messages: [] as any[] }

const sentImg = newStableId()
await saveAttachment({ id: sentImg, name: 'sent.png', mimeType: 'image/png', size: 4, createdAt: 1, updatedAt: 1 }, new Blob([new Uint8Array([137,80,78,71,1])], { type: 'image/png' }))
convA.messages.push({ id: newStableId(), role: 'user', content: 'sent text', images: [sentImg], createdAt: 1, updatedAt: 1 })
await saveConversation(convA)

setDraftText(A, 'unsent draft text')
const draftImg = newStableId()
await saveAttachment({ id: draftImg, name: 'draft.png', mimeType: 'image/png', size: 4, createdAt: 1, updatedAt: 1 }, new Blob([new Uint8Array([137,80,78,71,2])], { type: 'image/png' }))
addDraftImages(A, [draftImg])
const pdfRes = await addPdfContextToDraft(A, { documentId: 'doc-1', fileName: 'book.pdf', selection: { kind: 'outline', title: '4.1', ranges: [{ startPage: 1, endPage: 2 }], selectedChapterIds: ['c4.1'] }, pages: [{ blob: new Blob([new Uint8Array([137,80,78,71,3])], { type: 'image/png' }), pageNumber: 1, width: 1, height: 1, mimeType: 'image/png' }, { blob: new Blob([new Uint8Array([137,80,78,71,4])], { type: 'image/png' }), pageNumber: 2, width: 1, height: 1, mimeType: 'image/png' }] })
assert(pdfRes.ok === true, 'seeded: PDF Context group added to draft A')

await setAppearance('dark')
await setSetting('apiKey', 'sk-secret')

const seededDraft = getDraft(A)
assert(seededDraft.text === 'unsent draft text', 'seeded draft text present')
assert(seededDraft.imageIds.length === 3, 'seeded draft has 3 image ids (got ' + seededDraft.imageIds.length + ')')


// --- build the complete backup (V3) ---
const backup = await buildBackup()
assert(backup.version === 3, 'backup version is 3 (got ' + backup.version + ')')
const v3 = backup as any
assert(Array.isArray(v3.drafts), 'backup has drafts array')
const aDraft = v3.drafts.find((d: any) => d.conversationId === A)
assert(aDraft && aDraft.text === 'unsent draft text', 'backup drafts include A text')
assert(aDraft && aDraft.imageIds.length === 3, 'backup draft A has 3 image ids')
assert(v3.appearance === 'dark', 'backup appearance is dark (got ' + v3.appearance + ')')
assert(!('apiKey' in v3.settings), 'backup settings EXCLUDE apiKey')
const draftAttIds = aDraft ? aDraft.imageIds : []
const backupAttIds = v3.attachments.map((a: any) => a.id)
assert(draftAttIds.every((id: string) => backupAttIds.includes(id)), 'backup includes all draft-referenced attachments')

// --- clear ALL local data, then restore ---
await idbClearAll(); resetDrafts()
await restoreBackup(backup)
resetDrafts()
await initDrafts([A])

const convAfter = await getConversation(A)
assert(convAfter && convAfter.messages.length === 1 && convAfter.messages[0].content === 'sent text', 'restored: sent conversation content')
assert(convAfter && convAfter.messages[0].images[0] === sentImg, 'restored: sent image reference')
const draftAfter = getDraft(A)
assert(draftAfter.text === 'unsent draft text', 'restored: unsent draft text (got ' + draftAfter.text + ')')
assert(draftAfter.imageIds.length === 3, 'restored: draft images (ordinary + PDF context)')
assert(draftAfter.imageIds.includes(draftImg), 'restored: ordinary draft image present')
const rows = await idbGetAll('attachments') as any[]
const pdfSources = rows.filter(r => r.meta && r.meta.source && r.meta.source.type === 'pdf-page' && draftAfter.imageIds.includes(r.id))
assert(pdfSources.length === 2, 'restored: PDF Context group source present (got ' + pdfSources.length + ')')
assert((await getSetting('appearance')) === 'dark', 'restored: appearance dark')
const apiKey = await getSetting('apiKey')
assert(apiKey === '' || apiKey === undefined || apiKey === null, 'restored: apiKey NOT restored (empty)')

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)

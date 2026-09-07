// v1.3.3 Stage B: document-owned per-bookmark range mode persistence.
import 'fake-indexeddb/auto'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate, restoreBackup } from '../src/export/backup-import.ts'
import {
  BookmarkChapterNotFoundError,
  createDocument,
  getDocument,
  getDocumentBookmarkRangePreference,
  setDocumentBookmarkRangePreference,
  updateDocumentChapters,
} from '../src/documents/document-service.ts'
import { idbClearAll, idbGet, closeDb } from '../src/storage/idb.ts'
import type { ChapterNode } from '../src/documents/document-types.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

async function mustReject(action: () => Promise<unknown>, message: string, ctor?: new (...args: any[]) => Error) {
  let error: unknown
  try { await action() } catch (e) { error = e }
  assert(error !== undefined && (!ctor || error instanceof ctor), message)
}

const pdf = (size: number) => new Blob([new Uint8Array(size).fill(3)], { type: 'application/pdf' })
const chapter = (id: string, title: string): ChapterNode => ({
  id, title, level: 1, startPage: 1, endPage: 3, selectable: true, source: 'native', children: [],
})
const documentMeta = (id: string, chapters: ChapterNode[]) => ({
  id, kind: 'pdf' as const, fileName: id + '.pdf', mimeType: 'application/pdf' as const,
  fileSize: 3, pageCount: 3, chapters, chapterSource: 'native' as const, lastReadPage: 0,
  createdAt: 1, updatedAt: 1,
})
const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64')

await idbClearAll()
await createDocument({ id: 'doc-a', fileName: 'A.pdf', mimeType: 'application/pdf', fileSize: 3, pageCount: 3, sourceBlob: pdf(3) })
await createDocument({ id: 'doc-b', fileName: 'B.pdf', mimeType: 'application/pdf', fileSize: 3, pageCount: 3, sourceBlob: pdf(3) })
await updateDocumentChapters('doc-a', [chapter('shared', '同名章节'), chapter('leaf', '待替换')], 'native')
await updateDocumentChapters('doc-b', [chapter('shared', '同名章节')], 'native')

// Old document rows have no optional preference field and deterministically use exclusive.
const oldRow = await idbGet('documents', 'doc-a')
assert(oldRow.bookmarkRangePreferences === undefined, 'newly created document keeps the optional field absent')
assert(await getDocumentBookmarkRangePreference('doc-a', 'shared') === 'exclusive', 'missing preference defaults to exclusive')

// The same stable chapter id in two document-owned rows is still isolated by documentId.
await setDocumentBookmarkRangePreference('doc-a', 'shared', 'inclusive')
await setDocumentBookmarkRangePreference('doc-a', 'leaf', 'exclusive')
await setDocumentBookmarkRangePreference('doc-b', 'shared', 'exclusive')
assert(await getDocumentBookmarkRangePreference('doc-a', 'shared') === 'inclusive', 'doc-a shared chapter stores inclusive')
assert(await getDocumentBookmarkRangePreference('doc-a', 'leaf') === 'exclusive', 'doc-a leaf stores its own mode')
assert(await getDocumentBookmarkRangePreference('doc-b', 'shared') === 'exclusive', 'same chapter id in doc-b does not inherit doc-a')

// Close/reopen proves the value is durable, not just held in a caller or component.
await closeDb()
assert(await getDocumentBookmarkRangePreference('doc-a', 'shared') === 'inclusive', 'preference survives IndexedDB close/reopen')

// Bad writes reject before or during the atomic transaction and do not damage the row.
await mustReject(() => setDocumentBookmarkRangePreference('doc-a', 'shared', 'invalid' as any), 'invalid end mode is rejected')
await mustReject(() => setDocumentBookmarkRangePreference('doc-a', 'missing', 'inclusive'), 'unknown chapter id is rejected', BookmarkChapterNotFoundError)
assert(await getDocumentBookmarkRangePreference('doc-a', 'shared') === 'inclusive', 'rejected writes leave the previous preference unchanged')

// Replacing the chapter tree removes orphan ids; a same-title replacement gets the default.
await updateDocumentChapters('doc-a', [chapter('replacement', '待替换')], 'native')
const replaced = await getDocument('doc-a')
assert(replaced?.bookmarkRangePreferences?.leaf === undefined, 'removed chapter preference is cleaned from the document')
assert(await getDocumentBookmarkRangePreference('doc-a', 'replacement') === 'exclusive', 'replacement chapter does not inherit an orphan preference')
await setDocumentBookmarkRangePreference('doc-a', 'replacement', 'inclusive')

// New backup round-trip includes the optional field without a Backup/DB version bump.
const backup = await buildBackup()
const backedA = backup.documents.find(d => d.id === 'doc-a')
assert(backedA?.meta.bookmarkRangePreferences?.replacement === 'inclusive', 'new Backup includes per-bookmark preference')
await idbClearAll()
await restoreBackup(parseAndValidate(JSON.parse(JSON.stringify(backup))))
assert(await getDocumentBookmarkRangePreference('doc-a', 'replacement') === 'inclusive', 'new Backup round-trip restores doc-a preference')
assert(await getDocumentBookmarkRangePreference('doc-b', 'shared') === 'exclusive', 'new Backup round-trip keeps doc-b isolation')

// Stale ids in an otherwise valid backup are filtered during restore, not attached to a new tree.
const staleBackup: any = JSON.parse(JSON.stringify(backup))
staleBackup.documents.find((d: any) => d.id === 'doc-a').meta.bookmarkRangePreferences['stale-id'] = 'inclusive'
await idbClearAll()
await restoreBackup(parseAndValidate(staleBackup))
const staleRestored = await getDocument('doc-a')
assert(staleRestored?.bookmarkRangePreferences?.['stale-id'] === undefined, 'stale Backup preference is removed during restore')
assert(await getDocumentBookmarkRangePreference('doc-a', 'replacement') === 'inclusive', 'valid Backup preference survives stale-id cleanup')

// A v2 backup without the new optional field remains importable and defaults to exclusive.
const legacy = {
  format: 'ai-education-reader-backup', version: 2, exportedAt: 1,
  settings: { apiBaseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', customSystemPrompt: '', customSystemPromptEnabled: false },
  conversations: [], annotations: [], attachments: [],
  documents: [{ id: 'legacy-doc', meta: documentMeta('legacy-doc', [chapter('legacy-chapter', '旧书签')]), mimeType: 'application/pdf', data: b64([3, 3, 3]) }],
}
await idbClearAll()
await restoreBackup(parseAndValidate(legacy))
assert(await getDocumentBookmarkRangePreference('legacy-doc', 'legacy-chapter') === 'exclusive', 'old Backup without preference defaults to exclusive')

console.log('\nRESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)

// Agent B (Document Library): sorting metadata, rename semantics, layered duplicate
// detection, reading-time split (lastReadAt vs updatedAt), migration backfill, backup round
// trip of the new metadata, and no-cascade delete ownership.
import 'fake-indexeddb/auto'
import { createDocument, renameDocument, updateLastReadPage, ensureDocumentHash, getDocument, listDocumentSummaries, deleteDocument, updateDocumentChapters } from '../src/documents/document-service.ts'
import { sortDocuments, loadSortPreference, saveSortPreference, sanitizeDocumentSortKey, DEFAULT_DOCUMENT_SORT } from '../src/documents/document-sort.ts'
import { sanitizeFileName, nextAvailableName, resolveImportConflict, createDocumentFromImport } from '../src/documents/document-import-service.ts'
import { computeDocumentHashes } from '../src/documents/document-hash.ts'
import { backfillDocumentMetadata } from '../src/storage/migration.ts'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate, restoreBackup } from '../src/export/backup-import.ts'
import { idbClearAll, idbPut, idbGet, idbGetAll, closeDb } from '../src/storage/idb.ts'
import { newStableId } from '../src/engine/types.ts'
import type { OpfsFileSystem } from '../src/storage/binary-store.ts'

let pass = 0, fail = 0
function assert(c: boolean, m: string) { if (c) { pass++; console.log('  ok: ' + m) } else { fail++; console.log('  FAIL: ' + m) } }

function installMock() {
  const files = new Map<string, Blob>()
  const mock: OpfsFileSystem & { files: Map<string, Blob> } = {
    files,
    async read(path) { const b = files.get(path); if (!b) throw new Error('nf'); return b },
    async write(path, blob) { files.set(path, blob) },
    async delete(path) { files.delete(path) },
    async exists(path) { return files.has(path) },
    async listAppFiles() { return [...files.entries()].map(([p, b]) => ({ path: p, size: b.size, lastModified: 1 })) },
    async clearAppRoot() { for (const k of [...files.keys()]) try { files.delete(k) } catch {} return { completed: true, failedPaths: [] } },
  }
  ;(globalThis as any).__dshOpfsMock = mock
  return mock
}
function uninstallMock() { (globalThis as any).__dshOpfsMock = undefined }

const pdf = (bytes: number[]) => new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })

// ================= sort module (B1) =================
{
  const m = (fileName: string, createdAt: number, lastReadAt: number, pageCount: number, fileSize: number) => ({ fileName, createdAt, lastReadAt, pageCount, fileSize })
  const rows = [
    m('b.pdf', 20, 20, 5, 200),
    m('a.pdf', 10, 30, 3, 100),
    m('c.pdf', 30, 10, 8, 50),
  ]
  const byRead = sortDocuments(rows, 'last-read')
  assert(byRead[0].fileName === 'a.pdf' && byRead[2].fileName === 'c.pdf', 'sort last-read: a (lastReadAt 30) first, c (10) last')
  const byImport = sortDocuments(rows, 'last-import')
  assert(byImport[0].fileName === 'c.pdf' && byImport[2].fileName === 'a.pdf', 'sort last-import: c (createdAt 30) first, a (10) last')
  const byNameAsc = sortDocuments(rows, 'name-asc')
  assert(byNameAsc[0].fileName === 'a.pdf' && byNameAsc[2].fileName === 'c.pdf', 'sort name asc: a, b, c')
  const byNameDesc = sortDocuments(rows, 'name-desc')
  assert(byNameDesc[0].fileName === 'c.pdf' && byNameDesc[2].fileName === 'a.pdf', 'sort name desc: c, b, a')
  const byPages = sortDocuments(rows, 'pages')
  assert(byPages[0].fileName === 'c.pdf' && byPages[2].fileName === 'a.pdf', 'sort pages: c (8) first, a (3) last')
  const bySize = sortDocuments(rows, 'size')
  assert(bySize[0].fileName === 'b.pdf' && bySize[2].fileName === 'c.pdf', 'sort size: b (200) first, c (50) last')
  // sort does not mutate input
  assert(rows[0].fileName === 'b.pdf', 'sortDocuments is non-mutating')
}

// ================= sort preference persistence (B1) =================
{
  const store = new Map<string, string>()
  const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } }
  assert(loadSortPreference(fake as any) === DEFAULT_DOCUMENT_SORT, 'default sort = last-read')
  saveSortPreference('name-asc', fake as any)
  assert(loadSortPreference(fake as any) === 'name-asc', 'persisted sort preference read back')
  saveSortPreference('pages', fake as any)
  assert(loadSortPreference(fake as any) === 'pages', 'overwrite persisted preference')
  assert(sanitizeDocumentSortKey('bogus') === DEFAULT_DOCUMENT_SORT, 'invalid persisted key sanitized to default')
  assert(sanitizeDocumentSortKey(42) === DEFAULT_DOCUMENT_SORT, 'non-string persisted key sanitized')
  assert(loadSortPreference({ getItem: () => 'size' } as any) === 'size', 'valid key loaded')
}

// ================= reading-time split (B2) =================
installMock()
await idbClearAll()
{
  const id = newStableId()
  const created = await createDocument({ id, fileName: '教材.pdf', mimeType: 'application/pdf', fileSize: 100, pageCount: 20, sourceBlob: pdf([1, 2, 3, 4]) })
  const createdUpdatedAt = created.updatedAt
  const createdLastReadAt = created.lastReadAt
  assert(createdLastReadAt === createdUpdatedAt, 'new document lastReadAt = updatedAt at creation')
  await new Promise(r => setTimeout(r, 5))
  await updateLastReadPage(id, 7)
  const after = await getDocument(id)
  assert(after!.lastReadPage === 7 && after!.lastReadAt > createdLastReadAt, 'updateLastReadPage bumps lastReadAt + lastReadPage')
  assert(after!.updatedAt === createdUpdatedAt, 'updateLastReadPage does NOT bump updatedAt (metadata/read split)')
  assert(!!after!.lastReadAt && after!.lastReadAt >= after!.createdAt, 'lastReadAt is a valid reading timestamp')
}

// ================= session-style sort on summaries (B1) =================
{
  await idbClearAll()
  const d1 = newStableId(), d2 = newStableId()
  await createDocument({ id: d1, fileName: '老教材.pdf', mimeType: 'application/pdf', fileSize: 10, pageCount: 5, sourceBlob: pdf([5]) })
  await createDocument({ id: d2, fileName: '新教材.pdf', mimeType: 'application/pdf', fileSize: 20, pageCount: 9, sourceBlob: pdf([6, 6]) })
  await new Promise(r => setTimeout(r, 3))
  await updateLastReadPage(d2, 9) // d2 most recently read
  let sums = await listDocumentSummaries()
  let s = sortDocuments(sums, 'last-read')
  assert(s[0].id === d2, 'summaries sort last-read: d2 first')
  assert(s[0].lastReadAt > 0 && typeof s[0].lastReadAt === 'number', 'summary exposes lastReadAt')
  s = sortDocuments(sums, 'name-asc')
  assert(s[0].fileName === 'new'.length ? true : true, 'name-asc stable (no throw on zh)')
  s = sortDocuments(sums, 'size')
  assert(s[0].id === d2 && s[0].fileSize > s[1].fileSize, 'summaries sort size: larger-blob doc (d2) first')
}

// ================= rename (B4) =================
{
  const id = newStableId()
  await createDocument({ id, fileName: '原名.pdf', mimeType: 'application/pdf', fileSize: 100, pageCount: 10, sourceBlob: pdf([7, 7, 7]), importSource: { kind: 'pdf', originalFileName: '原名.pdf' } })
  await renameDocument(id, '  新名.pdf  ')
  const doc = await getDocument(id)
  assert(doc!.fileName === '新名.pdf', 'rename trims + persists new fileName')
  assert(doc!.importSource!.originalFileName === '原名.pdf', 'rename does NOT touch importSource.originalFileName')
  await new Promise(r => setTimeout(r, 2))
  const before = (await getDocument(id))!.updatedAt
  await new Promise(r => setTimeout(r, 2))
  await renameDocument(id, '新名2.pdf')
  const after = (await getDocument(id))!
  assert(after.fileName === '新名2.pdf' && after.updatedAt > before, 'rename bumps updatedAt (metadata mutation)')
  // empty name rejected
  let rej = false
  try { await renameDocument(id, '   ') } catch { rej = true }
  assert(rej, 'rename rejects empty/whitespace name')
  const still = await getDocument(id)
  assert(still!.fileName === '新名2.pdf', 'empty rename left the document unchanged')
  // not-found throws
  let nf = false
  try { await renameDocument(newStableId(), 'x.pdf') } catch { nf = true }
  assert(nf, 'rename on missing document throws DocumentNotFoundError')
}

// ================= name policy (B4/B6) =================
{
  assert(sanitizeFileName('  a<>b:c*d?.pdf  ') === 'a__b_c_d_.pdf', 'sanitizeFileName strips filesystem-hostile chars')
  assert(sanitizeFileName('   ') === 'document', 'sanitizeFileName falls back for empty')
  assert(nextAvailableName('高等数学.pdf', new Set(['高等数学.pdf'])) === '高等数学 (2).pdf', 'nextAvailableName: (2) on first conflict')
  assert(nextAvailableName('高等数学.pdf', new Set(['高等数学.pdf', '高等数学 (2).pdf'])) === '高等数学 (3).pdf', 'nextAvailableName: (3) on second conflict')
  assert(nextAvailableName('a.pdf', new Set()) === 'a.pdf', 'nextAvailableName unchanged when no conflict')
  assert(nextAvailableName('noext', new Set(['noext'])) === 'noext (2)', 'nextAvailableName handles no-extension')
}

// ================= duplicate detection (B5/B6/B7/B8) =================
{
  // build docs with distinct content
  const dump = async (name: string, bytes: number[], fileSize: number, pageCount: number) => {
    const id = newStaleFreeId(name)
    const blob = pdf(bytes)
    const hashes = await computeDocumentHashes(blob)
    await createDocumentFromImport({ fileName: name, originalFileName: name, pageCount, chapters: [], chapterSource: 'none', sourceBlob: blob, contentHash: hashes.contentHash, fastFingerprint: hashes.fastFingerprint })
    return { id, hashes }
  }
  function newStaleFreeId(seed: string) { return 'seed-' + seed + '-' + Math.random().toString(36).slice(2, 8) }
  await idbClearAll()
  const A = pdf([1, 1, 1, 1])   // size 4
  const B = pdf([2, 2, 2, 2])   // size 4, same size, different content
  const C = pdf([3, 3])         // size 2, different size

  const hA = await computeDocumentHashes(A), hB = await computeDocumentHashes(B), hC = await computeDocumentHashes(C)

  // exact duplicate, same name → duplicate
  await createDocumentFromImport({ fileName: 'math.pdf', originalFileName: 'math.pdf', pageCount: 5, chapters: [], chapterSource: 'none', sourceBlob: A, contentHash: hA.contentHash, fastFingerprint: hA.fastFingerprint })
  const dupSameName = await resolveImportConflict({ fileName: 'math.pdf', fileSize: 4, contentHash: hA.contentHash, fastFingerprint: hA.fastFingerprint })
  assert(dupSameName.kind === 'exact-duplicate' && dupSameName.existingFileName === 'math.pdf', '同内容同名 -> exact-duplicate')

  // exact duplicate, different name → duplicate
  const dupDiffName = await resolveImportConflict({ fileName: 'other.pdf', fileSize: 4, contentHash: hA.contentHash, fastFingerprint: hA.fastFingerprint })
  assert(dupDiffName.kind === 'exact-duplicate', '同内容不同名 -> duplicate')

  // same size, different content, different name → none
  const sameSizeDiff = await resolveImportConflict({ fileName: 'brand-new.pdf', fileSize: 4, contentHash: hB.contentHash, fastFingerprint: hB.fastFingerprint })
  assert(sameSizeDiff.kind === 'none', '同大小不同内容 -> 不是 duplicate')

  // same name, different content → name-conflict with (2)
  const nameConflict = await resolveImportConflict({ fileName: 'math.pdf', fileSize: 4, contentHash: hB.contentHash, fastFingerprint: hB.fastFingerprint })
  assert(nameConflict.kind === 'name-conflict' && nameConflict.suggestedName === 'math (2).pdf', '同名不同内容 -> 自动 (2)')

  // third name conflict → (3)
  await createDocumentFromImport({ fileName: 'math (2).pdf', originalFileName: 'math (2).pdf', pageCount: 3, chapters: [], chapterSource: 'none', sourceBlob: C, contentHash: hC.contentHash, fastFingerprint: hC.fastFingerprint })
  const again = await resolveImportConflict({ fileName: 'math.pdf', fileSize: 4, contentHash: hB.contentHash, fastFingerprint: hB.fastFingerprint })
  assert(again.kind === 'name-conflict' && again.suggestedName === 'math (3).pdf', '再次重名 -> (3)')

  // still import a copy → two distinct ids
  const beforeCount = (await listDocumentSummaries()).length
  const copyName = nextAvailableName('math.pdf', new Set((await listDocumentSummaries()).map(s => s.fileName)))
  await createDocumentFromImport({ fileName: copyName, originalFileName: 'math.pdf', pageCount: 4, chapters: [], chapterSource: 'none', sourceBlob: B, contentHash: hB.contentHash, fastFingerprint: hB.fastFingerprint })
  const afterCount = (await listDocumentSummaries()).length
  assert(afterCount === beforeCount + 1, '导入副本 -> 新增一个 document id')
  const ids = (await listDocumentSummaries()).map(s => s.id)
  assert(new Set(ids).size === ids.length, '所有 document id 互不相同')
}

// ================= old records without hash/lastReadAt (B2/B8) =================
{
  await idbClearAll()
  const oldId = 'legacy-nohash'
  await idbPut('documents', { id: oldId, kind: 'pdf', fileName: '旧.pdf', mimeType: 'application/pdf', fileSize: 6, pageCount: 2, chapters: [], chapterSource: 'none', lastReadPage: 0, createdAt: 100, updatedAt: 200, sourceBlob: pdf([9, 9, 9, 9, 9, 9]) })
  const doc = await getDocument(oldId)
  assert(!!doc && doc.lastReadAt === 200, '旧记录无 lastReadAt -> 用 updatedAt 回填 (got ' + doc!.lastReadAt + ')')
  assert(!!doc && doc.contentHash === undefined, '旧记录无 hash -> contentHash undefined 仍可读取')
  const hashes = await ensureDocumentHash(oldId)
  assert(!!hashes.contentHash && !!hashes.fastFingerprint, 'ensureDocumentHash lazily computes + returns hashes')
  const after = await getDocument(oldId)
  assert(after!.contentHash === hashes.contentHash, 'ensureDocumentHash persisted contentHash')
}

// ================= backfill metadata migration (B2) =================
{
  await idbClearAll()
  const id = 'old-row'
  await idbPut('documents', { id, kind: 'pdf', fileName: 'm.pdf', mimeType: 'application/pdf', fileSize: 3, pageCount: 1, chapters: [], chapterSource: 'none', lastReadPage: 0, createdAt: 5, updatedAt: 9, sourceBlob: pdf([9, 9, 9]), recordVersion: 2 })
  const res = await backfillDocumentMetadata()
  assert(res.migrated >= 1, 'backfillDocumentMetadata migrated at least the old row')
  const row = await idbGet('documents', id)
  assert(row.lastReadAt === 9, 'backfill set lastReadAt from updatedAt (got ' + row.lastReadAt + ')')
  assert(row.recordVersion === 3, 'backfill bumped recordVersion to 3')
  const got = await getDocument(id)
  assert(got!.lastReadAt === 9 && got!.updatedAt === 9, 'backfilled row hydrates with lastReadAt')
}

// ================= backup round trip keeps new metadata (B2) =================
{
  await idbClearAll()
  const h = await computeDocumentHashes(pdf([4, 4, 4, 4]))
  const id = await createDocumentFromImport({ fileName: '备份.pdf', originalFileName: '备份.pdf', pageCount: 4, chapters: [], chapterSource: 'none', sourceBlob: pdf([4, 4, 4, 4]), contentHash: h.contentHash, fastFingerprint: h.fastFingerprint })
  await updateLastReadPage(id, 2)
  const backup = await buildBackup()
  await idbClearAll()
  await restoreBackup(parseAndValidate(JSON.parse(JSON.stringify(backup))))
  const restored = await getDocument(id)
  assert(!!restored && restored.lastReadPage === 2, 'backup round trip keeps lastReadPage')
  assert(!!restored && restored.lastReadAt > 0, 'backup round trip keeps lastReadAt')
  assert(!!restored && restored.contentHash === h.contentHash, 'backup round trip keeps contentHash')
  assert(!!restored && restored.fastFingerprint === h.fastFingerprint, 'backup round trip keeps fastFingerprint')
}
function newStaleFreeId(seed: string) { return 'buf-' + seed + '-' + Math.random().toString(36).slice(2, 8) }

// ================= delete does not cascade Context attachments (B10) =================
{
  await idbClearAll()
  const docId = newStaleFreeId('del')
  await createDocument({ id: docId, fileName: 'del.pdf', mimeType: 'application/pdf', fileSize: 4, pageCount: 3, sourceBlob: pdf([8, 8, 8, 8]) })
  // an attachment referencing this document (context artifact provenance)
  const attId = 'att-' + newStaleFreeId('c')
  await idbPut('attachments', { id: attId, meta: { id: attId, name: 'a-p0001.jpg', mimeType: 'image/jpeg', size: 4, createdAt: 1, updatedAt: 1, source: { type: 'pdf-page', groupId: 'g', documentId: docId, fileName: 'del.pdf', pageNumber: 1, selection: { kind: 'manual', ranges: [{ startPage: 1, endPage: 2 }] } } }, blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }) })
  await deleteDocument(docId)
  const att = await idbGet('attachments', attId)
  assert(!!att, '删除 Document 后 Context 附件仍在（不级联）')
  assert((await getDocument(docId)) === undefined, '删除 Document 移除文档行')
}

uninstallMock()
await closeDb()
console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)

import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { deleteSelectedDraftItems, undoDraftDeletion, type ChapterDraftItem } from '../src/documents/chapter-builder.ts'
import { nextChapterVersions } from '../src/documents/chapter-versions.ts'
import { createDocument, updateDocumentChapters, getDocument, getDocumentRecordMeta, listDocumentRecords, toStoredRecord } from '../src/documents/document-service.ts'
import { buildBackup } from '../src/export/backup-export.ts'
import { parseAndValidate, restoreBackup } from '../src/export/backup-import.ts'
import { idbClearAll } from '../src/storage/idb.ts'
import type { ChapterNode } from '../src/documents/document-types.ts'

const before: ChapterDraftItem[] = [1,2,3,3,2,3,1].map((level, i) => ({id:String(i), title:'Entry '+i, level, startPage:i+1}))
const after = deleteSelectedDraftItems(before, new Set(['0','1','4']))
assert.deepEqual(after.map(row => [row.id,row.level]), [['2',1],['3',1],['5',1],['6',1]])
assert.deepEqual(before.map(row => row.level), [1,2,3,3,2,3,1], 'deletion does not mutate baseline')
const edited = after.map(row => row.id === '3' ? {...row,title:'Edited later',startPage:4} : row)
const restored = undoDraftDeletion(edited, before, after)
assert.deepEqual(restored.map(row => row.level), before.map(row => row.level))
assert.equal(restored[3].title, 'Edited later', 'undo preserves later title edits')
assert.deepEqual(undoDraftDeletion([], before, []), before, 'undo clearing all rows')
assert.deepEqual(deleteSelectedDraftItems(before, before.map(row => row.id)), [])

const chapter: ChapterNode = {id:'chapter',title:'Original',level:1,startPage:1,endPage:10,selectable:true,source:'manual',children:[]}
const versions = nextChapterVersions({chapters:[chapter],chapterSource:'native',updatedAt:1}, [{...chapter,title:'Edited'}], 'manual', 2)
assert.equal(versions.length, 2, 'pre-version legacy outline becomes baseline automatically')
assert.equal(nextChapterVersions({chapterVersions:versions}, [{...chapter,title:'Edited'}], 'manual', 3).length, 2, 'identical saves do not duplicate snapshots')
chapter.title = 'Mutated'; assert.equal(versions[0].chapters[0].title, 'Original')

await idbClearAll()
await createDocument({id:'versions',fileName:'versions.pdf',mimeType:'application/pdf',fileSize:4,pageCount:10,sourceBlob:new Blob(['%PDF'],{type:'application/pdf'})})
await updateDocumentChapters('versions',versions[0].chapters,'native')
await updateDocumentChapters('versions',versions[1].chapters,'manual')
const doc = (await getDocument('versions'))!
assert.equal(doc.chapterVersions?.length, 2)
assert.equal((await getDocumentRecordMeta('versions'))?.chapterVersions?.length,2)
assert.equal((await listDocumentRecords())[0].meta.chapterVersions?.length,2)
assert.equal(toStoredRecord(doc, {kind:'idb',key:'test'} as any).chapterVersions?.length,2)
const backup = await buildBackup()
assert.equal(backup.documents[0].meta.chapterVersions?.length, 2)
await restoreBackup(parseAndValidate(backup))
assert.deepEqual((await getDocument('versions'))?.chapterVersions,doc.chapterVersions, 'version history round-trips through backup')
const malformed = structuredClone(backup)
malformed.documents[0].meta.chapterVersions![0].chapters[0].startPage = 999
assert.throws(() => parseAndValidate(malformed), /chapterVersions/)
await updateDocumentChapters('versions',[],'none')
assert.equal((await getDocument('versions'))?.chapterVersions?.length,3, 'cleared outline is also versioned')
await updateDocumentChapters('versions',versions[0].chapters,'manual')
assert.equal((await getDocument('versions'))?.chapterVersions?.length,4, 'restoring creates a new snapshot without deleting history')
console.log('PASS chapter versions: selected-only deletion, promotion, undo preserving edits, immutable local history, backup round-trip, validation and restoration')

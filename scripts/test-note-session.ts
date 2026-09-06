import { flushNoteEditorSession, type NoteEditorSession } from '../src/documents/note-session.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

const makeSession = (text: string): NoteEditorSession => ({ documentId: 'doc', pageNumber: 1, key: 'doc:1', text, loaded: true, dirty: true, timer: null, lastSave: null })
const saved: string[] = []
let rejectNext = true
const writer = async (_documentId: string, _pageNumber: number, content: string) => {
  if (rejectNext) { rejectNext = false; throw new Error('injected note save failure') }
  saved.push(content)
  return undefined
}

// A/B: a rejected write keeps the session dirty and the following flush retries it.
const failed = makeSession('ABC')
await flushNoteEditorSession(failed, writer).catch(() => undefined)
assert(failed.dirty, 'save failure keeps the session dirty')
await flushNoteEditorSession(failed, writer)
assert(!failed.dirty && saved.at(-1) === 'ABC', 'failure followed by retry persists the note and clears dirty')

// C: a newer edit during an in-flight save remains dirty until its own snapshot lands.
let releaseFirst: (() => void) | undefined
const firstSave = new Promise<void>((resolve) => { releaseFirst = resolve })
const inFlightSaved: string[] = []
const controlledWriter = async (_documentId: string, _pageNumber: number, content: string) => {
  inFlightSaved.push(content)
  if (content === 'ABC') await firstSave
  return undefined
}
const evolving = makeSession('ABC')
const first = flushNoteEditorSession(evolving, controlledWriter)
evolving.text = 'ABCD'
evolving.dirty = true
const second = flushNoteEditorSession(evolving, controlledWriter)
releaseFirst!()
await first
assert(evolving.dirty, 'edit during save keeps dirty after the older snapshot succeeds')
await second
assert(!evolving.dirty && inFlightSaved.join(',') === 'ABC,ABCD', 'queued newer snapshot eventually wins and clears dirty')

// D: a failed autosave can be flushed again during Reader cleanup.
let closeReject = true
const closeSaved: string[] = []
const closeWriter = async (_documentId: string, _pageNumber: number, content: string) => {
  if (closeReject) { closeReject = false; throw new Error('injected close failure') }
  closeSaved.push(content)
  return undefined
}
const closing = makeSession('ABC')
await flushNoteEditorSession(closing, closeWriter).catch(() => undefined)
assert(closing.dirty, 'failed autosave remains dirty before Reader cleanup')
await flushNoteEditorSession(closing, closeWriter)
assert(!closing.dirty && closeSaved[0] === 'ABC', 'Reader cleanup retry can persist the failed autosave')

// E: a timer callback and a cleanup can request the same snapshot together,
// but they must share one in-flight write rather than duplicate it.
let releaseSameSnapshot!: () => void
const sameSnapshotBarrier = new Promise<void>((resolve) => { releaseSameSnapshot = resolve })
let sameSnapshotWrites = 0
const sameSnapshotWriter = async (_documentId: string, _pageNumber: number, _content: string) => {
  sameSnapshotWrites++
  await sameSnapshotBarrier
  return undefined
}
const sameSnapshot = makeSession('SAME')
const firstSameSnapshot = flushNoteEditorSession(sameSnapshot, sameSnapshotWriter)
const duplicateSameSnapshot = flushNoteEditorSession(sameSnapshot, sameSnapshotWriter)
assert(sameSnapshotWrites === 1, 'duplicate flush for the same snapshot reuses the pending write')
releaseSameSnapshot()
await Promise.all([firstSameSnapshot, duplicateSameSnapshot])

// F: a close/reopen read must observe the same-key write registration made by
// flush before it is allowed to read durable state. This is deliberately
// controlled rather than timing-based: the writer exposes its pending barrier
// synchronously, and the reader waits only when that barrier is visible.
let releasePendingWrite!: () => void
const pendingWrite = new Promise<void>((resolve) => { releasePendingWrite = resolve })
const pendingByKey = new Map<string, Promise<void>>()
let durableContent = 'OLD'
const barrierWriter = async (documentId: string, pageNumber: number, content: string) => {
  const key = `${documentId}:${pageNumber}`
  const write = pendingWrite.then(() => {
    durableContent = content
    pendingByKey.delete(key)
  })
  pendingByKey.set(key, write)
  await write
  return undefined
}
const readAfterFlush = async () => {
  await (pendingByKey.get('doc:1') ?? Promise.resolve())
  return durableContent
}
const reopening = makeSession('NEW')
const closeFlush = flushNoteEditorSession(reopening, barrierWriter)
let readSettled = false
const reopenedContent = readAfterFlush()
void reopenedContent.then(() => { readSettled = true })
await Promise.resolve()
await Promise.resolve()
assert(!readSettled, 'immediate close/reopen read waits for the pending same-key write')
releasePendingWrite()
await closeFlush
assert(await reopenedContent === 'NEW', 'close/reopen read observes the flushed latest content')

console.log(`RESULT pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)

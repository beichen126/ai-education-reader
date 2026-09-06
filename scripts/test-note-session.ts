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

console.log(`RESULT pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)

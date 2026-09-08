import type { DocumentNote } from '../src/documents/document-types'
import { NoteAvailabilityGate, NoteReadCache, noteAvailabilityFrom, noteKey, notePersistedState } from '../src/documents/note-availability'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string) {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

const row = (content: string): DocumentNote => ({
  id: 'doc/page-1', documentId: 'doc', pageNumber: 1, content, createdAt: 1, updatedAt: 1,
})

assert(noteAvailabilityFrom('doc:1', undefined).kind === 'empty', 'no row is empty')
assert(noteAvailabilityFrom('doc:1', row('  existing  ')).kind === 'existing', 'trim-nonempty row is existing')
assert(noteAvailabilityFrom('doc:1', row(' \n\t ')).kind === 'empty', 'whitespace-only legacy row is empty')
assert(notePersistedState(row('  ')) === 'empty', 'whitespace legacy state does not claim persisted existence')
assert(noteKey('doc', 7) === 'doc:7', 'cache identity is document plus page')
const gate = new NoteAvailabilityGate()
const slowA = gate.begin('doc:1')
const fastB = gate.begin('doc:2')
assert(!gate.accepts(slowA) && gate.accepts(fastB), 'slow page A result cannot commit after fast page B becomes current')

let resolveRead!: (value: DocumentNote | undefined) => void
let calls = 0
const cache = new NoteReadCache(async () => {
  calls++
  return new Promise<DocumentNote | undefined>(resolve => { resolveRead = resolve })
})
const first = cache.read('doc', 1)
const duplicate = cache.read('doc', 1)
assert(calls === 1 && first === duplicate, 'preload and editor share one pending read')
resolveRead(row('cached'))
assert((await first)?.content === 'cached', 'pending read resolves the shared row')
assert((await cache.read('doc', 1))?.content === 'cached' && calls === 1, 'resolved row is reused without a second read')
cache.remember('doc', 1, undefined)
assert(cache.peek('doc', 1) === undefined, 'successful empty save replaces cached existence')

console.log(`RESULT pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)

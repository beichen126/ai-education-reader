import fs from 'node:fs'
import { isCompletedAssistantMessage } from '../src/engine/types'
import { notePersistedState } from '../src/documents/note-availability'

let pass = 0
let fail = 0
function expect(condition: boolean, message: string) {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}

// V202-CR-01 RED: a cold cache miss must not be treated as durable empty.
expect(notePersistedState(undefined) === 'unknown', 'V202-CR-01 cold cache miss is unknown, not empty')

// V202-CR-03 RED: whitespace-only assistant output is not a meaningful completion.
expect(!isCompletedAssistantMessage({ role: 'assistant', content: ' \n\u00a0\t' }), 'V202-CR-03 whitespace-only assistant is not completed')

// V202-CR-02 RED: the two v2.0.2 browser regressions must be in release CORE.
const release = fs.readFileSync('scripts/test-release.mjs', 'utf8')
const core = release.match(/const CORE_E2E = \[([\s\S]*?)\n\]/)?.[1] ?? ''
expect(core.includes("'e2e-v202-message-state'") && core.includes("'e2e-v202-rejection'"), 'V202-CR-02 v2.0.2 browser regressions are in CORE')

console.log(`SUMMARY ${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)

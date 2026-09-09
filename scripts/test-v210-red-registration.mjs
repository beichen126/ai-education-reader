import fs from 'node:fs'
import path from 'node:path'

const releaseSource = fs.readFileSync(path.join('scripts', 'test-release.mjs'), 'utf8')
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const coreBlock = releaseSource.match(/const CORE_E2E = \[([\s\S]*?)\n\]/)?.[1] ?? ''
const core = [...coreBlock.matchAll(/'([^']+)'/g)].map(match => match[1])
const required = [
  'e2e-conversation-modes',
  'e2e-v210-range-control',
  'e2e-product-guide',
  'e2e-document-reader',
  'e2e-continuous-scroll',
]
let pass = 0
let fail = 0
const assert = (condition, message) => {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}

assert((releaseSource.match(/const CORE_E2E = \[/g) || []).length === 1, 'CORE_E2E has exactly one declaration')
assert(new Set(core).size === core.length, 'CORE_E2E entries are unique')
for (const name of required) {
  assert(core.filter(entry => entry === name).length === 1, 'required v2.1.0 gate is registered exactly once: ' + name)
  assert(typeof packageJson.scripts?.['test:' + name] === 'string', 'npm script exists: test:' + name)
  assert(fs.existsSync(path.join('scripts', name + '.mjs')), 'browser script exists: scripts/' + name + '.mjs')
}
assert(!core.includes('missing-e2e-test'), 'missing E2E names are not silently registered')
console.log(`SUMMARY ${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)

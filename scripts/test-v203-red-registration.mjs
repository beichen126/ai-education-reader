import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const release = readFileSync('scripts/test-release.mjs', 'utf8')
const core = [...(release.match(/const CORE_E2E = \[([\s\S]*?)\n\]/)?.[1].matchAll(/'([^']+)'/g) || [])].map(match => match[1])
const requiredCore = [
  'e2e-v202-message-state',
  'e2e-v202-rejection',
  'e2e-v203-note-read-safety',
  'e2e-v203-prompt-simplification',
  'e2e-v203-reader-navigation',
  'e2e-v203-context-preview',
  'e2e-v203-quick-follow-up-anchor',
]
const checks = [
  [requiredCore.every(name => core.includes(name)), 'v202/v203 browser suites are registered in CORE'],
  [requiredCore.every(name => typeof packageJson.scripts?.['test:' + name] === 'string'), 'all v202/v203 browser package scripts are registered'],
  [new Set(core).size === core.length, 'CORE browser suite names are unique'],
]
for (const [condition, message] of checks) console.log((condition ? 'PASS  ' : 'FAIL  ') + 'V203-REG ' + message)
const failed = checks.filter(([condition]) => !condition).length
console.log('SUMMARY ' + (checks.length - failed) + '/' + checks.length + ' passed')
process.exit(failed === 0 ? 0 : 1)

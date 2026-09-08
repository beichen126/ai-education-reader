import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const release = readFileSync('scripts/test-release.mjs', 'utf8')
const checks = [
  [typeof packageJson.scripts?.['test:e2e-v201-regressions'] === 'string', 'stable npm script exists'],
  [release.includes("'e2e-v201-regressions'"), 'regression browser gate is registered in CORE_E2E'],
]
for (const [condition, message] of checks) console.log((condition ? 'PASS  ' : 'FAIL  ') + 'V200-FCR-09 ' + message)
const failed = checks.filter(([condition]) => !condition).length
console.log('SUMMARY ' + (checks.length - failed) + '/' + checks.length + ' passed')
process.exit(failed === 0 ? 0 : 1)

import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const release = readFileSync('scripts/test-release.mjs', 'utf8')
const reader = readFileSync('src/documents/DocumentReader.tsx', 'utf8')
const testAll = packageJson.scripts?.['test:all'] || ''

function arrayLiteral(name) {
  const match = release.match(new RegExp('const ' + name + " = \\[([\\s\\S]*?)\\n\\]"))
  return [...(match?.[1]?.matchAll(/'([^']+)'/g) || [])].map((item) => item[1])
}

const core = arrayLiteral('CORE_E2E')
const optional = arrayLiteral('OPTIONAL_E2E')
const checks = [
  [typeof packageJson.scripts?.['test:v202-red'] === 'string', 'v2.0.2 RED domain script is registered'],
  [typeof packageJson.scripts?.['test:v202-red-registration'] === 'string', 'v2.0.2 RED registration script is registered'],
  [testAll.includes('test:regressions'), 'v201/v202 domain regression suite is reachable from the default unit gate'],
  [new Set([...core, ...optional]).size === core.length + optional.length, 'CORE and OPTIONAL E2E lists are unique in EXTRA mode'],
  [release.includes('shell: false') && !release.includes('shell: true') && !release.includes('shell: useShell'), 'release runner uses shell-free child processes'],
  [release.includes('RELEASE PORT OCCUPIED') && release.includes('UNKNOWN E2E TEST NAME'), 'release runner fails closed before stale/unknown E2E execution'],
  [!reader.includes('data-testid="reader-build"'), 'Reader top-bar build entry is absent from production source'],
  [reader.includes('新建笔记') && reader.includes('查看笔记'), 'Reader note action is state-aware in production source'],
]

for (const [condition, message] of checks) console.log((condition ? 'PASS  ' : 'FAIL  ') + 'V202-REG ' + message)
const failed = checks.filter(([condition]) => !condition).length
console.log('SUMMARY ' + (checks.length - failed) + '/' + checks.length + ' passed')
process.exit(failed === 0 ? 0 : 1)

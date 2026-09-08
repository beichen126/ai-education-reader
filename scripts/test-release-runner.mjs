import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { canBindPort, missingE2EScripts, resolveE2EList, resolveNpmInvocation } from './release-runner-utils.mjs'

let pass = 0
let fail = 0
function assert(condition, message) {
  if (condition) { pass++; console.log('PASS  ' + message) }
  else { fail++; console.log('FAIL  ' + message) }
}
function reservePort() {
  return new Promise(resolve => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server }))
  })
}
function runRelease(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts', 'test-release.mjs')], {
      cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('close', (code, signal) => resolve({ code, signal, output }))
  })
}

const win = resolveNpmInvocation({ platform: 'win32', execPath: 'C:/node/node.exe', npmExecPath: '', fileExists: value => value.endsWith('npm-cli.js') })
assert(win.command === 'C:/node/node.exe' && win.prefixArgs[0].endsWith('npm-cli.js'), 'Windows resolves npm-cli.js and remains shell-free')
assert(resolveNpmInvocation({ platform: 'linux' }).command === 'npm', 'POSIX resolves the npm command directly')

const core = ['a', 'b', 'a']
const optional = ['c', 'b']
assert(resolveE2EList({ extraE2E: true, core, optional }).join(',') === 'a,b,c', 'EXTRA E2E list is stable and unique')
assert(resolveE2EList({ releaseE2E: 'b,a,b', extraE2E: false, core, optional }).join(',') === 'b,a', 'explicit RELEASE_E2E list is stable and unique')
assert(missingE2EScripts(['known'], 'scripts', value => value.endsWith('known.mjs')).length === 0, 'known E2E script name is accepted')
assert(missingE2EScripts(['missing'], 'scripts', () => false)[0] === 'missing', 'unknown E2E script name is reported')

const occupied = await reservePort()
assert(await canBindPort('127.0.0.1', occupied.port) === false, 'occupied preview port is detected before Vite starts')
const occupiedRun = await runRelease({ RELEASE_SKIP_UNIT: '1', RELEASE_PORT: String(occupied.port), RELEASE_E2E: 'e2e-document-notes' })
await new Promise(resolve => occupied.server.close(resolve))
assert(occupiedRun.code !== 0 && occupiedRun.output.includes('RELEASE PORT OCCUPIED'), 'occupied port fails closed with non-zero exit')

const unknownPort = await reservePort()
await new Promise(resolve => unknownPort.server.close(resolve))
const unknownRun = await runRelease({ RELEASE_SKIP_UNIT: '1', RELEASE_PORT: String(unknownPort.port), RELEASE_E2E: 'missing-e2e-test' })
assert(unknownRun.code !== 0 && unknownRun.output.includes('UNKNOWN E2E TEST NAME'), 'unknown E2E name fails clearly without running a stale server')
assert(await canBindPort('127.0.0.1', unknownPort.port), 'unknown E2E failure still cleans up preview resources')

const childFailurePort = await reservePort()
await new Promise(resolve => childFailurePort.server.close(resolve))
const previewFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-education-release-runner-'))
fs.writeFileSync(path.join(previewFixture, 'index.html'), '<!doctype html><title>release runner self-test</title>')
try {
  const childFailureRun = await runRelease({
    RELEASE_SKIP_UNIT: '1',
    RELEASE_PORT: String(childFailurePort.port),
    RELEASE_E2E: 'e2e-release-runner-child-failure',
    RELEASE_RUNNER_SELF_TEST: '1',
    RELEASE_PREVIEW_ROOT: previewFixture,
  })
  assert(childFailureRun.code !== 0 && childFailureRun.output.includes('e2e-release-runner-child-failure FAILED'), 'failed child E2E returns non-zero')
  assert(await canBindPort('127.0.0.1', childFailurePort.port), 'failed child E2E cleans up the preview server')
} finally {
  fs.rmSync(previewFixture, { recursive: true, force: true })
}

console.log(`SUMMARY ${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)

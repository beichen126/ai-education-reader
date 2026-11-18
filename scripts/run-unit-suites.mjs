import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { performance } from 'node:perf_hooks'
import { resolveNpmInvocation } from './release-runner-utils.mjs'

const suites = process.argv.slice(2)
if (!suites.length) throw new Error('No unit suites configured')

const { command, prefixArgs } = resolveNpmInvocation()
const workerCount = Math.min(4, availableParallelism(), suites.length)
const started = performance.now()
let cursor = 0
const failures = []

function runSuite(name) {
  return new Promise(resolve => {
    const started = performance.now()
    const child = spawn(command, [...prefixArgs, 'run', name], { stdio: ['ignore', 'pipe', 'pipe'] })
    const output = []
    child.stdout.on('data', chunk => output.push(chunk))
    child.stderr.on('data', chunk => output.push(chunk))
    child.on('error', error => output.push(Buffer.from(error.message + '\n')))
    child.on('close', (code, signal) => {
      const success = code === 0
      const seconds = ((performance.now() - started) / 1000).toFixed(1)
      console.log(`\n==== [${success ? 'PASS' : 'FAIL'}] ${name} (${seconds}s) ====`)
      process.stdout.write(Buffer.concat(output))
      if (!success) failures.push(`${name} (${signal ?? code ?? 'process error'})`)
      resolve()
    })
  })
}

async function runWorker() {
  while (cursor < suites.length) await runSuite(suites[cursor++])
}

console.log(`Running ${suites.length} unit suite groups on ${workerCount} workers`)
await Promise.all(Array.from({ length: workerCount }, runWorker))
console.log(`Finished in ${((performance.now() - started) / 1000).toFixed(1)}s, ${failures.length} failed`)
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
}

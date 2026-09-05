#!/usr/bin/env node
// v1.1.1 release gate (Windows-first, not bash-only).
//   npm run test:release
// Orchestrates: typecheck -> test:all -> build -> critical E2E against a self-managed
// vite preview server, and ALWAYS tears the preview process tree down in a finally
// block — so a failure never leaves a stray 5299/5320 server behind (a regression the
// earlier agents introduced). Set RELEASE_PORT / RELEASE_HOST to move the server.
import { spawn, spawnSync } from 'node:child_process'

// Windows-first: npm resolves to npm.cmd; spawn without a shell cannot find the bare
// 'npm' shim on Windows, so use the platform-appropriate command name.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const PORT = Number(process.env.RELEASE_PORT || 5320)
const HOST = process.env.RELEASE_HOST || '127.0.0.1'
const BASE = process.env.E2E_BASE || `http://${HOST}:${PORT}/ai-education-reader/`
// Skip the unit/typecheck/build legs for a quick E2E-only iteration (RELEASE_SKIP_UNIT=1).
const SKIP_UNIT = process.env.RELEASE_SKIP_UNIT === '1'
const EXTRA_E2E = process.env.RELEASE_EXTRA_E2E === '1'

const CORE_E2E = [
  'e2e-artifacts',
  'e2e-document-reader',
  'e2e-document-context',
  'e2e-branching',
  'e2e-branching-graph',
  'e2e-branch-stream',
  'e2e-branch-stop',
  'e2e-root-stop',
  'e2e-backup',
]
const OPTIONAL_E2E = [
  'e2e-opfs-storage',
  'e2e-theme',
  'e2e-native-toc',
  'e2e-ai-toc',
  'e2e-toc-thumbnails',
  'e2e-toc-review-layout',
]
const E2E = process.env.RELEASE_E2E
  ? process.env.RELEASE_E2E.split(',').map((s) => s.trim()).filter(Boolean)
  : (EXTRA_E2E ? [...CORE_E2E, ...OPTIONAL_E2E] : CORE_E2E)

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: process.cwd(), stdio: opts.inherit ? 'inherit' : 'pipe', env: { ...process.env, ...(opts.env || {}) }, shell: !!opts.shell })
  return r.status === 0
}

function startServer() {
  // --strictPort (Agent H, H6): if the port is already taken, vite preview FAILS instead of
  // silently moving to the next free port — so the E2E never tests a stale server that is not
  // the one the release gate just started (a previous 5299 leak would otherwise pass silently).
  const child = spawn(NPM, ['run', 'preview', '--', '--port', String(PORT), '--host', HOST, '--strictPort'], {
    cwd: process.cwd(), stdio: 'ignore', detached: true, shell: true,
  })
  child.unref()
  return child.pid
}

function stopServer(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      // Windows: kill the process tree (npm -> node -> vite).
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      // POSIX (e.g. Ubuntu CI): the detached child is a process-group leader; kill the group.
      try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* best-effort */ } } }
    }
  } catch { /* best-effort */ }
}

async function waitHttp(url, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return true } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 400))
  }
  return false
}

let failures = 0
let serverPid = null
try {
  if (!SKIP_UNIT) {
    console.error('\n==== [release] typecheck ====')
    if (!run('npm', ['run', 'typecheck'], { inherit: true })) { console.error('TYPE CHECK FAILED'); failures++ }
    console.error('\n==== [release] test:all (npm test) ====')
    if (!run('npm', ['test'], { inherit: true })) { console.error('UNIT SUITE FAILED'); failures++ }
    console.error('\n==== [release] build ====')
    if (!run('npm', ['run', 'build'], { inherit: true })) { console.error('BUILD FAILED'); failures++ }
  }

  if (failures === 0 || SKIP_UNIT) {
    console.error('\n==== [release] start preview on ' + HOST + ':' + PORT + ' ====')
    serverPid = startServer()
    const up = await waitHttp(BASE)
    if (!up) {
      console.error('PREVIEW SERVER DID NOT COME UP — aborting E2E')
      failures++
    } else {
      // Ensure the gitignored generated reader fixture exists (e2e-document-reader needs a >30-page PDF).
      try {
        const fs = await import('node:fs')
        if (!fs.existsSync('test/.playwright/outline-big.pdf')) {
          console.error('==== [release] generating reader fixture outline-big.pdf ====')
          run('node', ['scripts/make-outline-pdf.mjs', 'test/.playwright/outline-big.pdf', '40'], { inherit: true })
        }
      } catch { /* non-fatal */ }
      for (const t of E2E) {
        console.error('\n#### [release] ' + t + ' ####')
        if (!run('node', ['scripts/' + t + '.mjs'], { inherit: true, env: { E2E_BASE: BASE } })) {
          console.error(t + ' FAILED')
          failures++
        }
      }
    }
  }

  if (failures > 0) {
    console.error('\n==== [release] FAILED (' + failures + ' failure(s)) ====')
    process.exitCode = 1
  } else {
    console.error('\n==== [release] PASSED ====')
    process.exitCode = 0
  }
} finally {
  stopServer(serverPid)
  console.error('==== [release] preview server stopped ====')
}

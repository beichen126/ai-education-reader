import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export function uniqueStable(values) {
  return [...new Set(values)]
}

export function resolveE2EList({ releaseE2E, extraE2E, core, optional }) {
  const explicit = typeof releaseE2E === 'string' && releaseE2E.trim().length > 0
  const selected = explicit
    ? releaseE2E.split(',').map(value => value.trim()).filter(Boolean)
    : (extraE2E ? [...core, ...optional] : [...core])
  return uniqueStable(selected)
}

export function missingE2EScripts(names, scriptsDir = path.join(process.cwd(), 'scripts'), fileExists = fs.existsSync) {
  return names.filter(name => !fileExists(path.join(scriptsDir, name + '.mjs')))
}

export function resolveNpmInvocation({ platform = process.platform, execPath = process.execPath, npmExecPath = process.env.npm_execpath, fileExists = fs.existsSync } = {}) {
  if (platform !== 'win32') return { command: 'npm', prefixArgs: [] }
  const candidates = [
    npmExecPath,
    path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const npmCli = candidates.find(fileExists)
  if (!npmCli) throw new Error('Unable to resolve npm-cli.js for shell-free Windows release commands')
  return { command: execPath, prefixArgs: [npmCli] }
}

export function resolveNodeInvocation({ execPath = process.execPath } = {}) {
  return { command: execPath, prefixArgs: [] }
}

export function canBindPort(host, port) {
  return new Promise(resolve => {
    const server = net.createServer()
    const finish = result => {
      server.removeAllListeners()
      try { server.close() } catch { /* not listening */ }
      resolve(result)
    }
    server.once('error', () => finish(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen({ host, port })
  })
}

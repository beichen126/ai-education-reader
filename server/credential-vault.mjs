import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

// This app's own vault only. Never searches for or imports other apps' credentials.
const vaultRoot = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'AI-Education-Reader')
  : join(homedir(), '.config', 'ai-education-reader')

function windowsProtect(bytes, decrypt = false) {
  // Secret bytes travel on stdin, not argv, environment variables or shell logs.
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[System.Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('credential_protection_failed')) }, 15000)
    child.stdout.on('data', data => { output += data; if (output.length > 2 * 1024 * 1024) child.kill() })
    child.stderr.on('data', () => {}) // Never echo cryptographic/provider errors.
    child.on('error', () => { clearTimeout(timer); reject(new Error('credential_protection_failed')) })
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.from(output.trim(), 'base64')) : reject(new Error('credential_protection_failed')) })
    child.stdin.on('error', () => {})
    child.stdin.end(bytes.toString('base64'))
  })
}

export function createCredentialVault(root = vaultRoot, name = 'chatgpt') {
  if (!/^[a-z-]+$/.test(name)) throw new Error('invalid_vault_name')
  const file = join(root, name + (process.platform === 'win32' ? '.dpapi' : '.json'))
  let queue = Promise.resolve()
  return {
    async load() {
      let bytes
      try { bytes = await readFile(file) } catch (error) { if (error.code === 'ENOENT') return { hostId: `urn:uuid:${randomUUID()}`, profiles: [], activeId: null }; throw new Error('credential_read_failed') }
      try {
        const value = JSON.parse((process.platform === 'win32' ? await windowsProtect(bytes, true) : bytes).toString('utf8'))
        if (!value.hostId?.startsWith('urn:uuid:') || !Array.isArray(value.profiles)) throw new Error()
        return value
      } catch { throw new Error('credential_read_failed') }
    },
    save(value) {
      // Capture at call time so later mutations cannot alter an already queued write.
      const serialized = Buffer.from(JSON.stringify(value))
      const task = queue.catch(() => {}).then(async () => {
        await mkdir(root, { recursive: true, mode: 0o700 })
        if (process.platform !== 'win32') await chmod(root, 0o700)
        const bytes = process.platform === 'win32' ? await windowsProtect(serialized) : serialized
        const temporary = file + '.' + randomUUID() + '.tmp'
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
        await rename(temporary, file)
        if (process.platform !== 'win32') await chmod(file, 0o600)
      })
      queue = task
      return task
    },
  }
}

import { createHash, randomBytes } from 'node:crypto'
import { LocalError } from './openai-contract.mjs'

const IDLE_MS = 30 * 24 * 60 * 60 * 1000
const RENEW_MS = 24 * 60 * 60 * 1000
const hash = token => createHash('sha256').update(token).digest('hex')

// Stores only hashes of Reader pairing capabilities, never OAuth credentials.
export async function createPairingStore(vault, now = Date.now) {
  let state = await vault.load()
  state.pairings = (state.pairings || []).filter(p => /^[a-f0-9]{64}$/.test(p.hash) && p.origin === 'https://beichen126.github.io' && Number.isFinite(p.expiresAt) && p.expiresAt > now())
  let queue = Promise.resolve()
  const serial = task => { const result = queue.catch(() => {}).then(task); queue = result; return result }
  async function save(pairings) {
    const next = { ...state, pairings }
    await vault.save(next)
    state = next
  }
  return {
    issue(origin) { return serial(async () => {
      if (origin !== 'https://beichen126.github.io') throw new LocalError('origin_denied', 403)
      const current = state.pairings.filter(p => p.expiresAt > now())
      if (current.length >= 16) throw new LocalError('pairing_device_limit', 409)
      const token = randomBytes(32).toString('base64url')
      await save([...current, { hash: hash(token), origin, expiresAt: now() + IDLE_MS, renewedAt: now() }])
      return token
    }) },
    validate(token, origin) { return serial(async () => {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false
      const digest = hash(token)
      const entry = state.pairings.find(p => p.hash === digest && p.origin === origin && p.expiresAt > now())
      if (!entry) return false
      if (now() - entry.renewedAt >= RENEW_MS) await save(state.pairings.map(p => p === entry ? { ...p, expiresAt: now() + IDLE_MS, renewedAt: now() } : p))
      return true
    }) },
    revoke(token) { return serial(async () => {
      if (typeof token === 'string') await save(state.pairings.filter(p => p.hash !== hash(token)))
    }) },
  }
}

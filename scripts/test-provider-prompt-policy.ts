import { DEFAULT_PROVIDER_CAPABILITIES, ProviderPromptPolicyError, resolveSystemMessagePolicy } from '../src/api/provider-capabilities.ts'

let pass = 0
let fail = 0
function assert(condition: boolean, message: string): void {
  if (condition) { pass++; console.log('  ok: ' + message) }
  else { fail++; console.log('  FAIL: ' + message) }
}

assert(resolveSystemMessagePolicy('auto', { supportsInterleavedSystemMessages: true }) === 'interleaved', 'auto uses explicit interleaved capability')
assert(resolveSystemMessagePolicy('auto', { supportsInterleavedSystemMessages: false }) === 'flattened', 'auto falls back to flattened without capability')
assert(resolveSystemMessagePolicy('auto') === 'flattened', 'missing capability uses safe flattened default')
assert(resolveSystemMessagePolicy('flattened', { supportsInterleavedSystemMessages: true }) === 'flattened', 'explicit flattened overrides capability')
assert(resolveSystemMessagePolicy('interleaved', { supportsInterleavedSystemMessages: true }) === 'interleaved', 'explicit interleaved is accepted when supported')
let rejected = false
try { resolveSystemMessagePolicy('interleaved', DEFAULT_PROVIDER_CAPABILITIES) } catch (error) { rejected = error instanceof ProviderPromptPolicyError }
assert(rejected, 'explicit unsupported interleaved policy is rejected, not silently downgraded')

console.log('RESULT pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)

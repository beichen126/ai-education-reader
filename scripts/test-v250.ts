import assert from 'node:assert/strict'
import { deriveDataSafetyStatus } from '../src/storage/data-safety.ts'
import { inspectApiSetup } from '../src/api/api-setup.ts'
import { testConnection } from '../src/api/deepseek.ts'
import type { StorageDiagnostics } from '../src/storage/diagnostics.ts'

const diagnostics = (overrides: Partial<StorageDiagnostics> = {}): StorageDiagnostics => ({
  attachmentCount: 0,
  attachmentBytes: 0,
  documentCount: 0,
  documentBytes: 0,
  totalBytes: 0,
  opfsSupported: true,
  storagePersistent: false,
  opfsDocumentCount: 0,
  opfsDocumentBytes: 0,
  opfsAttachmentCount: 0,
  opfsAttachmentBytes: 0,
  idbBinaryCount: 0,
  idbBinaryBytes: 0,
  legacyBinaryCount: 0,
  studyCardCount: 0,
  studyCardTextBytes: 0,
  ...overrides,
})

const now = Date.UTC(2026, 8, 19)
assert.deepEqual(
  deriveDataSafetyStatus(diagnostics({ originUsageBytes: 75, originQuotaBytes: 100 }), undefined, now),
  { quotaRatio: 0.75, quotaLevel: 'warning', backupState: 'never', protectedFromEviction: false },
)
assert.equal(deriveDataSafetyStatus(
  diagnostics({ originUsageBytes: 91, originQuotaBytes: 100, storagePersistent: true }),
  { completedAt: now - 15 * 86_400_000, fileName: 'backup.zip' },
  now,
).quotaLevel, 'critical')
assert.equal(deriveDataSafetyStatus(
  diagnostics(),
  { completedAt: now - 15 * 86_400_000, fileName: 'backup.zip' },
  now,
).backupState, 'stale')
assert.equal(deriveDataSafetyStatus(
  diagnostics(),
  { completedAt: now - 14 * 86_400_000, fileName: 'backup.zip' },
  now,
).backupState, 'fresh')

assert.deepEqual(inspectApiSetup({
  baseUrl: 'https://api.deepseek.com', apiKey: ' sk-test ', model: 'deepseek-chat', visionCapability: 'auto',
}), {
  endpointValid: true,
  keyPresent: true,
  modelPresent: true,
  visionConfigured: true,
  readyForConnectionTest: true,
})
assert.equal(inspectApiSetup({
  baseUrl: 'javascript:alert(1)', apiKey: '', model: '', visionCapability: 'text-only',
}).readyForConnectionTest, false)

const originalFetch = globalThis.fetch
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  const matchingModel = await testConnection({ apiKey: 'sk-test', baseUrl: 'https://api.example.test', model: 'deepseek-chat' })
  assert.equal(matchingModel.ok, true)
  assert.equal(matchingModel.modelAvailable, true)
  const missingModel = await testConnection({ apiKey: 'sk-test', baseUrl: 'https://api.example.test', model: 'missing-model' })
  assert.equal(missingModel.ok, true)
  assert.equal(missingModel.modelAvailable, false)
} finally {
  globalThis.fetch = originalFetch
}

console.log('PASS  v2.5.0 data-safety thresholds, API setup inspection, and model-list verification')

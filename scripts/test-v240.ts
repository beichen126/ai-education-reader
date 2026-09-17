import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'
import { BACKUP_ARCHIVE_ENTRY, buildBackupArchive, parseBackupArchive } from '../src/export/backup-archive'
import { normalizeUiLanguage } from '../src/engine/locale'
import type { BackupV1 } from '../src/export/backup-types'

const sample: BackupV1 = {
  format: 'ai-education-reader-backup',
  version: 1,
  exportedAt: 1,
  settings: { apiBaseUrl: 'https://example.invalid', model: 'model', customSystemPrompt: '', customSystemPromptEnabled: false },
  conversations: [], annotations: [], attachments: [],
}

const blob = buildBackupArchive({ ...sample, settings: { ...sample.settings, apiKey: 'must-not-leak' } } as any)
const bytes = new Uint8Array(await blob.arrayBuffer())
assert.equal(bytes[0], 0x50)
assert.equal(bytes[1], 0x4b)
const files = unzipSync(bytes)
assert.deepEqual(Object.keys(files), [BACKUP_ARCHIVE_ENTRY])
const packedText = strFromU8(files[BACKUP_ARCHIVE_ENTRY])
assert.equal(packedText.includes('must-not-leak'), false, 'ZIP must not contain API key material')
assert.equal(Object.hasOwn(JSON.parse(packedText).settings, 'apiKey'), false)
assert.equal(parseBackupArchive(bytes).format, sample.format)
assert.throws(() => parseBackupArchive(new Uint8Array([0x50, 0x4b, 3, 4])), /ZIP/)

assert.equal(normalizeUiLanguage('en'), 'en')
assert.equal(normalizeUiLanguage('zh-CN'), 'zh-CN')
assert.equal(normalizeUiLanguage('foreign'), 'zh-CN')

const html = readFileSync('index.html', 'utf8')
assert.match(html, /aer-ui-language/)
assert.match(html, /document\.documentElement\.lang/)
const settings = readFileSync('src/cockpit/SettingsDialog.tsx', 'utf8')
assert.match(settings, /settings-language/)
assert.match(settings, /exportBackupZip/)
assert.match(settings, /\.zip,\.json/)
const conversation = readFileSync('src/cockpit/Conversation.tsx', 'utf8')
assert.match(conversation, /StableAssistantContent/)
assert.doesNotMatch(conversation, /isStreaming \? \(\s*<div className=\{css\.assistantBody\}>\{m\.content\}/)
const releaseGate = readFileSync('scripts/test-release.mjs', 'utf8')
assert.match(releaseGate, /['"]e2e-v240['"]/, 'v2.4.0 browser coverage must stay in the release gate')

console.log('v2.4.x ZIP, language, and streaming-render regressions: PASS')

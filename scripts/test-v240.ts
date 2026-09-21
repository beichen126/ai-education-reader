import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'
import { BACKUP_ARCHIVE_ENTRY, buildBackupArchive, parseBackupArchive } from '../src/export/backup-archive'
import {
  applyUiLanguage, localizedArtifactSourceLabel, localizedArtifactTitle, localizedBranchTitle,
  localizedConversationTitle, localizedErrorText, localizedPdfName, localizedStudyCardTitle,
  normalizeUiLanguage,
} from '../src/engine/locale'
import { localizePromptDefinition, promptDisplayName } from '../src/prompts/prompt-display'
import { BUILTIN_PROMPT_IDS, getBuiltinPrompt } from '../src/prompts/prompt-registry'
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

applyUiLanguage('en')
assert.equal(localizedConversationTitle('新会话'), 'New chat')
assert.equal(localizedConversationTitle('图片对话'), 'Image chat')
assert.equal(localizedConversationTitle('用户命名的中文'), '用户命名的中文', 'user titles must remain untouched')
assert.equal(localizedBranchTitle('分支 12'), 'Branch 12')
assert.equal(localizedBranchTitle('我的分支'), '我的分支', 'custom branch titles must remain untouched')
assert.equal(localizedArtifactTitle('笔记', 'note'), 'Note')
assert.equal(localizedArtifactSourceLabel('会话'), 'Chat')
assert.equal(localizedStudyCardTitle('新会话-3', 'auto', 3), 'New chat-3')
assert.equal(localizedStudyCardTitle('我的卡片-3', 'manual', 3), '我的卡片-3')
assert.equal(localizedPdfName('未命名 PDF'), 'Untitled PDF')
assert.equal(localizedErrorText('未配置 API Key', 'API key is not configured.'), 'API key is not configured.')
assert.equal(localizedErrorText('Network unavailable', 'Fallback'), 'Network unavailable')
assert.equal(
  localizedErrorText('浏览器存储配额不足：恢复需要约 1.2 GB，当前站点剩余约 800 MB。请释放站点空间后重试。', 'Fallback'),
  'Not enough browser storage: this restore needs about 1.2 GB, but this site currently has about 800 MB available. Free some site storage and try again.',
)
assert.match(localizedErrorText('恢复写入过程中浏览器存储配额不足，已撤销本次暂存写入；原有数据没有被覆盖。', 'Fallback'), /existing data was not replaced/)
assert.match(localizedErrorText('该备份使用超过 4 GB 的 ZIP64 格式，当前 ZIP 解析器尚不支持', 'Fallback'), /ZIP64/)
const socratic = getBuiltinPrompt(BUILTIN_PROMPT_IDS.conversationSocratic)!
const englishSocratic = localizePromptDefinition(socratic)
assert.equal(promptDisplayName(socratic.name, socratic.id), 'Socratic learning')
assert.equal(englishSocratic.name, 'Socratic learning')
assert.doesNotMatch(englishSocratic.description, /[\u3400-\u9fff]/)
assert.doesNotMatch('systemPrompt' in englishSocratic ? englishSocratic.systemPrompt : '', /[\u3400-\u9fff]/)
applyUiLanguage('zh-CN')
assert.equal(localizedBranchTitle('分支 12'), '分支 12')

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

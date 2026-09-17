import { useState, useCallback, useEffect, useRef } from 'react'
import { useSettings, patchSettings, DEFAULT_SETTINGS, getSettingsSnapshot, useSettingsMutation } from '../engine/settings-store'
import { testConnection, type VisionCapability } from '../api/deepseek'
import { uiActions } from '../engine/ui-store'
import { useSessions } from '../engine/sessions-store'
import { exportBackupZip, exportConversationMd, exportMarkedOnlyMd, exportConversationBundle, importBackupFile, BackupError } from '../export'
import { type AppearanceMode } from '../theme/theme'
import type { PromptKind } from '../prompts/prompt-types'
import { setAppearance, setPdfNavigationMode, setUiLanguage, type PdfNavigationMode } from '../engine/settings-store'
import { tx } from '../engine/locale'
import { Modal, Button, Input } from '../dsh/primitives'
import { getStorageDiagnostics, formatBytes, type StorageDiagnostics } from '../storage/diagnostics'
import { clearAllLocalData } from '../storage/storage'
import { releaseAllPreviews } from '../engine/attachment-service'
import css from './cockpit.module.css'

export const APP_NAME = 'AI Education Reader'

/** The four prompt-management entries Settings owns. System protocols are deliberately NOT
 *  one of them: they stay reachable only by a user who opens the 系统协议 category. */
export const SETTINGS_PROMPT_ENTRIES: { controlId: string; label: string; category?: PromptKind }[] = [
  { controlId: 'settings-prompts-all', label: '全部提示词' },
  { controlId: 'settings-prompts-conversation-mode', label: '会话模式', category: 'conversation-mode' },
  { controlId: 'settings-prompts-artifact', label: '学习成果', category: 'artifact' },
  { controlId: 'settings-prompts-quick-follow-up', label: '快捷追问', category: 'quick-follow-up' },
]

function ShowHideLabel(props: { visible: boolean; onToggle: () => void; onClear: () => void }) {
  const { visible, onToggle, onClear } = props
  return (
    <span className={css.keyControls}>
      <button type="button" className={css.keyToggle} data-testid="key-toggle" onClick={onToggle}>{visible ? tx('隐藏', 'Hide') : tx('显示', 'Show')}</button>
      <button type="button" className={css.keyClear} data-testid="key-clear" onClick={onClear}>{tx('清除', 'Clear')}</button>
    </span>
  )
}

export function SettingsDialog() {
  const s = useSettings(x => x)
  const [base, setBase] = useState(s.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl)
  const [key, setKey] = useState(s.apiKey)
  const [showKey, setShowKey] = useState(false)
  const [model, setModel] = useState(s.model || DEFAULT_SETTINGS.model)
  const [visionCapability, setVisionCapability] = useState<VisionCapability>(s.visionCapability || 'auto')
  // PDF navigation is committed the moment the user chooses it. `pdfPending` only carries
  // the optimistic visual until the IndexedDB transaction resolves; the durable value is
  // always `s.pdfNavigationMode` from the committed store.
  const [pdfPending, setPdfPending] = useState<PdfNavigationMode | null>(null)
  const [pdfFailure, setPdfFailure] = useState<{ mode: PdfNavigationMode; message: string } | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])
  const mutation = useSettingsMutation()
  const pdfNavigationMode = pdfPending ?? s.pdfNavigationMode
  const pdfBusy = pdfPending !== null && pdfPending !== s.pdfNavigationMode
  const applyPdfNavigation = (next: PdfNavigationMode) => {
    setPdfFailure(null)
    setPdfPending(next)
    return setPdfNavigationMode(next).then(
      () => { if (mountedRef.current) setPdfPending(null) },
      (error: unknown) => {
        // Roll the visible selection back to the committed value and offer a retry.
        const message = error instanceof Error && error.message ? error.message : tx('保存失败', 'Save failed')
        if (mountedRef.current) { setPdfPending(null); setPdfFailure({ mode: next, message }) }
      },
    )
  }
  const choosePdfNavigation = (next: PdfNavigationMode) => {
    if (next === pdfNavigationMode && !pdfFailure) return
    void applyPdfNavigation(next)
  }
  const [test, setTest] = useState<string | null>(null)
  const [testOk, setTestOk] = useState<boolean | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const currentConv = useSessions(x => x.byId[x.current || ''])

  const [storage, setStorage] = useState<StorageDiagnostics | null>(null)
  const [storageState, setStorageState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const loadStorage = useCallback(async () => {
    setStorageState('loading')
    try { const d = await getStorageDiagnostics(); setStorage(d); setStorageState('ready') }
    catch (e) { console.error('存储诊断失败', e); setStorageState('error') }
  }, [])
  useEffect(() => { void loadStorage() }, [loadStorage])

  // The API form saves ONLY API-scoped fields. It must never write the PDF navigation mode
  // (committed on click) or a stale appearance snapshot.
  const onSave = async () => {
    setSaved(false)
    try {
      await patchSettings({ apiBaseUrl: base.trim(), apiKey: key.trim(), model: model.trim(), visionCapability })
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    } catch { /* mutation state carries the visible failure */ }
  }
  const onTest = async () => {
    setTest(tx('正在测试…', 'Testing…')); setTestOk(null)
    const r = await testConnection({ apiKey: key.trim(), baseUrl: base.trim() })
    setTest(r.label); setTestOk(r.ok)
  }
  const onClearKey = () => { setKey(''); setTest(null); setTestOk(null) }

  const onClearData = async () => {
    if (!window.confirm(tx('清除全部本地数据（不可恢复）？\n\n将删除：会话、图片附件、PDF 页面、标注、草稿、本地文档（含原始 PDF）、API 设置与 API Key。\n\n取消 / 继续清除', 'Clear all local data? This cannot be undone.\n\nThis removes chats, image attachments, PDF pages, marks, drafts, local documents, API settings, and the API key.\n\nCancel / Continue'))) return
    setClearing(true)
    try {
      releaseAllPreviews()
      const r = await clearAllLocalData()
      if (r && r.partialCleanup) { setMsg(tx('本地记录已清除，但部分文件数据清理失败（' + (r.failedPaths?.length ?? 0) + ' 个文件），请再次点击清除重试。', 'Local records were cleared, but ' + (r.failedPaths?.length ?? 0) + ' file(s) could not be removed. Try clearing again.')); setClearing(false); return }
      window.location.reload()
    } catch (e) { setClearing(false); setMsg(tx('清除本地数据失败，请重试。', 'Unable to clear local data. Try again.')) }
  }

  const setBusyMsg = (fn: () => Promise<void>, ok: string) => { setBusy(true); setMsg(null); void fn().then(() => setMsg(ok)).catch((e: any) => setMsg(e instanceof BackupError ? e.message : tx('操作失败', 'Operation failed'))).finally(() => setBusy(false)) }
  const onExportBackup = () => setBusyMsg(() => exportBackupZip(), tx('已导出完整备份 ZIP', 'Complete ZIP backup exported'))
  const onExportMd = () => currentConv ? setBusyMsg(() => exportConversationMd(currentConv.id), tx('已导出当前会话 Markdown', 'Current chat exported as Markdown')) : setMsg(tx('当前没有会话可导出', 'There is no chat to export'))
  const onExportMarked = () => currentConv ? setBusyMsg(() => exportMarkedOnlyMd(currentConv.id), tx('已导出仅标记内容', 'Marked content exported')) : setMsg(tx('当前没有会话可导出', 'There is no chat to export'))
  const onExportBundle = () => currentConv ? setBusyMsg(() => exportConversationBundle(currentConv.id), tx('已导出 Markdown + 图片 ZIP', 'Markdown + images ZIP exported')) : setMsg(tx('当前没有会话可导出', 'There is no chat to export'))
  const onImportFile = (file: File | undefined) => {
    if (!file) return
    if (!window.confirm(tx('导入将替换当前所有本地数据。\n建议先导出当前备份。\n\n取消 / 继续导入', 'Importing will replace all current local data.\nExport a backup first.\n\nCancel / Continue'))) return
    setBusy(true); setMsg(null)
    void importBackupFile(file).then(() => {
      const restored = getSettingsSnapshot()
      setBase(restored.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl)
      setKey('')
      setModel(restored.model || DEFAULT_SETTINGS.model)
      setVisionCapability(restored.visionCapability)
      setMsg(tx('导入完成', 'Import complete'))
    }).catch((e: any) => setMsg(e instanceof BackupError ? e.message : tx('导入失败', 'Import failed'))).finally(() => setBusy(false))
  }

  return (
    <Modal open onClose={uiActions.closeSettings} title={tx('设置', 'Settings')} closeLabel={tx('关闭', 'Close')} className={css.settingsDialog} contentClassName={css.settingsScroll}>
      <div className={css.settingsHint}>{APP_NAME} · v{__APP_VERSION__}</div>
      <div className={css.byokBlock} data-testid="settings-byok">
        <div className={css.byokTitle}>{tx('BYOK（自备 API Key）', 'BYOK (bring your own API key)')}</div>
        <div className={css.settingsHint}>{tx('本项目采用 BYOK：应用本身不提供模型额度。默认可使用 DeepSeek API，也可以填写兼容的 API Base URL 和模型。API Key 仅保存在当前浏览器本地。', 'This app uses BYOK and does not provide model credits. Use DeepSeek by default or enter a compatible API base URL and model. Your API key stays in this browser only.')}</div>
        <a className={css.byokLink} href="https://platform.deepseek.com/" target="_blank" rel="noopener noreferrer" data-testid="settings-deepseek-link">{tx('打开 DeepSeek 开放平台获取 API Key', 'Get an API key from DeepSeek')}</a>
        <a className={css.byokLinkSub} href="https://api-docs.deepseek.com/zh-cn/" target="_blank" rel="noopener noreferrer">{tx('DeepSeek API 文档', 'DeepSeek API documentation')}</a>
      </div>
      <div className={css.field}><label>API Base URL</label><Input className={css.fieldInput} value={base} onChange={e => setBase(e.target.value)} placeholder={DEFAULT_SETTINGS.apiBaseUrl} /></div>
      <div className={css.field}>
        <label>API Key</label>
        <span className={css.keyRow}>
          <Input className={css.fieldInput} type={showKey ? 'text' : 'password'} value={key} onChange={e => setKey(e.target.value)} placeholder="sk-..." />
          <ShowHideLabel visible={showKey} onToggle={() => setShowKey(v => !v)} onClear={onClearKey} />
        </span>
      </div>
      <div className={css.field}><label>Model</label><Input className={css.fieldInput} value={model} onChange={e => setModel(e.target.value)} placeholder="deepseek-v4-flash-vision-exp" /></div>
      <div className={css.field}>
        <label>{tx('模型图片能力（Vision）', 'Model image capability (Vision)')}</label>
        <div className={css.appearanceRow} data-testid="settings-vision">
          <button type="button" className={css.appearanceOpt} data-testid="vision-auto" aria-pressed={visionCapability === 'auto'} onClick={() => setVisionCapability('auto')}>{tx('自动', 'Auto')}</button>
          <button type="button" className={css.appearanceOpt} data-testid="vision-supports" aria-pressed={visionCapability === 'supports-image'} onClick={() => setVisionCapability('supports-image')}>{tx('支持图片', 'Supports images')}</button>
          <button type="button" className={css.appearanceOpt} data-testid="vision-textonly" aria-pressed={visionCapability === 'text-only'} onClick={() => setVisionCapability('text-only')}>{tx('仅文本', 'Text only')}</button>
        </div>
        <div className={css.settingsHint}>{tx('「自动」按模型名推断；「支持图片」对名称不含 vision 但支持图片的模型开启图片；「仅文本」禁止发送图片，避免误发。该设置会随备份一起导出。', 'Auto infers support from the model name. Supports images enables vision for compatible models whose names do not contain “vision”. Text only prevents images from being sent. This setting is included in backups.')}</div>
      </div>
      <div className={css.settingsHint}>{tx('API Key 保存在当前浏览器本地（IndexedDB），不进源码、不走 Git。发送消息时，所选文本与图片会直接发送到你配置的 API 服务（默认 https://api.deepseek.com）。本项目自身没有中转服务器。', 'Your API key is stored locally in this browser (IndexedDB), never in source control. When you send a message, selected text and images go directly to your configured API service. This project has no relay server.')}</div>
      <div className={css.settingsActions}>
        <Button variant="outline" onClick={onTest}>{test ?? tx('测试连接', 'Test connection')}</Button>
        <Button variant="primary" onClick={onSave}>{saved ? tx('已保存', 'Saved') : tx('保存 API 设置', 'Save API settings')}</Button>
      </div>
      {mutation.status === 'error' && mutation.error && (
        <div className={css.testResult} data-ok="false" data-testid="settings-mutation-error">{tx('设置保存失败：', 'Failed to save settings: ')}{mutation.error}</div>
      )}
      {test && <div className={css.testResult} data-ok={testOk === undefined ? undefined : String(testOk)}>{test}</div>}
      <div className={css.settingsHint}>{tx('“测试连接”仅调用 GET /models 验证服务可达与 Key 有效，不会发送聊天内容或文档。', 'Test connection only calls GET /models to verify connectivity and the key. It does not send chats or documents.')}</div>
      <div className={css.exportSection}>
        <div className={css.exportTitle}>{tx('数据与导出', 'Data and migration')}</div>
        <div className={css.exportRow}>
          <Button variant="outline" disabled={busy} onClick={onExportBackup}>{tx('导出完整备份 ZIP', 'Export complete ZIP backup')}</Button>
          <Button variant="outline" disabled={busy || !currentConv} onClick={onExportMd}>{tx('导出当前会话 Markdown', 'Export current chat as Markdown')}</Button>
          <Button variant="outline" disabled={busy || !currentConv} onClick={onExportMarked}>{tx('仅导出标记内容', 'Export marked content only')}</Button>
          <Button variant="outline" disabled={busy || !currentConv} onClick={onExportBundle}>{tx('导出 Markdown + 图片 ZIP', 'Export Markdown + images ZIP')}</Button>
        </div>
        <div className={css.exportRow}>
          <label className={css.importBtn}><span>{tx('导入备份 ZIP / JSON', 'Import ZIP / JSON backup')}</span><input type="file" accept=".zip,.json,application/zip,application/json" hidden disabled={busy} onChange={e => { onImportFile(e.target.files?.[0]); e.target.value = '' }} /></label>
        </div>
        <div className={css.settingsHint}>{tx('完整备份包含会话、附件、PDF、笔记、分支、提示词、学习卡片与界面设置，但不含 API Key。可用于迁移到其他浏览器；仍兼容旧版 JSON 备份。', 'A complete backup includes chats, attachments, PDFs, notes, branches, prompts, study cards, and UI settings, but never your API key. Use it to migrate to another browser. Legacy JSON backups remain supported.')}</div>
        {msg && <div className={css.testResult} data-ok="false">{msg}</div>}
      </div>
      <div className={css.exportSection}>
        <div className={css.exportTitle}>{tx('外观', 'Appearance')}</div>
        <div className={css.appearanceRow} data-testid="settings-appearance">
          <button type="button" className={css.appearanceOpt} data-testid="appearance-system" aria-pressed={s.appearance === 'system'} data-selected={s.appearance === 'system'} onClick={() => void setAppearance('system')}>{tx('跟随系统', 'System')}</button>
          <button type="button" className={css.appearanceOpt} data-testid="appearance-light" aria-pressed={s.appearance === 'light'} data-selected={s.appearance === 'light'} onClick={() => void setAppearance('light')}>{tx('浅色', 'Light')}</button>
          <button type="button" className={css.appearanceOpt} data-testid="appearance-dark" aria-pressed={s.appearance === 'dark'} data-selected={s.appearance === 'dark'} onClick={() => void setAppearance('dark')}>{tx('深色', 'Dark')}</button>
        </div>
        <div className={css.settingsHint}>{tx('选择后自动保存。', 'Saved automatically.')}</div>
      </div>
      <div className={css.exportSection} data-testid="settings-language">
        <div className={css.exportTitle} id="settings-language-label">{tx('界面语言', 'Interface language')}</div>
        <div className={css.appearanceRow} role="radiogroup" aria-labelledby="settings-language-label">
          <button type="button" role="radio" className={css.appearanceOpt} data-testid="language-zh-cn" aria-checked={s.uiLanguage === 'zh-CN'} data-selected={s.uiLanguage === 'zh-CN'} onClick={() => void setUiLanguage('zh-CN')}>简体中文</button>
          <button type="button" role="radio" className={css.appearanceOpt} data-testid="language-en" aria-checked={s.uiLanguage === 'en'} data-selected={s.uiLanguage === 'en'} onClick={() => void setUiLanguage('en')}>English</button>
        </div>
        <div className={css.settingsHint}>{tx('选择 English 后页面会同步设置 lang="en"，便于浏览器翻译工具正确识别。', 'Selecting English also sets the page language to lang="en" for browser translation tools.')}</div>
      </div>
      <div className={css.exportSection} data-testid="settings-pdf-navigation">
        <div className={css.exportTitle} id="settings-pdf-navigation-label">{tx('PDF 阅读方式', 'PDF reading mode')}</div>
        <div className={css.appearanceRow} role="radiogroup" aria-labelledby="settings-pdf-navigation-label">
          <button type="button" role="radio" className={css.appearanceOpt} data-testid="pdf-navigation-paged" aria-checked={pdfNavigationMode === 'paged'} aria-busy={pdfBusy || undefined} data-selected={pdfNavigationMode === 'paged'} onClick={() => choosePdfNavigation('paged')}>{tx('单页翻页', 'Single page')}</button>
          <button type="button" role="radio" className={css.appearanceOpt} data-testid="pdf-navigation-continuous" aria-checked={pdfNavigationMode === 'continuous'} aria-busy={pdfBusy || undefined} data-selected={pdfNavigationMode === 'continuous'} onClick={() => choosePdfNavigation('continuous')}>{tx('连续上下滚动', 'Continuous scroll')}</button>
        </div>
        <div className={css.settingsHint}>{tx('选择后自动保存。连续滚动只渲染屏幕附近的页面，可随时切换并保持当前页；对消息中的静态图片没有影响。', 'Saved automatically. Continuous mode renders only nearby pages, can be switched at any time, and keeps the current page. Static message images are unaffected.')}</div>
        {pdfFailure && (
          <div className={css.testResult} data-ok="false" data-testid="settings-pdf-navigation-error">
            {tx('阅读方式保存失败：', 'Failed to save reading mode: ')}{pdfFailure.message}
            <button type="button" className={css.keyToggle} data-testid="settings-pdf-navigation-retry" onClick={() => void applyPdfNavigation(pdfFailure.mode)}>{tx('重试', 'Retry')}</button>
          </div>
        )}
      </div>
      <div className={css.exportSection} data-testid="settings-prompts">
        <div className={css.exportTitle}>{tx('提示词管理', 'Prompt management')}</div>
        <div className={css.exportRow}>
          {SETTINGS_PROMPT_ENTRIES.map(entry => (
            <Button
              key={entry.controlId}
              variant="outline"
              data-testid={entry.controlId}
              onClick={() => uiActions.openPromptManager(entry.category, { kind: 'settings', controlId: entry.controlId })}
            >
              {tx(entry.label, entry.controlId === 'settings-prompts-all' ? 'All prompts' : entry.category === 'conversation-mode' ? 'Chat modes' : entry.category === 'artifact' ? 'Study outputs' : 'Quick follow-ups')}
            </Button>
          ))}
        </div>
        <div className={css.settingsHint}>{tx('打开提示词管理后可按分类查看、编辑、复制或停用提示词；系统协议只在提示词管理的“系统协议”分类里查看。', 'Open prompt management to view, edit, duplicate, or disable prompts by category. System protocols appear only in its System protocols category.')}</div>
      </div>
      <div className={css.storageSection}>
        <div className={css.exportTitle}>{tx('本地存储', 'Local storage')}</div>
        {storageState === 'loading' && <div className={css.storageHint}>{tx('正在统计……', 'Calculating…')}</div>}
        {storageState === 'error' && <div className={css.storageHint}>{tx('本地存储信息暂时无法读取', 'Local storage information is unavailable')}</div>}
        {storageState === 'ready' && storage && (
          <div className={css.storageRows}>
            <div className={css.storageRow}><span className={css.storageLabel}>{tx('文件存储', 'File storage')}</span><span className={css.storageValue}>{storage.opfsSupported ? tx('OPFS（推荐）', 'OPFS (recommended)') : tx('IndexedDB 兼容模式', 'IndexedDB compatibility mode')}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>{tx('持久化存储', 'Persistent storage')}</span><span className={css.storageValue}>{storage.storagePersistent === undefined ? tx('不支持', 'Unsupported') : (storage.storagePersistent ? tx('已授予', 'Granted') : tx('未授予', 'Not granted'))}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>{tx('本站总占用', 'Site usage')}</span><span className={css.storageValue}>{storage.originUsageBytes !== undefined ? formatBytes(storage.originUsageBytes) : tx('浏览器未提供', 'Unavailable')}</span></div>
            {storage.legacyBinaryCount > 0 && <div className={css.storageRow}><span className={css.storageLabel}>{tx('旧版 IndexedDB 二进制', 'Legacy IndexedDB binaries')}</span><span className={css.storageValue}>{tx(storage.legacyBinaryCount + ' 个等待迁移', storage.legacyBinaryCount + ' awaiting migration')}</span></div>}
            <div className={css.storageRow}><span className={css.storageLabel}>{tx('学习卡片', 'Study cards')}</span><span className={css.storageValue} data-testid="storage-study-card-count">{tx(storage.studyCardCount + ' 张', String(storage.studyCardCount))}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>{tx('学习卡片文本占用', 'Study card text')}</span><span className={css.storageValue} data-testid="storage-study-card-bytes">{formatBytes(storage.studyCardTextBytes)}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>{tx('图片附件', 'Image attachments')}</span><span className={css.storageValue}>{tx(storage.attachmentCount + ' 张', String(storage.attachmentCount))}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>{tx('图片附件占用', 'Image attachment usage')}</span><span className={css.storageValue}>{formatBytes(storage.attachmentBytes)}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>{tx('本地文档', 'Local documents')}</span><span className={css.storageValue}>{tx(storage.documentCount + ' 份', String(storage.documentCount))}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>{tx('本地文档占用', 'Local document usage')}</span><span className={css.storageValue}>{formatBytes(storage.documentBytes)}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>{tx('本地数据合计（附件 + 文档）', 'Local data total (attachments + documents)')}</span><span className={css.storageValue}>{formatBytes(storage.totalBytes)}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>{tx('浏览器存储配额', 'Browser storage quota')}</span><span className={css.storageValue}>{storage.originQuotaBytes !== undefined ? formatBytes(storage.originQuotaBytes) : tx('浏览器未提供', 'Unavailable')}</span></div>
          </div>
        )}
        <div className={css.storageHint}>{tx('仅用于查看本地空间占用，不清理、不删除任何数据。', 'This is informational only and does not delete any data.')}</div>
        <div className={css.settingsActions}>
          <Button variant="outline" disabled={storageState === 'loading'} onClick={() => void loadStorage()}>{tx('刷新', 'Refresh')}</Button>
        </div>
      </div>
      <div className={css.storageSection}>
        <div className={css.exportTitle}>{tx('隐私', 'Privacy')}</div>
        <div className={css.storageHint}>{tx('数据保存在浏览器本地；PDF 在浏览器内处理；仅在发送消息时，所选内容会发送到你配置的 API 服务；本项目无自有后端。详见仓库 PRIVACY.md。', 'Data stays in this browser and PDFs are processed locally. Selected content is sent only when you message your configured API service. This project has no backend. See PRIVACY.md.')}</div>
        <div className={css.settingsActions}>
          <Button variant="outline" disabled={clearing} data-testid="settings-clear-data" onClick={() => void onClearData()}>{clearing ? tx('正在清除…', 'Clearing…') : tx('清除本地数据', 'Clear local data')}</Button>
        </div>
      </div>
    </Modal>
  )
}

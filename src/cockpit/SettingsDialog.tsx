import { useState, useCallback, useEffect, useRef } from 'react'
import { useSettings, patchSettings, DEFAULT_SETTINGS, useSettingsMutation } from '../engine/settings-store'
import { testConnection, type VisionCapability } from '../api/deepseek'
import { uiActions } from '../engine/ui-store'
import { useSessions } from '../engine/sessions-store'
import { exportBackupJson, exportConversationMd, exportMarkedOnlyMd, exportConversationBundle, importBackupText, BackupError } from '../export'
import { type AppearanceMode } from '../theme/theme'
import { setAppearance, setPdfNavigationMode, type PdfNavigationMode } from '../engine/settings-store'
import { Modal, Button, Input } from '../dsh/primitives'
import { getStorageDiagnostics, formatBytes, type StorageDiagnostics } from '../storage/diagnostics'
import { clearAllLocalData } from '../storage/storage'
import { releaseAllPreviews } from '../engine/attachment-service'
import css from './cockpit.module.css'

export const APP_NAME = 'AI Education Reader'

function ShowHideLabel(props: { visible: boolean; onToggle: () => void; onClear: () => void }) {
  const { visible, onToggle, onClear } = props
  return (
    <span className={css.keyControls}>
      <button type="button" className={css.keyToggle} data-testid="key-toggle" onClick={onToggle}>{visible ? '隐藏' : '显示'}</button>
      <button type="button" className={css.keyClear} data-testid="key-clear" onClick={onClear}>清除</button>
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
        const message = error instanceof Error && error.message ? error.message : '保存失败'
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
    setTest('正在测试…'); setTestOk(null)
    const r = await testConnection({ apiKey: key.trim(), baseUrl: base.trim() })
    setTest(r.label); setTestOk(r.ok)
  }
  const onClearKey = () => { setKey(''); setTest(null); setTestOk(null) }

  const onClearData = async () => {
    if (!window.confirm('清除全部本地数据（不可恢复）？\n\n将删除：会话、图片附件、PDF 页面、标注、草稿、本地文档（含原始 PDF）、API 设置与 API Key。\n\n取消 / 继续清除')) return
    setClearing(true)
    try {
      releaseAllPreviews()
      const r = await clearAllLocalData()
      if (r && r.partialCleanup) { setMsg('本地记录已清除，但部分文件数据清理失败（' + (r.failedPaths?.length ?? 0) + ' 个文件），请再次点击清除重试。'); setClearing(false); return }
      window.location.reload()
    } catch (e) { setClearing(false); setMsg('清除本地数据失败，请重试。') }
  }

  const setBusyMsg = (fn: () => Promise<void>, ok: string) => { setBusy(true); setMsg(null); void fn().then(() => setMsg(ok)).catch((e: any) => setMsg(e instanceof BackupError ? e.message : '操作失败')).finally(() => setBusy(false)) }
  const onExportBackup = () => setBusyMsg(() => exportBackupJson(), '已导出完整备份 JSON')
  const onExportMd = () => currentConv ? setBusyMsg(() => exportConversationMd(currentConv.id), '已导出当前会话 Markdown') : setMsg('当前没有会话可导出')
  const onExportMarked = () => currentConv ? setBusyMsg(() => exportMarkedOnlyMd(currentConv.id), '已导出仅标记内容') : setMsg('当前没有会话可导出')
  const onExportBundle = () => currentConv ? setBusyMsg(() => exportConversationBundle(currentConv.id), '已导出 Markdown + 图片 ZIP') : setMsg('当前没有会话可导出')
  const onImportFile = (file: File | undefined) => {
    if (!file) return
    if (!window.confirm('导入将替换当前本地会话、图片和标注。\n建议先导出当前备份。\n\n取消 / 继续导入')) return
    setBusy(true); setMsg(null)
    void file.text().then((text) => importBackupText(text)).then(() => setMsg('导入完成')).catch((e: any) => setMsg(e instanceof BackupError ? e.message : '导入失败')).finally(() => setBusy(false))
  }

  return (
    <Modal open onClose={uiActions.closeSettings} title="设置" closeLabel="关闭" className={css.settingsDialog} contentClassName={css.settingsScroll}>
      <div className={css.settingsHint}>{APP_NAME} · v{__APP_VERSION__}</div>
      <div className={css.byokBlock} data-testid="settings-byok">
        <div className={css.byokTitle}>BYOK（自备 API Key）</div>
        <div className={css.settingsHint}>本项目采用 BYOK：应用本身不提供模型额度。默认可使用 DeepSeek API，也可以填写兼容的 API Base URL 和模型。API Key 仅保存在当前浏览器本地。</div>
        <a className={css.byokLink} href="https://platform.deepseek.com/" target="_blank" rel="noopener noreferrer" data-testid="settings-deepseek-link">打开 DeepSeek 开放平台获取 API Key</a>
        <a className={css.byokLinkSub} href="https://api-docs.deepseek.com/zh-cn/" target="_blank" rel="noopener noreferrer">DeepSeek API 文档</a>
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
        <label>模型图片能力（Vision）</label>
        <div className={css.appearanceRow} data-testid="settings-vision">
          <button type="button" className={css.appearanceOpt} data-testid="vision-auto" aria-pressed={visionCapability === 'auto'} onClick={() => setVisionCapability('auto')}>自动</button>
          <button type="button" className={css.appearanceOpt} data-testid="vision-supports" aria-pressed={visionCapability === 'supports-image'} onClick={() => setVisionCapability('supports-image')}>支持图片</button>
          <button type="button" className={css.appearanceOpt} data-testid="vision-textonly" aria-pressed={visionCapability === 'text-only'} onClick={() => setVisionCapability('text-only')}>仅文本</button>
        </div>
        <div className={css.settingsHint}>「自动」按模型名推断；「支持图片」对名称不含 vision 但支持图片的模型开启图片；「仅文本」禁止发送图片，避免误发。该设置会随备份一起导出。</div>
      </div>
      <div className={css.settingsHint}>API Key 保存在当前浏览器本地（IndexedDB），不进源码、不走 Git。发送消息时，所选文本与图片会直接发送到你配置的 API 服务（默认 https://api.deepseek.com）。本项目自身没有中转服务器。</div>
      <div className={css.settingsActions}>
        <Button variant="outline" onClick={onTest}>{test ?? '测试连接'}</Button>
        <Button variant="primary" onClick={onSave}>{saved ? '已保存' : '保存 API 设置'}</Button>
      </div>
      {mutation.status === 'error' && mutation.error && (
        <div className={css.testResult} data-ok="false" data-testid="settings-mutation-error">设置保存失败：{mutation.error}</div>
      )}
      {test && <div className={css.testResult} data-ok={testOk === undefined ? undefined : String(testOk)}>{test}</div>}
      <div className={css.settingsHint}>“测试连接”仅调用 GET /models 验证服务可达与 Key 有效，不会发送聊天内容或文档。</div>
      <div className={css.exportSection}>
        <div className={css.exportTitle}>数据与导出</div>
        <div className={css.exportRow}>
          <Button variant="outline" disabled={busy} onClick={onExportBackup}>导出完整备份 JSON</Button>
          <Button variant="outline" disabled={busy || !currentConv} onClick={onExportMd}>导出当前会话 Markdown</Button>
          <Button variant="outline" disabled={busy || !currentConv} onClick={onExportMarked}>仅导出标记内容</Button>
          <Button variant="outline" disabled={busy || !currentConv} onClick={onExportBundle}>导出 Markdown + 图片 ZIP</Button>
        </div>
        <div className={css.exportRow}>
          <label className={css.importBtn}><span>导入备份 JSON</span><input type="file" accept=".json,application/json" hidden disabled={busy} onChange={e => { onImportFile(e.target.files?.[0]); e.target.value = '' }} /></label>
        </div>
        <div className={css.settingsHint}>完整备份不含 API Key。导入将替换当前本地会话、图片和标注。</div>
        {msg && <div className={css.testResult} data-ok="false">{msg}</div>}
      </div>
      <div className={css.exportSection}>
        <div className={css.exportTitle}>外观</div>
        <div className={css.appearanceRow} data-testid="settings-appearance">
          <button type="button" className={css.appearanceOpt} data-testid="appearance-system" aria-pressed={s.appearance === 'system'} data-selected={s.appearance === 'system'} onClick={() => void setAppearance('system')}>跟随系统</button>
          <button type="button" className={css.appearanceOpt} data-testid="appearance-light" aria-pressed={s.appearance === 'light'} data-selected={s.appearance === 'light'} onClick={() => void setAppearance('light')}>浅色</button>
          <button type="button" className={css.appearanceOpt} data-testid="appearance-dark" aria-pressed={s.appearance === 'dark'} data-selected={s.appearance === 'dark'} onClick={() => void setAppearance('dark')}>深色</button>
        </div>
        <div className={css.settingsHint}>选择后自动保存。</div>
      </div>
      <div className={css.exportSection} data-testid="settings-pdf-navigation">
        <div className={css.exportTitle} id="settings-pdf-navigation-label">PDF 阅读方式</div>
        <div className={css.appearanceRow} role="radiogroup" aria-labelledby="settings-pdf-navigation-label">
          <button type="button" role="radio" className={css.appearanceOpt} data-testid="pdf-navigation-paged" aria-checked={pdfNavigationMode === 'paged'} aria-busy={pdfBusy || undefined} data-selected={pdfNavigationMode === 'paged'} onClick={() => choosePdfNavigation('paged')}>单页翻页</button>
          <button type="button" role="radio" className={css.appearanceOpt} data-testid="pdf-navigation-continuous" aria-checked={pdfNavigationMode === 'continuous'} aria-busy={pdfBusy || undefined} data-selected={pdfNavigationMode === 'continuous'} onClick={() => choosePdfNavigation('continuous')}>连续上下滚动</button>
        </div>
        <div className={css.settingsHint}>选择后自动保存。连续滚动只渲染屏幕附近的页面，可随时切换并保持当前页；对消息中的静态图片没有影响。</div>
        {pdfFailure && (
          <div className={css.testResult} data-ok="false" data-testid="settings-pdf-navigation-error">
            阅读方式保存失败：{pdfFailure.message}
            <button type="button" className={css.keyToggle} data-testid="settings-pdf-navigation-retry" onClick={() => void applyPdfNavigation(pdfFailure.mode)}>重试</button>
          </div>
        )}
      </div>
      <div className={css.storageSection}>
        <div className={css.exportTitle}>本地存储</div>
        {storageState === 'loading' && <div className={css.storageHint}>正在统计……</div>}
        {storageState === 'error' && <div className={css.storageHint}>本地存储信息暂时无法读取</div>}
        {storageState === 'ready' && storage && (
          <div className={css.storageRows}>
            <div className={css.storageRow}><span className={css.storageLabel}>文件存储</span><span className={css.storageValue}>{storage.opfsSupported ? 'OPFS（推荐）' : 'IndexedDB 兼容模式'}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>持久化存储</span><span className={css.storageValue}>{storage.storagePersistent === undefined ? '不支持' : (storage.storagePersistent ? '已授予' : '未授予')}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>本站总占用</span><span className={css.storageValue}>{storage.originUsageBytes !== undefined ? formatBytes(storage.originUsageBytes) : '浏览器未提供'}</span></div>
            {storage.legacyBinaryCount > 0 && <div className={css.storageRow}><span className={css.storageLabel}>旧版 IndexedDB 二进制</span><span className={css.storageValue}>{storage.legacyBinaryCount} 个等待迁移</span></div>}
            <div className={css.storageRow}><span className={css.storageLabel}>图片附件</span><span className={css.storageValue}>{storage.attachmentCount} 张</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>图片附件占用</span><span className={css.storageValue}>{formatBytes(storage.attachmentBytes)}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>本地文档</span><span className={css.storageValue}>{storage.documentCount} 份</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>本地文档占用</span><span className={css.storageValue}>{formatBytes(storage.documentBytes)}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>本地数据合计（附件 + 文档）</span><span className={css.storageValue}>{formatBytes(storage.totalBytes)}</span></div>
            <div className={css.storageRow}><span className={css.storageLabel}>浏览器存储配额</span><span className={css.storageValue}>{storage.originQuotaBytes !== undefined ? formatBytes(storage.originQuotaBytes) : '浏览器未提供'}</span></div>
          </div>
        )}
        <div className={css.storageHint}>仅用于查看本地空间占用，不清理、不删除任何数据。</div>
        <div className={css.settingsActions}>
          <Button variant="outline" disabled={storageState === 'loading'} onClick={() => void loadStorage()}>刷新</Button>
        </div>
      </div>
      <div className={css.storageSection}>
        <div className={css.exportTitle}>隐私</div>
        <div className={css.storageHint}>数据保存在浏览器本地；PDF 在浏览器内处理；仅在发送消息时，所选内容会发送到你配置的 API 服务；本项目无自有后端。详见仓库 PRIVACY.md。</div>
        <div className={css.settingsActions}>
          <Button variant="outline" disabled={clearing} data-testid="settings-clear-data" onClick={() => void onClearData()}>{clearing ? '正在清除…' : '清除本地数据'}</Button>
        </div>
      </div>
    </Modal>
  )
}

import { useState, useCallback, useEffect } from 'react'
import { useSettings, saveSettings, DEFAULT_SETTINGS } from '../engine/settings-store'
import { testConnection } from '../api/deepseek'
import { uiActions } from '../engine/ui-store'
import { useSessions } from '../engine/sessions-store'
import { exportBackupJson, exportConversationMd, exportMarkedOnlyMd, importBackupText, BackupError } from '../export'
import { Modal, Button, Input } from '../dsh/primitives'
import { getStorageDiagnostics, formatBytes, type StorageDiagnostics } from '../storage/diagnostics'
import { clearAllLocalData } from '../storage/storage'
import { releaseAllPreviews } from '../engine/attachment-service'
import css from './cockpit.module.css'

export const APP_VERSION = '0.1.0-alpha.3'
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
  const [test, setTest] = useState<string | null>(null)
  const [testOk, setTestOk] = useState<boolean | null>(null)
  const [saved, setSaved] = useState(false)
  const [prompt, setPrompt] = useState(s.customSystemPrompt || '')
  const [promptOn, setPromptOn] = useState(!!s.customSystemPromptEnabled)
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

  const onSave = async () => { await saveSettings({ apiBaseUrl: base.trim(), apiKey: key.trim(), model: model.trim(), customSystemPrompt: prompt, customSystemPromptEnabled: promptOn }); setSaved(true); setTimeout(() => setSaved(false), 1500) }
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
  const onImportFile = (file: File | undefined) => {
    if (!file) return
    if (!window.confirm('导入将替换当前本地会话、图片和标注。\n建议先导出当前备份。\n\n取消 / 继续导入')) return
    setBusy(true); setMsg(null)
    void file.text().then((text) => importBackupText(text)).then(() => setMsg('导入完成')).catch((e: any) => setMsg(e instanceof BackupError ? e.message : '导入失败')).finally(() => setBusy(false))
  }

  return (
    <Modal open onClose={uiActions.closeSettings} title="设置" closeLabel="关闭" className={css.settingsDialog} contentClassName={css.settingsScroll}>
      <div className={css.settingsHint}>{APP_NAME} · v{APP_VERSION} · Alpha</div>
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
      <div className={css.settingsHint}>API Key 保存在当前浏览器本地（IndexedDB），不进源码、不走 Git。发送消息时，所选文本与图片会直接发送到你配置的 API 服务（默认 https://api.deepseek.com）。本项目自身没有中转服务器。</div>
      <div className={css.promptSection}>
        <div className={css.promptRow}><label className={css.promptLabel}>固定提示词</label><input type="checkbox" checked={promptOn} onChange={e => setPromptOn(e.target.checked)} /></div>
        <textarea className={css.promptArea} value={prompt} placeholder="每次请求作为 system prompt 注入，例如：回答任何学习问题时，第一行固定写“学习模式：”。" onChange={e => setPrompt(e.target.value)} />
        <div className={css.settingsHint}>仅保存在本机 IndexedDB，作为全局 system prompt 注入，不进入聊天记录。</div>
      </div>
      <div className={css.settingsActions}>
        <Button variant="outline" onClick={onTest}>{test ?? '测试连接'}</Button>
        <Button variant="primary" onClick={onSave}>{saved ? '已保存' : '保存'}</Button>
      </div>
      {test && <div className={css.testResult} data-ok={testOk === undefined ? undefined : String(testOk)}>{test}</div>}
      <div className={css.settingsHint}>“测试连接”仅调用 GET /models 验证服务可达与 Key 有效，不会发送聊天内容或文档。</div>
      <div className={css.exportSection}>
        <div className={css.exportTitle}>数据与导出</div>
        <div className={css.exportRow}>
          <Button variant="outline" disabled={busy} onClick={onExportBackup}>导出完整备份 JSON</Button>
          <Button variant="outline" disabled={busy || !currentConv} onClick={onExportMd}>导出当前会话 Markdown</Button>
          <Button variant="outline" disabled={busy || !currentConv} onClick={onExportMarked}>仅导出标记内容</Button>
        </div>
        <div className={css.exportRow}>
          <label className={css.importBtn}><span>导入备份 JSON</span><input type="file" accept=".json,application/json" hidden disabled={busy} onChange={e => { onImportFile(e.target.files?.[0]); e.target.value = '' }} /></label>
        </div>
        <div className={css.settingsHint}>完整备份不含 API Key。导入将替换当前本地会话、图片和标注。</div>
        {msg && <div className={css.testResult} data-ok="false">{msg}</div>}
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
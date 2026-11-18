import { useRef, useState } from 'react'
import { ApiProfileFileError, exportApiConfiguration, MAX_API_PROFILE_FILE_BYTES } from '../engine/api-profile-transfer'
import { getSettingsSnapshot, importApiConfiguration, useSettingsMutation } from '../engine/settings-store'
import { readBlobBuffer } from '../engine/read-blob-buffer'
import { downloadJson } from '../export/download'
import { tx } from '../engine/locale'
import { Button } from '../dsh/primitives'
import css from './api-profiles.module.css'

export function ApiConfigTransfer({ hasImageDraft }: { hasImageDraft: () => boolean }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [includeKeys, setIncludeKeys] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const disabled = useSettingsMutation().status === 'pending' || importing
  const originalName = tx('原有配置', 'Original configuration')

  async function importFile(file: File) {
    setError('')
    setStatus('')
    setExportOpen(false)
    if (hasImageDraft()) {
      setError(tx('请先保存配图配置，再导入 JSON。', 'Save your image search settings before importing.'))
      return
    }
    if (file.size > MAX_API_PROFILE_FILE_BYTES) {
      setError(tx('请选择 1 MB 以内的 JSON 文件。', 'Choose a JSON file of 1 MB or less.'))
      return
    }
    setImporting(true)
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await readBlobBuffer(file))
      const changed = await importApiConfiguration(text, originalName)
      setStatus(changed ? tx('API 配置已导入。', 'API configuration imported.') : tx('这些配置已存在。', 'These configurations already exist.'))
    } catch (failure) {
      if (failure instanceof ApiProfileFileError && failure.reason === 'firecrawl-limit') {
        setError(tx('Firecrawl 最多保存 10 个 Key。请先腾出位置再导入。', 'Firecrawl supports up to 10 keys. Make room before importing.'))
      } else if (failure instanceof ApiProfileFileError && failure.row) {
        setError(tx('第 ' + failure.row + ' 份模型配置无效。', 'Model configuration ' + failure.row + ' is invalid.'))
      } else {
        setError(tx('无法导入，请检查 Reader API 配置 JSON 后重试。', 'Import failed. Check the Reader API configuration JSON and try again.'))
      }
    } finally {
      setImporting(false)
    }
  }

  return <section className={css.root} data-testid="api-config-management">
    <strong className={css.heading}>{tx('API 管理', 'API management')}</strong>
    <p className={css.hint}>{tx('迁移模型配置、Firecrawl、语音接口和本机 OpenAI 模型。', 'Transfer model profiles, Firecrawl, speech API, and the local OpenAI model.')}</p>
    <div className={css.actions}>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => fileInput.current?.click()}>{importing ? tx('正在导入…', 'Importing…') : tx('导入 JSON', 'Import JSON')}</Button>
      <Button size="sm" variant="outline" aria-expanded={exportOpen} disabled={disabled} onClick={() => {
        setError(''); setStatus(''); setIncludeKeys(false); setExportOpen(open => !open)
      }}>{tx('导出 JSON', 'Export JSON')}</Button>
      <input ref={fileInput} type="file" hidden accept=".json,application/json" data-testid="api-profiles-import" onChange={event => {
        const file = event.currentTarget.files?.[0]
        event.currentTarget.value = ''
        if (file) void importFile(file)
      }} />
    </div>
    {exportOpen && <div className={css.editor} role="group" aria-label={tx('导出 API 配置', 'Export API configuration')}>
      <label className={css.keyOption}><input type="checkbox" checked={includeKeys} disabled={disabled} onChange={event => setIncludeKeys(event.target.checked)} />{tx('包含 API Key', 'Include API keys')}</label>
      <p className={css.hint}>{includeKeys
        ? tx('Key 会以明文写入 JSON，请妥善保管。', 'API keys are written as plain text. Keep the file private.')
        : tx('勾选后才能迁移 Firecrawl 和其他 API Key。', 'Select this option to transfer Firecrawl and other API keys.')}</p>
      <div className={css.actions}><Button variant="primary" disabled={disabled} onClick={() => {
        downloadJson('reader-api-config.json', exportApiConfiguration(getSettingsSnapshot(), originalName, includeKeys))
        setExportOpen(false); setIncludeKeys(false)
      }}>{tx('下载 JSON', 'Download JSON')}</Button></div>
    </div>}
    {error && <p role="alert" className={css.error}>{error}</p>}
    {status && <p role="status" className={css.hint}>{status}</p>}
  </section>
}

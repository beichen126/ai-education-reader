import { useEffect, useRef, useState } from 'react'
import { Modal, Button } from '../dsh/primitives'
import { useCopyFeedback } from '../dsh/primitives/use-copy-feedback'
import { useSettings } from '../engine/settings-store'
import { getAttachment } from '../engine/attachment-service'
import type { Attachment } from '../engine/types'
import { ensurePageOcr, readPageOcr } from './document-ocr'
import { deepSeekServiceProfiles as deepSeekOcrProfiles, selectedDeepSeekServiceProfile as selectedOcrProfile, selectDeepSeekServiceProfile as selectOcrProfile } from '../engine/deepseek-service-profile'
import type { OcrPage } from '../api/deepseek-ocr'
import { tx } from '../engine/locale'
import css from './pdf-ocr.module.css'

function OcrProfileChoice() {
  useSettings(s => s.apiProfiles)
  const [, refresh] = useState(0)
  const profiles = deepSeekOcrProfiles()
  return <div className={css.profile}>
    {profiles.length > 0 ? <label>{tx('OCR 使用', 'OCR account')} <select aria-label="DeepSeek OCR 配置" value={selectedOcrProfile()?.id || ''} onChange={e => { selectOcrProfile(e.target.value); refresh(n => n + 1) }}>{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label> : <span>{tx('请在 API 配置中保存 DeepSeek 官方 Key，无需切换当前对话模型。', 'Save a DeepSeek official API profile first; keep your current chat model.')}</span>}
    <small>{tx('仅未识别的页面发送到 DeepSeek，按服务计费；已保存结果直接复用。', 'Only uncached pages are sent to DeepSeek and may be billed. Saved results are reused.')}</small>
  </div>
}

export function PdfContextMode({ value, onChange, disabled = false }: { value: 'image' | 'ocr'; onChange: (mode: 'image' | 'ocr') => void; disabled?: boolean }) {
  return <div className={css.mode} data-testid="pdf-context-mode">
    <label>{tx('发送方式', 'Send as')} <select aria-label={tx('PDF 发送方式', 'PDF send mode')} value={value} disabled={disabled} onChange={e => onChange(e.target.value as 'image' | 'ocr')}><option value="image">{tx('页面图片', 'Page images')}</option><option value="ocr">{tx('OCR 文本 · DeepSeek', 'OCR text · DeepSeek')}</option></select></label>
    {value === 'ocr' && <><small>{tx('保留页面预览；模型只接收 OCR 文本，输入框保持不变。', 'Keep page previews; send only OCR text to the model without changing your message.')}</small><OcrProfileChoice /></>}
  </div>
}

export function AttachmentPageOcr({ attachmentId }: { attachmentId: string }) {
  const [attachment, setAttachment] = useState<Attachment>()
  useEffect(() => {
    let active = true
    void getAttachment(attachmentId).then(value => { if (active) setAttachment(value) }).catch(() => {})
    return () => { active = false }
  }, [attachmentId])
  if (attachment?.id !== attachmentId || !attachment.source) return null
  const { documentId, pageNumber } = attachment.source
  if (!documentId && !attachment.ocr) return null
  return <PdfPageOcrButton key={attachmentId} documentId={documentId} page={pageNumber} cached={attachment.ocr} startOnOpen render={async () => {
    const { readDocumentSourceBlob } = await import('./document-service')
    const { openPdfSession, closePdfSession, renderSessionPage } = await import('../pdf/pdf-session')
    const { session } = await openPdfSession(await readDocumentSourceBlob(documentId!))
    try { return (await renderSessionPage(session, pageNumber)).blob }
    finally { await closePdfSession(session) }
  }} />
}

export function PdfPageOcrButton({ documentId, page, render, cached, startOnOpen = false }: { documentId?: string; page: number; render: () => Promise<Blob>; cached?: OcrPage; startOnOpen?: boolean }) {
  const [open, setOpen] = useState(false), [result, setResult] = useState(cached), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    const token = ++generation.current
    setResult(cached); setBusy(false); setError(''); setOpen(false)
    if (documentId) void readPageOcr(documentId, page).then(r => {
      if (r && token === generation.current) setResult(r)
    }).catch(() => {})
    return () => { generation.current++ }
  }, [documentId, page, cached])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setOpen(false) }
      else if (['ArrowLeft', 'ArrowRight', '+', '=', '-'].includes(event.key)) event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
  async function recognize() {
    if (!documentId || busy) return
    const token = generation.current
    setBusy(true); setError('')
    try { const r = await ensurePageOcr(documentId, page, render); if (token === generation.current) setResult(r) }
    catch (e) { if (token === generation.current) setError(e instanceof Error ? e.message : 'OCR 失败') }
    finally { if (token === generation.current) setBusy(false) }
  }
  return <>
    <button type="button" className={css.trigger} disabled={!documentId && !result} onClick={() => {
      setOpen(true)
      if (startOnOpen && !result && selectedOcrProfile()) void recognize()
    }} data-testid="pdf-page-ocr">{result ? tx('查看 OCR', 'View OCR') : tx('OCR 识别', 'OCR')}</button>
    {open && <Modal open onClose={() => setOpen(false)} title={tx('第 ' + page + ' 页 · DeepSeek OCR', 'Page ' + page + ' · DeepSeek OCR')} closeLabel={tx('关闭', 'Close')} className={css.modal} rootClassName={css.overlay}>
      {!result && <OcrProfileChoice />}
      {error && <p role="alert">{error}</p>}
      {result ? <OcrResult result={result} /> : <Button variant="primary" disabled={busy || !selectedOcrProfile()} onClick={() => void recognize()}>{busy ? tx('正在识别并保存…', 'Recognizing and saving…') : tx('识别并保存此页', 'Recognize and save page')}</Button>}
      {busy && <p>{tx('关闭窗口后，已开始的识别仍会完成并保存。', 'An OCR request already started will finish and save even if you close this window.')}</p>}
    </Modal>}
  </>
}

function OcrResult({ result }: { result: OcrPage }) {
  const copy = useCopyFeedback(result.text)
  return <>
    {result.finishReason === 'length' && <p>{tx('已保存，服务返回的文字不完整。', 'Saved. The service returned partial text.')}</p>}
    <textarea readOnly aria-label={tx('OCR 结果', 'OCR result')} value={result.text || tx('本页未识别出文字', 'No text found')} className={css.result} />
    <div className={css.resultActions}>
      <Button variant="outline" disabled={!result.text.trim()} onClick={copy.onCopy} aria-live="polite">
        {copy.copied ? tx('已复制', 'Copied') : copy.failed ? tx('复制失败，重试', 'Copy failed. Retry') : tx('复制 OCR 文本', 'Copy OCR text')}
      </Button>
    </div>
  </>
}

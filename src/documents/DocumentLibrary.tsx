// Document Library (Stage 9.2B1): lists persisted local documents, imports PDFs
// directly (validated, chapters from native outline when present) and opens the
// Reader. The list holds only DocumentSummary — never sourceBlob / full trees.
// Deleting a Document NEVER touches Context attachments (no cascade ownership).
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatBytes } from '../storage/diagnostics'
import { createDocument, deleteDocument, listDocumentSummaries, updateDocumentChapters, type DocumentSummary } from './document-service'
import { documentUiActions, useDocumentUi } from './document-ui-store'
import { chapterNodesFromPdfOutline } from './chapter-model'
import { openPdfSession, readSessionOutline, closePdfSession, pdfErrorMessage, type PdfSession } from '../pdf/pdf-session'
import { PdfError } from '../pdf/pdf-service'
import { newStableId } from '../engine/types'
import css from './document-library.module.css'

export function DocumentLibrary() {
  const ui = useDocumentUi(x => x)
  const [summaries, setSummaries] = useState<DocumentSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const open = ui.view === 'library'

  const refresh = useCallback(async () => {
    try { setSummaries(await listDocumentSummaries()) } catch { setSummaries([]) }
  }, [])
  useEffect(() => { if (open) void refresh() }, [open, refresh])

  const importFile = async (f: File) => {
    setImporting(true); setError(null)
    let session: PdfSession | null = null
    try {
      const opened = await openPdfSession(f)
      session = opened.session
      let chapters = []
      let chapterSource: 'none' | 'native' = 'none'
      try {
        const o = await readSessionOutline(session)
        if (o.items.length > 0) { chapters = chapterNodesFromPdfOutline(o.items); chapterSource = 'native' }
      } catch { /* no outline -> none */ }
      const id = newStableId()
      await createDocument({
        id, fileName: f.name, mimeType: 'application/pdf', fileSize: f.size,
        pageCount: opened.doc.pageCount, sourceBlob: f,
        importSource: { kind: 'pdf', originalFileName: f.name },
      })
      if (chapters.length > 0) { try { await updateDocumentChapters(id, chapters, chapterSource) } catch { /* metadata only */ } }
      await refresh()
      documentUiActions.openReader(id)
    } catch (e: unknown) {
      setError(e instanceof PdfError ? pdfErrorMessage(e.kind) : '无法导入该 PDF。')
    } finally {
      // ONE cleanup path: the temporary import session is always closed exactly
      // once (closePdfSession is idempotent) and the button re-enables even when
      // the reader opened right after a successful import.
      if (session) { try { await closePdfSession(session) } catch { /* ignore */ } }
      setImporting(false)
    }
  }

  const remove = async (d: DocumentSummary) => {
    const ok = window.confirm('删除《' + d.fileName + '》？\n\n删除会移除保存在当前浏览器中的原始 PDF 和阅读进度。聊天中已经生成并保存的 PDF 页面 Context 不会因此删除。\n\n取消 / 删除')
    if (!ok) return
    setError(null)
    try {
      await deleteDocument(d.id)
      await refresh()
    } catch { setError('删除失败，请重试。') }
  }

  if (!open) return null
  return (
    <div className={css.overlay} data-testid="document-library">
      <div className={css.head}>
        <span className={css.title}>文件</span>
        <div className={css.headBtns}>
          <input ref={fileRef} type="file" accept=".pdf,application/pdf" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = '' }} />
          <button className={css.primaryBtn} data-testid="library-import" disabled={importing} onClick={() => fileRef.current?.click()}>{importing ? '正在导入…' : '导入 PDF'}</button>
          <button className={css.closeBtn} data-testid="library-close" onClick={documentUiActions.close}>关闭</button>
        </div>
      </div>
      {error && <div className={css.error} data-testid="library-error">{error}</div>}
      {summaries.length === 0 ? (
        <div className={css.empty} data-testid="library-empty">
          <div>还没有本地文件。</div>
          <div className={css.emptyHint}>导入一份 PDF 开始阅读。</div>
          <button className={css.primaryBtn} data-testid="library-empty-import" onClick={() => fileRef.current?.click()}>导入 PDF</button>
        </div>
      ) : (
        <div className={css.list}>
          {summaries.map(d => (
            <div className={css.card} key={d.id} data-testid={'doc-card-' + d.id}>
              <button className={css.cardMain} data-testid={'doc-open-' + d.id} onClick={() => documentUiActions.openReader(d.id)}>
                <div className={css.cardTitle}>{d.fileName}</div>
                <div className={css.cardMeta}>PDF · {d.pageCount} 页 · {formatBytes(d.fileSize)}</div>
                <div className={css.cardMeta}>{d.lastReadPage > 0 ? '上次阅读：第 ' + d.lastReadPage + ' 页' : '尚未阅读'}{d.chapterCount > 0 ? ' · 有目录' : ' · 无目录'}</div>
              </button>
              <div className={css.cardActions}>
                <button className={css.actionBtn} data-testid={'doc-read-' + d.id} onClick={() => documentUiActions.openReader(d.id)}>阅读</button>
                <button className={css.actionBtn + ' ' + css.danger} data-testid={'doc-delete-' + d.id} onClick={() => void remove(d)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

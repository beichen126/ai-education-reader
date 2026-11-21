import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { tx } from '../engine/locale'
import { isSupportedImage } from '../engine/attachment-service'
import { YoutubePicker } from '../youtube/YoutubePicker'
import { transcriptPreview } from '../youtube/preview'
import { saveProjectMaterials, saveProjectPdf } from './project-materials'
import { DocumentContextPicker } from '../documents/DocumentContextPicker'
import { executeDocumentContext } from '../documents/document-context-service'
import type { PdfSelection } from '../pdf/pdf-types'
import css from '../gallery/gallery.module.css'

const PdfPanel = lazy(() => import('../pdf/PdfPanel').then(module => ({ default: module.PdfPanel })))

export function ProjectMaterialImport({ projectId, projectName }: { projectId: string; projectName: string }) {
  const imageInput = useRef<HTMLInputElement>(null)
  const pdfInput = useRef<HTMLInputElement>(null)
  const pendingSave = useRef<AbortController>()
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [pdf, setPdf] = useState<File>()
  const [youtube, setYoutube] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => () => pendingSave.current?.abort(), [])
  async function saveFromLibrary(selection: PdfSelection, documentId: string, fileName: string) {
    if (pendingSave.current) return
    const controller = new AbortController()
    pendingSave.current = controller
    setBusy(true)
    setNotice(tx('正在准备 PDF 页面…', 'Preparing PDF pages…'))
    try {
      const result = await executeDocumentContext({
        targetProjectId: projectId, documentId, fileName, pageCount: 0, selection,
        isCancelled: () => controller.signal.aborted,
        onProgress: ({ done, total }) => setNotice(tx('正在准备 PDF 页面 · ', 'Preparing PDF pages · ') + done + ' / ' + total),
      })
      if (controller.signal.aborted) return
      if (!result.ok) { setNotice(''); return result.error || tx('处理已取消。', 'Processing was cancelled.') }
      setNotice(tx('已存入项目 · ' + result.count + ' 页', 'Saved to project · ' + result.count + ' pages'))
      setLibraryOpen(false)
    } finally {
      pendingSave.current = undefined
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  async function saveImages(files: File[]) {
    if (!files.length || busy) return
    setBusy(true)
    setNotice('')
    try {
      if (!files.every(isSupportedImage)) throw new Error(tx('请选择支持的图片格式。', 'Choose supported image files.'))
      await saveProjectMaterials(projectId, files.map(file => ({ name: file.name, blob: file })))
      setNotice(tx('图片已固定到项目。', 'Images saved to project.'))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : tx('图片保存失败。', 'Could not save images.'))
    } finally { setBusy(false) }
  }
  return <div className={css.projectActions}>
    <button className={css.closeBtn} type="button" disabled={busy} onClick={() => setLibraryOpen(true)}>{tx('＋ PDF 章节或页面', '＋ PDF chapter or pages')}</button>
    <button className={css.closeBtn} type="button" disabled={busy} onClick={() => imageInput.current?.click()}>{tx('＋ 图片', '＋ Images')}</button>
    <button className={css.closeBtn} type="button" disabled={busy} onClick={() => setYoutube(true)}>＋ YouTube</button>
    <input ref={imageInput} hidden type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => {
      const files = Array.from(event.currentTarget.files ?? [])
      event.currentTarget.value = ''
      void saveImages(files)
    }} />
    <input ref={pdfInput} hidden type="file" accept=".pdf,application/pdf" onChange={event => {
      setPdf(event.currentTarget.files?.[0])
      event.currentTarget.value = ''
    }} />
    {notice && <span role="status">{notice}</span>}
    {libraryOpen && !pdf && <DocumentContextPicker projectName={projectName} onImportPdf={() => pdfInput.current?.click()} onCancel={() => setLibraryOpen(false)} onAdd={saveFromLibrary} />}
    {pdf && <Suspense fallback={null}><PdfPanel rootClassName={css.projectModal} projectMaterial initialFile={pdf} onClose={() => setPdf(undefined)} onAddToDraft={async payload => {
      const result = await saveProjectPdf(projectId, payload)
      if (result.ok) {
        setLibraryOpen(false)
        setNotice(tx('已存入项目 · ' + result.count + ' 页', 'Saved to project · ' + result.count + ' pages'))
      }
      return result
    }} /></Suspense>}
    {youtube && <YoutubePicker rootClassName={css.projectModal} selectLabel={tx('固定到项目', 'Save to project')} onClose={() => setYoutube(false)} onSelect={async transcript => {
      await saveProjectMaterials(projectId, [{ name: transcript.title + '.png', blob: await transcriptPreview(transcript), transcript }])
    }} />}
  </div>
}

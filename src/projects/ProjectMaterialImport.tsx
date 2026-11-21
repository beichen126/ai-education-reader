import { lazy, Suspense, useRef, useState } from 'react'
import { tx } from '../engine/locale'
import { isSupportedImage } from '../engine/attachment-service'
import { YoutubePicker } from '../youtube/YoutubePicker'
import { transcriptPreview } from '../youtube/preview'
import { saveProjectMaterials, saveProjectPdf } from './project-materials'
import css from '../gallery/gallery.module.css'

const PdfPanel = lazy(() => import('../pdf/PdfPanel').then(module => ({ default: module.PdfPanel })))

export function ProjectMaterialImport({ projectId }: { projectId: string }) {
  const imageInput = useRef<HTMLInputElement>(null)
  const pdfInput = useRef<HTMLInputElement>(null)
  const [pdf, setPdf] = useState<File>()
  const [youtube, setYoutube] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
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
    <button className={css.closeBtn} type="button" disabled={busy} onClick={() => pdfInput.current?.click()}>{tx('＋ PDF 章节或页面', '＋ PDF chapter or pages')}</button>
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
    {pdf && <Suspense fallback={null}><PdfPanel rootClassName={css.projectModal} projectMaterial initialFile={pdf} onClose={() => setPdf(undefined)} onAddToDraft={payload => saveProjectPdf(projectId, payload)} /></Suspense>}
    {youtube && <YoutubePicker rootClassName={css.projectModal} selectLabel={tx('固定到项目', 'Save to project')} onClose={() => setYoutube(false)} onSelect={async transcript => {
      await saveProjectMaterials(projectId, [{ name: transcript.title + '.png', blob: await transcriptPreview(transcript), transcript }])
    }} />}
  </div>
}

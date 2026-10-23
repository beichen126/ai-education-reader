import { tx } from '../engine/locale'
import { PdfError, pdfErrorMessage } from '../pdf/pdf-service'
export function documentImportError(error: unknown, stage: 'analyze' | 'save'): string {
  if (error instanceof PdfError) return pdfErrorMessage(error.kind)
  const name = error instanceof Error ? error.name : ''
  const code = ['QuotaExceededError', 'NotReadableError', 'SecurityError', 'DataCloneError', 'InvalidStateError', 'TypeError', 'ReferenceError', 'BinaryStorageError'].includes(name) ? name : 'unknown'
  const hint = name === 'QuotaExceededError'
    ? tx('本机存储空间不足，请释放空间后重试。', 'Local storage is full. Free space and retry.')
    : name === 'NotReadableError' || name === 'SecurityError'
      ? tx('无法读取所选文件，请先下载到本机，再从系统文件选择器重新选择。', 'Cannot read the selected file. Download it locally and select it again.')
      : tx('请保留此错误码用于排查；不要清除应用数据。', 'Keep this code for diagnosis; do not clear app data.')
  return tx(stage === 'analyze' ? 'PDF 读取或解析失败' : 'PDF 保存失败', stage === 'analyze' ? 'PDF reading or parsing failed' : 'PDF saving failed') + ` [${stage}/${code}]。` + hint
}

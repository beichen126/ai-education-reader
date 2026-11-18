import { useEffect, useRef, useState, type RefObject } from 'react'

const LOCAL_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
}

export function typedLocalFile(file: File): File {
  if (file.type && file.type !== 'application/octet-stream') return file
  const extension = file.name.split('.').at(-1)?.toLowerCase() || ''
  const type = LOCAL_MIME[extension]
  return type ? new File([file], file.name, { type, lastModified: file.lastModified }) : file
}

export function pastedImages(data: DataTransfer) {
  const files = Array.from(data.files ?? []).map(typedLocalFile).filter(file => file.type.startsWith('image/'))
  if (files.length) return files
  return Array.from(data.items ?? []).flatMap(item => {
    const file = item.kind === 'file' && item.type.startsWith('image/') ? item.getAsFile() : null
    return file ? [typedLocalFile(file)] : []
  })
}

function isFileDrag(event: DragEvent): boolean {
  const data = event.dataTransfer
  return !!data && (Array.from(data.types).includes('Files') || Array.from(data.items ?? []).some(item => item.kind === 'file') || data.files.length > 0)
}

export function useComposerFileDrop(targetRef: RefObject<HTMLElement | null>, enabled: boolean, onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false)
  const handleFiles = useRef(onFiles)
  handleFiles.current = onFiles
  useEffect(() => {
    const target = targetRef.current
    if (!target || !enabled) {
      setDragging(false)
      return
    }
    const reset = () => setDragging(false)
    const over = (event: DragEvent) => {
      if (event.defaultPrevented || !isFileDrag(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      setDragging(true)
    }
    const leave = (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) reset()
    }
    const drop = (event: DragEvent) => {
      reset()
      if (event.defaultPrevented || !isFileDrag(event) || !event.dataTransfer) return
      event.preventDefault()
      const data = event.dataTransfer
      const files = Array.from(data.files)
      if (!files.length) {
        for (const item of Array.from(data.items ?? [])) {
          if (item.kind !== 'file') continue
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      handleFiles.current(files.map(typedLocalFile))
    }
    target.addEventListener('dragover', over)
    target.addEventListener('dragleave', leave)
    target.addEventListener('drop', drop)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    return () => {
      target.removeEventListener('dragover', over)
      target.removeEventListener('dragleave', leave)
      target.removeEventListener('drop', drop)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
    }
  }, [enabled, targetRef])
  return dragging && enabled
}

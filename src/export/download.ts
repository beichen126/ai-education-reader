function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
}
export function downloadText(filename: string, text: string, mime: string): void {
  download(filename, new Blob([text], { type: mime + ';charset=utf-8' }))
}
export function downloadJson(filename: string, obj: unknown): void {
  download(filename, new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' }))
}
export function downloadBlob(filename: string, blob: Blob): void {
  download(filename, blob)
}

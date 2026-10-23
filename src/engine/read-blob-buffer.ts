/** Read selected files on older/embedded WebViews without relying on Blob.arrayBuffer. */
export async function readBlobBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    try { return await blob.arrayBuffer() } catch (error) {
      if (typeof FileReader === 'undefined') throw error
    }
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('file_read_invalid_result'))
    reader.onerror = () => reject(reader.error || new Error('file_read_failed'))
    reader.onabort = () => reject(new Error('file_read_aborted'))
    reader.readAsArrayBuffer(blob)
  })
}

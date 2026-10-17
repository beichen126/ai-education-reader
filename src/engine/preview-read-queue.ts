/** Bounded asynchronous reads: keep nearby previews responsive without loading
 * every original Blob in a long conversation into memory at once. */
export class PreviewReadQueue {
  private active = 0
  private pending: Array<() => void> = []
  constructor(private readonly limit = 2) {}
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push(() => {
        this.active++
        void Promise.resolve().then(task).then(resolve, reject).finally(() => { this.active--; this.pump() })
      })
      this.pump()
    })
  }
  private pump(): void {
    while (this.active < Math.max(1, this.limit) && this.pending.length) this.pending.shift()!()
  }
}

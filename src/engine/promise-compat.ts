/** WebView 114 lacks this API. Window and PDF worker must each install it. */
export function installPromiseWithResolvers() {
  const ctor = Promise as PromiseConstructor & { withResolvers?: unknown }
  if (typeof ctor.withResolvers === 'function') return
  Object.defineProperty(ctor, 'withResolvers', {
    configurable: true, writable: true,
    value: function<T>(this: PromiseConstructor) {
      let resolve!: (value: T | PromiseLike<T>) => void
      let reject!: (reason?: unknown) => void
      const promise = new this<T>((res, rej) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    },
  })
}
installPromiseWithResolvers()

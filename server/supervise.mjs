import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Supervise only our own child. No HTTP/auth retry and no credential logging. */
export function restartDelay(code, signal, failures) {
  if (code === 0 || code === 78 || signal === 'SIGINT' || signal === 'SIGTERM') return null
  return Math.min(60000, 1000 * 2 ** Math.min(failures, 6))
}

export function supervise({ spawnChild = () => spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL('./start.mjs', import.meta.url))], { stdio: 'inherit', windowsHide: true }), schedule = setTimeout, now = Date.now } = {}) {
  let child, timer, stopping = false, failures = 0
  const launch = () => {
    const started = now()
    child = spawnChild()
    child.once('error', () => { /* close handles the failure; never log raw errors */ })
    child.once('close', (code, signal) => {
      if (stopping) return
      if (now() - started >= 60000) failures = 0
      const delay = restartDelay(code, signal, failures++)
      if (delay === null) return
      console.error(`Reader service exited unexpectedly; retry in ${delay / 1000}s.`)
      timer = schedule(launch, delay)
    })
  }
  launch()
  return () => { stopping = true; clearTimeout(timer); child?.kill('SIGTERM') }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stop = supervise()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop)
}

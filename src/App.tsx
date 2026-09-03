
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { AppFrame } from './dsh/layout/AppFrame'
import { useSessions, initStore } from './engine/sessions-store'
import { flushAllDrafts } from './engine/draft-store'
import { initSettings } from './engine/settings-store'
import { migrateLegacyBinaryStorage } from './storage/migration'
import { useUi } from './engine/ui-store'
import { layoutStore, useLayoutStore } from './engine/layout-store'
import { SessionProvider } from './engine/session-context'
import { t } from './engine/locale'
import { Sidebar } from './cockpit/Sidebar'
import { Conversation } from './cockpit/Conversation'
import { SettingsDialog } from './cockpit/SettingsDialog'
import { Gallery } from './gallery/Gallery'
import { DocumentLibrary } from './documents/DocumentLibrary'
import { DocumentReader } from './documents/DocumentReader'

function renderSlot(key: string, owner?: any): ReactNode {
  if (key === 'sidebar') return <Sidebar collapsed={!!owner?.collapsed} width={owner?.width ?? 0} />
  if (key === 'conversation') return <Conversation />
  return null
}

type BootState = 'loading' | 'ready' | 'error'

export function App() {
  const settingsOpen = useUi(s => s.settingsOpen)
  const [boot, setBoot] = useState<BootState>('loading')
  const bootFn = useCallback(async () => {
    setBoot('loading')
    try { await initSettings(); await initStore(); setBoot('ready') }
    catch (e) { console.error('本地数据载入失败', e); setBoot('error') }
  }, [])
  useEffect(() => { void bootFn() }, [bootFn])
  // Stage 9.4D: best-effort, NON-blocking legacy-blob -> OPFS background migration + a
  // one-time persistent-storage request (never a hard requirement, never a blocking modal).
  useEffect(() => {
    if (boot !== 'ready') return
    void migrateLegacyBinaryStorage().catch((e) => console.warn('binary migration failed', e))
  }, [boot])
  // Best-effort flush of any pending debounced text draft when the page is hidden/unloaded,
  // so quick navigation / system kill doesn't lose the last keystrokes.
  useEffect(() => {
    const flush = () => { void flushAllDrafts() }
    const onVis = () => { if (document.visibilityState === 'hidden') void flushAllDrafts() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVis)
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', onVis) }
  }, [])
  if (boot !== 'ready') {
    return (
      <div className="eink-boot">
        <div className="eink-boot-card">
          <div className="eink-boot-title">{t('brand.localBuild')}</div>
          {boot === 'loading'
            ? <div className="eink-boot-hint">正在载入本地会话…</div>
            : <div className="eink-boot-error">本地数据载入失败</div>}
          {boot === 'error' && <button className="eink-boot-retry" onClick={() => void bootFn()}>重试</button>}
        </div>
      </div>
    )
  }
  return (
    <>
      <AppFrame
        useStore={useLayoutStore as any}
        useSessions={useSessions as any}
        actions={layoutStore.actions as any}
        renderSlot={renderSlot as any}
        SessionProvider={SessionProvider as any}
        t={t as any}
      />
      {settingsOpen && <SettingsDialog />}
      <Gallery />
      <DocumentLibrary />
      <DocumentReader />
    </>
  )
}
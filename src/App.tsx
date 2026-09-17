
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AppFrame } from './dsh/layout/AppFrame'
import { useSessions, initStore } from './engine/sessions-store'
import { flushAllDrafts } from './engine/draft-store'
import { initSettings } from './engine/settings-store'
import { migrateLegacyBinaryStorage, backfillDocumentMetadata } from './storage/migration'
import { cleanupOrphanAttachments } from './engine/attachment-service'
import { requestStoragePersist } from './storage/binary-store'
import { uiActions, useUi } from './engine/ui-store'
import { useSettings, getSettingsSnapshot } from './engine/settings-store'
import { useTheme } from './theme/use-theme'
import { initLayout, layoutStore, useLayoutStore } from './engine/layout-store'
import { SessionProvider } from './engine/session-context'
import { t, tx, useUiLanguage } from './engine/locale'
import { Sidebar } from './cockpit/Sidebar'
import { Conversation } from './cockpit/Conversation'
import { migrateLegacyPrompts } from './prompts/prompt-migration'
import { migratePromptSimplification } from './prompts/prompt-simplification'
import { ProductGuideDialog } from './help/ProductGuideDialog'
import { migrateAnnotationsToStudyCards } from './annotations/annotation-migration'
import { getProductGuideSeenVersion, markProductGuideSeen, PRODUCT_GUIDE_VERSION } from './help/product-guide-state'
import { documentUiActions, useDocumentUi } from './documents/document-ui-store'
import { useGallery } from './gallery/gallery-store'
import { useLearningUi } from './study-cards/learning-ui-store'

const SettingsDialog = lazy(() => import('./cockpit/SettingsDialog').then(module => ({ default: module.SettingsDialog })))
const PromptManager = lazy(() => import('./prompts/PromptManager').then(module => ({ default: module.PromptManager })))
const Gallery = lazy(() => import('./gallery/Gallery').then(module => ({ default: module.Gallery })))
const DocumentLibrary = lazy(() => import('./documents/DocumentLibrary').then(module => ({ default: module.DocumentLibrary })))
const DocumentReader = lazy(() => import('./documents/DocumentReader').then(module => ({ default: module.DocumentReader })))
const LearningCenter = lazy(() => import('./study-cards/LearningCenter').then(module => ({ default: module.LearningCenter })))

function renderSlot(key: string, owner?: any): ReactNode {
  if (key === 'sidebar') return <Sidebar collapsed={!!owner?.collapsed} width={owner?.width ?? 0} />
  if (key === 'conversation') return <Conversation />
  return null
}

type BootState = 'loading' | 'ready' | 'error'

export function App() {
  useTheme()
  // Subscribing at the application boundary re-renders every visible surface when the
  // language changes, including layout slots rendered through AppFrame.
  useUiLanguage()
  const persistRequestedRef = useRef(false)
  const settingsOpen = useUi(s => s.settingsOpen)
  const promptManagerOpen = useUi(s => s.promptManagerOpen)
  const productGuideOpen = useUi(s => s.productGuideOpen)
  const galleryOpen = useGallery(s => s.open)
  const documentView = useDocumentUi(s => s.view)
  const learningView = useLearningUi(s => s.view)
  const apiKey = useSettings(s => s.apiKey)
  const [boot, setBoot] = useState<BootState>('loading')
  const productGuideCheckedRef = useRef(false)
  const bootFn = useCallback(async () => {
    setBoot('loading')
    try { await migrateLegacyPrompts(); await migratePromptSimplification(); await initSettings(); await initLayout(); await initStore(); setBoot('ready') }
    catch (e) { console.error('本地数据载入失败', e); setBoot('error') }
  }, [])
  useEffect(() => { void bootFn() }, [bootFn])
  useEffect(() => {
    if (boot !== 'ready' || productGuideCheckedRef.current) return
    productGuideCheckedRef.current = true
    let active = true
    void getProductGuideSeenVersion().then(seen => {
      if (!active || getSettingsSnapshot().apiKey.trim() || seen === PRODUCT_GUIDE_VERSION) return
      uiActions.openProductGuide()
      // Marker persistence is deliberately best-effort. A storage failure may cause the
      // guide to appear again after reload, but must never block the ready application.
      void markProductGuideSeen().catch(() => {})
    }).catch(() => {
      if (active && !apiKey.trim()) uiActions.openProductGuide()
    })
    return () => { active = false }
  }, [apiKey, boot])
  // Stage 9.4D: best-effort, NON-blocking legacy-blob -> OPFS background migration + a
  // one-time persistent-storage request (never a hard requirement, never a blocking modal).
  useEffect(() => {
    if (boot !== 'ready') return
    void migrateLegacyBinaryStorage().catch((e) => console.warn('binary migration failed', e))
    // Agent B (B2): non-blocking backfill of lastReadAt + recordVersion bump for old doc rows.
    void backfillDocumentMetadata().catch((e) => console.warn('document metadata backfill failed', e))
    void migrateAnnotationsToStudyCards().catch((e) => console.warn('annotation migration failed', e))
    // P2: conservative attachment-graph reachability cleanup after boot (best-effort, never
    // blocks boot, never deletes fresh/in-flight data, no modal — diagnostics only).
    void cleanupOrphanAttachments().catch(() => {})
    // One-time best-effort persistent-storage request (never blocks; failure is a no-op).
    if (!persistRequestedRef.current) { persistRequestedRef.current = true; void requestStoragePersist().catch(() => {}) }
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
            ? <div className="eink-boot-hint">{tx('正在载入本地会话…', 'Loading local chats…')}</div>
            : <div className="eink-boot-error">{tx('本地数据载入失败', 'Failed to load local data')}</div>}
          {boot === 'error' && <button className="eink-boot-retry" onClick={() => void bootFn()}>{tx('重试', 'Retry')}</button>}
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
      <Suspense fallback={null}>
        {settingsOpen && <SettingsDialog />}
        {promptManagerOpen && <PromptManager />}
        {learningView !== 'closed' && <LearningCenter />}
        {galleryOpen && <Gallery />}
        {documentView === 'library' && <DocumentLibrary />}
        {documentView === 'reader' && <DocumentReader />}
      </Suspense>
      <ProductGuideDialog
        open={productGuideOpen}
        onClose={uiActions.closeProductGuide}
        onImportPdf={() => { documentUiActions.openLibrary(); }}
        onOpenLibrary={() => { documentUiActions.openLibrary(); }}
        onConfigureApi={uiActions.openSettings}
      />
    </>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newStableId, type StableId } from '../engine/types'
import type { ArtifactKind } from '../artifacts/artifact-types'
import { uiActions, useUi } from '../engine/ui-store'
import { getPromptPreferences, setActiveProtocolOverride, setDefaultConversationModeId, setPromptSortPreference } from './prompt-preferences'
import {
  copyPromptDefinition,
  deletePromptDefinition,
  getPromptDefinition,
  listPromptCatalog,
  PROMPT_CATALOG_CHANGED_EVENT,
  PromptServiceError,
  saveDefaultConversationMode,
  savePromptDefinition,
  setPromptEnabled,
  updatePromptDefinition,
  type PromptMutationResult,
} from './prompt-service'
import { BUILTIN_PROMPT_IDS, getBuiltinPrompt, getBuiltinProtocol } from './prompt-registry'
import { resolveProtocolCanonicalRoot } from './protocol-lineage'
import { promptContent } from './prompt-validation'
import type { PromptDefinition, PromptKind, PromptUserPreferences } from './prompt-types'
import css from './prompt-manager.module.css'
import { tx } from '../engine/locale'

type Category = 'all' | PromptKind
type MobileStep = 'categories' | 'list' | 'detail'

const categories: { id: Category; label: string; labelEn: string; description: string; descriptionEn: string }[] = [
  { id: 'all', label: '全部', labelEn: 'All', description: '所有本地提示词', descriptionEn: 'All local prompts' },
  { id: 'conversation-mode', label: '会话模式', labelEn: 'Chat modes', description: '对话时使用的模式', descriptionEn: 'Modes used in chats' },
  { id: 'artifact', label: '学习成果', labelEn: 'Study outputs', description: '笔记与题目', descriptionEn: 'Notes and quizzes' },
  { id: 'quick-follow-up', label: '快捷追问', labelEn: 'Quick follow-ups', description: '对最新回答继续追问', descriptionEn: 'Continue from the latest answer' },
  { id: 'protocol', label: '系统协议', labelEn: 'System protocols', description: '结构化输出约束', descriptionEn: 'Structured-output constraints' },
]

const kindLabels: Record<PromptKind, string> = {
  'conversation-mode': '会话模式',
  artifact: '学习成果',
  'quick-follow-up': '快捷追问',
  protocol: '系统协议',
}
const kindLabelsEn: Record<PromptKind, string> = { 'conversation-mode': 'Chat mode', artifact: 'Study output', 'quick-follow-up': 'Quick follow-up', protocol: 'System protocol' }
const kindLabel = (kind: PromptKind) => tx(kindLabels[kind], kindLabelsEn[kind])

const artifactKinds: { id: ArtifactKind; label: string; labelEn: string }[] = [
  { id: 'note', label: '笔记', labelEn: 'Note' },
  { id: 'quiz', label: '测验', labelEn: 'Quiz' },
]

function contentOf(definition: PromptDefinition): string { return promptContent(definition) }

function withContent(definition: PromptDefinition, content: string): PromptDefinition {
  if (definition.kind === 'conversation-mode' || definition.kind === 'protocol') return { ...definition, systemPrompt: content }
  return { ...definition, userPrompt: content }
}

function cloneDefinition(definition: PromptDefinition): PromptDefinition {
  return definition.kind === 'protocol'
    ? { ...definition, ...(definition.validator ? { validator: { ...definition.validator } } : {}) }
    : { ...definition }
}

function newDefinition(kind: PromptKind = 'conversation-mode'): PromptDefinition {
  const now = Date.now()
  const common = { id: newStableId(), name: tx('未命名提示词', 'Untitled prompt'), description: '', source: 'custom' as const, enabled: true, createdAt: now, updatedAt: now, revision: 1 }
  switch (kind) {
    case 'conversation-mode': return { ...common, kind, systemPrompt: '' }
    case 'artifact': return { ...common, kind, artifactKind: 'note', userPrompt: '' }
    case 'quick-follow-up': return { ...common, kind, label: tx('新的追问', 'New follow-up'), userPrompt: '', pinned: false, sortOrder: 0 }
    case 'protocol': return { ...common, kind, domain: 'custom-protocol', systemPrompt: '', outputContract: '', overridePolicy: 'experimental' }
    default: return assertNever(kind)
  }
}

type ProtocolActivationStatus = { eligible: boolean; reason?: string }

function protocolActivationStatus(definition: PromptDefinition, catalog: readonly PromptDefinition[]): ProtocolActivationStatus {
  if (definition.kind !== 'protocol') return { eligible: false, reason: tx('只有 protocol 定义可以启用。', 'Only protocol definitions can be activated.') }
  if (definition.source !== 'experimental') return { eligible: false, reason: tx('只有从 canonical 复制出的 experimental protocol 可以启用。', 'Only an experimental protocol copied from canonical can be activated.') }
  if (!definition.enabled) return { eligible: false, reason: tx('该 experimental protocol 已停用，请先启用它。', 'This experimental protocol is disabled. Enable it first.') }
  if (definition.overridePolicy !== 'experimental') return { eligible: false, reason: tx('该 protocol 的 overridePolicy 不允许启用。', 'This protocol’s override policy does not allow activation.') }
  const canonical = getBuiltinProtocol(definition.domain)
  if (!canonical) return { eligible: false, reason: tx('该 protocol domain 没有可用的 canonical 定义。', 'This protocol domain has no canonical definition.') }
  const lineage = resolveProtocolCanonicalRoot(definition, [...catalog, definition])
  if ('message' in lineage) return { eligible: false, reason: tx('该 protocol 无法启用：', 'This protocol cannot be activated: ') + lineage.message }
  if (lineage.canonicalId !== canonical.id) return { eligible: false, reason: tx('该 protocol 无法启用：canonical domain 不匹配。', 'This protocol cannot be activated: canonical domain mismatch.') }
  return { eligible: true }
}

function assertNever(value: never): never { throw new Error('Unhandled prompt kind: ' + String(value)) }

function errorText(error: unknown): string {
  if (error instanceof PromptServiceError) return error.message
  if (error instanceof Error) return error.message || tx('操作失败。', 'Operation failed.')
  return tx('操作失败。', 'Operation failed.')
}

function usageText(definition: PromptDefinition, preferences: PromptUserPreferences): string {
  if (!definition.enabled) return tx('已停用，不会出现在选择器中。', 'Disabled and hidden from selectors.')
  if (definition.kind === 'conversation-mode' && preferences.defaultConversationModeId === definition.id) return tx('当前默认会话模式。', 'Current default chat mode.')
  if (definition.kind === 'protocol') {
    const domains = Object.entries(preferences.activeProtocolOverrideByDomain)
      .filter(([, id]) => id === definition.id)
      .map(([domain]) => domain)
    if (domains.length) return tx('当前实验 override：', 'Active experimental override: ') + domains.join(', ')
  }
  return tx('已保存，可在对应作用范围内使用。', 'Saved and available in its scope.')
}

function sourceLabel(source: PromptDefinition['source']): string {
  if (source === 'builtin') return tx('内置', 'Built-in')
  if (source === 'experimental') return tx('实验', 'Experimental')
  return tx('自定义', 'Custom')
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function isVisibleFocusable(element: HTMLElement): boolean {
  if (element.getAttribute('aria-hidden') === 'true') return false
  const style = window.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
}

function getModalFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisibleFocusable)
}

/** Stable fallback focus target in the app shell; never a synthetic body tabIndex. */
const STABLE_SHELL_FOCUS = '[data-testid="sidebar-new-chat"], [data-testid="rail-new-chat"]'

/**
 * Focus a control that may only appear AFTER the overlay closes (Settings re-mounts when
 * the manager closes). Tries immediately, then retries on a TIMER — `requestAnimationFrame`
 * is throttled in headless/background pages, which made the old implementation give up
 * after a single frame and silently lose the focus round-trip on CI.
 */
function focusWhenAvailable(selector: string, timeoutMs = 600): void {
  const deadline = Date.now() + timeoutMs
  const attempt = () => {
    const element = document.querySelector<HTMLElement>(selector)
    if (element && isVisibleFocusable(element) && !element.closest('[aria-hidden="true"]')) {
      element.focus({ preventScroll: true })
      return
    }
    if (Date.now() < deadline) window.setTimeout(attempt, 16)
  }
  attempt()
}

type BackgroundState = {
  element: HTMLElement
  inert: boolean
  ariaHidden: string | null
}

function setBackgroundInert(dialog: HTMLElement): BackgroundState[] {
  const appRoot = document.getElementById('root')
  if (!appRoot) return []
  const background = Array.from(appRoot.children).filter((element) => element !== dialog && !element.contains(dialog)) as HTMLElement[]
  const states = background.map((element) => ({
    element,
    inert: Boolean((element as HTMLElement & { inert?: boolean }).inert),
    ariaHidden: element.getAttribute('aria-hidden'),
  }))
  for (const { element } of states) {
    ;(element as HTMLElement & { inert?: boolean }).inert = true
    element.setAttribute('aria-hidden', 'true')
  }
  return states
}

function restoreBackground(states: BackgroundState[]): void {
  for (const { element, inert, ariaHidden } of states) {
    if (!element.isConnected) continue
    ;(element as HTMLElement & { inert?: boolean }).inert = inert
    if (ariaHidden === null) element.removeAttribute('aria-hidden')
    else element.setAttribute('aria-hidden', ariaHidden)
  }
}

export function PromptManager() {
  const requestedCategory = useUi(s => s.promptManagerCategory)
  const requestedReturnTarget = useUi(s => s.promptManagerReturnTarget)
  const [catalog, setCatalog] = useState<PromptDefinition[]>([])
  const [protocolCatalog, setProtocolCatalog] = useState<PromptDefinition[]>([])
  const [preferences, setPreferences] = useState<PromptUserPreferences | null>(null)
  const [category, setCategory] = useState<Category>(() => requestedCategory ?? 'all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<StableId | null>(null)
  const [draft, setDraft] = useState<PromptDefinition | null>(null)
  const [editorMode, setEditorMode] = useState<'edit' | 'create'>('edit')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [mobileStep, setMobileStep] = useState<MobileStep>(() => requestedCategory ? 'list' : window.innerWidth <= 720 ? 'categories' : 'detail')
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 720)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const returnTargetRef = useRef(requestedReturnTarget)
  returnTargetRef.current = requestedReturnTarget
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const active = document.activeElement
    openerRef.current = active instanceof HTMLElement && !dialog.contains(active) ? active : null
    const background = setBackgroundInert(dialog)
    let cancelled = false
    const focusables = () => getModalFocusableElements(dialog)
    const focusFirst = () => {
      const target = focusables()[0]
      if (target) target.focus({ preventScroll: true })
      else dialog.focus({ preventScroll: true })
    }
    const focusLast = () => {
      const current = focusables()
      const target = current[current.length - 1]
      if (target) target.focus({ preventScroll: true })
      else dialog.focus({ preventScroll: true })
    }
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && dialog.contains(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      focusFirst()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!busyRef.current) uiActions.closePromptManager()
        return
      }
      if (event.key !== 'Tab') return
      const current = focusables()
      if (current.length === 0) {
        event.preventDefault()
        dialog.focus({ preventScroll: true })
        return
      }
      const activeElement = document.activeElement
      const index = activeElement instanceof HTMLElement ? current.indexOf(activeElement) : -1
      if (index < 0) {
        event.preventDefault()
        if (event.shiftKey) focusLast()
        else focusFirst()
      } else if (event.shiftKey && index === 0) {
        event.preventDefault()
        focusLast()
      } else if (!event.shiftKey && index === current.length - 1) {
        event.preventDefault()
        focusFirst()
      }
    }
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('keydown', onKeyDown, true)
    // Move focus into the dialog. This MUST NOT rely on requestAnimationFrame: headless and
    // background pages throttle rAF, so the dialog could open with focus still outside it
    // (an intermittent CI failure). Try immediately, then retry on a timer.
    let initialFocusTimer = 0
    const focusInitial = () => {
      if (cancelled) return
      const close = dialog.querySelector<HTMLElement>('[data-testid="prompt-manager-close"]')
      if (close && isVisibleFocusable(close)) { close.focus({ preventScroll: true }); return }
      const first = focusables()[0]
      if (first) { first.focus({ preventScroll: true }); return }
      dialog.focus({ preventScroll: true })
    }
    focusInitial()
    initialFocusTimer = window.setTimeout(focusInitial, 0)
    return () => {
      cancelled = true
      window.clearTimeout(initialFocusTimer)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('keydown', onKeyDown, true)
      restoreBackground(background)
      const target = returnTargetRef.current
      const opener = openerRef.current
      openerRef.current = null
      // 1. An explicit origin wins: Settings re-mounts when the manager closes, so the
      //    original button is focused once it is back in the DOM.
      if (target?.kind === 'settings') { focusWhenAvailable('[data-testid="' + target.controlId + '"]'); return }
      if (target?.kind === 'app-control') { focusWhenAvailable('[data-testid="' + target.testId + '"]'); return }
      // 2. Otherwise return to whatever opened the manager (message-level quick follow-up).
      if (opener?.isConnected && !opener.closest('[aria-hidden="true"]')) {
        opener.focus({ preventScroll: true })
        return
      }
      // 3. Final fallback is a stable app-shell control, never a temporary body tabIndex.
      focusWhenAvailable(STABLE_SHELL_FOCUS)
    }
  }, [])

  const loadCatalog = useCallback(async (preferredId?: StableId, scope: 'default' | 'protocol' = 'default') => {
    setLoading(true)
    try {
      const [next, nextPreferences] = await Promise.all([listPromptCatalog(scope === 'protocol' ? 'protocol' : undefined), getPromptPreferences()])
      if (scope === 'protocol') setProtocolCatalog(next)
      else setCatalog(next)
      setPreferences(nextPreferences)
      const nextId = preferredId && next.some((item) => item.id === preferredId)
        ? preferredId
        : next.find((item) => item.id === selectedId)?.id ?? next[0]?.id ?? null
      setSelectedId(nextId)
      if (editorMode === 'edit' && nextId) {
        const selected = next.find((item) => item.id === nextId)
        if (selected && !dirty) setDraft(cloneDefinition(selected))
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [dirty, editorMode, selectedId])

  useEffect(() => { void loadCatalog(undefined, category === 'protocol' ? 'protocol' : 'default') }, []) // visible catalog is loaded once per manager open; protocols are explicit-only
  useEffect(() => {
    const onResize = () => {
      const next = window.innerWidth <= 720
      setNarrow(next)
      if (!next) setMobileStep('detail')
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const browseCatalog = category === 'protocol' ? protocolCatalog : catalog
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return browseCatalog.filter((item) => {
      if (category !== 'all' && item.kind !== category) return false
      if (!normalized) return true
      return [item.name, item.description, contentOf(item)].some((value) => value.toLocaleLowerCase().includes(normalized))
    })
  }, [browseCatalog, category, query])

  const selected = draft ?? (selectedId ? browseCatalog.find((item) => item.id === selectedId) : undefined)
  const canonicalDefault = selected?.kind === 'conversation-mode' && selected.id === (preferences?.defaultConversationModeId ?? BUILTIN_PROMPT_IDS.conversationDefault)
  const readonly = selected?.source === 'builtin' && !canonicalDefault
  const protocolStatus = selected?.kind === 'protocol' ? protocolActivationStatus(selected, protocolCatalog) : undefined

  const openDefinition = (definition: PromptDefinition) => {
    if (dirty && !window.confirm(tx('当前修改尚未保存，确定切换提示词吗？', 'Your changes are not saved. Switch prompts anyway?'))) return
    setSelectedId(definition.id)
    setDraft(cloneDefinition(definition))
    setEditorMode('edit')
    setDirty(false)
    setError(null)
    setNotice(null)
    if (narrow) setMobileStep('detail')
  }

  const chooseCategory = (next: Category) => {
    if (dirty && !window.confirm(tx('当前修改尚未保存，确定切换提示词分类吗？', 'Your changes are not saved. Switch categories anyway?'))) return
    setCategory(next)
    setDraft(null)
    setSelectedId(null)
    setEditorMode('edit')
    setDirty(false)
    setError(null)
    setNotice(null)
    if (next === 'protocol') void loadCatalog(undefined, 'protocol')
    else {
      const nextRows = next === 'all' ? catalog : catalog.filter((item) => item.kind === next)
      const first = nextRows[0]
      if (first) { setSelectedId(first.id); setDraft(cloneDefinition(first)) }
    }
    if (narrow) setMobileStep('list')
  }

  const startCreate = () => {
    if (category === 'protocol') {
      setError(tx('系统协议不能直接新建，请先选择 canonical protocol，再使用“复制 / 另存为”。', 'System protocols cannot be created directly. Select a canonical protocol and use “Copy / Save as”.'))
      setNotice(null)
      return
    }
    if (dirty && !window.confirm(tx('当前修改尚未保存，确定新建提示词吗？', 'Your changes are not saved. Create a new prompt anyway?'))) return
    setDraft(newDefinition(category === 'all' ? 'conversation-mode' : category))
    setSelectedId(null)
    setEditorMode('create')
    setDirty(true)
    setError(null)
    setNotice(null)
    if (narrow) setMobileStep('detail')
  }

  const updateDraft = (next: PromptDefinition) => { setDraft(next); setDirty(true); setError(null); setNotice(null) }

  const afterMutation = async (result: PromptMutationResult, message: string) => {
    setDraft(cloneDefinition(result.definition))
    setSelectedId(result.definition.id)
    setEditorMode('edit')
    setDirty(false)
    setNotice(result.warnings.length ? result.warnings.map((warning) => warning.message).join(' ') : message)
    window.dispatchEvent(new Event(PROMPT_CATALOG_CHANGED_EVENT))
    await loadCatalog(result.definition.id, result.definition.kind === 'protocol' ? 'protocol' : 'default')
  }

  const save = async () => {
    if (!draft) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = editorMode === 'create'
        ? await savePromptDefinition(draft)
        : draft.kind === 'conversation-mode' && canonicalDefault
          ? await saveDefaultConversationMode(draft)
          : await updatePromptDefinition(draft.id, draft)
      await afterMutation(result, editorMode === 'create' ? tx('提示词已创建。', 'Prompt created.') : tx('提示词已保存。', 'Prompt saved.'))
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const copy = async () => {
    const definition = selected
    if (!definition) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await copyPromptDefinition(definition.id)
      await afterMutation(result, tx('已复制为新的自定义提示词。', 'Copied as a new custom prompt.'))
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const toggleEnabled = async () => {
    const definition = selected
    if (!definition) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await setPromptEnabled(definition.id, !definition.enabled)
      await afterMutation(result, result.definition.enabled ? tx('提示词已启用。', 'Prompt enabled.') : tx('提示词已停用。', 'Prompt disabled.'))
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const restoreCanonical = async () => {
    const definition = selected
    if (!definition || definition.source !== 'builtin') return
    setBusy(true); setError(null); setNotice(null)
    try {
      const canonical = getBuiltinPrompt(definition.id)
      if (!canonical) throw new Error(tx('内置提示词不存在。', 'The built-in prompt does not exist.'))
      const result = await setPromptEnabled(definition.id, true)
      setDraft(cloneDefinition(canonical))
      await afterMutation({ ...result, definition: canonical }, tx('已恢复 canonical 内置提示词。', 'Canonical built-in prompt restored.'))
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const restoreProtocolCanonical = async () => {
    const definition = selected
    if (!definition || definition.kind !== 'protocol' || definition.source !== 'experimental') return
    setBusy(true); setError(null); setNotice(null)
    try {
      const committed = await setActiveProtocolOverride(definition.domain, undefined)
      setPreferences(committed)
      setNotice(tx('已恢复内置协议；实验版本和历史快照仍保留。', 'Built-in protocol restored; experimental versions and historical snapshots were preserved.'))
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const activateProtocolOverride = async () => {
    const definition = selected
    if (!definition || definition.kind !== 'protocol' || definition.source !== 'experimental' || dirty) return
    if (!protocolStatus?.eligible) {
      setError(protocolStatus?.reason ?? tx('该 protocol 无法启用。', 'This protocol cannot be activated.'))
      return
    }
    if (!window.confirm(tx('启用实验协议后，后续对应请求会使用它的 Prompt；解析器和 validator 代码仍保持内置版本。确定启用吗？', 'Future matching requests will use this experimental prompt, while parser and validator code remain built in. Activate it?'))) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const committed = await setActiveProtocolOverride(definition.domain, definition.id)
      setPreferences(committed)
      setNotice(tx('实验协议已启用。新请求开始前会冻结当前版本。', 'Experimental protocol activated. Its current version will be snapshotted before new requests.'))
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const remove = async () => {
    const definition = selected
    if (!definition || definition.source === 'builtin') return
    if (!window.confirm(tx('删除这个自定义提示词？历史消息中的 snapshot 不会被删除。', 'Delete this custom prompt? Snapshots in previous messages will remain.'))) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await deletePromptDefinition(definition.id)
      window.dispatchEvent(new Event(PROMPT_CATALOG_CHANGED_EVENT))
      setDraft(null); setDirty(false); setEditorMode('edit')
      setNotice(tx('提示词已删除，历史 snapshot 保持不变。', 'Prompt deleted. Historical snapshots are unchanged.'))
      await loadCatalog(undefined, category === 'protocol' ? 'protocol' : 'default')
      if (narrow) setMobileStep('list')
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const setDefault = async () => {
    if (!selected || selected.kind !== 'conversation-mode' || !selected.enabled) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await setDefaultConversationModeId(selected.id)
      setPreferences(await getPromptPreferences())
      window.dispatchEvent(new Event(PROMPT_CATALOG_CHANGED_EVENT))
      setNotice(tx('已设为默认会话模式。', 'Set as the default chat mode.'))
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const changeSort = async (value: 'updatedAt-desc' | 'name-asc') => {
    setBusy(true); setError(null)
    try { await setPromptSortPreference(value); await loadCatalog(undefined, category === 'protocol' ? 'protocol' : 'default'); setNotice(tx('排序已保存。', 'Sort order saved.')) }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  return (
    <div ref={dialogRef} className={css.promptManager} data-testid="prompt-manager" data-mobile-step={mobileStep} role="dialog" aria-modal="true" aria-label={tx('提示词管理', 'Prompt manager')} tabIndex={-1}>
      <header className={css.managerHeader}>
        <div>
          <h1>{tx('提示词', 'Prompts')}</h1>
          <p>{tx('所有提示词只保存在当前浏览器本地。', 'All prompts are stored only in this browser.')}</p>
        </div>
        <button type="button" className={css.managerClose} data-testid="prompt-manager-close" onClick={() => uiActions.closePromptManager()} disabled={busy} aria-label={tx('关闭提示词管理', 'Close prompt manager')}>×</button>
      </header>
      <div className={css.managerBody}>
        <aside className={css.categoryPane} aria-label={tx('提示词分类', 'Prompt categories')}>
          <div className={css.paneTitle}>{tx('分类', 'Categories')}</div>
          {categories.map((item) => (
            <button type="button" key={item.id} className={css.categoryBtn} data-testid={'prompt-category-' + item.id} data-active={category === item.id} aria-current={category === item.id ? 'page' : undefined} onClick={() => chooseCategory(item.id)}>
              <span>{tx(item.label, item.labelEn)}</span><small>{tx(item.description, item.descriptionEn)}</small>
            </button>
          ))}
        </aside>
        <section className={css.listPane} aria-label={tx('提示词列表', 'Prompt list')}>
          <div className={css.listToolbar}>
            <button type="button" className={css.mobileBack} onClick={() => setMobileStep('categories')}>‹ {tx('分类', 'Categories')}</button>
            <label className={css.searchField}><span>{tx('搜索提示词', 'Search prompts')}</span><input data-testid="prompt-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tx('搜索名称、描述或内容', 'Search names, descriptions, or content')} /></label>
            <button type="button" className={css.newButton} data-testid="prompt-new" disabled={category === 'protocol'} title={category === 'protocol' ? tx('系统协议需从 canonical 复制', 'System protocols must be copied from canonical') : undefined} onClick={startCreate}>＋ {tx('新建', 'New')}</button>
            {category === 'protocol' && <span data-testid="protocol-new-hint" role="note">{tx('系统协议请从 canonical 复制', 'Copy system protocols from canonical')}</span>}
          </div>
          <div className={css.listMeta}>
            <span>{loading ? tx('正在读取…', 'Loading…') : tx(filtered.length + ' 个提示词', filtered.length + ' prompts')}</span>
            <select aria-label={tx('提示词排序', 'Prompt sort')} value={preferences?.sortPreference ?? 'updatedAt-desc'} disabled={busy} onChange={(event) => void changeSort(event.target.value as 'updatedAt-desc' | 'name-asc')}>
              <option value="updatedAt-desc">{tx('最近修改', 'Recently modified')}</option><option value="name-asc">{tx('名称', 'Name')}</option>
            </select>
          </div>
          <div className={css.promptList}>
            {!loading && filtered.length === 0 && <div className={css.emptyList}>{tx('没有匹配的提示词。', 'No matching prompts.')}</div>}
            {filtered.map((item) => (
              <button type="button" key={item.id} className={css.promptRow} data-testid="prompt-row" data-id={item.id} data-source={item.source} data-active={selectedId === item.id && editorMode === 'edit'} aria-current={selectedId === item.id && editorMode === 'edit' ? 'true' : undefined} onClick={() => openDefinition(item)}>
                <span className={css.promptRowMain}><strong>{item.name}</strong><small>{item.description || tx('无描述', 'No description')}</small></span>
                <span className={css.promptRowMeta}><em data-source={item.source}>{sourceLabel(item.source)}</em><em>{kindLabel(item.kind)}</em>{!item.enabled && <em>{tx('已停用', 'Disabled')}</em>}</span>
              </button>
            ))}
          </div>
        </section>
        <main className={css.editorPane} aria-label={tx('提示词详情', 'Prompt details')}>
          <button type="button" className={css.mobileBack} onClick={() => setMobileStep('list')}>‹ {tx('列表', 'List')}</button>
          {selected && draft ? (
            <PromptEditor
              definition={draft}
              readonly={!!readonly}
              canonicalDefault={!!canonicalDefault}
              creating={editorMode === 'create'}
              busy={busy}
              preferences={preferences}
              dirty={dirty}
              error={error}
              notice={notice}
              onChange={updateDraft}
              onSave={() => void save()}
              onCopy={() => void copy()}
              onDelete={() => void remove()}
              onToggle={() => void toggleEnabled()}
              onRestore={() => void restoreCanonical()}
              onActivateOverride={() => void activateProtocolOverride()}
              onRestoreProtocol={() => void restoreProtocolCanonical()}
              onSetDefault={() => void setDefault()}
              protocolStatus={protocolStatus}
              onCancel={() => { setDraft(null); setDirty(false); setEditorMode('edit'); if (narrow) setMobileStep('list') }}
            />
          ) : (
            <div className={css.noSelection}><strong>{tx('选择一个提示词', 'Select a prompt')}</strong><span>{tx('或新建一个只属于你的本地提示词。', 'Or create a local prompt of your own.')}</span></div>
          )}
        </main>
      </div>
    </div>
  )
}

function PromptEditor(props: {
  definition: PromptDefinition
  readonly: boolean
  canonicalDefault: boolean
  creating: boolean
  busy: boolean
  preferences: PromptUserPreferences | null
  dirty: boolean
  error: string | null
  notice: string | null
  onChange: (definition: PromptDefinition) => void
  onSave: () => void
  onCopy: () => void
  onDelete: () => void
  onToggle: () => void
  onRestore: () => void
  onActivateOverride: () => void
  onRestoreProtocol: () => void
  onSetDefault: () => void
  onCancel: () => void
  protocolStatus?: ProtocolActivationStatus
}) {
  const { definition, readonly, canonicalDefault, creating, busy, preferences } = props
  const change = (patch: Partial<PromptDefinition>) => props.onChange({ ...definition, ...patch } as PromptDefinition)
  const changeContent = (value: string) => props.onChange(withContent(definition, value))
  const usage = preferences ? usageText(definition, preferences) : tx('正在读取使用情况…', 'Loading usage…')
  const activeProtocol = definition.kind === 'protocol' && preferences?.activeProtocolOverrideByDomain[definition.domain] === definition.id
  const quickPromptError = definition.kind === 'quick-follow-up' && definition.userPrompt.trim().length === 0 ? tx('快捷追问内容不能为空。', 'Quick follow-up content cannot be empty.') : undefined

  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <div><h2>{creating ? tx('新建提示词', 'New prompt') : definition.name}</h2><p>{creating ? tx('保存后会生成独立的本地记录。', 'Saving creates an independent local record.') : tx('编辑前会先复制定义，内置提示词不会被直接改写。', 'Built-in prompts are copied before editing and are never modified directly.')}</p></div>
        <span className={css.sourceBadge} data-source={definition.source}>{sourceLabel(definition.source)}</span>
      </div>
      <div className={css.editorScroll}>
        <label className={css.editorField}><span>{tx('名称', 'Name')}</span><input data-testid="prompt-editor-name" value={definition.name} disabled={readonly || canonicalDefault || busy} onChange={(event) => change({ name: event.target.value })} /></label>
        <label className={css.editorField}><span>{tx('描述', 'Description')}</span><input data-testid="prompt-editor-description" value={definition.description} disabled={readonly || canonicalDefault || busy} onChange={(event) => change({ description: event.target.value })} /></label>
        {creating && <label className={css.editorField}><span>{tx('作用范围', 'Scope')}</span><select data-testid="prompt-editor-kind" value={definition.kind} disabled={busy} onChange={(event) => props.onChange(newDefinition(event.target.value as PromptKind))}><option value="conversation-mode">{tx('会话模式', 'Chat mode')}</option><option value="artifact">{tx('学习成果', 'Study output')}</option><option value="quick-follow-up">{tx('快捷追问', 'Quick follow-up')}</option><option value="protocol" disabled>{tx('系统协议（请从 canonical 复制）', 'System protocol (copy from canonical)')}</option></select></label>}
        {definition.kind === 'artifact' && <label className={css.editorField}><span>{tx('学习成果类型', 'Study output type')}</span><select aria-label={tx('学习成果类型', 'Study output type')} value={definition.artifactKind} disabled={readonly || busy} onChange={(event) => change({ artifactKind: event.target.value as ArtifactKind })}>{artifactKinds.map((kind) => <option value={kind.id} key={kind.id}>{tx(kind.label, kind.labelEn)}</option>)}</select></label>}
        {definition.kind === 'quick-follow-up' && <>
          <label className={css.editorField}><span>{tx('按钮文字', 'Button label')}</span><input value={definition.label} disabled={readonly || busy} onChange={(event) => change({ label: event.target.value })} /></label>
          <label className={css.checkField}><input type="checkbox" checked={definition.pinned} disabled={readonly || busy} onChange={(event) => change({ pinned: event.target.checked })} /><span>{tx('固定显示', 'Pin')}</span></label>
          <label className={css.editorField}><span>{tx('排序序号', 'Sort order')}</span><input type="number" min="0" step="1" value={definition.sortOrder} disabled={readonly || busy} onChange={(event) => change({ sortOrder: Math.max(0, Number(event.target.value) || 0) })} /></label>
        </>}
        {definition.kind === 'protocol' && <>
          <label className={css.editorField}><span>{tx('协议 domain', 'Protocol domain')}</span><input value={definition.domain} disabled={readonly || busy} onChange={(event) => change({ domain: event.target.value })} /></label>
          <label className={css.editorField}><span>{tx('输出契约', 'Output contract')}</span><input value={definition.outputContract ?? ''} disabled={readonly || busy} onChange={(event) => change({ outputContract: event.target.value })} /></label>
          <section className={css.protocolInspector} data-testid="protocol-inspector" aria-label={tx('协议详情', 'Protocol details')}>
            <div className={css.protocolInspectorTitle}>{tx('协议详情', 'Protocol details')}</div>
            <dl className={css.protocolMeta}>
              <div><dt>{tx('作用位置', 'Used for')}</dt><dd>{definition.domain === 'ai-toc-transcription' ? tx('AI TOC · 文字转录', 'AI TOC · transcription') : definition.domain === 'ai-toc-structure' ? tx('AI TOC · 结构分析', 'AI TOC · structure') : definition.domain === 'quiz-output' ? tx('Quiz · 输出校验', 'Quiz · output validation') : tx('自定义协议域', 'Custom protocol domain')}</dd></div>
              <div><dt>{tx('模型职责', 'Model responsibility')}</dt><dd>{definition.description || tx('由协议 Prompt 约束结构化模型输出。', 'The protocol prompt constrains structured model output.')}</dd></div>
              <div><dt>{tx('来源', 'Source')}</dt><dd>{definition.source === 'builtin' ? tx('canonical / 内置', 'canonical / built-in') : definition.source + ' / experimental'}</dd></div>
              <div><dt>revision</dt><dd>v{definition.revision}</dd></div>
              <div><dt>validator</dt><dd>{definition.validator?.name || tx('未声明', 'Not declared')}</dd></div>
              <div><dt>{tx('validator 说明', 'Validator details')}</dt><dd>{definition.validator?.description || tx('由对应 domain 的内置校验器负责。', 'Handled by the built-in validator for this domain.')}</dd></div>
            </dl>
            <div className={css.protocolContract}><span>output contract</span><strong>{definition.outputContract || tx('未声明', 'Not declared')}</strong></div>
            <div className={css.protocolNote}>{tx('完整实际 system prompt 已在下方显示。validator 仅展示元数据，不能从界面修改执行代码。', 'The full effective system prompt appears below. Validator metadata is read-only; executable code cannot be changed here.')}</div>
          </section>
        </>}
        <label className={css.editorField}><span>{definition.kind === 'artifact' || definition.kind === 'quick-follow-up' ? tx('模板内容', 'Template content') : definition.kind === 'protocol' ? tx('协议提示词', 'Protocol prompt') : tx('系统提示词', 'System prompt')}</span><textarea id="prompt-editor-content" data-testid="prompt-editor-content" aria-invalid={quickPromptError ? 'true' : undefined} aria-describedby={quickPromptError ? 'prompt-editor-content-error' : undefined} value={contentOf(definition)} readOnly={readonly} disabled={busy} onChange={(event) => changeContent(event.target.value)} />{quickPromptError && <span id="prompt-editor-content-error" className={css.editorError} role="alert">{quickPromptError}</span>}</label>
        {!creating && <div className={css.metaGrid}><div><span>{tx('作用范围', 'Scope')}</span><strong>{kindLabel(definition.kind)}</strong></div><div><span>{tx('版本', 'Version')}</span><strong>revision {definition.revision}</strong></div><div><span>{tx('当前使用情况', 'Current usage')}</span><strong>{usage}</strong></div></div>}
        {definition.kind === 'conversation-mode' && definition.source !== 'builtin' && !canonicalDefault && <label className={css.checkField}><input type="checkbox" checked={definition.enabled} disabled={busy} onChange={(event) => change({ enabled: event.target.checked })} /><span>{tx('启用此会话模式', 'Enable this chat mode')}</span></label>}
        {props.error && <div className={css.editorError} role="alert">{props.error}</div>}
        {props.notice && <div className={css.editorNotice} role="status">{props.notice}</div>}
      </div>
      <div className={css.editorActions}>
        {creating ? <><button type="button" className={css.primaryAction} data-testid="prompt-save" disabled={busy} onClick={props.onSave}>{tx('创建', 'Create')}</button><button type="button" className={css.secondaryAction} disabled={busy} onClick={props.onCancel}>{tx('取消', 'Cancel')}</button></>
          : <>
            {readonly ? <button type="button" className={css.primaryAction} data-testid="prompt-copy" disabled={busy} onClick={props.onCopy}>{tx('复制 / 另存为', 'Copy / Save as')}</button> : <button type="button" className={css.primaryAction} data-testid="prompt-save" disabled={busy} onClick={props.onSave}>{tx('保存', 'Save')}</button>}
            {definition.kind === 'conversation-mode' && !canonicalDefault && <button type="button" className={css.secondaryAction} disabled={busy || !definition.enabled || preferences?.defaultConversationModeId === definition.id} onClick={props.onSetDefault}>{preferences?.defaultConversationModeId === definition.id ? tx('当前默认', 'Current default') : tx('设为默认', 'Set as default')}</button>}
            {definition.kind === 'protocol' ? <>
              {!readonly && <button type="button" className={css.secondaryAction} data-testid="protocol-activate" disabled={busy || props.dirty || activeProtocol || !props.protocolStatus?.eligible} onClick={props.onActivateOverride}>{activeProtocol ? tx('当前实验协议', 'Active experimental protocol') : tx('启用实验协议', 'Activate experimental protocol')}</button>}
              {!readonly && props.protocolStatus && !props.protocolStatus.eligible && <div className={css.editorError} data-testid="protocol-activation-reason" role="alert">{props.protocolStatus.reason}</div>}
              {!readonly && <button type="button" className={css.secondaryAction} data-testid="protocol-restore" disabled={busy || !activeProtocol} onClick={props.onRestoreProtocol}>{tx('恢复内置协议', 'Restore built-in protocol')}</button>}
              {!readonly && <><button type="button" className={css.secondaryAction} disabled={busy} onClick={props.onCopy}>{tx('复制', 'Copy')}</button><button type="button" className={css.dangerAction} data-testid="prompt-delete" disabled={busy} onClick={props.onDelete}>{tx('删除', 'Delete')}</button></>}
            </> : <>
              {!canonicalDefault && <button type="button" className={css.secondaryAction} disabled={busy} onClick={props.onToggle}>{definition.enabled ? tx('停用', 'Disable') : tx('启用', 'Enable')}</button>}
              {readonly && <button type="button" className={css.secondaryAction} data-testid="prompt-restore-canonical" disabled={busy} onClick={props.onRestore}>{tx('恢复 canonical', 'Restore canonical')}</button>}
              {!readonly && !canonicalDefault && <><button type="button" className={css.secondaryAction} disabled={busy} onClick={props.onCopy}>{tx('复制', 'Copy')}</button><button type="button" className={css.dangerAction} data-testid="prompt-delete" disabled={busy} onClick={props.onDelete}>{tx('删除', 'Delete')}</button></>}
            </>}
          </>}
      </div>
    </div>
  )
}

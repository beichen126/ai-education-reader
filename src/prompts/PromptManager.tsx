import { useCallback, useEffect, useMemo, useState } from 'react'
import { newStableId, type StableId } from '../engine/types'
import type { ArtifactKind } from '../artifacts/artifact-types'
import { uiActions, useUi } from '../engine/ui-store'
import { getPromptPreferences, setActiveProtocolOverride, setDefaultConversationModeId, setPromptSortPreference } from './prompt-preferences'
import {
  copyPromptDefinition,
  deletePromptDefinition,
  getPromptDefinition,
  listPromptCatalog,
  PromptServiceError,
  savePromptDefinition,
  setPromptEnabled,
  updatePromptDefinition,
  type PromptMutationResult,
} from './prompt-service'
import { getBuiltinPrompt } from './prompt-registry'
import { promptContent } from './prompt-validation'
import type { PromptDefinition, PromptKind, PromptUserPreferences } from './prompt-types'
import css from './prompt-manager.module.css'

type Category = 'all' | PromptKind
type MobileStep = 'categories' | 'list' | 'detail'

const categories: { id: Category; label: string; description: string }[] = [
  { id: 'all', label: '全部', description: '所有本地提示词' },
  { id: 'conversation-mode', label: '会话模式', description: '对话时使用的模式' },
  { id: 'artifact', label: '学习成果', description: '笔记、总结与练习' },
  { id: 'quick-follow-up', label: '快捷追问', description: '对最新回答继续追问' },
  { id: 'protocol', label: '系统协议', description: '结构化输出约束' },
]

const kindLabels: Record<PromptKind, string> = {
  'conversation-mode': '会话模式',
  artifact: '学习成果',
  'quick-follow-up': '快捷追问',
  protocol: '系统协议',
}

const artifactKinds: { id: ArtifactKind; label: string }[] = [
  { id: 'note', label: '笔记' },
  { id: 'quiz', label: '测验' },
  { id: 'summary', label: '总结' },
  { id: 'study-guide', label: '学习指南' },
  { id: 'custom', label: '自定义' },
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
  const common = { id: newStableId(), name: '未命名提示词', description: '', source: 'custom' as const, enabled: true, createdAt: now, updatedAt: now, revision: 1 }
  switch (kind) {
    case 'conversation-mode': return { ...common, kind, systemPrompt: '' }
    case 'artifact': return { ...common, kind, artifactKind: 'custom', userPrompt: '' }
    case 'quick-follow-up': return { ...common, kind, label: '新的追问', userPrompt: '', pinned: false, sortOrder: 0 }
    case 'protocol': return { ...common, kind, domain: 'custom-protocol', systemPrompt: '', outputContract: '', overridePolicy: 'experimental' }
    default: return assertNever(kind)
  }
}

function assertNever(value: never): never { throw new Error('Unhandled prompt kind: ' + String(value)) }

function errorText(error: unknown): string {
  if (error instanceof PromptServiceError) return error.message
  if (error instanceof Error) return error.message || '操作失败。'
  return '操作失败。'
}

function usageText(definition: PromptDefinition, preferences: PromptUserPreferences): string {
  if (!definition.enabled) return '已停用，不会出现在选择器中。'
  if (definition.kind === 'conversation-mode' && preferences.defaultConversationModeId === definition.id) return '当前默认会话模式。'
  if (definition.kind === 'protocol') {
    const domains = Object.entries(preferences.activeProtocolOverrideByDomain)
      .filter(([, id]) => id === definition.id)
      .map(([domain]) => domain)
    if (domains.length) return '当前实验 override：' + domains.join('、')
  }
  return '已保存，可在对应作用范围内使用。'
}

function sourceLabel(source: PromptDefinition['source']): string {
  if (source === 'builtin') return '内置'
  if (source === 'experimental') return '实验'
  return '自定义'
}

export function PromptManager() {
  const requestedCategory = useUi(s => s.promptManagerCategory)
  const [catalog, setCatalog] = useState<PromptDefinition[]>([])
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

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => { if (opener?.isConnected) opener.focus() }
  }, [])

  const loadCatalog = useCallback(async (preferredId?: StableId) => {
    setLoading(true)
    try {
      const [next, nextPreferences] = await Promise.all([listPromptCatalog(), getPromptPreferences()])
      setCatalog(next)
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

  useEffect(() => { void loadCatalog() }, []) // catalog is intentionally loaded once per manager open
  useEffect(() => {
    const onResize = () => {
      const next = window.innerWidth <= 720
      setNarrow(next)
      if (!next) setMobileStep('detail')
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) uiActions.closePromptManager() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return catalog.filter((item) => {
      if (category !== 'all' && item.kind !== category) return false
      if (!normalized) return true
      return [item.name, item.description, contentOf(item)].some((value) => value.toLocaleLowerCase().includes(normalized))
    })
  }, [catalog, category, query])

  const selected = draft ?? (selectedId ? catalog.find((item) => item.id === selectedId) : undefined)
  const readonly = selected?.source === 'builtin'

  const openDefinition = (definition: PromptDefinition) => {
    if (dirty && !window.confirm('当前修改尚未保存，确定切换提示词吗？')) return
    setSelectedId(definition.id)
    setDraft(cloneDefinition(definition))
    setEditorMode('edit')
    setDirty(false)
    setError(null)
    setNotice(null)
    if (narrow) setMobileStep('detail')
  }

  const chooseCategory = (next: Category) => {
    setCategory(next)
    if (narrow) setMobileStep('list')
  }

  const startCreate = () => {
    if (dirty && !window.confirm('当前修改尚未保存，确定新建提示词吗？')) return
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
    await loadCatalog(result.definition.id)
  }

  const save = async () => {
    if (!draft) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = editorMode === 'create'
        ? await savePromptDefinition(draft)
        : await updatePromptDefinition(draft.id, draft)
      await afterMutation(result, editorMode === 'create' ? '提示词已创建。' : '提示词已保存。')
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const copy = async () => {
    const definition = selected
    if (!definition) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await copyPromptDefinition(definition.id)
      await afterMutation(result, '已复制为新的自定义提示词。')
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const toggleEnabled = async () => {
    const definition = selected
    if (!definition) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await setPromptEnabled(definition.id, !definition.enabled)
      await afterMutation(result, result.definition.enabled ? '提示词已启用。' : '提示词已停用。')
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const restoreCanonical = async () => {
    const definition = selected
    if (!definition || definition.source !== 'builtin') return
    setBusy(true); setError(null); setNotice(null)
    try {
      const canonical = getBuiltinPrompt(definition.id)
      if (!canonical) throw new Error('内置提示词不存在。')
      const result = await setPromptEnabled(definition.id, true)
      setDraft(cloneDefinition(canonical))
      await afterMutation({ ...result, definition: canonical }, '已恢复 canonical 内置提示词。')
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const restoreProtocolCanonical = async () => {
    const definition = selected
    if (!definition || definition.kind !== 'protocol' || definition.source !== 'experimental') return
    setBusy(true); setError(null); setNotice(null)
    try {
      const committed = await setActiveProtocolOverride(definition.domain, undefined)
      setPreferences(committed)
      setNotice('已恢复内置协议；实验版本和历史快照仍保留。')
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const activateProtocolOverride = async () => {
    const definition = selected
    if (!definition || definition.kind !== 'protocol' || definition.source !== 'experimental' || dirty) return
    if (!window.confirm('启用实验协议后，后续对应请求会使用它的 Prompt；解析器和 validator 代码仍保持内置版本。确定启用吗？')) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const committed = await setActiveProtocolOverride(definition.domain, definition.id)
      setPreferences(committed)
      setNotice('实验协议已启用。新请求开始前会冻结当前版本。')
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const remove = async () => {
    const definition = selected
    if (!definition || definition.source === 'builtin') return
    if (!window.confirm('删除这个自定义提示词？历史消息中的 snapshot 不会被删除。')) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await deletePromptDefinition(definition.id)
      setDraft(null); setDirty(false); setEditorMode('edit')
      setNotice('提示词已删除，历史 snapshot 保持不变。')
      await loadCatalog()
      if (narrow) setMobileStep('list')
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const setDefault = async () => {
    if (!selected || selected.kind !== 'conversation-mode' || !selected.enabled) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await setDefaultConversationModeId(selected.id)
      setPreferences(await getPromptPreferences())
      setNotice('已设为默认会话模式。')
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const changeSort = async (value: 'updatedAt-desc' | 'name-asc') => {
    setBusy(true); setError(null)
    try { await setPromptSortPreference(value); await loadCatalog(); setNotice('排序已保存。') }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  return (
    <div className={css.promptManager} data-testid="prompt-manager" data-mobile-step={mobileStep} role="dialog" aria-modal="true" aria-label="提示词管理">
      <header className={css.managerHeader}>
        <div>
          <h1>提示词</h1>
          <p>所有提示词只保存在当前浏览器本地。</p>
        </div>
        <button type="button" className={css.managerClose} data-testid="prompt-manager-close" onClick={() => uiActions.closePromptManager()} disabled={busy} aria-label="关闭提示词管理">×</button>
      </header>
      <div className={css.managerBody}>
        <aside className={css.categoryPane} aria-label="提示词分类">
          <div className={css.paneTitle}>分类</div>
          {categories.map((item) => (
            <button type="button" key={item.id} className={css.categoryBtn} data-testid={'prompt-category-' + item.id} data-active={category === item.id} aria-current={category === item.id ? 'page' : undefined} onClick={() => chooseCategory(item.id)}>
              <span>{item.label}</span><small>{item.description}</small>
            </button>
          ))}
        </aside>
        <section className={css.listPane} aria-label="提示词列表">
          <div className={css.listToolbar}>
            <button type="button" className={css.mobileBack} onClick={() => setMobileStep('categories')}>‹ 分类</button>
            <label className={css.searchField}><span>搜索提示词</span><input data-testid="prompt-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、描述或内容" /></label>
            <button type="button" className={css.newButton} data-testid="prompt-new" onClick={startCreate}>＋ 新建</button>
          </div>
          <div className={css.listMeta}>
            <span>{loading ? '正在读取…' : filtered.length + ' 个提示词'}</span>
            <select aria-label="提示词排序" value={preferences?.sortPreference ?? 'updatedAt-desc'} disabled={busy} onChange={(event) => void changeSort(event.target.value as 'updatedAt-desc' | 'name-asc')}>
              <option value="updatedAt-desc">最近修改</option><option value="name-asc">名称</option>
            </select>
          </div>
          <div className={css.promptList}>
            {!loading && filtered.length === 0 && <div className={css.emptyList}>没有匹配的提示词。</div>}
            {filtered.map((item) => (
              <button type="button" key={item.id} className={css.promptRow} data-testid="prompt-row" data-id={item.id} data-source={item.source} data-active={selectedId === item.id && editorMode === 'edit'} aria-current={selectedId === item.id && editorMode === 'edit' ? 'true' : undefined} onClick={() => openDefinition(item)}>
                <span className={css.promptRowMain}><strong>{item.name}</strong><small>{item.description || '无描述'}</small></span>
                <span className={css.promptRowMeta}><em data-source={item.source}>{sourceLabel(item.source)}</em><em>{kindLabels[item.kind]}</em>{!item.enabled && <em>已停用</em>}</span>
              </button>
            ))}
          </div>
        </section>
        <main className={css.editorPane} aria-label="提示词详情">
          <button type="button" className={css.mobileBack} onClick={() => setMobileStep('list')}>‹ 列表</button>
          {selected && draft ? (
            <PromptEditor
              definition={draft}
              readonly={!!readonly}
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
              onCancel={() => { setDraft(null); setDirty(false); setEditorMode('edit'); if (narrow) setMobileStep('list') }}
            />
          ) : (
            <div className={css.noSelection}><strong>选择一个提示词</strong><span>或新建一个只属于你的本地提示词。</span></div>
          )}
        </main>
      </div>
    </div>
  )
}

function PromptEditor(props: {
  definition: PromptDefinition
  readonly: boolean
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
}) {
  const { definition, readonly, creating, busy, preferences } = props
  const change = (patch: Partial<PromptDefinition>) => props.onChange({ ...definition, ...patch } as PromptDefinition)
  const changeContent = (value: string) => props.onChange(withContent(definition, value))
  const usage = preferences ? usageText(definition, preferences) : '正在读取使用情况…'
  const activeProtocol = definition.kind === 'protocol' && preferences?.activeProtocolOverrideByDomain[definition.domain] === definition.id

  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <div><h2>{creating ? '新建提示词' : definition.name}</h2><p>{creating ? '保存后会生成独立的本地记录。' : '编辑前会先复制定义，内置提示词不会被直接改写。'}</p></div>
        <span className={css.sourceBadge} data-source={definition.source}>{sourceLabel(definition.source)}</span>
      </div>
      <div className={css.editorScroll}>
        <label className={css.editorField}><span>名称</span><input data-testid="prompt-editor-name" value={definition.name} disabled={readonly || busy} onChange={(event) => change({ name: event.target.value })} /></label>
        <label className={css.editorField}><span>描述</span><input data-testid="prompt-editor-description" value={definition.description} disabled={readonly || busy} onChange={(event) => change({ description: event.target.value })} /></label>
        {creating && <label className={css.editorField}><span>作用范围</span><select data-testid="prompt-editor-kind" value={definition.kind} disabled={busy} onChange={(event) => props.onChange(newDefinition(event.target.value as PromptKind))}><option value="conversation-mode">会话模式</option><option value="artifact">学习成果</option><option value="quick-follow-up">快捷追问</option><option value="protocol">系统协议</option></select></label>}
        {definition.kind === 'artifact' && <label className={css.editorField}><span>学习成果类型</span><select aria-label="学习成果类型" value={definition.artifactKind} disabled={readonly || busy} onChange={(event) => change({ artifactKind: event.target.value as ArtifactKind })}>{artifactKinds.map((kind) => <option value={kind.id} key={kind.id}>{kind.label}</option>)}</select></label>}
        {definition.kind === 'quick-follow-up' && <>
          <label className={css.editorField}><span>按钮文字</span><input value={definition.label} disabled={readonly || busy} onChange={(event) => change({ label: event.target.value })} /></label>
          <label className={css.checkField}><input type="checkbox" checked={definition.pinned} disabled={readonly || busy} onChange={(event) => change({ pinned: event.target.checked })} /><span>固定显示</span></label>
          <label className={css.editorField}><span>排序序号</span><input type="number" min="0" step="1" value={definition.sortOrder} disabled={readonly || busy} onChange={(event) => change({ sortOrder: Math.max(0, Number(event.target.value) || 0) })} /></label>
        </>}
        {definition.kind === 'protocol' && <>
          <label className={css.editorField}><span>协议 domain</span><input value={definition.domain} disabled={readonly || busy} onChange={(event) => change({ domain: event.target.value })} /></label>
          <label className={css.editorField}><span>输出契约</span><input value={definition.outputContract ?? ''} disabled={readonly || busy} onChange={(event) => change({ outputContract: event.target.value })} /></label>
          <section className={css.protocolInspector} data-testid="protocol-inspector" aria-label="协议详情">
            <div className={css.protocolInspectorTitle}>协议详情</div>
            <dl className={css.protocolMeta}>
              <div><dt>作用位置</dt><dd>{definition.domain === 'ai-toc-transcription' ? 'AI TOC · 文字转录' : definition.domain === 'ai-toc-structure' ? 'AI TOC · 结构分析' : definition.domain === 'quiz-output' ? 'Quiz · 输出校验' : '自定义协议域'}</dd></div>
              <div><dt>模型职责</dt><dd>{definition.description || '由协议 Prompt 约束结构化模型输出。'}</dd></div>
              <div><dt>来源</dt><dd>{definition.source === 'builtin' ? 'canonical / 内置' : definition.source + ' / experimental'}</dd></div>
              <div><dt>revision</dt><dd>v{definition.revision}</dd></div>
              <div><dt>validator</dt><dd>{definition.validator?.name || '未声明'}</dd></div>
              <div><dt>validator 说明</dt><dd>{definition.validator?.description || '由对应 domain 的内置校验器负责。'}</dd></div>
            </dl>
            <div className={css.protocolContract}><span>output contract</span><strong>{definition.outputContract || '未声明'}</strong></div>
            <div className={css.protocolNote}>完整实际 system prompt 已在下方显示。validator 仅展示元数据，不能从界面修改执行代码。</div>
          </section>
        </>}
        <label className={css.editorField}><span>{definition.kind === 'artifact' || definition.kind === 'quick-follow-up' ? '模板内容' : definition.kind === 'protocol' ? '协议提示词' : '系统提示词'}</span><textarea data-testid="prompt-editor-content" value={contentOf(definition)} readOnly={readonly} disabled={busy} onChange={(event) => changeContent(event.target.value)} /></label>
        {!creating && <div className={css.metaGrid}><div><span>作用范围</span><strong>{kindLabels[definition.kind]}</strong></div><div><span>版本</span><strong>revision {definition.revision}</strong></div><div><span>当前使用情况</span><strong>{usage}</strong></div></div>}
        {definition.kind === 'conversation-mode' && definition.source !== 'builtin' && <label className={css.checkField}><input type="checkbox" checked={definition.enabled} disabled={busy} onChange={(event) => change({ enabled: event.target.checked })} /><span>启用此会话模式</span></label>}
        {props.error && <div className={css.editorError} role="alert">{props.error}</div>}
        {props.notice && <div className={css.editorNotice} role="status">{props.notice}</div>}
      </div>
      <div className={css.editorActions}>
        {creating ? <><button type="button" className={css.primaryAction} data-testid="prompt-save" disabled={busy} onClick={props.onSave}>创建</button><button type="button" className={css.secondaryAction} disabled={busy} onClick={props.onCancel}>取消</button></>
          : <>
            {readonly ? <button type="button" className={css.primaryAction} data-testid="prompt-copy" disabled={busy} onClick={props.onCopy}>复制 / 另存为</button> : <button type="button" className={css.primaryAction} data-testid="prompt-save" disabled={busy} onClick={props.onSave}>保存</button>}
            {definition.kind === 'conversation-mode' && <button type="button" className={css.secondaryAction} disabled={busy || !definition.enabled || preferences?.defaultConversationModeId === definition.id} onClick={props.onSetDefault}>{preferences?.defaultConversationModeId === definition.id ? '当前默认' : '设为默认'}</button>}
            {definition.kind === 'protocol' ? <>
              {!readonly && <button type="button" className={css.secondaryAction} data-testid="protocol-activate" disabled={busy || props.dirty || activeProtocol} onClick={props.onActivateOverride}>{activeProtocol ? '当前实验协议' : '启用实验协议'}</button>}
              {!readonly && <button type="button" className={css.secondaryAction} data-testid="protocol-restore" disabled={busy || !activeProtocol} onClick={props.onRestoreProtocol}>恢复内置协议</button>}
              {!readonly && <><button type="button" className={css.secondaryAction} disabled={busy} onClick={props.onCopy}>复制</button><button type="button" className={css.dangerAction} data-testid="prompt-delete" disabled={busy} onClick={props.onDelete}>删除</button></>}
            </> : <>
              <button type="button" className={css.secondaryAction} disabled={busy} onClick={props.onToggle}>{definition.enabled ? '停用' : '启用'}</button>
              {readonly && <button type="button" className={css.secondaryAction} data-testid="prompt-restore-canonical" disabled={busy} onClick={props.onRestore}>恢复 canonical</button>}
              {!readonly && <><button type="button" className={css.secondaryAction} disabled={busy} onClick={props.onCopy}>复制</button><button type="button" className={css.dangerAction} data-testid="prompt-delete" disabled={busy} onClick={props.onDelete}>删除</button></>}
            </>}
          </>}
      </div>
    </div>
  )
}

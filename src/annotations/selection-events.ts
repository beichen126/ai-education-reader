type AnnotationEventOwner = {
  dismiss(): void
  selectionEnd(): void
  trackTouchSelection?: boolean
}

const eventOwners = new Map<string, AnnotationEventOwner>()
let activeEventOwner: string | null = null
let annotationEventsInstalled = false
let draggingSelection = false
let touchSelection = false

function eventOwnerForNode(node: Node | null): [string, AnnotationEventOwner] | null {
  const element = node instanceof Element ? node : node?.parentElement
  const root = element?.closest<HTMLElement>('[data-annotation-owner]')
  if (!root) return null
  const id = root.dataset.annotationOwner
  const owner = id ? eventOwners.get(id) : undefined
  return id && owner ? [id, owner] : null
}

function eventOwnerForSelection(): [string, AnnotationEventOwner] | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const start = eventOwnerForNode(range.startContainer)
  const end = eventOwnerForNode(range.endContainer)
  return start && end && start[0] === end[0] ? start : null
}

const delegatedPointerDown = (event: PointerEvent) => {
  draggingSelection = true
  touchSelection = event.pointerType === 'touch'
  const found = eventOwnerForNode(event.target as Node | null)
  const previous = activeEventOwner ? eventOwners.get(activeEventOwner) : undefined
  if (previous && found?.[0] !== activeEventOwner) previous.dismiss()
  activeEventOwner = found?.[0] ?? null
  found?.[1].dismiss()
}
const delegatedSelectionEnd = (event?: Event) => {
  if (event?.type === 'pointerup' || event?.type === 'pointercancel' || event?.type === 'touchend' || event?.type === 'blur') draggingSelection = false
  if (draggingSelection && !touchSelection) return
  const found = eventOwnerForSelection()
  // Android's native selection handles may move the range without forwarding
  // the end of the original long press to the WebView document.
  if (draggingSelection && !found?.[1].trackTouchSelection) return
  if (found) {
    if (activeEventOwner && activeEventOwner !== found[0]) eventOwners.get(activeEventOwner)?.dismiss()
    activeEventOwner = found[0]; found[1].selectionEnd(); return
  }
  if (activeEventOwner) eventOwners.get(activeEventOwner)?.selectionEnd()
}

function installAnnotationEvents(): void {
  if (annotationEventsInstalled || typeof document === 'undefined') return
  annotationEventsInstalled = true
  document.addEventListener('selectionchange', delegatedSelectionEnd)
  document.addEventListener('pointerdown', delegatedPointerDown)
  document.addEventListener('pointerup', delegatedSelectionEnd)
  document.addEventListener('pointercancel', delegatedSelectionEnd)
  window.addEventListener('blur', delegatedSelectionEnd)
  document.addEventListener('touchend', delegatedSelectionEnd)
}

function uninstallAnnotationEventsIfIdle(): void {
  if (!annotationEventsInstalled || eventOwners.size > 0 || typeof document === 'undefined') return
  annotationEventsInstalled = false
  activeEventOwner = null
  draggingSelection = false
  touchSelection = false
  document.removeEventListener('selectionchange', delegatedSelectionEnd)
  document.removeEventListener('pointerdown', delegatedPointerDown)
  document.removeEventListener('pointerup', delegatedSelectionEnd)
  document.removeEventListener('pointercancel', delegatedSelectionEnd)
  window.removeEventListener('blur', delegatedSelectionEnd)
  document.removeEventListener('touchend', delegatedSelectionEnd)
}

export function registerSelectionOwner(id: string, owner: AnnotationEventOwner): () => void {
  eventOwners.set(id, owner)
  installAnnotationEvents()
  return () => {
    eventOwners.delete(id)
    if (activeEventOwner === id) activeEventOwner = null
    uninstallAnnotationEventsIfIdle()
  }
}

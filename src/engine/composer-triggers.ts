// Tiny bridge so the empty-state hero (rendered by Conversation) can open the
// Composer's file inputs. The Composer registers its triggers on mount.
type Triggers = { openImages: () => void; openPdf: () => void; openMaterials: () => void }
let triggers: Triggers | null = null
export function setComposerTriggers(t: Triggers): void { triggers = t }
export function triggerComposerImages(): void { if (triggers) triggers.openImages() }
export function triggerComposerPdf(): void { if (triggers) triggers.openPdf() }
/** Unified "添加资料" (images OR a single PDF) trigger used by the new-chat empty hero. */
export function triggerComposerMaterials(): void { if (triggers) triggers.openMaterials() }

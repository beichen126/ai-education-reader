import type { ChapterNode, ChapterVersion, DocumentChapterSource } from './document-types'
import { newStableId } from '../engine/types'

function cloneTree(nodes: readonly ChapterNode[]): ChapterNode[] { return nodes.map(node=>({...node,children:cloneTree(node.children)})) }

/** Build immutable metadata snapshots, never duplicate the PDF binary. */
export function nextChapterVersions(current: { chapters?: ChapterNode[]; chapterSource?: DocumentChapterSource; chapterVersions?: ChapterVersion[]; updatedAt?: number }, chapters: ChapterNode[], chapterSource: DocumentChapterSource, now: number): ChapterVersion[] {
  const versions = [...(current.chapterVersions ?? [])]
  const add = (tree: ChapterNode[], source: DocumentChapterSource, createdAt: number) => {
    const last = versions[versions.length - 1]
    if (last && last.chapterSource === source && JSON.stringify(last.chapters) === JSON.stringify(tree)) return
    versions.push({ id: newStableId(), createdAt, chapters: cloneTree(tree), chapterSource: source })
  }
  if (!versions.length && current.chapters?.length) add(current.chapters, current.chapterSource ?? 'none', current.updatedAt ?? now)
  add(chapters, chapterSource, now)
  return versions
}

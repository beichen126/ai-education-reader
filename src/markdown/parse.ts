
import { fromMarkdown, type Options } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { mathCompatibility } from './mathCompatibility'
import { cjkFriendlyStrong } from './cjkFriendlyStrong'
import type { Root } from 'mdast'
import { protectMathTablePipes } from './math-table-pipes'
/** Parse GFM markdown + TeX math into an mdast Root (nodes carry source position offsets).
 *  Supports `$...
 / `$...$` (native) and `\(...\)` / `\[...\]` (via DSH mathCompatibility). */
export function parseMarkdown(content: string): Root {
  const options = { extensions: [gfm(), math(), mathCompatibility(), cjkFriendlyStrong()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] } as Options
  let root = fromMarkdown(content, options)
  const tableRanges: { start: number; end: number }[] = []
  const findTables = (node: any) => {
    if (node.type === 'table') tableRanges.push({ start: node.position.start.offset, end: node.position.end.offset })
    node.children?.forEach(findTables)
  }
  findTables(root)
  const protectedMath = protectMathTablePipes(content, tableRanges)
  if (protectedMath) {
    root = fromMarkdown(protectedMath.content, options)
    const restore = (node: any) => {
      if (typeof node.value === 'string') node.value = node.value.replaceAll(protectedMath.placeholder, '|')
      if (node.children) node.children.forEach(restore)
      if (node.data?.hChildren) node.data.hChildren.forEach(restore)
    }
    restore(root)
  }
  return root
}

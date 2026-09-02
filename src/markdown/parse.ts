
import { fromMarkdown, type Options } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { mathCompatibility } from './mathCompatibility'
import { cjkFriendlyStrong } from './cjkFriendlyStrong'
import type { Root } from 'mdast'
/** Parse GFM markdown + TeX math into an mdast Root (nodes carry source position offsets).
 *  Supports `$...
 / `$...$` (native) and `\(...\)` / `\[...\]` (via DSH mathCompatibility). */
export function parseMarkdown(content: string): Root {
  return fromMarkdown(content, { extensions: [gfm(), math(), mathCompatibility(), cjkFriendlyStrong()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] } as Options)
}
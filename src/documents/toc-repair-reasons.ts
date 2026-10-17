import type { TocStructureDiagnostic } from './ai-toc'

/** Stable, localized reasons only; never expose raw provider errors. */
export function describeTocRepairReasons(diagnostics: readonly TocStructureDiagnostic[], english: boolean): string {
  const choose = (zh: string, en: string) => english ? en : zh
  return [...new Set(diagnostics.map(d => {
    switch (d.code) {
      case 'OUTPUT_TRUNCATED': return choose('上次层级输出达到长度限制，被截断', 'The previous hierarchy output hit its length limit and was truncated')
      case 'LEVEL_COUNT_MISMATCH': return choose(`返回 ${d.actualLevels ?? '?'} 项层级，应有 ${d.expectedRows ?? '?'} 项`, `Returned ${d.actualLevels ?? '?'} levels; expected ${d.expectedRows ?? '?'}`)
      case 'SUSPICIOUS_FLAT': return choose('章节编号存在多级结构，但上次结果被错误地扁平化', 'The previous result flattened a multi-level numbered outline')
      case 'LEVEL_JUMP': return choose(`第 ${d.rowIndex != null ? d.rowIndex + 1 : '?'} 项出现跳级`, `Invalid hierarchy jump at entry ${d.rowIndex != null ? d.rowIndex + 1 : '?'}`)
      case 'INVALID_LEVEL': return choose(`第 ${d.rowIndex != null ? d.rowIndex + 1 : '?'} 项层级数值无效`, `Invalid level at entry ${d.rowIndex != null ? d.rowIndex + 1 : '?'}`)
      case 'EMPTY_OUTPUT': return choose('上次未返回目录层级', 'The previous response contained no hierarchy')
      case 'API_ERROR': return choose('上次结构分析请求失败，正在重试', 'The previous structure request failed; retrying')
      case 'ABORTED': return choose('上次结构分析被中断', 'The previous structure analysis was interrupted')
      default: return choose('上次层级结果不是有效 JSON 格式', 'The previous hierarchy response was not valid JSON')
    }
  }))].join(choose('；', '; '))
}

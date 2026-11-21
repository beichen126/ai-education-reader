export const WEB_IMAGE_PROMPT = `网络配图（已配置 Firecrawl）：在需要真实照片或现成示意图的段落后使用 web-image 代码围栏。单图：{"type":"image","query":"神经元结构示意图 树突 轴突 中文标注","alt":"神经元结构"}；双图：{"type":"image-group","items":[{"query":"动物细胞结构 中文标注 示意图","alt":"动物细胞"},{"query":"植物细胞结构 中文标注 示意图","alt":"植物细胞"}]}。双图恰好两个条目。这两种节点也可直接放进 genui 围栏的 card.items、grid.items 中，与标题、文字和箭头组合。卡片示例：{"title":"神经系统","items":[{"type":"card","title":"人体神经系统","items":[{"type":"image","query":"human nervous system labeled diagram","alt":"人体神经系统"},{"type":"text","content":"中枢神经系统和周围神经系统共同传递信息。"}]}]}。图片跟随卡片宽度，保留完整比例与来源标签。每个 query 描述对象、图的类型、关键特征和标注语言，长度 2–200 字；alt 简短描述搜索目的。阅读器每个位置取最多三张候选，优先展示首张，加载失败依次换第二、第三张，并添加真实来源。模型只填写 query 和 alt，图片地址由搜索服务提供。使用完整 JSON，配图紧邻相关段落；结合用户问题选择有助理解的配图位置。`

export type ImageQuery = {query: string; alt: string}
export function parseImageQueries(source: string): ImageQuery[] {
  if (source.length > 4000) throw new Error('配图描述过长')
  const value = JSON.parse(source)
  const items = value.type === 'image' ? [value] : value.type === 'image-group' && Array.isArray(value.items) && value.items.length === 2 ? value.items : []
  if (!items.length) throw new Error('配图需要 image 或含两个条目的 image-group')
  return items.map((item: any) => {
    if (typeof item?.query !== 'string' || item.query.trim().length < 2 || item.query.length > 200) throw new Error('搜索词需要 2–200 字')
    return {query: item.query.trim(), alt: typeof item.alt === 'string' ? item.alt.slice(0, 200) : item.query.trim()}
  })
}


export function withWebImageCapabilities(prompt: string, imagePrompt = WEB_IMAGE_PROMPT): string {
  const runtime = '当前阅读器运行时能力：Firecrawl 已配置，image 与 image-group 已启用。当前请求以本段能力清单为准。用户请求配图、搜图或测试图片时，直接输出带 query 的图片节点；阅读器收到节点后自动调用 Firecrawl 并显示首张。模型负责生成节点，阅读器负责联网请求、图片加载及来源展示。'
  const catalog = '\nimage: query*:string（2–200字搜索词）,alt:string；用途：搜索并显示首张图片，可作为 card/grid 子节点。\nimage-group: items*:[{query*:string,alt:string},{query*:string,alt:string}]；用途：两个位置各搜索首张并排展示。'
  const marker = '组件字段目录'
  const index = prompt.indexOf(marker)
  const lineEnd = index < 0 ? -1 : prompt.indexOf('\n',index)
  const integrated = lineEnd < 0 ? prompt + catalog : prompt.slice(0,lineEnd) + catalog + prompt.slice(lineEnd)
  return runtime + '\n\n' + integrated + '\n\n' + imagePrompt
}

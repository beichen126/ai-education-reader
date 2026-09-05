import type { ArtifactKind, TransformationPreset } from './artifact-types'

/**
 * Transformation prompt presets. Default prompts MUST live here, never scattered
 * through JSX. Users may edit / replace them before generation; the ACTUAL prompt
 * used is stored on the Artifact record for reproducibility.
 */
export const TRANSFORMATION_PRESETS: readonly TransformationPreset[] = [
  {
    id: 'note',
    kind: 'note',
    label: '整理成笔记',
    description: '把截至当前点的对话内容整理为一份结构化的学习笔记。',
    defaultPrompt: '请把以下学习内容整理成一份结构清晰的中文学习笔记。要求：保留关键概念、定义、公式与例子；按主题分小节，善用标题与要点；适当补充易错点与记忆提示；用 Markdown 输出。',
  },
  {
    id: 'quiz',
    kind: 'quiz',
    label: '生成题目',
    description: '基于截至当前点的内容生成一份练习题目（单选/多选/判断/简答）。',
    defaultPrompt: [
      '请根据下面的学习内容生成一份练习题目。',
      '只输出一个合法的 JSON 对象，不要 Markdown 代码围栏，不要附加任何解释文字。',
      '唯一允许的结构是：',
      '{"questions":[{"id":"q1","type":"single-choice","question":"...","options":["...","...","...","..."],"answer":1}]}',
      '',
      '类型与字段规则：',
      '- single-choice：字段为 options(string[]) 与 answer(number)。answer 为正确选项下标，从 0 开始。',
      '- multiple-choice：字段为 options(string[]) 与 answers(number[])。answers 为所有正确选项下标（请用冒号分隔的数组，如 [0,2]）。',
      '- true-false：字段为 answer(boolean)。',
      '- short-answer：字段为 answer(string)，作为参考答案。',
      '',
      '每条 question 必须包含 id（每道题唯一）、question；option 下标一律从 0 开始。',
      '题目数量建议 4~8 道，覆盖所给内容的关键概念；options 至少 2 个、至多 26 个。',
      '不要输出结构之外的任何字段；不要输出任何解释性文字。',
    ].join('\n'),
  },
  {
    id: 'summary',
    kind: 'summary',
    label: '生成总结',
    description: '提炼截至当前点内容的核心要点与结论。',
    defaultPrompt: '请把下面的学习内容总结成一份简明扼要的中文要点总结。列出核心结论、关键公式与待复习点，控制在 300 字以内，用 Markdown 输出。',
  },
  {
    id: 'study-guide',
    kind: 'study-guide',
    label: '生成学习指南',
    description: '把截至当前点的内容组织成一份可循的复习/学习指南。',
    defaultPrompt: '请把下面的学习内容整理成一份学习指南：先给出知识框架，再按重点/难点/考点分层，最后给出建议的学习顺序与自查问题。用 Markdown 输出。',
  },
  {
    id: 'custom',
    kind: 'custom',
    label: '自定义处理',
    description: '用你自己的提示词对截至当前点的内容做任意加工。',
    defaultPrompt: '请对下面的学习内容执行如下处理：',
  },
];

export function presetById(id: string): TransformationPreset | undefined {
  return TRANSFORMATION_PRESETS.find((p) => p.id === id)
}

export function presetForKind(kind: ArtifactKind): TransformationPreset | undefined {
  return TRANSFORMATION_PRESETS.find((p) => p.kind === kind)
}

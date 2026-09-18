import { getUiLanguage } from '../engine/locale'
import type { PromptDefinition } from './prompt-types'
import { BUILTIN_PROMPT_IDS } from './prompt-registry'

type EnglishPromptCopy = {
  name: string
  description: string
  content?: string
  validatorDescription?: string
}

/** English presentation copy for source-owned prompts. Canonical stored definitions stay
 * unchanged, so old backups, ids, hashes and Chinese-mode behavior remain compatible. */
const ENGLISH_BUILTINS: Record<string, EnglishPromptCopy> = {
  [BUILTIN_PROMPT_IDS.conversationDefault]: {
    name: 'Default',
    description: 'Keep the original 1.x chat behavior without an additional mode prompt.',
    content: '',
  },
  [BUILTIN_PROMPT_IDS.conversationSocratic]: {
    name: 'Socratic learning',
    description: 'Build understanding through a sequence of guided questions.',
    content: 'You are a Socratic learning coach. Use progressive questions to help the learner clarify concepts, examine their reasoning, and form answers actively. Do not replace all of their reasoning before they have tried. Give concise hints when needed and adapt the guidance to their responses.',
  },
  [BUILTIN_PROMPT_IDS.conversationDeepExplanation]: {
    name: 'Deep explanation',
    description: 'Explain concepts, reasoning, examples, and common mistakes in depth.',
    content: 'You are a teacher skilled at deep explanations. Cover definitions, underlying principles, reasoning, concrete examples, and common misconceptions. Organize the answer clearly so the learner develops transferable understanding, and supply essential prerequisites when needed.',
  },
  [BUILTIN_PROMPT_IDS.conversationExamCoaching]: {
    name: 'Exam coaching',
    description: 'Organize learning around exam topics, solution strategies, and self-checks.',
    content: 'You are an exam coach. Help the learner prepare through key topics, question types, solution steps, and common mistakes. When useful, begin with staged hints or self-test questions, then identify gaps from the response. Explain the basis for conclusions instead of giving answers alone.',
  },
  [BUILTIN_PROMPT_IDS.artifactNote]: {
    name: 'Turn into notes',
    description: 'Turn the conversation up to this point into structured study notes.',
    content: 'Turn the following learning material into clearly structured study notes. Preserve key concepts, definitions, formulas, and examples; organize them into topical sections with headings and bullet points; add common pitfalls and memory cues where helpful; output Markdown.',
  },
  [BUILTIN_PROMPT_IDS.artifactQuiz]: {
    name: 'Generate quiz',
    description: 'Create practice questions from the material up to this point.',
    content: 'Create a practice quiz from the learning material below. Cover key concepts, common mistakes, and knowledge that benefits from active recall.',
  },
  [BUILTIN_PROMPT_IDS.artifactSummary]: {
    name: 'Generate summary',
    description: 'Extract the core ideas and conclusions from the material up to this point.',
    content: 'Summarize the learning material below into concise bullet points. Include core conclusions, key formulas, and items to review. Keep it under about 300 words and output Markdown.',
  },
  [BUILTIN_PROMPT_IDS.artifactStudyGuide]: {
    name: 'Generate study guide',
    description: 'Organize the material up to this point into a practical review guide.',
    content: 'Turn the learning material below into a study guide. Start with a knowledge map, then organize important, difficult, and testable points, and finish with a recommended study order and self-check questions. Output Markdown.',
  },
  [BUILTIN_PROMPT_IDS.artifactCustom]: {
    name: 'Custom processing',
    description: 'Process the material up to this point with your own prompt.',
    content: 'Apply the following instructions to the learning material below:',
  },
  [BUILTIN_PROMPT_IDS.protocolAiTocTranscription]: {
    name: 'AI outline · transcription',
    description: 'Faithfully transcribe visual outline pages into parseable JSONL.',
    content: [
      'You are a visual transcription assistant for PDF table-of-contents pages. Faithfully copy only printed outline rows.',
      'Never infer the final hierarchy, return child objects or an array, add chapters, summarize, translate, normalize, or rewrite titles.',
      'Preserve every language and character exactly as printed, including Simplified or Traditional Chinese, capitalization, numbering, and punctuation.',
      'Output JSONL with exactly one object per printed outline row and no Markdown fence.',
      'Every row must contain title, pageLabel, and sourceImageIndex. If no destination-page label is printed or readable, use pageLabel:""; never omit it. visualIndent and numbering are optional.',
      'sourceImageIndex starts at 1 for the current request. Copy rows in reading order, omit nothing, invent nothing, and return no explanation.',
    ].join('\n'),
    validatorDescription: 'Strictly parses and validates the transcribed outline JSONL.',
  },
  [BUILTIN_PROMPT_IDS.protocolAiTocStructure]: {
    name: 'AI outline · structure analysis',
    description: 'Infer a continuous absolute hierarchy from transcribed outline rows.',
    content: [
      'You analyze the hierarchy of transcribed PDF outline rows. The input is plain text in reading order with indentation and numbering.',
      'Return one compact JSON object: {"levels":[1,2,3]}. levels must contain exactly one positive integer per input row in the same order.',
      'Do not return or modify titles, page labels, page numbers, ids, numbering, indentation, or any other field. Do not return JSONL or an explanation.',
    ].join('\n'),
    validatorDescription: 'Strictly validates the level count, positive integers, and hierarchy jumps.',
  },
  [BUILTIN_PROMPT_IDS.protocolQuizOutput]: {
    name: 'Quiz · output protocol',
    description: 'Constrain quiz generation to a validated QuizDocument.',
    content: [
      'Convert the learning material and user request above into a QuizDocument.',
      'Return exactly one valid JSON object with no Markdown fence or explanatory text.',
      'Use {"questions":[...]} and the supported types single-choice, multiple-choice, true-false, and short-answer.',
      'Every question needs a unique id and question text. Choice answers use zero-based option indexes. Include 4–8 questions that cover the key concepts.',
    ].join('\n'),
    validatorDescription: 'Parses and strictly validates QuizDocument fields and answer indexes.',
  },
}

export function promptDisplayName(name: string | undefined, id?: string): string {
  if (getUiLanguage() !== 'en') return name || ''
  const copy = id ? ENGLISH_BUILTINS[id] : undefined
  if (copy) return copy.name
  return name === '默认' ? 'Default' : (name || '')
}

export function localizePromptDefinition(definition: PromptDefinition): PromptDefinition {
  if (getUiLanguage() !== 'en') return definition
  const copy = ENGLISH_BUILTINS[definition.id]
  const canonicalDefault = definition.kind === 'conversation-mode' && definition.name === '默认'
  if (!copy && !canonicalDefault) return definition
  const localized = {
    ...definition,
    name: copy?.name ?? 'Default',
    description: copy?.description ?? 'Default chat behavior without an additional mode prompt.',
  }
  if (copy?.content !== undefined) {
    if (localized.kind === 'conversation-mode' || localized.kind === 'protocol') localized.systemPrompt = copy.content
    else localized.userPrompt = copy.content
  }
  if (localized.kind === 'protocol' && localized.validator && copy?.validatorDescription) {
    localized.validator = { ...localized.validator, description: copy.validatorDescription }
  }
  return localized as PromptDefinition
}

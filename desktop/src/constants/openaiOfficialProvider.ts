import type { ModelInfo } from '../types/settings'

export const OPENAI_OFFICIAL_PROVIDER_ID = 'openai-official'
export const OPENAI_OFFICIAL_DEFAULT_MODEL_ID = 'gpt-5.3-codex'
export const OPENAI_OFFICIAL_PROVIDER_NAME = 'ChatGPT Official'

export const OPENAI_OFFICIAL_MODELS: ModelInfo[] = [
  {
    id: OPENAI_OFFICIAL_DEFAULT_MODEL_ID,
    name: 'GPT-5.3 Codex',
    description: 'Best for coding and agentic work',
    context: '258k',
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    description: 'Strong general-purpose model',
    context: '950k',
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    description: 'Latest general-purpose model',
    context: '258k',
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    description: 'Fastest for quick tasks',
    context: '258k',
  },
]

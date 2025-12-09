import { AnthropicProvider } from './anthropic/client';
import { OpenAIChatCompletionProvider } from './openai/chat-completion-client';
import type {
  ApiProvider,
  ProviderConfig,
  ProviderDefinition,
} from './interface';

export const PROVIDERS: Record<ProviderType, ProviderDefinition> = {
  anthropic: {
    type: 'anthropic',
    label: 'Anthropic Messages API',
    description: '/v1/messages',
    supportMimics: ['claude-code'],
    class: AnthropicProvider,
  },
  'openai-chat-completion': {
    type: 'openai-chat-completion',
    label: 'OpenAI Chat Completion API',
    description: '/v1/chat/completions',
    supportMimics: [],
    class: OpenAIChatCompletionProvider,
  },
};

/**
 * Valid provider types
 */
export const PROVIDER_TYPES = Object.keys(PROVIDERS) as ProviderType[];

export const MIMIC_LABELS: Record<Mimic, string> = {
  'claude-code': 'Claude Code',
};

/**
 * Supported provider types
 */
export type ProviderType = 'anthropic' | 'openai-chat-completion';

/**
 * Provider mimic options
 */
export type Mimic = 'claude-code';

export function createProvider(provider: ProviderConfig): ApiProvider {
  const definition = PROVIDERS[provider.type];
  if (!definition) {
    throw new Error(`Unsupported provider type: ${provider.type}`);
  }
  return new definition.class(provider);
}

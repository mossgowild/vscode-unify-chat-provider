import { ModelConfig, ProviderConfig } from './client/interface';
import { getBaseModelId } from './model-id-utils';

export enum FeatureId {
  /**
   * @see https://platform.claude.com/docs/en/build-with-claude/extended-thinking#interleaved-thinking
   */
  AnthropicInterleavedThinking = 'anthropic_interleaved-thinking',
  /**
   * @see https://docs.anthropic.com/en/docs/build-with-claude/tool-use/web-search-tool
   */
  AnthropicWebSearch = 'anthropic_web-search',
  /**
   * @see https://docs.anthropic.com/en/docs/build-with-claude/tool-use/memory-tool
   */
  AnthropicMemoryTool = 'anthropic_memory-tool',
  /**
   * @see https://community.openai.com/t/developer-role-not-accepted-for-o1-o1-mini-o3-mini/1110750/7
   */
  OpenAIOnlyUseMaxCompletionTokens = 'openai_only-use-max-completion-tokens',
  /**
   * Only sends the thought content after the user's last message.
   * @see https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
   */
  OpenAIConciseReasoning = 'openai_concise-reasoning',
  /**
   * @see https://openrouter.ai/docs/guides/best-practices/prompt-caching
   */
  OpenAICacheControl = 'openai_cache-control',
}

export interface Feature {
  /**
   * Supported model familys, use {@link Array.includes} to check if a family is supported.
   */
  supportedFamilys?: string[];

  /**
   * Supported model IDs, use {@link Array.includes} to check if a model is supported.
   */
  supportedModels?: string[];

  /**
   * Supported provider URL patterns.
   * Can be strings with wildcards (*) or RegExp objects.
   * Examples:
   * - "https://api.anthropic.com" - exact match
   * - "https://*.openai.com" - wildcard match
   * - /^https:\/\/.*\.azure\.com/ - regex match
   */
  supportedProviders?: ProviderPattern[];

  /**
   * Custom checker functions for feature support.
   * If any checker returns true, the feature is considered supported.
   */
  customCheckers?: FeatureChecker[];
}

export const FEATURES: Record<FeatureId, Feature> = {
  [FeatureId.AnthropicInterleavedThinking]: {
    supportedFamilys: [
      'claude-sonnet-4-5',
      'claude-sonnet-4.5',
      'claude-sonnet-4',
      'claude-opus-4-5',
      'claude-opus-4.5',
      'claude-opus-4-1',
      'claude-opus-4.1',
      'claude-opus-4',
    ],
  },
  [FeatureId.AnthropicWebSearch]: {
    supportedFamilys: [
      'claude-sonnet-4-5',
      'claude-sonnet-4.5',
      'claude-sonnet-4',
      'claude-3-7-sonnet',
      'claude-3.7-sonnet',
      'claude-haiku-4-5',
      'claude-haiku-4.5',
      'claude-3-5-haiku',
      'claude-3.5-haiku',
      'claude-opus-4-5',
      'claude-opus-4.5',
      'claude-opus-4-1',
      'claude-opus-4.1',
      'claude-opus-4',
    ],
  },
  [FeatureId.AnthropicMemoryTool]: {
    supportedFamilys: [
      'claude-sonnet-4-5',
      'claude-sonnet-4.5',
      'claude-opus-4-5',
      'claude-opus-4.5',
      'claude-opus-4-1',
      'claude-opus-4.1',
      'claude-opus-4',
    ],
  },
  [FeatureId.OpenAIOnlyUseMaxCompletionTokens]: {
    supportedFamilys: [
      'codex-mini-latest',
      'gpt-5.1',
      'gpt-5.1-codex',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-mini',
      'gpt-5',
      'gpt-5-codex',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-5-pro',
      'o1',
      'o1-mini',
      'o1-preview',
      'o1-pro',
      'o3',
      'o3-deep-research',
      'o3-mini',
      'o3-pro',
      'o4-mini',
      'o4-mini-deep-research',
      'gpt-oss-120b',
      'gpt-oss-20b',
    ],
  },
  [FeatureId.OpenAIConciseReasoning]: {
    supportedFamilys: ['deepseek-reasoner'],
  },
  [FeatureId.OpenAICacheControl]: {
    supportedFamilys: [
      'claude-sonnet-4-5',
      'claude-sonnet-4.5',
      'claude-sonnet-4',
      'claude-3-7-sonnet',
      'claude-3.7-sonnet',
      'claude-haiku-4-5',
      'claude-haiku-4.5',
      'claude-3-5-haiku',
      'claude-3.5-haiku',
      'claude-3-haiku',
      'claude-opus-4-5',
      'claude-opus-4.5',
      'claude-opus-4-1',
      'claude-opus-4.1',
      'claude-opus-4',
    ],
  },
};

/**
 * Pattern for matching provider URLs.
 * Can be a string with wildcards (*) or a RegExp.
 */
export type ProviderPattern = string | RegExp;

/**
 * Custom checker function for feature support.
 * Returns true if the feature should be enabled.
 */
export type FeatureChecker = (
  model: ModelConfig,
  provider: ProviderConfig,
) => boolean;

/**
 * Match a URL against a provider pattern.
 * @param url The URL to match
 * @param pattern The pattern to match against (string with wildcards or RegExp)
 * @returns true if the URL matches the pattern
 */
function matchProviderPattern(url: string, pattern: ProviderPattern): boolean {
  if (pattern instanceof RegExp) {
    return pattern.test(url);
  }

  // Convert wildcard string to regex
  // Escape special regex characters except *
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Convert * to regex pattern (match any characters)
  const regexStr = `^${escaped.replace(/\*/g, '.*')}$`;
  const regex = new RegExp(regexStr);
  return regex.test(url);
}

/**
 * Check if a feature is supported by a specific model and provider.
 * @param featureId The feature ID to check
 * @param model The model configuration
 * @param provider The provider configuration
 * @returns true if the feature is supported
 */
export function isFeatureSupported(
  featureId: FeatureId,
  provider: ProviderConfig,
  model: ModelConfig,
): boolean {
  const feature = FEATURES[featureId];
  if (!feature) {
    return false;
  }

  // Check custom checkers first - if any returns true, feature is supported
  if (feature.customCheckers?.some((checker) => checker(model, provider))) {
    return true;
  }

  // Check supported providers
  if (
    feature.supportedProviders?.some((pattern) =>
      matchProviderPattern(provider.baseUrl, pattern),
    )
  ) {
    return true;
  }

  // Check supported models
  const baseId = getBaseModelId(model.id);
  if (baseId && feature.supportedModels?.some((v) => baseId.includes(v))) {
    return true;
  }

  // Check supported families
  const family = model.family ?? baseId;
  if (family && feature.supportedFamilys?.some((v) => family.includes(v))) {
    return true;
  }

  return false;
}

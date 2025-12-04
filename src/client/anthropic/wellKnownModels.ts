import type { ModelConfig } from '../../types';

/**
 * Well-known Anthropic models configuration
 * This array contains pre-configured settings for popular Anthropic Claude models
 */
export const ANTHROPIC_WELL_KNOWN_MODELS: ModelConfig[] = [
  {
    id: 'claude-opus-4-20250514',
    name: 'Claude Opus 4',
    maxInputTokens: 200000,
    maxOutputTokens: 32000,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet',
    maxInputTokens: 200000,
    maxOutputTokens: 8000,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-5-haiku-20241022',
    name: 'Claude 3.5 Haiku',
    maxInputTokens: 200000,
    maxOutputTokens: 8000,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-opus-20240229',
    name: 'Claude 3 Opus',
    maxInputTokens: 200000,
    maxOutputTokens: 4000,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-sonnet-20240229',
    name: 'Claude 3 Sonnet',
    maxInputTokens: 200000,
    maxOutputTokens: 4000,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
  {
    id: 'claude-3-haiku-20240307',
    name: 'Claude 3 Haiku',
    maxInputTokens: 200000,
    maxOutputTokens: 4000,
    capabilities: {
      toolCalling: true,
      imageInput: true,
    },
  },
];

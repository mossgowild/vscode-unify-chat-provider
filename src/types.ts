/**
 * Supported provider types
 */
export type ProviderType = 'anthropic';

/**
 * Configuration for a single provider endpoint
 */
export interface ProviderConfig {
  /** Provider type (determines API format) */
  type: ProviderType;
  /** Unique name for this provider */
  name: string;
  /** Base URL for the API (e.g., https://api.anthropic.com) */
  baseUrl: string;
  /** API key for authentication */
  apiKey?: string;
  /** List of available model IDs */
  models: ModelConfig[];
}

/**
 * Model capabilities configuration
 */
export interface ModelCapabilities {
  /** Whether the model supports tool/function calling */
  toolCalling?: boolean;
  /** Whether the model supports image input */
  imageInput?: boolean;
}

/**
 * Configuration for a single model
 */
export interface ModelConfig {
  /** Model ID (e.g., claude-sonnet-4-20250514) */
  id: string;
  /** Display name for the model */
  name?: string;
  /** Maximum input tokens */
  maxInputTokens?: number;
  /** Maximum output tokens */
  maxOutputTokens?: number;
  /** Model capabilities */
  capabilities?: ModelCapabilities;
}

/**
 * Extension configuration stored in workspace settings
 */
export interface ExtensionConfiguration {
  endpoints: ProviderConfig[];
  verbose: boolean;
}

/**
 * Common interface for all API clients
 */
export interface ApiClient {
  /**
   * Stream a chat response
   */
  streamChat(
    messages: unknown[],
    modelId: string,
    options: {
      maxTokens?: number;
      system?: string;
      tools?: unknown[];
    },
    token: import('vscode').CancellationToken,
  ): AsyncGenerator<
    | import('vscode').LanguageModelTextPart
    | import('vscode').LanguageModelToolCallPart
  >;

  /**
   * Convert VS Code messages to the client's format
   */
  convertMessages(
    messages: readonly import('vscode').LanguageModelChatMessage[],
  ): { system?: string; messages: unknown[] };

  /**
   * Convert VS Code tools to the client's format
   */
  convertTools(
    tools: readonly import('vscode').LanguageModelChatTool[],
  ): unknown[];

  /**
   * Estimate token count for text
   */
  estimateTokenCount(text: string): number;

  /**
   * Get available models from the provider
   * Returns a list of model configurations supported by this API client
   */
  getAvailableModels?(): Promise<ModelConfig[]>;
}

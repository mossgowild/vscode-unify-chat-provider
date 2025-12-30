import * as vscode from 'vscode';
import { ConfigStore } from './config-store';
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from './defaults';
import { ApiProvider } from './client/interface';
import { createRequestLogger } from './logger';
import { ModelConfig, PerformanceTrace, ProviderConfig } from './types';
import { getBaseModelId } from './model-id-utils';
import { createProvider } from './client/utils';
import { formatModelDetail } from './ui/form-utils';
import { getAllModelsForProvider } from './utils';
import { ApiKeySecretStore } from './api-key-secret-store';
import { t } from './i18n';

export class UnifyChatService implements vscode.LanguageModelChatProvider {
  private readonly clients = new Map<string, ApiProvider>();
  private readonly onDidChangeModelInfoEmitter =
    new vscode.EventEmitter<void>();

  readonly onDidChangeLanguageModelChatInformation =
    this.onDidChangeModelInfoEmitter.event;

  constructor(
    private readonly configStore: ConfigStore,
    private readonly apiKeyStore: ApiKeySecretStore,
  ) {}

  /**
   * Provide information about available models
   */
  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const models: vscode.LanguageModelChatInformation[] = [];

    for (const provider of this.configStore.endpoints) {
      const allModels = await getAllModelsForProvider(provider);
      for (const model of allModels) {
        models.push(this.createModelInfo(provider, model));
      }
    }

    // If no models configured and not silent, prompt user to add a provider
    if (models.length === 0 && !options.silent) {
      vscode.commands.executeCommand('unifyChatProvider.manageProviders');
    }

    return models;
  }

  /**
   * Create model information object
   */
  private createModelInfo(
    provider: ProviderConfig,
    model: ModelConfig,
  ): vscode.LanguageModelChatInformation {
    const modelId = this.createModelId(provider.name, model.id);

    return {
      id: modelId,
      name: model.name ?? model.id,
      family: model.family ?? getBaseModelId(model.id),
      version: '1.0.0',
      maxInputTokens: model.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: {
        toolCalling: model.capabilities?.toolCalling ?? false,
        imageInput: model.capabilities?.imageInput ?? false,
      },
      category: {
        label: provider.name,
        order: 2,
      },
      detail: provider.name,
      tooltip: formatModelDetail(model),
      isUserSelectable: true,
    };
  }

  /**
   * Create a unique model ID combining provider and model names
   */
  private createModelId(providerName: string, modelId: string): string {
    return `${this.encodeProviderName(providerName)}/${modelId}`;
  }

  /**
   * Parse model ID to extract provider and model names
   */
  private parseModelId(
    modelId: string,
  ): { providerName: string; modelName: string } | null {
    const slashIndex = modelId.indexOf('/');
    if (slashIndex === -1) {
      return null;
    }
    return {
      providerName: modelId.slice(0, slashIndex),
      modelName: modelId.slice(slashIndex + 1),
    };
  }

  /**
   * Encode provider name for use in model ID (reversible via decodeURIComponent)
   */
  private encodeProviderName(name: string): string {
    return encodeURIComponent(name);
  }

  private decodeProviderName(encodedName: string): string | null {
    try {
      return decodeURIComponent(encodedName);
    } catch {
      return null;
    }
  }

  /**
   * Find provider and model configuration by model ID
   */
  private async findProviderAndModel(
    modelId: string,
  ): Promise<{ provider: ProviderConfig; model: ModelConfig } | null> {
    const parsed = this.parseModelId(modelId);
    if (!parsed) {
      return null;
    }

    const decodedProviderName = this.decodeProviderName(parsed.providerName);
    if (!decodedProviderName) {
      return null;
    }

    const provider = this.configStore.endpoints.find(
      (p) => p.name === decodedProviderName,
    );
    if (!provider) {
      return null;
    }

    const allModels = await getAllModelsForProvider(provider);
    const model = allModels.find((m) => m.id === parsed.modelName);
    if (model) {
      return { provider, model };
    }

    return null;
  }

  /**
   * Get or create client for a provider
   */
  private getClient(provider: ProviderConfig): ApiProvider {
    let client = this.clients.get(provider.name);
    if (!client) {
      client = createProvider(provider);
      this.clients.set(provider.name, client);
    }
    return client;
  }

  private async resolveProvider(
    provider: ProviderConfig,
  ): Promise<ProviderConfig> {
    const status = await this.apiKeyStore.getStatus(provider.apiKey);

    if (status.kind === 'unset' || status.kind === 'plain') {
      return provider;
    }

    if (status.kind === 'secret') {
      return { ...provider, apiKey: status.apiKey };
    }

    const confirm = await vscode.window.showErrorMessage(
      t('API key for provider "{0}" is missing. Please re-enter it to continue.', provider.name),
      { modal: true },
      t('Re-enter API Key'),
    );
    if (confirm !== t('Re-enter API Key')) {
      throw new Error(
        t('API key for provider "{0}" is missing. Please re-enter it and try again.', provider.name),
      );
    }

    const entered = await vscode.window.showInputBox({
      title: t('API Key ({0})', provider.name),
      prompt: t('Enter the API key for "{0}"', provider.name),
      password: true,
      ignoreFocusOut: true,
    });
    const apiKey = entered?.trim();
    if (!apiKey) {
      throw new Error(
        t('API key for provider "{0}" is missing. Please re-enter it and try again.', provider.name),
      );
    }

    if (this.configStore.storeApiKeyInSettings) {
      const updated = this.configStore.endpoints.map((p) =>
        p.name === provider.name ? { ...p, apiKey } : p,
      );
      await this.configStore.setEndpoints(updated);
      this.clients.delete(provider.name);
      return { ...provider, apiKey };
    }

    await this.apiKeyStore.set(status.ref, apiKey);
    this.clients.delete(provider.name);
    return { ...provider, apiKey };
  }

  /**
   * Handle chat request and stream response
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const logger = createRequestLogger();
    const performanceTrace: PerformanceTrace = {
      tts: Date.now(),
      tl: 0,
      tps: 0,
      ttf: 0,
      ttft: 0,
    };

    const found = await this.findProviderAndModel(model.id);
    if (!found) {
      throw new Error(`Model not found: ${model.id}`);
    }

    const { provider: _provider, model: modelConfig } = found;
    const provider = await this.resolveProvider(_provider);

    logger.start({
      providerName: provider.name,
      providerType: provider.type,
      baseUrl: provider.baseUrl,
      vscodeModelId: model.id,
      modelId: modelConfig.id,
      modelName: modelConfig.name,
    });
    logger.vscodeInput(messages, options);

    const client = this.getClient(provider);

    // Stream the response
    const stream = client.streamChat(
      model.id,
      modelConfig,
      messages,
      options,
      performanceTrace,
      token,
      logger,
    );

    try {
      for await (const part of stream) {
        if (token.isCancellationRequested) {
          break;
        }
        // Log VSCode output (verbose only)
        logger.vscodeOutput(part);
        progress.report(part);
      }
    } catch (error) {
      // sometimes, the chat panel in VSCode does not display the specific error,
      // but instead shows the output from `stackTrace.format`.
      logger.error(error);
      throw error;
    }

    performanceTrace.tl = Date.now() - performanceTrace.tts;
    logger.complete(performanceTrace);
  }

  /**
   * Provide token count estimation
   */
  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const found = await this.findProviderAndModel(model.id);

    // Extract text content
    let content: string;
    if (typeof text === 'string') {
      content = text;
    } else {
      content = text.content
        .map((part) => {
          if (part instanceof vscode.LanguageModelTextPart) {
            return part.value;
          }
          return '';
        })
        .join('');
    }

    // Use client's estimation if available, otherwise use default
    if (found) {
      const provider = await this.resolveProvider(found.provider);
      const client = this.getClient(provider);
      return client.estimateTokenCount(content);
    }

    // Default estimation: ~4 characters per token
    return Math.ceil(content.length / 4);
  }

  /**
   * Clear cached clients (useful when configuration changes)
   */
  clearClients(): void {
    this.clients.clear();
  }

  /**
   * Handle configuration change by clearing cached clients and notifying VS Code
   * that the available language model information has changed.
   */
  handleConfigurationChange(): void {
    this.clearClients();
    this.onDidChangeModelInfoEmitter.fire();
  }

  dispose(): void {
    this.clearClients();
    this.onDidChangeModelInfoEmitter.dispose();
  }
}

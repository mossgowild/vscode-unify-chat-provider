import * as vscode from 'vscode';
import { GoogleAuth } from 'google-auth-library';
import {
  AuthProvider,
  AuthProviderContext,
  AuthProviderDefinition,
  AuthConfigureResult,
  AuthStatusChange,
  AuthStatusViewItem,
  AuthUiStatusSnapshot,
} from '../../auth-provider';
import type {
  GoogleVertexAIAuthConfig,
  GoogleVertexAIAdcConfig,
  GoogleVertexAIServiceAccountConfig,
  GoogleVertexAIApiKeyConfig,
  AuthCredential,
} from '../../types';
import { t } from '../../../i18n';
import {
  createSecretRef,
  isSecretRef,
  type SecretStore,
} from '../../../secret';
import { authLog } from '../../../logger';
import { selectAuthType } from './screens/select-auth-type-screen';
import { configureAdc } from './screens/configure-adc-screen';
import { configureServiceAccount } from './screens/configure-service-account-screen';
import { configureApiKey } from './screens/configure-api-key-screen';

/**
 * Google Vertex AI unified authentication provider.
 * Supports ADC, Service Account JSON key file, and API Key authentication.
 */
export class GoogleVertexAIAuthProvider implements AuthProvider {
  static supportsSensitiveDataInSettings(
    auth: GoogleVertexAIAuthConfig,
  ): boolean {
    return auth.subType === 'api-key' || auth.subType === 'adc';
  }

  // Token cache for ADC and Service Account modes
  private googleAuth: GoogleAuth | null = null;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  private readonly _onDidChangeStatus =
    new vscode.EventEmitter<AuthStatusChange>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  constructor(
    private readonly context: AuthProviderContext,
    private config?: GoogleVertexAIAuthConfig,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Static methods for export/import handling
  // ─────────────────────────────────────────────────────────────────────────

  static redactForExport(
    auth: GoogleVertexAIAuthConfig,
  ): GoogleVertexAIAuthConfig {
    if (auth.subType === 'api-key') {
      return { ...auth, apiKey: undefined };
    }
    return auth;
  }

  static async resolveForExport(
    auth: GoogleVertexAIAuthConfig,
    secretStore: SecretStore,
  ): Promise<GoogleVertexAIAuthConfig> {
    if (auth.subType === 'api-key') {
      const apiKeyConfig = auth as GoogleVertexAIApiKeyConfig;
      if (!apiKeyConfig.apiKey) {
        throw new Error('Missing API key');
      }
      if (isSecretRef(apiKeyConfig.apiKey)) {
        const stored = await secretStore.getApiKey(apiKeyConfig.apiKey);
        if (!stored) {
          throw new Error('Missing API key secret');
        }
        return { ...auth, apiKey: stored };
      }
    }
    return auth;
  }

  static async normalizeOnImport(
    auth: GoogleVertexAIAuthConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: GoogleVertexAIAuthConfig;
    },
  ): Promise<GoogleVertexAIAuthConfig> {
    if (auth.subType === 'api-key') {
      const apiKeyConfig = auth as GoogleVertexAIApiKeyConfig;
      const apiKey = apiKeyConfig.apiKey?.trim();

      if (!apiKey) {
        return { ...auth, apiKey: undefined };
      }

      if (options.storeSecretsInSettings) {
        if (isSecretRef(apiKey)) {
          const stored = await options.secretStore.getApiKey(apiKey);
          return { ...auth, apiKey: stored ?? undefined };
        }
        return auth;
      }

      if (isSecretRef(apiKey)) {
        return auth;
      }

      const existingApiKeyConfig = options.existing as
        | GoogleVertexAIApiKeyConfig
        | undefined;
      const existingRef =
        existingApiKeyConfig?.apiKey && isSecretRef(existingApiKeyConfig.apiKey)
          ? existingApiKeyConfig.apiKey
          : undefined;

      const ref = existingRef ?? createSecretRef();
      await options.secretStore.setApiKey(ref, apiKey);
      return { ...auth, apiKey: ref };
    }
    return auth;
  }

  static async prepareForDuplicate(
    auth: GoogleVertexAIAuthConfig,
    options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<GoogleVertexAIAuthConfig> {
    if (auth.subType === 'api-key') {
      const apiKeyConfig = auth as GoogleVertexAIApiKeyConfig;
      const apiKey = apiKeyConfig.apiKey?.trim();

      if (!apiKey) {
        throw new Error('Missing API key');
      }

      let resolvedKey: string;
      if (isSecretRef(apiKey)) {
        const stored = await options.secretStore.getApiKey(apiKey);
        if (!stored) {
          throw new Error('Missing API key secret');
        }
        resolvedKey = stored;
      } else {
        resolvedKey = apiKey;
      }

      if (options.storeSecretsInSettings) {
        return { ...auth, apiKey: resolvedKey };
      }

      const ref = createSecretRef();
      await options.secretStore.setApiKey(ref, resolvedKey);
      return { ...auth, apiKey: ref };
    }

    return auth;
  }

  static async cleanupOnDiscard(
    auth: GoogleVertexAIAuthConfig,
    secretStore: SecretStore,
  ): Promise<void> {
    if (auth.subType === 'api-key') {
      const apiKeyConfig = auth as GoogleVertexAIApiKeyConfig;
      if (apiKeyConfig.apiKey && isSecretRef(apiKeyConfig.apiKey)) {
        await secretStore.deleteApiKey(apiKeyConfig.apiKey);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Instance methods
  // ─────────────────────────────────────────────────────────────────────────

  get definition(): AuthProviderDefinition {
    const subTypeLabel = this.config?.subType
      ? this.getSubTypeLabel(this.config.subType)
      : undefined;
    return {
      id: 'google-vertex-ai-auth',
      label: this.config?.label ?? t('Google Vertex AI'),
      description:
        this.config?.description ??
        subTypeLabel ??
        t('Authenticate with Google Vertex AI'),
    };
  }

  private getSubTypeLabel(subType: string): string {
    switch (subType) {
      case 'adc':
        return t('Application Default Credentials');
      case 'service-account':
        return t('Service Account');
      case 'api-key':
        return t('API Key');
      default:
        return '';
    }
  }

  getConfig(): GoogleVertexAIAuthConfig | undefined {
    return this.config;
  }

  async getSummaryDetail(): Promise<string | undefined> {
    if (!this.config) {
      return t('Not configured');
    }

    switch (this.config.subType) {
      case 'adc':
        return t('ADC: {0} ({1})', this.config.projectId, this.config.location);
      case 'service-account':
        return t('Service Account: {0}', this.config.location);
      case 'api-key': {
        const hasKey = !!(this.config as GoogleVertexAIApiKeyConfig).apiKey;
        return hasKey ? t('API Key configured') : t('API Key not set');
      }
    }
  }

  async getStatusSnapshot(): Promise<AuthUiStatusSnapshot> {
    if (!this.config) {
      return { kind: 'not-configured' };
    }

    if (this.config.subType === 'api-key') {
      const apiKeyConfig = this.config as GoogleVertexAIApiKeyConfig;
      if (!apiKeyConfig.apiKey) {
        return { kind: 'not-authorized' };
      }
      if (isSecretRef(apiKeyConfig.apiKey)) {
        const stored = await this.context.secretStore.getApiKey(
          apiKeyConfig.apiKey,
        );
        if (!stored) {
          return {
            kind: 'missing-secret',
            message: t('API key not found in storage'),
          };
        }
      }
      return { kind: 'valid' };
    }

    // For ADC and Service Account, we just check configuration validity
    return { kind: 'valid' };
  }

  async getStatusViewItems(): Promise<AuthStatusViewItem[]> {
    const detail = await this.getSummaryDetail();

    const items: AuthStatusViewItem[] = [
      {
        label: `$(key) ${t('Vertex AI Authentication')}`,
        description: this.config?.subType
          ? this.getSubTypeLabel(this.config.subType)
          : t('Not configured'),
        detail,
        action: {
          kind: 'close',
          run: async () => {
            await this.configure();
          },
        },
      },
    ];

    return items;
  }

  async getCredential(): Promise<AuthCredential | undefined> {
    authLog.verbose(
      `${this.context.providerId}:vertex-ai-auth`,
      'Getting credential',
    );

    if (!this.config) {
      authLog.verbose(
        `${this.context.providerId}:vertex-ai-auth`,
        'No config available',
      );
      return undefined;
    }

    switch (this.config.subType) {
      case 'adc':
      case 'service-account': {
        // Check if cached token is still valid
        if (
          this.cachedToken &&
          Date.now() < this.cachedToken.expiresAt - this.getExpiryBufferMs()
        ) {
          authLog.verbose(
            `${this.context.providerId}:vertex-ai-auth`,
            'Using cached token',
          );
          return {
            value: this.cachedToken.value,
            tokenType: 'Bearer',
            expiresAt: this.cachedToken.expiresAt,
          };
        }

        // Fetch new token
        try {
          const token = await this.fetchNewToken();
          this.cachedToken = token;
          authLog.verbose(
            `${this.context.providerId}:vertex-ai-auth`,
            `Token fetched, expires at ${new Date(token.expiresAt).toISOString()}`,
          );
          return {
            value: token.value,
            tokenType: 'Bearer',
            expiresAt: token.expiresAt,
          };
        } catch (error) {
          authLog.error(
            `${this.context.providerId}:vertex-ai-auth`,
            'Token fetch failed',
            error,
          );
          this._onDidChangeStatus.fire({
            status: 'error',
            error: error as Error,
          });
          return undefined;
        }
      }

      case 'api-key': {
        const apiKeyConfig = this.config as GoogleVertexAIApiKeyConfig;
        if (!apiKeyConfig.apiKey) {
          return { value: '' };
        }
        if (isSecretRef(apiKeyConfig.apiKey)) {
          const stored = await this.context.secretStore.getApiKey(
            apiKeyConfig.apiKey,
          );
          if (!stored) {
            authLog.error(
              `${this.context.providerId}:vertex-ai-auth`,
              'API key not found in secret storage',
            );
            return undefined;
          }
          return { value: stored };
        }
        return { value: apiKeyConfig.apiKey };
      }
    }
  }

  getExpiryBufferMs(): number {
    // ADC/Service Account: 5 minute buffer
    // API Key: no expiry
    return this.config?.subType === 'api-key' ? 0 : 5 * 60 * 1000;
  }

  async isValid(): Promise<boolean> {
    if (!this.config) {
      return false;
    }

    if (this.config.subType === 'api-key') {
      const apiKeyConfig = this.config as GoogleVertexAIApiKeyConfig;
      if (!apiKeyConfig.apiKey) {
        return false;
      }
      if (isSecretRef(apiKeyConfig.apiKey)) {
        const stored = await this.context.secretStore.getApiKey(
          apiKeyConfig.apiKey,
        );
        return !!stored;
      }
      return true;
    }

    // For ADC and Service Account, check if we can get a token
    const credential = await this.getCredential();
    return !!credential?.value;
  }

  async configure(): Promise<AuthConfigureResult> {
    authLog.verbose(
      `${this.context.providerId}:vertex-ai-auth`,
      'Starting configuration',
    );

    // Step 1: Select auth type
    const authType = await selectAuthType();
    if (!authType) {
      return { success: false };
    }

    // Step 2: Configure based on type
    let newConfig: GoogleVertexAIAuthConfig | undefined;

    switch (authType) {
      case 'adc':
        newConfig = await configureAdc(
          this.config?.subType === 'adc'
            ? (this.config as GoogleVertexAIAdcConfig)
            : undefined,
        );
        break;
      case 'service-account':
        newConfig = await configureServiceAccount(
          this.config?.subType === 'service-account'
            ? (this.config as GoogleVertexAIServiceAccountConfig)
            : undefined,
        );
        break;
      case 'api-key':
        newConfig = await configureApiKey(
          {
            secretStore: this.context.secretStore,
            providerId: this.context.providerId,
          },
          this.config?.subType === 'api-key'
            ? (this.config as GoogleVertexAIApiKeyConfig)
            : undefined,
        );
        break;
    }

    if (!newConfig) {
      return { success: false };
    }

    // Preserve label/description from existing config
    newConfig.label = this.config?.label;
    newConfig.description = this.config?.description;

    // Clear token cache when config changes
    this.cachedToken = null;
    this.googleAuth = null;

    this.config = newConfig;
    await this.context.persistAuthConfig?.(newConfig);
    this._onDidChangeStatus.fire({ status: 'valid' });

    authLog.verbose(
      `${this.context.providerId}:vertex-ai-auth`,
      `Configuration successful (type: ${authType})`,
    );
    return { success: true, config: newConfig };
  }

  async refresh(): Promise<boolean> {
    authLog.verbose(
      `${this.context.providerId}:vertex-ai-auth`,
      'Refreshing token',
    );

    // Clear cached token to force refresh
    this.cachedToken = null;
    this.googleAuth = null;

    try {
      const credential = await this.getCredential();
      if (credential?.value) {
        this._onDidChangeStatus.fire({ status: 'valid' });
        return true;
      }
    } catch (error) {
      authLog.error(
        `${this.context.providerId}:vertex-ai-auth`,
        'Token refresh failed',
        error,
      );
    }

    this._onDidChangeStatus.fire({ status: 'error' });
    return false;
  }

  async revoke(): Promise<void> {
    authLog.verbose(`${this.context.providerId}:vertex-ai-auth`, 'Revoking');

    if (this.config?.subType === 'api-key') {
      const apiKeyConfig = this.config as GoogleVertexAIApiKeyConfig;
      if (apiKeyConfig.apiKey && isSecretRef(apiKeyConfig.apiKey)) {
        await this.context.secretStore.deleteApiKey(apiKeyConfig.apiKey);
      }
    }

    // Clear token cache
    this.cachedToken = null;
    this.googleAuth = null;

    this.config = undefined;
    this._onDidChangeStatus.fire({ status: 'revoked' });
  }

  dispose(): void {
    this._onDidChangeStatus.dispose();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private methods
  // ─────────────────────────────────────────────────────────────────────────

  private async fetchNewToken(): Promise<{ value: string; expiresAt: number }> {
    if (!this.googleAuth) {
      this.googleAuth = this.createGoogleAuth();
    }

    const client = await this.googleAuth.getClient();
    const tokenResponse = await client.getAccessToken();

    if (!tokenResponse.token) {
      throw new Error('Failed to get access token');
    }

    // Extract expiry from response
    const expiresAt =
      (tokenResponse.res?.data as { expiry_date?: number } | undefined)
        ?.expiry_date ?? Date.now() + 3600 * 1000;

    return {
      value: tokenResponse.token,
      expiresAt,
    };
  }

  private createGoogleAuth(): GoogleAuth {
    if (this.config?.subType === 'adc') {
      const adcConfig = this.config as GoogleVertexAIAdcConfig;
      return new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        projectId: adcConfig.projectId,
      });
    }

    if (this.config?.subType === 'service-account') {
      const saConfig = this.config as GoogleVertexAIServiceAccountConfig;
      return new GoogleAuth({
        keyFilename: saConfig.keyFilePath,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        projectId: saConfig.projectId,
      });
    }

    throw new Error('Invalid auth subType for token fetch');
  }
}

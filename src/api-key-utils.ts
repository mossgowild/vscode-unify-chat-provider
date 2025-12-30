import * as vscode from 'vscode';
import type { ProviderConfig } from './types';
import type { ApiKeySecretStore } from './api-key-secret-store';
import { t } from './i18n';

export const MISSING_API_KEY_FOR_COPY_MESSAGE =
  t('API key is missing. Please re-enter it before exporting the configuration.');

export async function resolveApiKeyForExport(
  apiKeyStore: ApiKeySecretStore,
  rawApiKey: string | undefined,
): Promise<
  | { kind: 'ok'; apiKey: string | undefined }
  | { kind: 'missing-secret' }
> {
  const status = await apiKeyStore.getStatus(rawApiKey);
  if (status.kind === 'unset') return { kind: 'ok', apiKey: undefined };
  if (status.kind === 'plain') return { kind: 'ok', apiKey: status.apiKey };
  if (status.kind === 'secret') return { kind: 'ok', apiKey: status.apiKey };
  return { kind: 'missing-secret' };
}

export async function resolveApiKeyForExportOrShowError(
  apiKeyStore: ApiKeySecretStore,
  config: { apiKey?: string },
  message: string = MISSING_API_KEY_FOR_COPY_MESSAGE,
): Promise<boolean> {
  const resolved = await resolveApiKeyForExport(apiKeyStore, config.apiKey);
  if (resolved.kind === 'missing-secret') {
    vscode.window.showErrorMessage(message, { modal: true });
    return false;
  }
  config.apiKey = resolved.apiKey;
  return true;
}

export async function resolveProvidersForExportOrShowError(options: {
  apiKeyStore: ApiKeySecretStore;
  providers: readonly ProviderConfig[];
  message?: string;
}): Promise<ProviderConfig[] | undefined> {
  const resolvedProviders: ProviderConfig[] = [];
  const missing: string[] = [];

  for (const provider of options.providers) {
    const resolved = await resolveApiKeyForExport(
      options.apiKeyStore,
      provider.apiKey,
    );
    if (resolved.kind === 'missing-secret') {
      missing.push(provider.name);
      continue;
    }
    resolvedProviders.push({ ...provider, apiKey: resolved.apiKey });
  }

  if (missing.length > 0) {
    const message =
      options.message ??
      t('API key is missing for: {0}. Please re-enter before exporting.', missing.join(', '));
    vscode.window.showErrorMessage(message, { modal: true });
    return undefined;
  }

  return resolvedProviders;
}

export async function deleteProviderApiKeySecretIfUnused(options: {
  apiKeyStore: ApiKeySecretStore;
  providers: readonly ProviderConfig[];
  providerName: string;
}): Promise<void> {
  const provider = options.providers.find((p) => p.name === options.providerName);
  const rawApiKey = provider?.apiKey?.trim();
  if (!rawApiKey) return;

  const status = await options.apiKeyStore.getStatus(rawApiKey);
  if (status.kind !== 'secret' && status.kind !== 'missing-secret') {
    return;
  }

  const stillUsed = options.providers.some(
    (p) => p.name !== options.providerName && p.apiKey?.trim() === rawApiKey,
  );
  if (stillUsed) return;

  await options.apiKeyStore.delete(rawApiKey);
}

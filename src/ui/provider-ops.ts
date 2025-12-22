import * as vscode from 'vscode';
import { ConfigStore } from '../config-store';
import {
  deepClone,
  mergePartialByKeys,
  PROVIDER_CONFIG_KEYS,
} from '../config-ops';
import { showValidationErrors } from './component';
import {
  ApiKeySecretStore,
  createApiKeySecretRef,
  isApiKeySecretRef,
} from '../api-key-secret-store';
import { resolveApiKeyForExportOrShowError } from '../api-key-utils';
import {
  normalizeProviderDraft,
  validateProviderForm,
  type ProviderFormDraft,
} from './form-utils';
import { ProviderConfig } from '../types';
import { officialModelsManager } from '../official-models-manager';

async function applyApiKeyStoragePolicy(options: {
  store: ConfigStore;
  apiKeyStore: ApiKeySecretStore;
  provider: ProviderConfig;
  existing?: ProviderConfig;
}): Promise<ProviderConfig> {
  const next = options.provider;
  const storeApiKeyInSettings = options.store.storeApiKeyInSettings;

  const existingRef =
    options.existing?.apiKey && isApiKeySecretRef(options.existing.apiKey)
      ? options.existing.apiKey
      : undefined;

  const status = await options.apiKeyStore.getStatus(next.apiKey);

  if (storeApiKeyInSettings) {
    if (status.kind === 'unset') {
      next.apiKey = undefined;
      return next;
    }
    if (status.kind === 'plain') {
      next.apiKey = status.apiKey;
      return next;
    }
    if (status.kind === 'secret') {
      next.apiKey = status.apiKey;
      return next;
    }
    next.apiKey = status.ref;
    return next;
  }

  // Store in VS Code Secret Storage by default
  if (status.kind === 'unset') {
    next.apiKey = undefined;
    return next;
  }
  if (status.kind === 'plain') {
    const ref = existingRef ?? createApiKeySecretRef();
    await options.apiKeyStore.set(ref, status.apiKey);
    next.apiKey = ref;
    return next;
  }
  if (status.kind === 'secret') {
    next.apiKey = status.ref;
    return next;
  }
  next.apiKey = status.ref;
  return next;
}

export async function saveProviderDraft(options: {
  draft: ProviderFormDraft;
  store: ConfigStore;
  apiKeyStore: ApiKeySecretStore;
  existing?: ProviderConfig;
  originalName?: string;
}): Promise<'saved' | 'invalid'> {
  const errors = validateProviderForm(
    options.draft,
    options.store,
    options.originalName,
  );
  if (errors.length > 0) {
    await showValidationErrors(errors);
    return 'invalid';
  }

  const provider = await applyApiKeyStoragePolicy({
    store: options.store,
    apiKeyStore: options.apiKeyStore,
    provider: normalizeProviderDraft(options.draft),
    existing: options.existing,
  });
  if (options.originalName && provider.name !== options.originalName) {
    await options.store.removeProvider(options.originalName);
  }
  await options.store.upsertProvider(provider);

  // Handle official models state migration
  const sessionId = options.draft._officialModelsSessionId;
  if (sessionId) {
    if (options.draft.autoFetchOfficialModels) {
      await officialModelsManager.migrateDraftToProvider(
        sessionId,
        provider.name,
      );
    } else {
      officialModelsManager.clearDraftSession(sessionId);
    }
  }

  vscode.window.showInformationMessage(
    options.existing
      ? `Provider "${provider.name}" updated.`
      : `Provider "${provider.name}" added.`,
  );
  return 'saved';
}

export async function duplicateProvider(
  store: ConfigStore,
  apiKeyStore: ApiKeySecretStore,
  provider: ProviderConfig,
): Promise<void> {
  let baseName = provider.name;
  let newName = `${baseName} (copy)`;
  let counter = 2;

  while (store.getProvider(newName)) {
    newName = `${baseName} (copy ${counter})`;
    counter++;
  }

  const duplicated = deepClone(provider);
  duplicated.name = newName;

  const ok = await resolveApiKeyForExportOrShowError(
    apiKeyStore,
    duplicated,
    `Provider "${provider.name}" API key is missing. Please re-enter it before duplicating.`,
  );
  if (!ok) return;

  if (!store.storeApiKeyInSettings) {
    if (duplicated.apiKey) {
      const newRef = createApiKeySecretRef();
      await apiKeyStore.set(newRef, duplicated.apiKey);
      duplicated.apiKey = newRef;
    } else {
      duplicated.apiKey = undefined;
    }
  }

  await store.upsertProvider(duplicated);
  vscode.window.showInformationMessage(`Provider duplicated as "${newName}".`);
}

export function buildProviderConfigFromDraft(
  draft: ProviderFormDraft,
): Partial<ProviderConfig> {
  const source: Partial<ProviderConfig> = {
    ...deepClone(draft),
    name: draft.name?.trim() || undefined,
    baseUrl: draft.baseUrl?.trim() || undefined,
    apiKey: draft.apiKey?.trim() || undefined,
    models: draft.models.length > 0 ? deepClone(draft.models) : undefined,
  };

  const config: Partial<ProviderConfig> = {};
  mergePartialByKeys(config, source, PROVIDER_CONFIG_KEYS);
  return config;
}

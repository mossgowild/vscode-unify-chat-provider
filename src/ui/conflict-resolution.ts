import * as vscode from 'vscode';
import { t } from '../i18n';
import type { ConfigStore } from '../config-store';
import type { ModelConfig } from '../types';
import {
  getBaseModelId,
  generateAutoVersion,
  createVersionedModelId,
} from '../model-id-utils';

/**
 * Conflict resolution options
 */
export type ConflictResolution = 'overwrite' | 'rename' | 'cancel';

/**
 * Conflict information for prompting user
 */
export interface ConflictInfo {
  kind: 'provider' | 'model';
  conflicts: string[];
}

/**
 * Prompt user to resolve conflicts with existing configurations.
 */
export async function promptConflictResolution(
  info: ConflictInfo,
): Promise<ConflictResolution> {
  const itemType = info.kind === 'provider' ? t('provider') : t('model');
  const itemField = info.kind === 'provider' ? t('name') : t('ID');
  const conflictList = info.conflicts.map((c) => `• ${c}`).join('\n');

  const message = t('The following {0} {1}s already exist:\n{2}', itemType, itemField, conflictList);

  const overwriteAll = t('Overwrite All');
  const renameAll = t('Rename All');

  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    overwriteAll,
    renameAll,
  );

  if (choice === overwriteAll) return 'overwrite';
  if (choice === renameAll) return 'rename';
  return 'cancel';
}

/**
 * Generate a unique provider name by appending (copy), (copy 2), etc.
 * Reuses the duplicate logic from provider-ops.ts.
 */
export function generateUniqueProviderName(
  baseName: string,
  store: ConfigStore,
): string {
  if (!store.getProvider(baseName)) {
    return baseName;
  }

  let newName = `${baseName} (copy)`;
  let counter = 2;

  while (store.getProvider(newName)) {
    newName = `${baseName} (copy ${counter})`;
    counter++;
  }

  return newName;
}

/**
 * Result of generating unique model ID and name.
 */
export interface UniqueModelResult {
  id: string;
  name?: string;
}

/**
 * Generate a unique model ID and name.
 * ID uses #1, #2 suffix, name uses (1), (2) suffix with matching version.
 * Example: model#1 -> model (1)
 */
export function generateUniqueModelIdAndName(
  modelId: string,
  modelName: string | undefined,
  existingModels: ModelConfig[],
): UniqueModelResult {
  const baseId = getBaseModelId(modelId);
  const version = generateAutoVersion(baseId, existingModels);
  const newId = createVersionedModelId(baseId, version);

  let newName: string | undefined;
  if (modelName) {
    newName = `${modelName} (${version})`;
  }

  return { id: newId, name: newName };
}

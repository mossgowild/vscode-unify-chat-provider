import * as vscode from 'vscode';
import type { ProviderConfig, ModelConfig } from '../types';
import type { ProviderType } from '../client/definitions';
import type { UiContext } from './router/types';
import {
  createProviderDraft,
  formatModelDetail,
  normalizeModelDraft,
  type ProviderFormDraft,
  validateProviderForm,
} from './form-utils';
import {
  mergePartialModelConfig,
  mergePartialProviderConfig,
} from './base64-config';
import { buildFormItems, type FormItem } from './field-schema';
import { providerFormSchema, type ProviderFieldContext } from './provider-fields';
import { modelFormSchema, type ModelFieldContext } from './model-fields';
import { editField } from './field-editors';
import { pickQuickItem } from './component';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasProviderIndicators(value: Record<string, unknown>): boolean {
  return (
    'type' in value ||
    'baseUrl' in value ||
    'models' in value ||
    'apiKey' in value ||
    'mimic' in value ||
    'timeout' in value ||
    'autoFetchOfficialModels' in value
  );
}

export function isProviderConfigInput(
  value: unknown,
): value is Partial<ProviderConfig> {
  return isObjectRecord(value) && hasProviderIndicators(value);
}

export function parseProviderConfigArray(
  value: unknown,
): Partial<ProviderConfig>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const configs: Partial<ProviderConfig>[] = [];

  for (const item of value) {
    if (!isObjectRecord(item)) {
      return undefined;
    }
    if (!isProviderConfigInput(item)) {
      return undefined;
    }
    configs.push(item);
  }

  return configs;
}

export function parseModelConfigArray(
  value: unknown,
): ModelConfig[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models: ModelConfig[] = [];

  for (const item of value) {
    if (typeof item === 'string') {
      models.push({ id: item });
      continue;
    }
    if (!isObjectRecord(item)) {
      return undefined;
    }
    if (isProviderConfigInput(item)) {
      return undefined;
    }
    const draft: ModelConfig = { id: '' };
    mergePartialModelConfig(draft, item as Partial<ModelConfig>);
    models.push(draft);
  }

  return models;
}

export function buildProviderDraftFromConfig(
  config: Partial<ProviderConfig>,
): ProviderFormDraft {
  const draft = createProviderDraft();
  mergePartialProviderConfig(draft, config);
  return draft;
}

type ProviderImportEntry = {
  id: number;
  draft: ProviderFormDraft;
};

type ProviderImportItem = vscode.QuickPickItem & {
  entryId?: number;
};

type ModelImportEntry = {
  id: number;
  model: ModelConfig;
};

type ModelImportItem = vscode.QuickPickItem & {
  entryId?: number;
};

const providerImportSchema = {
  ...providerFormSchema,
  fields: providerFormSchema.fields.filter(
    (field) => field.key !== 'models' && field.key !== 'timeout',
  ),
};

function getProviderDisplayName(
  draft: ProviderFormDraft,
  fallbackIndex: number,
): string {
  const name = draft.name?.trim();
  if (name) return name;
  return `Provider ${fallbackIndex + 1}`;
}

function getModelDisplayName(model: ModelConfig, fallbackIndex: number): string {
  if (model.name?.trim()) return model.name.trim();
  if (model.id?.trim()) return model.id.trim();
  return `Model ${fallbackIndex + 1}`;
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }

  return [...duplicates];
}

async function editProviderDraftInline(
  ctx: UiContext,
  draft: ProviderFormDraft,
): Promise<void> {
  while (true) {
    const apiKeyStatus = await ctx.apiKeyStore.getStatus(draft.apiKey);
    const fieldContext: ProviderFieldContext = {
      store: ctx.store,
      apiKeyStatus,
      storeApiKeyInSettings: ctx.store.storeApiKeyInSettings,
      onEditModels: async () => {},
      onEditTimeout: async () => {},
    };

    const selection = await pickQuickItem<FormItem<ProviderFormDraft>>({
      title: draft.name?.trim()
        ? `Edit Provider (${draft.name.trim()})`
        : 'Edit Provider',
      placeholder: 'Select a field to edit',
      ignoreFocusOut: true,
      items: buildFormItems(
        providerImportSchema,
        draft,
        {
          isEditing: false,
          hasConfirm: false,
          hasExport: false,
          backLabel: '$(check) Done',
        },
        fieldContext,
      ),
    });

    if (!selection || selection.action === 'cancel') {
      return;
    }

    if (selection.field) {
      await editField(providerImportSchema, draft, selection.field, fieldContext);
    }
  }
}

async function editModelDraftInline(options: {
  draft: ModelConfig;
  existingModels: ModelConfig[];
  otherImportedModels: ModelConfig[];
  providerType?: ProviderType;
}): Promise<void> {
  const originalId = options.draft.id;

  while (true) {
    const contextModels = [
      ...options.existingModels,
      ...options.otherImportedModels,
    ];
    const fieldContext: ModelFieldContext = {
      models: contextModels,
      originalId,
      providerType: options.providerType,
    };

    const selection = await pickQuickItem<FormItem<ModelConfig>>({
      title: options.draft.id?.trim()
        ? `Edit Model (${options.draft.id.trim()})`
        : 'Edit Model',
      placeholder: 'Select a field to edit',
      ignoreFocusOut: true,
      items: buildFormItems(modelFormSchema, options.draft, {
        isEditing: false,
        hasConfirm: false,
        hasExport: false,
        backLabel: '$(check) Done',
      }, fieldContext),
    });

    if (!selection || selection.action === 'cancel') {
      return;
    }

    if (selection.field) {
      await editField(modelFormSchema, options.draft, selection.field, fieldContext);
    }
  }
}

export async function selectProvidersForImport(options: {
  ctx: UiContext;
  drafts: ProviderFormDraft[];
  title?: string;
}): Promise<ProviderFormDraft[] | undefined> {
  if (options.drafts.length === 0) return undefined;

  const entries: ProviderImportEntry[] = options.drafts.map((draft, index) => ({
    id: index,
    draft,
  }));

  let selectedIds = new Set(entries.map((entry) => entry.id));

  while (true) {
    const result = await showProviderImportPicker({
      entries,
      selectedIds,
      title: options.title ?? 'Import Providers',
    });

    if (result.kind === 'back') {
      return undefined;
    }

    if (result.kind === 'edit') {
      selectedIds = result.selectedIds;
      const entry = entries.find((item) => item.id === result.entryId);
      if (entry) {
        await editProviderDraftInline(options.ctx, entry.draft);
      }
      continue;
    }

    const selectedEntries = [...result.selectedIds]
      .map((id) => entries.find((entry) => entry.id === id))
      .filter((entry): entry is ProviderImportEntry => !!entry);

    if (selectedEntries.length === 0) {
      vscode.window.showErrorMessage(
        'Select at least one provider to import.',
        { modal: true },
      );
      selectedIds = result.selectedIds;
      continue;
    }

    const selectedDrafts = selectedEntries.map((entry) => entry.draft);
    const names = selectedDrafts.map((draft) => draft.name?.trim() || '');
    const missingNames = names.filter((name) => !name);
    if (missingNames.length > 0) {
      vscode.window.showErrorMessage(
        'Some providers are missing names. Please edit them before importing.',
        { modal: true },
      );
      selectedIds = result.selectedIds;
      continue;
    }

    const existingNames = new Set(
      options.ctx.store.endpoints.map((provider) => provider.name),
    );
    const conflicts = names.filter((name) => existingNames.has(name));
    const duplicates = findDuplicates(names);
    const conflictNames = [...new Set([...conflicts, ...duplicates])];

    if (conflictNames.length > 0) {
      vscode.window.showErrorMessage(
        `Provider name conflicts: ${conflictNames.join(
          ', ',
        )}. Please edit them before importing.`,
        { modal: true },
      );
      selectedIds = result.selectedIds;
      continue;
    }

    const invalidProviders = selectedDrafts.filter(
      (draft) => validateProviderForm(draft, options.ctx.store).length > 0,
    );
    if (invalidProviders.length > 0) {
      const invalidNames = invalidProviders.map((draft, index) =>
        getProviderDisplayName(draft, index),
      );
      vscode.window.showErrorMessage(
        `Some providers are missing required fields: ${invalidNames.join(
          ', ',
        )}. Please edit them before importing.`,
        { modal: true },
      );
      selectedIds = result.selectedIds;
      continue;
    }

    return selectedDrafts;
  }
}

export async function selectModelsForImport(options: {
  models: ModelConfig[];
  existingModels: ModelConfig[];
  providerType?: ProviderType;
  title?: string;
}): Promise<ModelConfig[] | undefined> {
  if (options.models.length === 0) return undefined;

  const entries: ModelImportEntry[] = options.models.map((model, index) => ({
    id: index,
    model,
  }));

  let selectedIds = new Set(entries.map((entry) => entry.id));

  while (true) {
    const result = await showModelImportPicker({
      entries,
      selectedIds,
      title: options.title ?? 'Import Models',
    });

    if (result.kind === 'back') {
      return undefined;
    }

    if (result.kind === 'edit') {
      selectedIds = result.selectedIds;
      const entry = entries.find((item) => item.id === result.entryId);
      if (entry) {
        const otherModels = entries
          .filter((item) => item.id !== entry.id)
          .map((item) => item.model);

        await editModelDraftInline({
          draft: entry.model,
          existingModels: options.existingModels,
          otherImportedModels: otherModels,
          providerType: options.providerType,
        });
      }
      continue;
    }

    const selectedEntries = [...result.selectedIds]
      .map((id) => entries.find((entry) => entry.id === id))
      .filter((entry): entry is ModelImportEntry => !!entry);

    if (selectedEntries.length === 0) {
      vscode.window.showErrorMessage(
        'Select at least one model to import.',
        { modal: true },
      );
      selectedIds = result.selectedIds;
      continue;
    }

    const selectedModels = selectedEntries.map((entry) => entry.model);
    const ids = selectedModels.map((model) => model.id?.trim() || '');
    const missingIds = ids.filter((id) => !id);
    if (missingIds.length > 0) {
      vscode.window.showErrorMessage(
        'Some models are missing IDs. Please edit them before importing.',
        { modal: true },
      );
      selectedIds = result.selectedIds;
      continue;
    }

    const existingIds = new Set(options.existingModels.map((model) => model.id));
    const conflicts = ids.filter((id) => existingIds.has(id));
    const duplicates = findDuplicates(ids);
    const conflictIds = [...new Set([...conflicts, ...duplicates])];

    if (conflictIds.length > 0) {
      vscode.window.showErrorMessage(
        `Model ID conflicts: ${conflictIds.join(
          ', ',
        )}. Please edit them before importing.`,
        { modal: true },
      );
      selectedIds = result.selectedIds;
      continue;
    }

    return selectedModels.map((model) => normalizeModelDraft(model));
  }
}

type ProviderPickerResult =
  | { kind: 'back' }
  | { kind: 'edit'; entryId: number; selectedIds: Set<number> }
  | { kind: 'accept'; selectedIds: Set<number> };

async function showProviderImportPicker(options: {
  entries: ProviderImportEntry[];
  selectedIds: Set<number>;
  title: string;
}): Promise<ProviderPickerResult> {
  return new Promise<ProviderPickerResult>((resolve) => {
    const qp = vscode.window.createQuickPick<ProviderImportItem>();
    qp.title = options.title;
    qp.placeholder = 'Select providers to import';
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.buttons = [vscode.QuickInputButtons.Back];

    let resolved = false;
    const finish = (value: ProviderPickerResult) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    qp.items = buildProviderImportItems(options.entries, options.selectedIds);

    qp.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        finish({ kind: 'back' });
        qp.hide();
      }
    });

    qp.onDidTriggerItemButton((event) => {
      const entryId = event.item.entryId;
      if (entryId === undefined) return;

      const selectedIds = new Set(
        qp.selectedItems
          .map((item) => item.entryId)
          .filter((id): id is number => id !== undefined),
      );

      finish({ kind: 'edit', entryId, selectedIds });
      qp.hide();
    });

    qp.onDidAccept(() => {
      const selectedItems = qp.selectedItems;
      const selectedIds = new Set(
        selectedItems
          .map((item) => item.entryId)
          .filter((id): id is number => id !== undefined),
      );

      finish({ kind: 'accept', selectedIds });
      qp.hide();
    });

    qp.onDidHide(() => {
      if (!resolved) {
        finish({ kind: 'back' });
      }
      qp.dispose();
    });

    qp.show();
  });
}

type ModelPickerResult =
  | { kind: 'back' }
  | { kind: 'edit'; entryId: number; selectedIds: Set<number> }
  | { kind: 'accept'; selectedIds: Set<number> };

async function showModelImportPicker(options: {
  entries: ModelImportEntry[];
  selectedIds: Set<number>;
  title: string;
}): Promise<ModelPickerResult> {
  return new Promise<ModelPickerResult>((resolve) => {
    const qp = vscode.window.createQuickPick<ModelImportItem>();
    qp.title = options.title;
    qp.placeholder = 'Select models to import';
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.buttons = [vscode.QuickInputButtons.Back];

    let resolved = false;
    const finish = (value: ModelPickerResult) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    qp.items = buildModelImportItems(options.entries, options.selectedIds);

    qp.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        finish({ kind: 'back' });
        qp.hide();
      }
    });

    qp.onDidTriggerItemButton((event) => {
      const entryId = event.item.entryId;
      if (entryId === undefined) return;

      const selectedIds = new Set(
        qp.selectedItems
          .map((item) => item.entryId)
          .filter((id): id is number => id !== undefined),
      );

      finish({ kind: 'edit', entryId, selectedIds });
      qp.hide();
    });

    qp.onDidAccept(() => {
      const selectedItems = qp.selectedItems;
      const selectedIds = new Set(
        selectedItems
          .map((item) => item.entryId)
          .filter((id): id is number => id !== undefined),
      );

      finish({ kind: 'accept', selectedIds });
      qp.hide();
    });

    qp.onDidHide(() => {
      if (!resolved) {
        finish({ kind: 'back' });
      }
      qp.dispose();
    });

    qp.show();
  });
}

function buildProviderImportItems(
  entries: ProviderImportEntry[],
  selectedIds: Set<number>,
): ProviderImportItem[] {
  const items: ProviderImportItem[] = [];

  for (const entry of entries) {
    const name = getProviderDisplayName(entry.draft, entry.id);
    const modelNames = entry.draft.models
      .map((m) => m.name || m.id)
      .filter((name): name is string => !!name);
    const detail =
      modelNames.length > 0 ? `Models: ${modelNames.join(', ')}` : 'No models';

    items.push({
      label: name,
      description: entry.draft.baseUrl,
      detail,
      entryId: entry.id,
      picked: selectedIds.has(entry.id),
      buttons: [
        { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Edit provider' },
      ],
    });
  }

  return items;
}

function buildModelImportItems(
  entries: ModelImportEntry[],
  selectedIds: Set<number>,
): ModelImportItem[] {
  const items: ModelImportItem[] = [];

  for (const entry of entries) {
    const label = getModelDisplayName(entry.model, entry.id);
    const description = entry.model.name ? entry.model.id : undefined;

    items.push({
      label,
      description,
      detail: formatModelDetail(entry.model),
      entryId: entry.id,
      picked: selectedIds.has(entry.id),
      buttons: [
        { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Edit model' },
      ],
    });
  }

  return items;
}

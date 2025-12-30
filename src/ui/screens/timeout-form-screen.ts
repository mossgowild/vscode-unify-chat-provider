import * as vscode from 'vscode';
import { pickQuickItem } from '../component';
import { DEFAULT_TIMEOUT_CONFIG } from '../../utils';
import { TimeoutConfig } from '../../types';
import type {
  TimeoutFormRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import { t } from '../../i18n';

interface TimeoutFormItem extends vscode.QuickPickItem {
  action?: 'back' | 'reset';
  field?: 'connection' | 'response';
}

export async function runTimeoutFormScreen(
  _ctx: UiContext,
  route: TimeoutFormRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const timeout = route.timeout;

  const items: TimeoutFormItem[] = [
    { label: `$(arrow-left) ${t('Back')}`, action: 'back' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: `$(clock) ${t('Connection Timeout')}`,
      description: formatTimeoutValue(timeout.connection, 'connection'),
      detail: t('Maximum time to wait for TCP connection to be established'),
      field: 'connection',
    },
    {
      label: `$(clock) ${t('Response Timeout')}`,
      description: formatTimeoutValue(timeout.response, 'response'),
      detail:
        t('Maximum time to wait between data chunks during streaming (resets on each data received)'),
      field: 'response',
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: `$(refresh) ${t('Reset to Defaults')}`, action: 'reset' },
  ];

  const selection = await pickQuickItem<TimeoutFormItem>({
    title: t('Timeout Configuration'),
    placeholder: t('Select a field to edit'),
    ignoreFocusOut: true,
    items,
  });

  if (!selection || selection.action === 'back') {
    route.draft.timeout = hasTimeoutValues(timeout) ? timeout : undefined;
    return { kind: 'pop' };
  }

  if (selection.action === 'reset') {
    route.timeout.connection = undefined;
    route.timeout.response = undefined;
    return { kind: 'stay' };
  }

  if (selection.field) {
    await editTimeoutField(timeout, selection.field);
  }

  return { kind: 'stay' };
}

function formatTimeoutValue(
  value: number | undefined,
  field: 'connection' | 'response',
): string {
  const defaultValue = DEFAULT_TIMEOUT_CONFIG[field];
  if (value === undefined) {
    return t('default ({0})', formatMs(defaultValue));
  }
  return formatMs(value);
}

function formatMs(ms: number): string {
  if (ms >= 60_000) {
    const minutes = ms / 60_000;
    return `${minutes}min`;
  }
  if (ms >= 1_000) {
    const seconds = ms / 1_000;
    return `${seconds}s`;
  }
  return `${ms}ms`;
}

function hasTimeoutValues(timeout: TimeoutConfig): boolean {
  return timeout.connection !== undefined || timeout.response !== undefined;
}

async function editTimeoutField(
  timeout: TimeoutConfig,
  field: 'connection' | 'response',
): Promise<void> {
  const currentValue = timeout[field];
  const defaultValue = DEFAULT_TIMEOUT_CONFIG[field];

  const label =
    field === 'connection' ? t('Connection Timeout') : t('Response Timeout');
  const placeholder = t('Enter timeout in milliseconds (default: {0})', defaultValue);

  const input = await vscode.window.showInputBox({
    title: label,
    prompt: placeholder,
    value: currentValue?.toString() ?? '',
    placeHolder: t('e.g., {0}', defaultValue),
    validateInput: (value) => {
      if (!value.trim()) return null; // Empty is valid (means use default)
      const n = Number(value);
      if (Number.isNaN(n) || n <= 0) {
        return t('Please enter a positive number');
      }
      return null;
    },
  });

  if (input === undefined) {
    return; // Cancelled
  }

  if (!input.trim()) {
    timeout[field] = undefined;
  } else {
    timeout[field] = Number(input);
  }
}

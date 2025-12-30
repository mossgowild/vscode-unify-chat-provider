import { showInput } from '../component';
import { saveProviderDraft } from '../provider-ops';
import type {
  UiContext,
  UiNavAction,
  UiResume,
  WellKnownProviderApiKeyRoute,
} from '../router/types';
import { t } from '../../i18n';

export async function runWellKnownProviderApiKeyScreen(
  ctx: UiContext,
  route: WellKnownProviderApiKeyRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const apiKey = await showInput({
    title: t('API Key'),
    prompt: t('Enter your API key'),
    value: route.draft.apiKey,
    password: true,
    ignoreFocusOut: true,
    showBackButton: true,
  });

  if (apiKey === undefined) {
    return { kind: 'pop' };
  }

  route.draft.apiKey = apiKey.trim() || undefined;

  return {
    kind: 'push',
    route: {
      kind: 'modelList',
      invocation: 'addFromWellKnownProvider',
      models: route.draft.models,
      providerLabel: route.draft.name ?? route.provider.name,
      requireAtLeastOne: false,
      draft: route.draft,
      confirmDiscardOnBack: true,
      onSave: async () =>
        saveProviderDraft({
          draft: route.draft,
          store: ctx.store,
          apiKeyStore: ctx.apiKeyStore,
        }),
      afterSave: 'popToRoot',
    },
  };
}

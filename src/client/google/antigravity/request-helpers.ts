const GEMINI_PREVIEW_LINK = 'https://goo.gle/enable-preview-features';

export const ANTIGRAVITY_BASE_SYSTEM_INSTRUCTION =
  'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type NormalizedSystemInstruction = {
  role?: string;
  parts: Array<Record<string, unknown>>;
};

function normalizeSystemInstructionParts(
  value: unknown,
): NormalizedSystemInstruction | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? { parts: [{ text: trimmed }] } : undefined;
  }

  if (Array.isArray(value)) {
    const parts: Array<Record<string, unknown>> = [];
    for (const item of value) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed.length > 0) {
          parts.push({ text: trimmed });
        }
        continue;
      }
      if (isRecord(item)) {
        if (Object.keys(item).length === 1 && typeof item['text'] === 'string') {
          const trimmed = item['text'].trim();
          if (trimmed.length === 0) {
            continue;
          }
        }
        parts.push(item);
      }
    }
    return parts.length > 0 ? { parts } : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const roleRaw = value['role'];
  const role = typeof roleRaw === 'string' && roleRaw.trim().length > 0 ? roleRaw : undefined;

  const partsRaw = value['parts'];
  if (Array.isArray(partsRaw)) {
    const parts: Array<Record<string, unknown>> = [];
    for (const item of partsRaw) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed.length > 0) {
          parts.push({ text: trimmed });
        }
        continue;
      }
      if (isRecord(item)) {
        if (Object.keys(item).length === 1 && typeof item['text'] === 'string') {
          const trimmed = item['text'].trim();
          if (trimmed.length === 0) {
            continue;
          }
        }
        parts.push(item);
      }
    }
    return parts.length > 0 ? { role, parts } : undefined;
  }

  if (Object.keys(value).length === 1 && typeof value['text'] === 'string') {
    const trimmed = value['text'].trim();
    if (trimmed.length === 0) {
      return undefined;
    }
  }

  return { parts: [value] };
}

export function normalizeAntigravitySystemInstruction(
  payload: Record<string, unknown>,
): void {
  if (!('systemInstruction' in payload)) {
    return;
  }

  const normalized = normalizeSystemInstructionParts(payload['systemInstruction']);
  if (!normalized) {
    delete payload['systemInstruction'];
    return;
  }

  payload['systemInstruction'] = normalized.role
    ? { role: normalized.role, parts: normalized.parts }
    : { parts: normalized.parts };
}

export function applyAntigravitySystemInstruction(
  payload: Record<string, unknown>,
  model: string,
): void {
  const normalizedModel = model.toLowerCase();
  const needsInjection =
    normalizedModel.includes('claude') ||
    normalizedModel.includes('gemini-3-pro') ||
    normalizedModel.includes('gemini-3-flash');
  if (!needsInjection) {
    return;
  }

  const existing = payload['systemInstruction'];
  let existingParts: Array<Record<string, unknown>> = [];
  let existingRecord: Record<string, unknown> | undefined;

  if (typeof existing === 'string') {
    if (existing.length > 0) {
      existingParts = [{ text: existing }];
    }
  } else if (isRecord(existing)) {
    existingRecord = existing;
    const parts = existingRecord['parts'];
    if (Array.isArray(parts)) {
      existingParts = parts.filter(
        (part): part is Record<string, unknown> => isRecord(part),
      );
    }
  }

  const nextParts = [{ text: ANTIGRAVITY_BASE_SYSTEM_INSTRUCTION }, ...existingParts];

  payload['systemInstruction'] = existingRecord
    ? { ...existingRecord, role: 'user', parts: nextParts }
    : { role: 'user', parts: nextParts };
}

export type ThinkingConfig = {
  thinkingBudget?: number;
  thinkingLevel?: string;
  includeThoughts?: boolean;
  include_thoughts?: boolean;
};

export function normalizeThinkingConfig(config: unknown): ThinkingConfig | undefined {
  if (!isRecord(config)) {
    return undefined;
  }

  const budgetRaw = config['thinkingBudget'] ?? config['thinking_budget'];
  const levelRaw = config['thinkingLevel'] ?? config['thinking_level'];
  const includeRaw = config['includeThoughts'] ?? config['include_thoughts'];

  const thinkingBudget =
    typeof budgetRaw === 'number' && Number.isFinite(budgetRaw) ? budgetRaw : undefined;
  const thinkingLevel =
    typeof levelRaw === 'string' && levelRaw.length > 0
      ? levelRaw.toLowerCase()
      : undefined;
  const includeThoughts = typeof includeRaw === 'boolean' ? includeRaw : undefined;

  if (
    thinkingBudget === undefined &&
    thinkingLevel === undefined &&
    includeThoughts === undefined
  ) {
    return undefined;
  }

  const normalized: ThinkingConfig = {};
  if (thinkingBudget !== undefined) {
    normalized.thinkingBudget = thinkingBudget;
  }
  if (thinkingLevel !== undefined) {
    normalized.thinkingLevel = thinkingLevel;
  }
  if (includeThoughts !== undefined) {
    normalized.include_thoughts = includeThoughts;
  }
  return normalized;
}

export interface GeminiApiError {
  code?: number;
  message?: string;
  status?: string;
  [key: string]: unknown;
}

export interface GeminiApiBody {
  response?: unknown;
  error?: GeminiApiError;
  [key: string]: unknown;
}

export function parseGeminiApiBody(rawText: string): GeminiApiBody | null {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      const firstObject = parsed.find((item: unknown) => isRecord(item));
      return firstObject ? (firstObject as GeminiApiBody) : null;
    }
    return isRecord(parsed) ? (parsed as GeminiApiBody) : null;
  } catch {
    return null;
  }
}

function isGeminiThreeModel(target?: string): boolean {
  if (!target) {
    return false;
  }
  return /gemini[\s-]?3/i.test(target);
}

function needsPreviewAccessOverride(
  status: number,
  body: GeminiApiBody,
  requestedModel?: string,
): boolean {
  if (status !== 404) {
    return false;
  }

  if (isGeminiThreeModel(requestedModel)) {
    return true;
  }

  const errorMessage =
    body.error && typeof body.error.message === 'string' ? body.error.message : '';
  return isGeminiThreeModel(errorMessage);
}

export function rewriteGeminiPreviewAccessError(
  body: GeminiApiBody,
  status: number,
  requestedModel?: string,
): GeminiApiBody | null {
  if (!needsPreviewAccessOverride(status, body, requestedModel)) {
    return null;
  }

  const error: GeminiApiError = body.error ?? {};
  const trimmedMessage = typeof error.message === 'string' ? error.message.trim() : '';
  const messagePrefix =
    trimmedMessage.length > 0
      ? trimmedMessage
      : 'Gemini 3 preview features are not enabled for this account.';
  const enhancedMessage = `${messagePrefix} Request preview access at ${GEMINI_PREVIEW_LINK} before using Gemini 3 models.`;

  return {
    ...body,
    error: {
      ...error,
      message: enhancedMessage,
    },
  };
}

export function rewriteGeminiRateLimitError(body: GeminiApiBody): GeminiApiBody | null {
  const error: GeminiApiError = body.error ?? {};
  const isRateLimit = error.code === 429 || error.status === 'RESOURCE_EXHAUSTED';
  if (!isRateLimit) {
    return null;
  }

  const message =
    error.message ??
    'You have exhausted your capacity on this model. Please try again later.';

  return {
    ...body,
    error: {
      ...error,
      message,
    },
  };
}

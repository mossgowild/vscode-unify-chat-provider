import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { GenerateContentResponse, FunctionCallingConfigMode } from '@google/genai';
import type {
  ContentUnion,
  FunctionCallingConfig,
  Part,
  Tool,
} from '@google/genai';
import { GoogleAIStudioProvider } from './ai-studio-client';
import type { RequestLogger } from '../../logger';
import type { AuthTokenInfo } from '../../auth/types';
import { ModelConfig, PerformanceTrace } from '../../types';
import { DEFAULT_TIMEOUT_CONFIG, withIdleTimeout } from '../../utils';
import {
  createCustomFetch,
  getToken,
  getTokenType,
  mergeHeaders,
} from '../utils';
import {
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  CODE_ASSIST_HEADERS,
} from '../../auth/providers/antigravity-oauth/constants';
import { getBaseModelId } from '../../model-id-utils';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPart(value: unknown): value is Part {
  return isRecord(value) && !Array.isArray(value['parts']);
}

function toGenerateContentResponse(
  value: Record<string, unknown>,
): GenerateContentResponse {
  const response = new GenerateContentResponse();
  Object.assign(response, value);
  return response;
}

function extractAntigravityResponsePayload(
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const nested = value['response'];
  if (isRecord(nested)) {
    return nested;
  }

  return value;
}

function sanitizeAntigravityToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return '_';
  }

  let sanitized = trimmed.replace(/[^a-zA-Z0-9_.:-]/g, '_');

  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  if (sanitized.length > 64) {
    sanitized = sanitized.slice(0, 64);
  }

  return sanitized;
}

function cleanJsonSchemaForAntigravity(schema: unknown): unknown {
  const rootRecord = isRecord(schema) ? schema : undefined;
  const rootDefs = (() => {
    const defs = rootRecord?.['$defs'];
    return isRecord(defs) ? defs : undefined;
  })();
  const rootDefinitions = (() => {
    const defs = rootRecord?.['definitions'];
    return isRecord(defs) ? defs : undefined;
  })();

  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(clean);
    }

    if (!isRecord(value)) {
      return value;
    }

    const ref = value['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/')) {
      const [, section, key] = ref.split('/');
      const store =
        section === '$defs'
          ? rootDefs
          : section === 'definitions'
            ? rootDefinitions
            : undefined;

      const resolved = store?.[key];
      if (resolved !== undefined) {
        const merged: Record<string, unknown> = { ...value };
        delete merged['$ref'];
        const cleanedResolved = clean(resolved);
        if (isRecord(cleanedResolved)) {
          return clean({ ...cleanedResolved, ...merged });
        }
        return clean(cleanedResolved);
      }
    }

    const out: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(value)) {
      if (
        k === '$schema' ||
        k === '$id' ||
        k === '$defs' ||
        k === 'definitions' ||
        k === 'default' ||
        k === 'examples' ||
        k === 'title'
      ) {
        continue;
      }

      if (k === '$ref') {
        continue;
      }

      if (k === 'const') {
        const existingEnum = out['enum'];
        if (!Array.isArray(existingEnum)) {
          out['enum'] = [clean(v)];
        }
        continue;
      }

      out[k] = clean(v);
    }

    const propertiesRaw = out['properties'];
    const requiredRaw = out['required'];

    if (isRecord(propertiesRaw) && Array.isArray(requiredRaw)) {
      const propertyNames = new Set(Object.keys(propertiesRaw));

      const validRequired = requiredRaw.filter(
        (prop): prop is string =>
          typeof prop === 'string' && propertyNames.has(prop),
      );

      if (validRequired.length > 0) {
        out['required'] = validRequired;
      } else {
        delete out['required'];
      }
    }

    const typeRaw = out['type'];
    if (
      typeof typeRaw === 'string' &&
      typeRaw.toLowerCase() === 'array' &&
      out['items'] === undefined
    ) {
      out['items'] = { type: 'string' };
    }

    return out;
  };

  const cleanedRoot = clean(schema);
  if (!isRecord(cleanedRoot)) {
    return cleanedRoot;
  }

  const { $defs: _defs, definitions: _definitions, ...rest } = cleanedRoot;
  return rest;
}

function buildSyntheticProjectId(): string {
  const adjectives = ['useful', 'bright', 'swift', 'calm', 'bold'];
  const nouns = ['fuze', 'wave', 'spark', 'flow', 'core'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const randomPart = randomUUID().slice(0, 5).toLowerCase();
  return `${adj}-${noun}-${randomPart}`;
}

const EMPTY_TOOL_SCHEMA_PLACEHOLDER_NAME = '_placeholder';
const EMPTY_TOOL_SCHEMA_PLACEHOLDER_DESCRIPTION = 'Placeholder. Always pass true.';
const GEMINI_3_PRO_MAX_OUTPUT_TOKENS_ANTIGRAVITY = 65535;

function normalizeToolParametersSchema(schema: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(schema) ? { ...schema } : {};
  out['type'] = 'object';

  const propertiesRaw = out['properties'];
  const properties = isRecord(propertiesRaw) ? { ...propertiesRaw } : {};

  if (Object.keys(properties).length === 0) {
    properties[EMPTY_TOOL_SCHEMA_PLACEHOLDER_NAME] = {
      type: 'boolean',
      description: EMPTY_TOOL_SCHEMA_PLACEHOLDER_DESCRIPTION,
    };
  }

  out['properties'] = properties;
  return out;
}

type Gemini3ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

const GEMINI_3_TIER_SUFFIX_PATTERN = /-(minimal|low|medium|high)$/i;
const ANTIGRAVITY_MODEL_PREFIX_PATTERN = /^antigravity-/i;
const IMAGE_MODEL_PATTERN = /image|imagen/i;

function mapThinkingEffortToGemini3ThinkingLevel(
  effort: NonNullable<NonNullable<ModelConfig['thinking']>['effort']>,
): Gemini3ThinkingLevel | undefined {
  switch (effort) {
    case 'minimal':
      return 'minimal';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
      return 'high';
    case 'none':
      return undefined;
  }
}

function resolveAntigravityModelForRequest(
  modelId: string,
  preferredGemini3ThinkingLevel?: Gemini3ThinkingLevel,
): {
  requestModelId: string;
  gemini3ThinkingLevel?: Gemini3ThinkingLevel;
} {
  const trimmed = modelId.trim();
  const withoutPrefix = trimmed.replace(ANTIGRAVITY_MODEL_PREFIX_PATTERN, '');
  const maybeGemini3 = withoutPrefix.toLowerCase().includes('gemini-3');

  // Antigravity model resolver strips Gemini CLI -preview suffixes.
  const withoutPreview = maybeGemini3
    ? withoutPrefix.replace(/-preview$/i, '')
    : withoutPrefix;

  const tierMatch = withoutPreview.match(GEMINI_3_TIER_SUFFIX_PATTERN);
  const tier = ((): Gemini3ThinkingLevel | undefined => {
    const raw = tierMatch?.[1];
    if (!raw) {
      return undefined;
    }
    const lower = raw.toLowerCase();
    switch (lower) {
      case 'minimal':
      case 'low':
      case 'medium':
      case 'high':
        return lower;
      default:
        return undefined;
    }
  })();

  const baseName = tier
    ? withoutPreview.replace(GEMINI_3_TIER_SUFFIX_PATTERN, '')
    : withoutPreview;
  const baseLower = baseName.toLowerCase();

  const isGemini3 = baseLower.includes('gemini-3');
  const isGemini3Pro = baseLower.startsWith('gemini-3-pro');
  const isGemini3Flash = baseLower.startsWith('gemini-3-flash');

  if (!isGemini3) {
    return { requestModelId: withoutPreview };
  }

  // Default thinking level for Gemini 3 models is low in the reference project.
  const effectiveLevel: Gemini3ThinkingLevel =
    preferredGemini3ThinkingLevel ?? tier ?? 'low';

  if (isGemini3Pro) {
    // Antigravity requires tier suffix for Gemini 3 Pro. Default to -low.
    const isImageModel = IMAGE_MODEL_PATTERN.test(withoutPreview);
    const requestModelId = isImageModel
      ? withoutPreview
      : `${baseName}-${effectiveLevel}`;
    return { requestModelId, gemini3ThinkingLevel: effectiveLevel };
  }

  if (isGemini3Flash) {
    // Antigravity uses bare model name + thinkingLevel for Gemini 3 Flash.
    return { requestModelId: baseName, gemini3ThinkingLevel: effectiveLevel };
  }

  // Other Gemini 3 models: keep as-is, but still expose default thinkingLevel.
  return { requestModelId: withoutPreview, gemini3ThinkingLevel: effectiveLevel };
}

type AntigravityFunctionDeclaration = {
  name: string;
  description: string;
  parameters: unknown;
};

type AntigravityTool = {
  functionDeclarations: AntigravityFunctionDeclaration[];
};

export class GoogleAntigravityProvider extends GoogleAIStudioProvider {
  private fallbackProjectId: string | undefined;

  private resolveEndpointBaseUrl(): string {
    const trimmed = this.baseUrl.replace(/\/+$/, '');
    return trimmed.replace(/\/v1internal(?::.*)?$/i, '');
  }

  private resolveProjectId(): string {
    const auth = this.config.auth;
    if (auth?.method === 'antigravity-oauth') {
      const projectId = auth.projectId?.trim();
      if (projectId) {
        return projectId;
      }
    }

    if (!this.fallbackProjectId) {
      this.fallbackProjectId = buildSyntheticProjectId();
    }
    return this.fallbackProjectId;
  }

  private buildAntigravityHeaders(
    credential: AuthTokenInfo,
    modelConfig?: ModelConfig,
    options?: { streaming?: boolean },
  ): Record<string, string> {
    const token = getToken(credential);
    if (!token) {
      throw new Error('Missing OAuth access token for Antigravity');
    }

    const headers = mergeHeaders(token, this.config.extraHeaders, modelConfig?.extraHeaders);

    // Antigravity requires OAuth bearer auth (not x-goog-api-key).
    const tokenType = getTokenType(credential) ?? 'Bearer';
    headers['Authorization'] = `${tokenType} ${token}`;

    // Remove API key headers if present.
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === 'x-api-key' || lower === 'x-goog-api-key') {
        delete headers[key];
      }
    }

    // Required Antigravity headers (match CLIProxy behavior).
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
      headers['User-Agent'] = CODE_ASSIST_HEADERS['User-Agent'];
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'x-goog-api-client')) {
      headers['X-Goog-Api-Client'] = CODE_ASSIST_HEADERS['X-Goog-Api-Client'];
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'client-metadata')) {
      headers['Client-Metadata'] = CODE_ASSIST_HEADERS['Client-Metadata'];
    }

    if (options?.streaming) {
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept')) {
        headers['Accept'] = 'text/event-stream';
      }

      // Enable interleaved thinking streaming for Claude thinking models.
      if (modelConfig?.id.toLowerCase().includes('claude') && modelConfig.id.toLowerCase().includes('thinking')) {
        const headerKey = Object.keys(headers).find(
          (k) => k.toLowerCase() === 'anthropic-beta',
        );
        const existing = headerKey ? headers[headerKey] : undefined;
        const interleaved = 'interleaved-thinking-2025-05-14';
        if (existing) {
          if (!existing.split(',').some((v) => v.trim() === interleaved)) {
            headers[headerKey ?? 'anthropic-beta'] = `${existing},${interleaved}`;
          }
        } else {
          headers['anthropic-beta'] = interleaved;
        }
      }
    }

    return headers;
  }

  private buildAntigravityFunctionCallingConfig(
    mode: vscode.LanguageModelChatToolMode,
    tools: AntigravityTool[] | undefined,
  ): FunctionCallingConfig | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    if (mode !== vscode.LanguageModelChatToolMode.Required) {
      return undefined;
    }

    const allowedFunctionNames = tools
      .flatMap((tool) => tool.functionDeclarations)
      .map((decl) => decl.name)
      .filter((name) => name !== '');

    return {
      mode: FunctionCallingConfigMode.ANY,
      ...(allowedFunctionNames.length > 0
        ? { allowedFunctionNames }
        : undefined),
    };
  }

  private buildSystemInstruction(
    systemInstruction: ContentUnion | undefined,
  ): { role: 'user'; parts: Part[] } {
    const parts: Part[] = (() => {
      if (!systemInstruction) {
        return [];
      }

      const addPartUnion = (value: unknown, output: Part[]): void => {
        if (!value) {
          return;
        }
        if (typeof value === 'string') {
          if (value.trim()) {
            output.push({ text: value });
          }
          return;
        }
        if (isRecord(value) && Array.isArray(value['parts'])) {
          for (const child of value['parts']) {
            addPartUnion(child, output);
          }
          return;
        }
        if (isPart(value)) {
          output.push(value);
        }
      };

      const output: Part[] = [];

      if (Array.isArray(systemInstruction)) {
        for (const item of systemInstruction) {
          addPartUnion(item, output);
        }
        return output;
      }

      addPartUnion(systemInstruction, output);
      return output;
    })();

    const first = parts.at(0);
    if (first && isRecord(first) && typeof first['text'] === 'string' && first['text'].trim()) {
      const text = `${ANTIGRAVITY_SYSTEM_INSTRUCTION}\n\n${first['text'].trim()}`;
      return { role: 'user', parts: [{ text }, ...parts.slice(1)] };
    }

    return { role: 'user', parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...parts] };
  }

  private normalizeTools(tools: Tool[] | undefined): AntigravityTool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    const normalized: AntigravityTool[] = [];

    for (const tool of tools) {
      if (!tool.functionDeclarations || tool.functionDeclarations.length === 0) {
        continue;
      }

      const functionDeclarations: AntigravityFunctionDeclaration[] = [];
      for (const decl of tool.functionDeclarations) {
        const name = typeof decl.name === 'string' ? decl.name : '';
        const description =
          typeof decl.description === 'string' ? decl.description : '';

        const schemaSource = decl.parametersJsonSchema;

        functionDeclarations.push({
          name: sanitizeAntigravityToolName(name),
          description,
          parameters: normalizeToolParametersSchema(
            cleanJsonSchemaForAntigravity(schemaSource),
          ),
        });
      }

      if (functionDeclarations.length > 0) {
        normalized.push({ functionDeclarations: [...functionDeclarations] });
      }
    }

    return normalized.length > 0 ? normalized : undefined;
  }

  private async *streamAntigravitySse(
    response: Response,
    abortSignal: AbortSignal,
  ): AsyncGenerator<GenerateContentResponse> {
    const stream = response.body;
    if (!stream) {
      throw new Error('Missing response body for Antigravity streaming request');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines: string[] = [];

    const flushEvent = (): GenerateContentResponse | null => {
      if (dataLines.length === 0) {
        return new GenerateContentResponse();
      }

      const data = dataLines.join('\n').trim();
      dataLines = [];
      if (!data) {
        return new GenerateContentResponse();
      }
      if (data === '[DONE]') {
        return null;
      }

      try {
        const parsed: unknown = JSON.parse(data);
        const raw = extractAntigravityResponsePayload(parsed);
        return raw ? toGenerateContentResponse(raw) : new GenerateContentResponse();
      } catch {
        return new GenerateContentResponse();
      }
    };

    const reader = stream.getReader();

    try {
      while (true) {
        if (abortSignal.aborted) {
          await reader.cancel().catch(() => {});
          break;
        }

        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        if (value) {
          buffer += decoder.decode(value, { stream: true });
        }

        while (true) {
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex === -1) {
            break;
          }

          const rawLine = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

          if (line === '') {
            const flushed = flushEvent();
            if (!flushed) {
              return;
            }
            yield flushed;
            continue;
          }

          if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    buffer += decoder.decode();
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
      if (line === '') {
        const flushed = flushEvent();
        if (!flushed) {
          return;
        }
        yield flushed;
      }
    }

    const flushed = flushEvent();
    if (flushed) {
      yield flushed;
    }
  }

  override async *streamChat(
    encodedModelId: string,
    model: ModelConfig,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    performanceTrace: PerformanceTrace,
    token: vscode.CancellationToken,
    logger: RequestLogger,
    credential: AuthTokenInfo,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const abortController = new AbortController();
    const cancellationListener = token.onCancellationRequested(() => {
      abortController.abort();
    });
    if (token.isCancellationRequested) {
      abortController.abort();
      cancellationListener.dispose();
      return;
    }

    const streamEnabled = model.stream ?? true;
    const requestTimeoutMs = streamEnabled
      ? this.config.timeout?.connection ?? DEFAULT_TIMEOUT_CONFIG.connection
      : this.config.timeout?.response ?? DEFAULT_TIMEOUT_CONFIG.response;

    const { systemInstruction, contents } = this.convertMessages(
      encodedModelId,
      messages,
    );

    const sdkTools = this.convertTools(options.tools);
    const tools = this.normalizeTools(sdkTools);
    const functionCallingConfig = this.buildAntigravityFunctionCallingConfig(
      options.toolMode,
      tools,
    );

    const requestedModelId = getBaseModelId(model.id);
    const preferredGemini3ThinkingLevel =
      model.thinking &&
      model.thinking.type !== 'disabled' &&
      model.thinking.effort &&
      model.thinking.effort !== 'none'
        ? mapThinkingEffortToGemini3ThinkingLevel(model.thinking.effort)
        : undefined;
    const resolvedModel = resolveAntigravityModelForRequest(
      requestedModelId,
      preferredGemini3ThinkingLevel,
    );

    const generationConfig: Record<string, unknown> = {};
    if (model.temperature !== undefined) generationConfig.temperature = model.temperature;
    if (model.topP !== undefined) generationConfig.topP = model.topP;
    if (model.topK !== undefined) generationConfig.topK = model.topK;
    if (model.maxOutputTokens !== undefined) {
      generationConfig.maxOutputTokens = model.maxOutputTokens;
    }
    if (model.presencePenalty !== undefined) {
      generationConfig.presencePenalty = model.presencePenalty;
    }
    if (model.frequencyPenalty !== undefined) {
      generationConfig.frequencyPenalty = model.frequencyPenalty;
    }

    if (model.thinking) {
      const thinkingDisabled =
        model.thinking.type === 'disabled' || model.thinking.effort === 'none';

      if (resolvedModel.gemini3ThinkingLevel) {
        generationConfig.thinkingConfig = {
          includeThoughts: !thinkingDisabled,
          thinkingLevel: resolvedModel.gemini3ThinkingLevel,
        };
      } else {
        const thinkingConfig: Record<string, unknown> = {
          includeThoughts: !thinkingDisabled,
        };

        const budgetTokens = model.thinking.budgetTokens;
        const hasPositiveBudget =
          typeof budgetTokens === 'number' &&
          Number.isFinite(budgetTokens) &&
          budgetTokens > 0;

        if (!thinkingDisabled && hasPositiveBudget) {
          if (
            typeof generationConfig.maxOutputTokens === 'number' &&
            generationConfig.maxOutputTokens <= budgetTokens
          ) {
            throw new Error(
              'Invalid thinking config: maxOutputTokens must be greater than thinkingBudget',
            );
          }
          thinkingConfig.thinkingBudget = budgetTokens;
        }

        generationConfig.thinkingConfig = thinkingConfig;
      }
    }

    if (
      typeof generationConfig.maxOutputTokens === 'number' &&
      resolvedModel.requestModelId.toLowerCase().startsWith('gemini-3-pro') &&
      !IMAGE_MODEL_PATTERN.test(resolvedModel.requestModelId) &&
      generationConfig.maxOutputTokens > GEMINI_3_PRO_MAX_OUTPUT_TOKENS_ANTIGRAVITY
    ) {
      generationConfig.maxOutputTokens = GEMINI_3_PRO_MAX_OUTPUT_TOKENS_ANTIGRAVITY;
    }

    const requestPayload: Record<string, unknown> = {
      contents,
      systemInstruction: this.buildSystemInstruction(systemInstruction),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      ...(tools ? { tools } : {}),
      ...(functionCallingConfig
        ? { toolConfig: { functionCallingConfig } }
        : {}),
    };

    const body: Record<string, unknown> = {
      project: this.resolveProjectId(),
      model: resolvedModel.requestModelId,
      request: requestPayload,
      requestType: 'agent',
      userAgent: 'antigravity',
      requestId: `agent-${randomUUID()}`,
    };

    Object.assign(body, this.config.extraBody, model.extraBody);

    const headers = this.buildAntigravityHeaders(credential, model, { streaming: streamEnabled });

    const fetcher = createCustomFetch({
      connectionTimeoutMs: requestTimeoutMs,
      logger,
    });

    const endpointBase = this.resolveEndpointBaseUrl();
    const endpoint = `${endpointBase}/v1internal:${streamEnabled ? 'streamGenerateContent' : 'generateContent'}${streamEnabled ? '?alt=sse' : ''}`;

    performanceTrace.ttf = Date.now() - performanceTrace.tts;

    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
          `Antigravity request failed (${response.status}): ${
            text || response.statusText || 'Unknown error'
          }`,
        );
      }

      if (streamEnabled) {
        const responseTimeoutMs =
          this.config.timeout?.response ?? DEFAULT_TIMEOUT_CONFIG.response;

        const stream = this.streamAntigravitySse(response, abortController.signal);
        const timedStream = withIdleTimeout(
          stream,
          responseTimeoutMs,
          abortController.signal,
        );

        yield* this.parseMessageStream(
          timedStream,
          token,
          logger,
          performanceTrace,
        );
      } else {
        const payload: unknown = await response.json();
        const raw = extractAntigravityResponsePayload(payload);
        if (!raw) {
          throw new Error('Invalid Antigravity response payload');
        }
        yield* this.parseMessage(toGenerateContentResponse(raw), performanceTrace, logger);
      }
    } finally {
      cancellationListener.dispose();
    }
  }
}

import { randomUUID } from 'node:crypto';
import type { RequestPayload, TransformContext, TransformResult } from './types';
import { cacheToolSchemas } from '../tool-schema-cache';
import {
  applyAntigravitySystemInstruction,
  normalizeThinkingConfig,
  normalizeAntigravitySystemInstruction,
} from '../request-helpers';
import {
  cacheThoughtSignature,
  getCachedThoughtSignature,
} from '../thought-signature-cache';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function transformClaudeRequest(
  context: TransformContext,
  parsedBody: RequestPayload,
): TransformResult {
  const requestPayload: RequestPayload = { ...parsedBody };
  let toolsTransformed = false;
  let toolCount = 0;

  delete requestPayload['safetySettings'];

  if (!requestPayload['toolConfig']) {
    requestPayload['toolConfig'] = {};
  }
  if (isRecord(requestPayload['toolConfig'])) {
    const toolConfig = requestPayload['toolConfig'];
    if (!toolConfig['functionCallingConfig']) {
      toolConfig['functionCallingConfig'] = {};
    }
    if (isRecord(toolConfig['functionCallingConfig'])) {
      toolConfig['functionCallingConfig']['mode'] = 'VALIDATED';
    }
  }

  const rawGenerationConfig = requestPayload['generationConfig'];

  let normalizedThinking = normalizeThinkingConfig(
    isRecord(rawGenerationConfig) ? rawGenerationConfig['thinkingConfig'] : undefined,
  );
  const isThinkingModel = context.model.includes('-thinking');

  if (isThinkingModel) {
    if (!normalizedThinking) {
      normalizedThinking = {
        thinkingBudget: 16384,
        include_thoughts: true,
      };
    } else {
      if (normalizedThinking.include_thoughts === undefined) {
        normalizedThinking.include_thoughts = true;
      }

      if (
        normalizedThinking.thinkingBudget === undefined ||
        normalizedThinking.thinkingBudget === 0
      ) {
        normalizedThinking.thinkingBudget = 16384;
      }
    }

    if (normalizedThinking) {
      const finalThinkingConfig: Record<string, unknown> = {
        include_thoughts: normalizedThinking.include_thoughts ?? true,
      };

      if (normalizedThinking.thinkingBudget) {
        finalThinkingConfig['thinking_budget'] = normalizedThinking.thinkingBudget;
      }

      if (isRecord(rawGenerationConfig)) {
        rawGenerationConfig['thinkingConfig'] = finalThinkingConfig;

        const currentMax =
          (rawGenerationConfig['maxOutputTokens'] ??
            rawGenerationConfig['max_output_tokens']) as number | undefined;
        const budget = normalizedThinking.thinkingBudget;

        if (budget && (!currentMax || currentMax <= budget)) {
          rawGenerationConfig['maxOutputTokens'] = 64000;
          if (rawGenerationConfig['max_output_tokens'] !== undefined) {
            delete rawGenerationConfig['max_output_tokens'];
          }
        }

        requestPayload['generationConfig'] = rawGenerationConfig;
      } else {
        const genConfig: Record<string, unknown> = {
          thinkingConfig: finalThinkingConfig,
        };

        if (normalizedThinking.thinkingBudget) {
          genConfig['maxOutputTokens'] = 64000;
        }

        requestPayload['generationConfig'] = genConfig;
      }
    } else if (isRecord(rawGenerationConfig) && rawGenerationConfig['thinkingConfig']) {
      delete rawGenerationConfig['thinkingConfig'];
      requestPayload['generationConfig'] = rawGenerationConfig;
    }
  } else {
    if (normalizedThinking) {
      if (isRecord(rawGenerationConfig)) {
        rawGenerationConfig['thinkingConfig'] = normalizedThinking;
        requestPayload['generationConfig'] = rawGenerationConfig;
      } else {
        requestPayload['generationConfig'] = { thinkingConfig: normalizedThinking };
      }
    } else if (isRecord(rawGenerationConfig) && rawGenerationConfig['thinkingConfig']) {
      delete rawGenerationConfig['thinkingConfig'];
      requestPayload['generationConfig'] = rawGenerationConfig;
    }
  }

  if ('system_instruction' in requestPayload) {
    requestPayload['systemInstruction'] = requestPayload['system_instruction'];
    delete requestPayload['system_instruction'];
  }

  normalizeAntigravitySystemInstruction(requestPayload);

  applyAntigravitySystemInstruction(requestPayload, context.model);

  const extraBody = requestPayload['extra_body'];
  const cachedContentFromExtra = isRecord(extraBody)
    ? (extraBody['cached_content'] ?? extraBody['cachedContent'])
    : undefined;
  const cachedContent =
    (requestPayload['cached_content'] as string | undefined) ??
    (requestPayload['cachedContent'] as string | undefined) ??
    (cachedContentFromExtra as string | undefined);
  if (cachedContent) {
    requestPayload['cachedContent'] = cachedContent;
  }

  delete requestPayload['cached_content'];
  delete requestPayload['cachedContent'];
  if (isRecord(extraBody)) {
    delete extraBody['cached_content'];
    delete extraBody['cachedContent'];
    if (Object.keys(extraBody).length === 0) {
      delete requestPayload['extra_body'];
    }
  }

  if ('model' in requestPayload) {
    delete requestPayload['model'];
  }

  cacheToolSchemas(requestPayload['tools'] as unknown[] | undefined);

  const tools = requestPayload['tools'] as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const funcDecls = tool['functionDeclarations'] as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(funcDecls)) continue;

      for (const funcDecl of funcDecls) {
        toolCount += 1;

        if (funcDecl['parametersJsonSchema']) {
          funcDecl['parameters'] = funcDecl['parametersJsonSchema'];
          delete funcDecl['parametersJsonSchema'];
          toolsTransformed = true;
        }

        const params = funcDecl['parameters'];
        if (isRecord(params)) {
          delete params['$schema'];

          if (!params['type']) {
            params['type'] = 'object';
          }
          if (!params['properties']) {
            params['properties'] = {};
          }
        } else if (!params) {
          funcDecl['parameters'] = { type: 'object', properties: {} };
          toolsTransformed = true;
        }
      }
    }
  }

  const contents = requestPayload['contents'] as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(contents)) {
    const funcCallIdQueues = new Map<string, string[]>();

    for (const content of contents) {
      const parts = content['parts'] as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(parts)) continue;

      const filteredParts: Array<Record<string, unknown>> = [];

      for (const part of parts) {
        if (!part) continue;

        if (part['thought'] === true) {
          let signature = part['thoughtSignature'];

          if (
            !signature ||
            (typeof signature === 'string' && signature.length < 50)
          ) {
            const text = typeof part['text'] === 'string' ? part['text'] : undefined;
            if (text && context.sessionId) {
              const cached = getCachedThoughtSignature(context.family, context.sessionId, text);
              if (cached) {
                signature = cached;
                part['thoughtSignature'] = cached;
              }
            }
          }

          if (typeof signature === 'string' && signature.length > 50) {
            const text = typeof part['text'] === 'string' ? part['text'] : undefined;
            if (text && context.sessionId) {
              cacheThoughtSignature(context.family, context.sessionId, text, signature);
            }
          } else {
            continue;
          }
        }

        const functionCall = part['functionCall'];
        if (isRecord(functionCall) && typeof functionCall['name'] === 'string') {
          if (!functionCall['id']) {
            functionCall['id'] = `${functionCall['name']}-${randomUUID()}`;
            toolsTransformed = true;
          }
          const name = functionCall['name'];
          const id = functionCall['id'];
          if (typeof id === 'string' && id.length > 0) {
            const queue = funcCallIdQueues.get(name) ?? [];
            queue.push(id);
            funcCallIdQueues.set(name, queue);
          }
        }

        const functionResponse = part['functionResponse'];
        if (isRecord(functionResponse) && typeof functionResponse['name'] === 'string') {
          if (!functionResponse['id']) {
            const queue = funcCallIdQueues.get(functionResponse['name']);
            if (queue && queue.length > 0) {
              functionResponse['id'] = queue.shift();
            }
          }
        }

        filteredParts.push(part);
      }

      content['parts'] = filteredParts;
    }
  }

  requestPayload['sessionId'] = context.sessionId;

  const wrappedBody = {
    project: context.projectId,
    model: context.model,
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: context.requestId,
    request: requestPayload,
  };

  return {
    body: JSON.stringify(wrappedBody),
    debugInfo: {
      transformer: 'claude',
      toolCount,
      toolsTransformed,
    },
  };
}

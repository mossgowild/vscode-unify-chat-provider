import type { RequestPayload, TransformContext, TransformResult } from './types';
import { cacheToolSchemas, sanitizeToolNameForGemini } from '../tool-schema-cache';
import {
  applyAntigravitySystemInstruction,
  normalizeThinkingConfig,
  normalizeAntigravitySystemInstruction,
} from '../request-helpers';
import { getCachedThoughtSignature } from '../thought-signature-cache';

const THOUGHT_SIGNATURE_BYPASS = 'skip_thought_signature_validator';

const GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION = `<CRITICAL_TOOL_USAGE_INSTRUCTIONS>
You are operating in a CUSTOM ENVIRONMENT where tool definitions COMPLETELY DIFFER from your training data.
VIOLATION OF THESE RULES WILL CAUSE IMMEDIATE SYSTEM FAILURE.

## ABSOLUTE RULES - NO EXCEPTIONS

1. **SCHEMA IS LAW**: The JSON schema in each tool definition is the ONLY source of truth.
   - Your pre-trained knowledge about tools like 'read_file', 'apply_diff', 'write_to_file', 'bash', etc. is INVALID here.
   - Every tool has been REDEFINED with different parameters than what you learned during training.

2. **PARAMETER NAMES ARE EXACT**: Use ONLY the parameter names from the schema.
   - WRONG: 'suggested_answers', 'file_path', 'files_to_read', 'command_to_run'
   - RIGHT: Check the 'properties' field in the schema for the exact names
   - The schema's 'required' array tells you which parameters are mandatory

3. **ARRAY PARAMETERS**: When a parameter has "type": "array", check the 'items' field:
   - If items.type is "object", you MUST provide an array of objects with the EXACT properties listed
   - If items.type is "string", you MUST provide an array of strings
   - NEVER provide a single object when an array is expected
   - NEVER provide an array when a single value is expected

4. **NESTED OBJECTS**: When items.type is "object":
   - Check items.properties for the EXACT field names required
   - Check items.required for which nested fields are mandatory
   - Include ALL required nested fields in EVERY array element

5. **STRICT PARAMETERS HINT**: Tool descriptions contain "STRICT PARAMETERS: ..." which lists:
   - Parameter name, type, and whether REQUIRED
   - For arrays of objects: the nested structure in brackets like [field: type REQUIRED, ...]
   - USE THIS as your quick reference, but the JSON schema is authoritative

6. **BEFORE EVERY TOOL CALL**:
   a. Read the tool's 'parametersJsonSchema' or 'parameters' field completely
   b. Identify ALL required parameters
   c. Verify your parameter names match EXACTLY (case-sensitive)
   d. For arrays, verify you're providing the correct item structure
   e. Do NOT add parameters that don't exist in the schema

## COMMON FAILURE PATTERNS TO AVOID

- Using 'path' when schema says 'filePath' (or vice versa)
- Using 'content' when schema says 'text' (or vice versa)  
- Providing {"file": "..."} when schema wants [{"path": "...", "line_ranges": [...]}]
- Omitting required nested fields in array items
- Adding 'additionalProperties' that the schema doesn't define
- Guessing parameter names from similar tools you know from training

## REMEMBER
Your training data about function calling is OUTDATED for this environment.
The tool names may look familiar, but the schemas are DIFFERENT.
When in doubt, RE-READ THE SCHEMA before making the call.
</CRITICAL_TOOL_USAGE_INSTRUCTIONS>

## GEMINI 3 RESPONSE RULES
- Default to a direct, concise answer; add detail only when asked or required for correctness.
- For multi-part tasks, use a short numbered list or labeled sections.
- For long provided context, answer only from that context and avoid assumptions.
- For multimodal inputs, explicitly reference each modality used and synthesize across them; do not invent details from absent modalities.
- For complex tasks, outline a short plan and verify constraints before acting.
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasFunctionTools(payload: RequestPayload): boolean {
  const tools = payload['tools'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => Array.isArray(tool['functionDeclarations']));
}

function extractSystemInstructionText(systemInstruction: unknown): string {
  if (typeof systemInstruction === 'string') {
    return systemInstruction;
  }
  if (!isRecord(systemInstruction)) {
    return '';
  }

  const parts = systemInstruction['parts'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(parts)) {
    return '';
  }

  return parts
    .map((part) => (typeof part['text'] === 'string' ? part['text'] : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}

type ScrubResult = { cleaned: string; removedLines: number; removedBlocks: number };

function scrubToolTranscriptArtifacts(text: string): ScrubResult {
  const lines = text.split('\n');
  const output: string[] = [];

  let removedLines = 0;
  let removedBlocks = 0;

  let inFence = false;
  let fenceStart = '';
  let fenceLines: string[] = [];

  const isMarkerLine = (line: string): boolean => {
    return /^\s*Tool:\s*\w+/i.test(line) || /^\s*(?:thought|think)\s*:/i.test(line);
  };

  for (const line of lines) {
    const isFence = line.trim().startsWith('```');

    if (isFence) {
      if (!inFence) {
        inFence = true;
        fenceStart = line;
        fenceLines = [];
        continue;
      }

      const hadMarker = fenceLines.some(isMarkerLine);
      const cleanedFenceLines: string[] = [];
      for (const fenceLine of fenceLines) {
        if (isMarkerLine(fenceLine)) {
          removedLines += 1;
        } else {
          cleanedFenceLines.push(fenceLine);
        }
      }

      const hasNonWhitespace = cleanedFenceLines.some((l) => l.trim().length > 0);
      if (hadMarker && !hasNonWhitespace) {
        removedBlocks += 1;
      } else {
        output.push(fenceStart);
        output.push(...cleanedFenceLines);
        output.push(line);
      }

      inFence = false;
      fenceStart = '';
      fenceLines = [];
      continue;
    }

    if (inFence) {
      fenceLines.push(line);
      continue;
    }

    if (isMarkerLine(line)) {
      removedLines += 1;
      continue;
    }

    output.push(line);
  }

  if (inFence) {
    output.push(fenceStart);
    output.push(...fenceLines);
  }

  const cleaned = output.join('\n').replace(/\n{4,}/g, '\n\n\n');
  return { cleaned, removedLines, removedBlocks };
}

function scrubConversationArtifactsFromModelHistory(payload: RequestPayload): void {
  const contents = payload['contents'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(contents)) return;

  for (const content of contents) {
    if (content['role'] !== 'model') continue;

    const parts = content['parts'] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      const text = part['text'];
      if (typeof text !== 'string') continue;

      const scrubbed = scrubToolTranscriptArtifacts(text);
      if (scrubbed.removedLines > 0 || scrubbed.removedBlocks > 0) {
        part['text'] = scrubbed.cleaned;
      }
    }
  }
}

function injectSystemInstructionIfNeeded(payload: RequestPayload): void {
  if (!hasFunctionTools(payload)) return;

  const existingText = extractSystemInstructionText(payload['systemInstruction']);
  if (existingText.includes('<CRITICAL_TOOL_USAGE_INSTRUCTIONS>')) {
    return;
  }

  const existing = payload['systemInstruction'];
  if (!existing || typeof existing === 'string') {
    const suffix =
      typeof existing === 'string' && existing.trim().length > 0
        ? `\n\n${existing}`
        : '';
    payload['systemInstruction'] = {
      parts: [{ text: `${GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION}${suffix}` }],
    };
    return;
  }

  const asRecord = isRecord(existing) ? existing : undefined;
  if (!asRecord) {
    payload['systemInstruction'] = {
      parts: [{ text: GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION }],
    };
    return;
  }

  const parts = asRecord['parts'];
  if (Array.isArray(parts)) {
    asRecord['parts'] = [{ text: GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION }, ...parts];
    payload['systemInstruction'] = asRecord;
    return;
  }

  payload['systemInstruction'] = {
    ...asRecord,
    parts: [{ text: GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION }],
  };
}

function normalizeSchemaType(typeValue: unknown): string | undefined {
  if (typeof typeValue === 'string') {
    return typeValue;
  }
  if (Array.isArray(typeValue)) {
    const nonNull = typeValue.filter((t) => t !== 'null');
    const first = nonNull[0] ?? typeValue[0];
    return typeof first === 'string' ? first : undefined;
  }
  return undefined;
}

function summarizeSchema(schema: unknown, depth: number): string {
  if (!isRecord(schema)) {
    return 'unknown';
  }

  const normalizedType = normalizeSchemaType(schema['type']);
  const enumValues = Array.isArray(schema['enum']) ? schema['enum'] : undefined;

  if (normalizedType === 'array') {
    const items = schema['items'];
    const itemSummary = depth > 0 ? summarizeSchema(items, depth - 1) : 'unknown';
    return `array[${itemSummary}]`;
  }

  if (normalizedType === 'object') {
    const props = schema['properties'];
    const requiredRaw = schema['required'];
    const required = Array.isArray(requiredRaw)
      ? requiredRaw.filter((v): v is string => typeof v === 'string')
      : [];

    if (!isRecord(props) || depth <= 0) {
      return 'object';
    }

    const keys = Object.keys(props);
    const requiredKeys = keys.filter((k) => required.includes(k));
    const optionalKeys = keys.filter((k) => !required.includes(k));
    const orderedKeys = [...requiredKeys.sort(), ...optionalKeys.sort()];

    const maxPropsToShow = 8;
    const shownKeys = orderedKeys.slice(0, maxPropsToShow);

    const inner = shownKeys
      .map((key) => {
        const propSchema = props[key];
        const propType = summarizeSchema(propSchema, depth - 1);
        const requiredSuffix = required.includes(key) ? ' REQUIRED' : '';
        return `${key}: ${propType}${requiredSuffix}`;
      })
      .join(', ');

    const extraCount = orderedKeys.length - shownKeys.length;
    const extra = extraCount > 0 ? `, …+${extraCount}` : '';

    return `{${inner}${extra}}`;
  }

  if (enumValues && enumValues.length > 0) {
    const preview = enumValues.slice(0, 6).map(String).join('|');
    const suffix = enumValues.length > 6 ? '|…' : '';
    return `${normalizedType ?? 'unknown'} enum(${preview}${suffix})`;
  }

  return normalizedType ?? 'unknown';
}

function buildStrictParamsSummary(parametersSchema: Record<string, unknown>): string {
  const schemaType = normalizeSchemaType(parametersSchema['type']);
  const properties = parametersSchema['properties'];
  const requiredRaw = parametersSchema['required'];
  const required = Array.isArray(requiredRaw)
    ? requiredRaw.filter((v): v is string => typeof v === 'string')
    : [];

  if (schemaType !== 'object' || !isRecord(properties)) {
    return '(schema missing top-level object properties)';
  }

  const keys = Object.keys(properties);
  const requiredKeys = keys.filter((k) => required.includes(k));
  const optionalKeys = keys.filter((k) => !required.includes(k));
  const orderedKeys = [...requiredKeys.sort(), ...optionalKeys.sort()];

  const parts = orderedKeys.map((key) => {
    const propSchema = properties[key];
    const typeSummary = summarizeSchema(propSchema, 2);
    const requiredSuffix = required.includes(key) ? ' REQUIRED' : '';
    return `${key}: ${typeSummary}${requiredSuffix}`;
  });

  const summary = parts.join(', ');
  const maxLen = 900;
  return summary.length > maxLen ? `${summary.slice(0, maxLen)}…` : summary;
}

function augmentToolDescriptionsWithStrictParams(payload: RequestPayload): void {
  const tools = payload['tools'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return;

  for (const tool of tools) {
    const funcDecls = tool['functionDeclarations'] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(funcDecls)) continue;

    for (const funcDecl of funcDecls) {
      const schema = (funcDecl['parametersJsonSchema'] ??
        funcDecl['parameters']) as Record<string, unknown> | undefined;
      if (!isRecord(schema)) continue;

      const currentDescription =
        typeof funcDecl['description'] === 'string' ? funcDecl['description'] : '';
      if (currentDescription.includes('STRICT PARAMETERS:')) continue;

      const summary = buildStrictParamsSummary(schema);
      const nextDescription =
        currentDescription.trim().length > 0
          ? `${currentDescription.trim()}\n\nSTRICT PARAMETERS: ${summary}`
          : `STRICT PARAMETERS: ${summary}`;

      funcDecl['description'] = nextDescription;
    }
  }
}

function sanitizeToolNames(payload: RequestPayload): void {
  const tools = payload['tools'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return;

  for (const tool of tools) {
    const funcDecls = tool['functionDeclarations'] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(funcDecls)) continue;

    for (const funcDecl of funcDecls) {
      const name = funcDecl['name'];
      if (typeof name === 'string') {
        funcDecl['name'] = sanitizeToolNameForGemini(name);
      }
    }
  }

  const contents = payload['contents'] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(contents)) return;

  for (const content of contents) {
    const parts = content['parts'] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      const functionCall = part['functionCall'];
      if (isRecord(functionCall) && typeof functionCall['name'] === 'string') {
        functionCall['name'] = sanitizeToolNameForGemini(functionCall['name']);
      }

      const functionResponse = part['functionResponse'];
      if (isRecord(functionResponse) && typeof functionResponse['name'] === 'string') {
        functionResponse['name'] = sanitizeToolNameForGemini(functionResponse['name']);
      }
    }
  }
}

export function transformGeminiRequest(
  context: TransformContext,
  parsedBody: RequestPayload,
): TransformResult {
  const requestPayload: RequestPayload = { ...parsedBody };

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
  const normalizedThinking = normalizeThinkingConfig(
    isRecord(rawGenerationConfig) ? rawGenerationConfig['thinkingConfig'] : undefined,
  );
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

  if ('system_instruction' in requestPayload) {
    requestPayload['systemInstruction'] = requestPayload['system_instruction'];
    delete requestPayload['system_instruction'];
  }

  normalizeAntigravitySystemInstruction(requestPayload);

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
  sanitizeToolNames(requestPayload);

  augmentToolDescriptionsWithStrictParams(requestPayload);
  injectSystemInstructionIfNeeded(requestPayload);
  scrubConversationArtifactsFromModelHistory(requestPayload);
  applyAntigravitySystemInstruction(requestPayload, context.model);

  const contents = requestPayload['contents'] as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(contents)) {
    for (const content of contents) {
      if (!content || content['role'] !== 'model') continue;

      const parts = content['parts'] as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(parts)) continue;

      const filteredParts: Array<Record<string, unknown>> = [];
      let currentThoughtSignature: string | undefined;

      for (const part of parts) {
        if (!part) continue;

        if (part['thought'] === true) {
          const thoughtText = typeof part['text'] === 'string' ? part['text'] : undefined;
          if (thoughtText && context.sessionId) {
            const cachedSig = getCachedThoughtSignature(
              context.family,
              context.sessionId,
              thoughtText,
            );
            if (cachedSig) {
              part['thoughtSignature'] = cachedSig;
              currentThoughtSignature = cachedSig;
              filteredParts.push(part);
            }
          }
          continue;
        }

        if (part['functionCall']) {
          if (isRecord(part['functionCall'])) {
            if (typeof part['thoughtSignature'] !== 'string' || part['thoughtSignature'].length === 0) {
              part['thoughtSignature'] = currentThoughtSignature ?? THOUGHT_SIGNATURE_BYPASS;
            }
          }
          filteredParts.push(part);
          continue;
        }

        if (part['thoughtSignature'] !== undefined) {
          delete part['thoughtSignature'];
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

  const body = JSON.stringify(wrappedBody);

  return {
    body,
    debugInfo: {
      transformer: 'gemini',
      toolCount: Array.isArray(requestPayload['tools'])
        ? (requestPayload['tools'] as unknown[]).length
        : undefined,
    },
  };
}

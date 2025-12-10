#!/usr/bin/env bun
/**
 * Lightweight Bun proxy to capture ClaudeCode traffic.
 *
 * Example:
 *   bun run scripts/claude-proxy.ts --target https://api.anthropic.com --port 8787 --log scripts/claude-proxy.log
 *
 * You can also use env vars:
 *   TARGET_BASE_URL (required if --target is omitted)
 *   PORT (default: 8787)
 *   LOG_FILE (default: scripts/claude-proxy.log)
 */
import { parseArgs } from 'node:util';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

type BodyLog = {
  encoding: 'text' | 'base64' | 'empty';
  preview: string;
  bytes: number;
};

type TrafficLog = {
  id: number;
  start: Date;
  method: string;
  incomingUrl: URL;
  upstreamUrl: URL;
  requestHeaders: Headers;
  requestBody: Uint8Array;
  responseHeaders?: Headers;
  responseBody?: Uint8Array;
  responseStatus?: string;
  error?: string;
};

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    port: { type: 'string' },
    log: { type: 'string' },
    'raw-events': { type: 'boolean' },
  },
});

const targetBaseUrl = values.target ?? process.env.TARGET_BASE_URL;
if (!targetBaseUrl) {
  console.error('Missing target base URL. Provide --target or set TARGET_BASE_URL.');
  process.exit(1);
}

let targetBase: URL;
try {
  targetBase = new URL(targetBaseUrl);
} catch (error) {
  console.error(`Invalid target base URL: ${targetBaseUrl}`);
  process.exit(1);
}

const port = Number(values.port ?? process.env.PORT ?? 8787);
if (!Number.isFinite(port) || port <= 0) {
  console.error('Invalid port. Provide a positive number via --port or PORT.');
  process.exit(1);
}

const logFile = values.log ?? process.env.LOG_FILE ?? 'scripts/claude-proxy.log';
const rawEventsEnabled = coerceBoolean(values['raw-events'], process.env.RAW_EVENTS);
await ensureLogPath(logFile);

let nextRequestId = 1;

console.log(`ClaudeCode proxy → ${targetBase.toString()}`);
console.log(`Listening on http://localhost:${port}`);
console.log(`Logging to ${logFile}`);
console.log(`raw_events logging: ${rawEventsEnabled ? 'enabled' : 'disabled'}`);

Bun.serve({
  port,
  async fetch(request) {
    const requestId = nextRequestId++;
    const start = new Date();
    const incomingUrl = new URL(request.url);
    const upstreamUrl = buildUpstreamUrl(targetBase, incomingUrl.pathname, incomingUrl.search);

    const incomingHeaders = new Headers(request.headers);
    const forwardHeaders = new Headers(incomingHeaders);
    forwardHeaders.delete('host');

    const requestBodyBuffer = new Uint8Array(await request.arrayBuffer());
    const bodyAllowed = request.method !== 'GET' && request.method !== 'HEAD';
    const forwardBody =
      bodyAllowed && requestBodyBuffer.byteLength > 0 ? requestBodyBuffer : undefined;

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: forwardBody,
        redirect: 'manual',
      });

      const responseHeaders = new Headers(upstreamResponse.headers);
      const bodyForClient = upstreamResponse.body
        ? upstreamResponse.body.tee()
        : [null, null];
      const responseStream = bodyForClient[0];
      const logStream = bodyForClient[1];
      const responseLogPromise = logStream
        ? collectStream(logStream)
        : Promise.resolve(new Uint8Array());

      void responseLogPromise
        .then(async (responseBodyBuffer) => {
          await writeTrafficLog({
            id: requestId,
            start,
            method: request.method,
            incomingUrl,
            upstreamUrl,
            requestHeaders: incomingHeaders,
            requestBody: requestBodyBuffer,
            responseHeaders,
            responseBody: responseBodyBuffer,
            responseStatus: `${upstreamResponse.status} ${upstreamResponse.statusText}`,
          });
        })
        .catch((error) => {
          console.error(`[${requestId}] Failed to write log:`, error);
        });

      return new Response(responseStream, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeTrafficLog({
        id: requestId,
        start,
        method: request.method,
        incomingUrl,
        upstreamUrl,
        requestHeaders: incomingHeaders,
        requestBody: requestBodyBuffer,
        error: message,
      });
      return new Response(`Proxy error: ${message}`, { status: 502 });
    }
  },
});

function buildUpstreamUrl(base: URL, path: string, search: string): URL {
  const upstream = new URL(base.toString());
  const basePath = upstream.pathname.endsWith('/')
    ? upstream.pathname.slice(0, -1)
    : upstream.pathname;
  const incomingPath = path.startsWith('/') ? path : `/${path}`;
  upstream.pathname = `${basePath}${incomingPath}`;
  upstream.search = search;
  return upstream;
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

function formatBodyForLog(body: Uint8Array, contentType: string | null): BodyLog {
  if (!body || body.byteLength === 0) {
    return { encoding: 'empty', preview: '(empty body)', bytes: 0 };
  }

  const isText = isTextLike(contentType, body);
  if (isText) {
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(body);
    return { encoding: 'text', preview: decoded, bytes: body.byteLength };
  }

  const base64 = Buffer.from(body).toString('base64');
  return {
    encoding: 'base64',
    preview: base64,
    bytes: body.byteLength,
  };
}

function isTextLike(contentType: string | null, body: Uint8Array): boolean {
  if (contentType) {
    const lower = contentType.toLowerCase();
    if (
      lower.startsWith('text/') ||
      lower.includes('json') ||
      lower.includes('xml') ||
      lower.includes('yaml') ||
      lower.includes('event-stream') ||
      lower.includes('x-www-form-urlencoded')
    ) {
      return true;
    }
  }

  if (body.byteLength === 0) {
    return true;
  }

  const sample = body.subarray(0, Math.min(body.byteLength, 64));
  let readable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) {
      readable++;
      continue;
    }
    if (byte >= 32 && byte <= 126) {
      readable++;
    }
  }

  return readable / sample.length > 0.8;
}

async function writeTrafficLog(entry: TrafficLog): Promise<void> {
  const requestBodyLog = formatBodyForLog(
    entry.requestBody,
    entry.requestHeaders.get('content-type'),
  );
  const responseBodyLog = entry.responseBody
    ? formatBodyForLog(entry.responseBody, entry.responseHeaders?.get('content-type') ?? null)
    : { encoding: 'empty', preview: '(no response body)', bytes: 0 };

  const lines = [
    `=== [${entry.start.toISOString()}] Request #${entry.id} ===`,
    `→ ${entry.method} ${entry.incomingUrl.pathname}${entry.incomingUrl.search}`,
    `↗ Forwarded to: ${entry.upstreamUrl.toString()}`,
    `Request headers: ${JSON.stringify(headersToObject(entry.requestHeaders), null, 2)}`,
    `Request body (${requestBodyLog.encoding}, ${requestBodyLog.bytes} bytes):`,
    requestBodyLog.preview,
  ];

  if (entry.error) {
    lines.push(`✕ Upstream error: ${entry.error}`);
  } else {
    lines.push(`Response: ${entry.responseStatus ?? 'unknown'}`);
    lines.push(
      `Response headers: ${JSON.stringify(
        entry.responseHeaders ? headersToObject(entry.responseHeaders) : {},
        null,
        2,
      )}`,
    );

    const isEventStream =
      (entry.responseHeaders?.get('content-type') ?? '').toLowerCase().includes('event-stream') &&
      responseBodyLog.encoding === 'text';

    if (isEventStream) {
      const sseParsed = parseSseEvents(responseBodyLog.preview);
      const reconstructed = reconstructAnthropicStream(sseParsed, rawEventsEnabled);
      if (reconstructed) {
        lines.push(
          `Response body (reconstructed message from SSE, ${responseBodyLog.bytes} bytes):`,
          JSON.stringify(reconstructed, null, 2),
        );
      } else {
        lines.push(
          `Response body (event-stream, ${responseBodyLog.bytes} bytes, raw):`,
          responseBodyLog.preview,
        );
      }
    } else {
      lines.push(
        `Response body (${responseBodyLog.encoding}, ${responseBodyLog.bytes} bytes):`,
        responseBodyLog.preview,
      );
    }
  }

  lines.push(`=== End Request #${entry.id} ===`, '');
  await appendFile(logFile, `${lines.join('\n')}\n`);
}

async function ensureLogPath(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  if (!dir || dir === '.') {
    return;
  }
  await mkdir(dir, { recursive: true });
}

function coerceBoolean(cliValue: unknown, envValue: string | undefined): boolean {
  if (typeof cliValue === 'boolean') {
    return cliValue;
  }
  if (envValue === undefined) {
    return false;
  }
  const normalized = envValue.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

type SseEvent = { event: string; data: string; json?: unknown };

function parseSseEvents(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  let currentEvent = 'message';
  let currentData: string[] = [];

  const flush = () => {
    const data = currentData.join('\n');
    if (!data && !currentEvent) {
      return;
    }
    const trimmed = data.trim();
    const parsed: SseEvent = { event: currentEvent || 'message', data: trimmed };
    try {
      parsed.json = trimmed ? JSON.parse(trimmed) : undefined;
    } catch {
      // ignore JSON parse errors; keep raw string
    }
    events.push(parsed);
    currentEvent = 'message';
    currentData = [];
  };

  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('event:')) {
      currentEvent = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      currentData.push(line.slice('data:'.length).trim());
    } else if (line === '') {
      flush();
    }
  }
  flush();
  return events;
}

type AnthropicReconstructed = {
  message: Record<string, unknown>;
  usage?: Record<string, unknown>;
  text?: string;
  stop_reason?: string | null;
  stop_sequence?: string | null;
  raw_events?: SseEvent[];
};

function reconstructAnthropicStream(
  events: SseEvent[],
  includeRawEvents: boolean,
): AnthropicReconstructed | null {
  if (!events.length) {
    return null;
  }

  let messageMeta: any = null;
  const contentBlocks = new Map<number, any>();
  let stopReason: string | null | undefined;
  let stopSequence: string | null | undefined;
  let usage: Record<string, unknown> | undefined;

  for (const evt of events) {
    if (evt.event === 'message_start' && evt.json && typeof evt.json === 'object') {
      const payload = (evt.json as any).message ?? (evt.json as any).delta;
      if (payload) {
        messageMeta = { ...payload, content: [] };
      }
      if ((evt.json as any).message?.usage) {
        usage = (evt.json as any).message.usage;
      }
    }

    if (evt.event === 'content_block_start' && evt.json && typeof evt.json === 'object') {
      const { index, content_block } = evt.json as any;
      if (typeof index === 'number' && content_block) {
        contentBlocks.set(index, { ...content_block });
      }
    }

    if (evt.event === 'content_block_delta' && evt.json && typeof evt.json === 'object') {
      const { index, delta } = evt.json as any;
      if (typeof index === 'number' && delta) {
        const block = contentBlocks.get(index) ?? { type: delta.type };
        if (delta.type === 'text_delta') {
          block.text = (block.text ?? '') + (delta.text ?? '');
        } else {
          block.delta = delta;
        }
        contentBlocks.set(index, block);
      }
    }

    if (evt.event === 'message_delta' && evt.json && typeof evt.json === 'object') {
      const delta = (evt.json as any).delta ?? evt.json;
      if (delta.stop_reason !== undefined) {
        stopReason = delta.stop_reason;
      }
      if (delta.stop_sequence !== undefined) {
        stopSequence = delta.stop_sequence;
      }
      if ((evt.json as any).usage) {
        usage = (evt.json as any).usage;
      }
    }
  }

  if (!messageMeta) {
    return { raw_events: events, message: {}, usage };
  }

  const textParts: string[] = [];
  const content = Array.from(contentBlocks.entries())
    .sort(([a], [b]) => a - b)
    .map(([, block]) => {
      if (block.text) {
        textParts.push(block.text);
      }
      return block;
    });

  const reconstructedMessage = {
    ...messageMeta,
    content,
    stop_reason: stopReason ?? messageMeta.stop_reason ?? null,
    stop_sequence: stopSequence ?? messageMeta.stop_sequence ?? null,
  };

  return {
    message: reconstructedMessage,
    usage,
    text: textParts.join(''),
    stop_reason: reconstructedMessage.stop_reason,
    stop_sequence: reconstructedMessage.stop_sequence,
    ...(includeRawEvents ? { raw_events: events } : {}),
  };
}

import * as vscode from 'vscode';
import type { PerformanceTrace } from './types';

const CHANNEL_NAME = 'Unify Chat Provider';

let channel: vscode.LogOutputChannel | undefined;
let nextRequestId = 1;
let hasShownChannel = false;

/**
 * Lazily create and return the log output channel.
 */
function getChannel(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel(CHANNEL_NAME, { log: true });
  }

  // Show the channel once so users notice new logs.
  if (!hasShownChannel) {
    hasShownChannel = true;
    channel.show(true);
  }

  return channel;
}

function isVerboseEnabled(): boolean {
  const config = vscode.workspace.getConfiguration('unifyChatProvider');
  const verbose = config.get<unknown>('verbose', false);
  return typeof verbose === 'boolean' ? verbose : false;
}

function maskSensitiveHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const masked: Record<string, string> = { ...headers };
  for (const key of Object.keys(masked)) {
    const lower = key.toLowerCase();
    if (
      lower === 'x-api-key' ||
      lower === 'authorization' ||
      lower.includes('token')
    ) {
      masked[key] = maskValue(masked[key]);
    }
  }
  return masked;
}

function maskValue(value?: string): string {
  if (!value) {
    return '';
  }
  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * A logger bound to a specific request ID for contextual logging.
 *
 * Logging rules:
 * - Request start and complete are always logged (regardless of verbose setting)
 * - Performance and usage info are always logged at complete
 * - Detailed data (messages, options, request body, response chunks) only logged when verbose is enabled
 * - Errors are NOT logged here (caller handles error logging before throwing)
 */
export class RequestLogger {
  private readonly ch = getChannel();
  private providerContext: {
    label: string;
    endpoint: string;
    headers: Record<string, string>;
    body: unknown;
    logged: boolean;
  } | null = null;

  constructor(public readonly requestId: string) {}

  /**
   * Log the start of a request. Always printed.
   */
  start(modelId: string): void {
    this.ch.info(`[${this.requestId}] ▶ Request started for model: ${modelId}`);
  }

  /**
   * Log the raw input received from VSCode.
   * Only logged when verbose is enabled.
   */
  vscodeInput(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
  ): void {
    if (!isVerboseEnabled()) {
      return;
    }
    this.ch.info(
      `[${this.requestId}] VSCode Input Messages:\n${JSON.stringify(
        messages,
        null,
        2,
      )}`,
    );
    this.ch.info(
      `[${this.requestId}] VSCode Input Options:\n${JSON.stringify(
        options,
        null,
        2,
      )}`,
    );
  }

  /**
   * Log the request being sent to the provider.
   * Headers are always masked for sensitive values.
   * Only logged when verbose is enabled, but context is saved for error logging.
   */
  providerRequest(details: {
    provider: string;
    endpoint: string;
    headers: Record<string, string>;
    body: unknown;
    modelId?: string;
  }): void {
    const maskedHeaders = maskSensitiveHeaders(details.headers);
    const label = `${details.provider}${
      details.modelId ? ` (${details.modelId})` : ''
    }`;

    this.providerContext = {
      label,
      endpoint: details.endpoint,
      headers: maskedHeaders,
      body: details.body,
      logged: false,
    };

    if (isVerboseEnabled()) {
      this.ch.info(`[${this.requestId}] → ${label} ${details.endpoint}`);
      this.ch.info(
        `[${this.requestId}] Provider Request Headers:\n${JSON.stringify(
          maskedHeaders,
          null,
          2,
        )}`,
      );
      this.ch.info(
        `[${this.requestId}] Provider Request Body:\n${JSON.stringify(
          details.body,
          null,
          2,
        )}`,
      );
      this.providerContext.logged = true;
    }
  }

  /**
   * Log provider response metadata (status, content-type).
   * Always logged on error, otherwise only when verbose is enabled.
   */
  providerResponseMeta(response: Response): void {
    const contentType = response.headers.get('content-type') ?? 'unknown';
    const message = `[${this.requestId}] ← Status ${response.status} ${
      response.statusText || ''
    } (${contentType})`.trim();

    if (!response.ok) {
      this.logProviderContext();
      this.ch.error(message);
      return;
    }

    if (isVerboseEnabled()) {
      this.ch.info(message);
    }
  }

  /**
   * Log a raw response chunk from the provider.
   * Only logged when verbose is enabled.
   */
  providerResponseChunk(data: string): void {
    if (!isVerboseEnabled()) {
      return;
    }
    this.ch.info(`[${this.requestId}] ⇦ ${data}`);
  }

  /**
   * Log a part being sent to VSCode.
   * Only logged when verbose is enabled.
   */
  vscodeOutput(part: vscode.LanguageModelResponsePart2): void {
    if (!isVerboseEnabled()) {
      return;
    }
    this.ch.info(`[${this.requestId}] VSCode Output: ${JSON.stringify(part)}`);
  }

  /**
   * Log verbose information. Only logged when verbose is enabled.
   */
  verbose(message: string): void {
    if (!isVerboseEnabled()) {
      return;
    }
    this.ch.info(`[${this.requestId}] ${message}`);
  }

  /**
   * Log usage information from provider. Always logged.
   * @param usage Raw usage object from provider (will be JSON stringified)
   */
  usage(usage: unknown): void {
    this.ch.info(`[${this.requestId}] Usage: ${JSON.stringify(usage)}`);
  }

  /**
   * Log request completion with performance metrics.
   * Always logged regardless of verbose setting.
   */
  complete(performanceTrace: PerformanceTrace): void {
    const perfInfo = [
      `Time to Fetch: ${performanceTrace.ttf}ms`,
      `Time to First Token: ${performanceTrace.ttft}ms`,
      `Tokens Per Second: ${
        isNaN(performanceTrace.tps)
          ? 'N/A'
          : performanceTrace.tps.toFixed(1) + '/s'
      }`,
      `Total Latency: ${performanceTrace.tl}ms`,
    ].join(', ');

    this.ch.info(`[${this.requestId}] ✓ Request completed | ${perfInfo}`);
    this.providerContext = null;
  }

  /**
   * Log an error that occurred during the request.
   * This logs the provider context if not already logged.
   * Note: This should only be called when NOT re-throwing the error.
   * If re-throwing, let the caller handle error logging.
   */
  error(error: unknown): void {
    this.logProviderContext();
    const message = error instanceof Error ? error.message : String(error);
    this.ch.error(`[${this.requestId}] ✕ ${message}`);
    this.providerContext = null;
  }

  /**
   * Log the provider context (request details) when an error occurs.
   * Only logs if not already logged.
   */
  private logProviderContext(): void {
    if (!this.providerContext || this.providerContext.logged) {
      return;
    }

    const ctx = this.providerContext;
    this.ch.error(`[${this.requestId}] → ${ctx.label} ${ctx.endpoint}`);
    this.ch.error(
      `[${this.requestId}] Provider Request Headers:\n${JSON.stringify(
        ctx.headers,
        null,
        2,
      )}`,
    );
    this.ch.error(
      `[${this.requestId}] Provider Request Body:\n${JSON.stringify(
        ctx.body,
        null,
        2,
      )}`,
    );
    ctx.logged = true;
  }
}

/**
 * Create a new RequestLogger with a unique request ID.
 */
export function createRequestLogger(): RequestLogger {
  const id = `req-${nextRequestId++}`;
  return new RequestLogger(id);
}

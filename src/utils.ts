import type { RequestLogger } from './logger';

/**
 * HTTP status codes that should trigger a retry.
 * - 429: Too Many Requests (rate limiting)
 * - 500: Internal Server Error
 * - 502: Bad Gateway
 * - 503: Service Unavailable
 * - 504: Gateway Timeout
 */
export const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504] as const;

/**
 * Default retry configuration following industry standards.
 * Uses exponential backoff with jitter.
 */
export const DEFAULT_RETRY_CONFIG = {
  /** Maximum number of retry attempts */
  maxRetries: 10,
  /** Initial delay before first retry in milliseconds */
  initialDelayMs: 1000,
  /** Maximum delay cap in milliseconds */
  maxDelayMs: 60000,
  /** Backoff multiplier (delay doubles each attempt by default) */
  backoffMultiplier: 2,
  /** Jitter factor (0-1, adds randomness to prevent thundering herd) */
  jitterFactor: 0.1,
} as const;

export interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterFactor?: number;
}

export interface FetchWithRetryOptions extends RequestInit {
  retryConfig?: RetryConfig;
  logger?: RequestLogger;
}

/**
 * Check if an HTTP status code is retryable.
 */
export function isRetryableStatusCode(status: number): boolean {
  return (RETRYABLE_STATUS_CODES as readonly number[]).includes(status);
}

/**
 * Delay execution for a specified number of milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate retry delay using exponential backoff with jitter.
 *
 * Formula: min(maxDelay, initialDelay * multiplier^attempt) * (1 ± jitter)
 *
 * @param attempt Current attempt number (0-based)
 * @param config Retry configuration
 * @returns Delay in milliseconds
 */
function calculateBackoffDelay(
  attempt: number,
  config: {
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
    jitterFactor: number;
  },
): number {
  // Calculate base exponential delay
  const exponentialDelay =
    config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);

  // Cap at maximum delay
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);

  // Add jitter: random value between -jitter% and +jitter%
  const jitterRange = cappedDelay * config.jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;

  return Math.round(cappedDelay + jitter);
}

/**
 * Fetch with automatic retry for transient HTTP errors.
 *
 * Uses exponential backoff with jitter for the following status codes:
 * 429 (Too Many Requests), 500 (Internal Server Error),
 * 502 (Bad Gateway), 503 (Service Unavailable), 504 (Gateway Timeout)
 *
 * Only logs retry attempts - does not return any text to VSCode for display.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const { retryConfig, logger, ...fetchOptions } = options;
  const maxRetries = retryConfig?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries;
  const initialDelayMs =
    retryConfig?.initialDelayMs ?? DEFAULT_RETRY_CONFIG.initialDelayMs;
  const maxDelayMs = retryConfig?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs;
  const backoffMultiplier =
    retryConfig?.backoffMultiplier ?? DEFAULT_RETRY_CONFIG.backoffMultiplier;
  const jitterFactor =
    retryConfig?.jitterFactor ?? DEFAULT_RETRY_CONFIG.jitterFactor;

  let lastResponse: Response | undefined;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      const response = await fetch(url, fetchOptions);

      // If successful or non-retryable error, return immediately
      if (response.ok || !isRetryableStatusCode(response.status)) {
        return response;
      }

      // Retryable status code - decide whether to retry
      lastResponse = response;

      if (attempt < maxRetries) {
        // Calculate delay with exponential backoff and jitter
        const delayMs = calculateBackoffDelay(attempt, {
          initialDelayMs,
          maxDelayMs,
          backoffMultiplier,
          jitterFactor,
        });

        // Log retry attempt (only to logs, not displayed in VSCode)
        logger?.retry(attempt + 1, maxRetries, response.status, delayMs);

        // Wait before retrying
        await delay(delayMs);
      }

      attempt++;
    } catch (error) {
      // Network errors or abort signals should not be retried
      throw error;
    }
  }

  // All retries exhausted, return the last response
  return lastResponse!;
}

/**
 * Normalize a base URL for API calls:
 * - trims whitespace
 * - removes query/hash
 * - collapses extra slashes
 * - rejects URLs that already include /v1/messages
 * - removes trailing slash
 */
export function normalizeBaseUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Base URL is required');
  }
  const parsed = new URL(trimmed);
  parsed.search = '';
  parsed.hash = '';

  const collapsed = parsed.pathname.replace(/\/{2,}/g, '/');
  if (/\/v1\/messages\/?$/i.test(collapsed)) {
    throw new Error('Base URL should not include /v1/messages');
  }
  const pathname = collapsed.replace(/\/+$/, '');
  parsed.pathname = pathname;

  // URL.toString re-adds a trailing slash when pathname is empty; strip it.
  const normalized = parsed.toString().replace(/\/+$/, '');
  return normalized;
}

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

export function buildAnthropicMessagesUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrlInput(baseUrl);
  return `${normalized}/v1/messages`;
}

export function buildAnthropicModelsUrl(
  baseUrl: string,
  afterId?: string,
): string {
  const normalized = normalizeBaseUrlInput(baseUrl);
  const url = new URL(`${normalized}/v1/models`);
  if (afterId) {
    url.searchParams.set('after_id', afterId);
  }
  return url.toString();
}

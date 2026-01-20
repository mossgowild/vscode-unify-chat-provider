import { createHash, randomBytes } from 'node:crypto';
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  CODE_ASSIST_ENDPOINT_FALLBACKS,
  CODE_ASSIST_HEADERS,
  CODE_ASSIST_LOAD_ENDPOINTS,
  GEMINI_CLI_HEADERS,
  GOOGLE_OAUTH_AUTH_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_USERINFO_URL,
} from './constants';
import type {
  AntigravityAccountInfo,
  AntigravityAuthState,
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
  AntigravityTier,
} from './types';
import { authLog } from '../../../logger';

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function encodeState(payload: AntigravityAuthState): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeState(state: string): AntigravityAuthState {
  const json = Buffer.from(state, 'base64url').toString('utf8');
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid state');
  }
  const record = parsed as Record<string, unknown>;
  const verifier = record['verifier'];
  const projectId = record['projectId'];
  if (typeof verifier !== 'string' || verifier.trim() === '') {
    throw new Error('Invalid state');
  }
  return {
    verifier,
    projectId: typeof projectId === 'string' ? projectId : '',
  };
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const hash = createHash('sha256').update(verifier).digest();
  const challenge = hash.toString('base64url');
  return { verifier, challenge };
}

export async function authorizeAntigravity(projectId = ''): Promise<AntigravityAuthorization> {
  const pkce = generatePkce();

  const state = encodeState({ verifier: pkce.verifier, projectId });

  const url = new URL(GOOGLE_OAUTH_AUTH_URL);
  url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', ANTIGRAVITY_REDIRECT_URI);
  url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '));
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');

  return {
    url: url.toString(),
    verifier: pkce.verifier,
    projectId,
  };
}

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  token_type?: string;
};

type UserInfo = { email?: string };

const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchAccountInfo(
  accessToken: string,
): Promise<AntigravityAccountInfo> {
  authLog.verbose('antigravity-client', 'Fetching account info');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': GEMINI_CLI_HEADERS['User-Agent'],
    'X-Goog-Api-Client': GEMINI_CLI_HEADERS['X-Goog-Api-Client'],
    'Client-Metadata': CODE_ASSIST_HEADERS['Client-Metadata'],
  };

  let detectedTier: AntigravityTier = 'free';

  const loadEndpoints = Array.from(
    new Set<string>([...CODE_ASSIST_LOAD_ENDPOINTS, ...CODE_ASSIST_ENDPOINT_FALLBACKS]),
  );

  for (const baseEndpoint of loadEndpoints) {
    try {
      authLog.verbose('antigravity-client', `Trying endpoint: ${baseEndpoint}`);
      const response = await fetchWithTimeout(`${baseEndpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          metadata: {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
          },
        }),
      });

      if (!response.ok) {
        authLog.verbose('antigravity-client', `Endpoint ${baseEndpoint} returned ${response.status}, trying next`);
        continue;
      }

      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        continue;
      }

      const record = data as Record<string, unknown>;
      const projectField = record['cloudaicompanionProject'];

      let projectId = '';
      if (typeof projectField === 'string') {
        projectId = projectField;
      } else if (
        projectField &&
        typeof projectField === 'object' &&
        !Array.isArray(projectField) &&
        typeof (projectField as Record<string, unknown>)['id'] === 'string'
      ) {
        projectId = (projectField as Record<string, unknown>)['id'] as string;
      }

      const allowedTiers = record['allowedTiers'];
      if (Array.isArray(allowedTiers)) {
        const defaultTier = allowedTiers.find((t) => {
          return (
            t &&
            typeof t === 'object' &&
            !Array.isArray(t) &&
            (t as Record<string, unknown>)['isDefault'] === true
          );
        }) as Record<string, unknown> | undefined;

        const tierId = defaultTier?.['id'];
        if (typeof tierId === 'string') {
          if (
            tierId !== 'legacy-tier' &&
            !tierId.includes('free') &&
            !tierId.includes('zero')
          ) {
            detectedTier = 'paid';
          } else if (tierId !== 'legacy-tier') {
            detectedTier = 'free';
          }
        }
      }

      const paidTier = record['paidTier'];
      if (
        paidTier &&
        typeof paidTier === 'object' &&
        !Array.isArray(paidTier) &&
        typeof (paidTier as Record<string, unknown>)['id'] === 'string'
      ) {
        const paidTierId = (paidTier as Record<string, unknown>)['id'] as string;
        if (!paidTierId.includes('free') && !paidTierId.includes('zero')) {
          detectedTier = 'paid';
        }
      }

      if (projectId) {
        authLog.verbose('antigravity-client', `Account info fetched (projectId: ${projectId}, tier: ${detectedTier})`);
        return { projectId, tier: detectedTier };
      }
    } catch (error) {
      authLog.verbose('antigravity-client', `Endpoint ${baseEndpoint} failed with error, trying next`);
      continue;
    }
  }

  authLog.verbose('antigravity-client', `Account info fetch completed (projectId: empty, tier: ${detectedTier})`);
  return { projectId: '', tier: detectedTier };
}

export async function exchangeAntigravity(options: {
  code: string;
  state: string;
}): Promise<AntigravityTokenExchangeResult> {
  authLog.verbose('antigravity-client', 'Exchanging authorization code for tokens');
  try {
    const decoded = decodeState(options.state);

    authLog.verbose('antigravity-client', `Token exchange request to ${GOOGLE_OAUTH_TOKEN_URL}`);
    const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': GEMINI_CLI_HEADERS['User-Agent'],
        'X-Goog-Api-Client': GEMINI_CLI_HEADERS['X-Goog-Api-Client'],
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        code: options.code,
        grant_type: 'authorization_code',
        redirect_uri: ANTIGRAVITY_REDIRECT_URI,
        code_verifier: decoded.verifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text().catch(() => '');
      authLog.error('antigravity-client', `Token exchange failed (status: ${tokenResponse.status})`, errorText);
      return { type: 'failed', error: errorText || 'Token exchange failed' };
    }

    const tokenPayload = (await tokenResponse.json()) as TokenResponse;

    const accessToken = tokenPayload.access_token;
    const refreshToken = tokenPayload.refresh_token;

    if (typeof accessToken !== 'string' || accessToken.trim() === '') {
      authLog.error('antigravity-client', 'Missing access token in response');
      return { type: 'failed', error: 'Missing access token in response' };
    }

    if (typeof refreshToken !== 'string' || refreshToken.trim() === '') {
      authLog.error('antigravity-client', 'Missing refresh token in response');
      return { type: 'failed', error: 'Missing refresh token in response' };
    }

    const expiresAt =
      typeof tokenPayload.expires_in === 'number'
        ? Date.now() + tokenPayload.expires_in * 1000
        : undefined;

    authLog.verbose('antigravity-client', 'Fetching user info');
    const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': GEMINI_CLI_HEADERS['User-Agent'],
        'X-Goog-Api-Client': GEMINI_CLI_HEADERS['X-Goog-Api-Client'],
      },
    });

    const userInfo: UserInfo = userInfoResponse.ok
      ? ((await userInfoResponse.json()) as UserInfo)
      : {};

    const accountInfo = await fetchAccountInfo(accessToken);

    const projectId = decoded.projectId || accountInfo.projectId;

    authLog.verbose('antigravity-client', `Token exchange successful (email: ${userInfo.email}, projectId: ${projectId})`);
    return {
      type: 'success',
      accessToken,
      refreshToken,
      expiresAt,
      email: userInfo.email,
      projectId,
      tier: accountInfo.tier,
    };
  } catch (error) {
    authLog.error('antigravity-client', 'Token exchange failed with exception', error);
    return {
      type: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function refreshAccessToken(options: {
  refreshToken: string;
}): Promise<{ accessToken: string; expiresAt?: number; tokenType?: string } | null> {
  authLog.verbose('antigravity-client', 'Refreshing access token');
  try {
    const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': GEMINI_CLI_HEADERS['User-Agent'],
        'X-Goog-Api-Client': GEMINI_CLI_HEADERS['X-Goog-Api-Client'],
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        refresh_token: options.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      authLog.error('antigravity-client', `Token refresh failed (status: ${response.status})`);
      return null;
    }

    const payload = (await response.json()) as TokenResponse;
    const accessToken = payload.access_token;
    if (typeof accessToken !== 'string' || accessToken.trim() === '') {
      authLog.error('antigravity-client', 'Missing access token in refresh response');
      return null;
    }

    const expiresAt =
      typeof payload.expires_in === 'number'
        ? Date.now() + payload.expires_in * 1000
        : undefined;

    const tokenType = typeof payload.token_type === 'string' ? payload.token_type : undefined;

    authLog.verbose('antigravity-client', `Token refresh successful (expiresAt: ${expiresAt ? new Date(expiresAt).toISOString() : 'never'})`);
    return { accessToken, expiresAt, tokenType };
  } catch (error) {
    authLog.error('antigravity-client', 'Token refresh failed with exception', error);
    return null;
  }
}

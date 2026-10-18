import { safeFetch } from '@amable/auth/security';

/**
 * Google service account keys (the JSON downloaded from Google Cloud → IAM →
 * Service accounts → Keys). The connector signs a JWT with the key and trades
 * it for an access token (https://developers.google.com/identity/protocols/oauth2/service-account);
 * the spreadsheet must be shared with the account's `client_email`.
 */

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export interface ServiceAccountKey {
  readonly clientEmail: string;
  readonly privateKey: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function parseServiceAccountKey(
  text: string,
): { ok: true; key: ServiceAccountKey } | { ok: false; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'not a JSON file: upload the key downloaded from Google Cloud' };
  }
  const v = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (v['type'] !== 'service_account') {
    return { ok: false, message: 'not a service account key (expected "type": "service_account")' };
  }
  const clientEmail = typeof v['client_email'] === 'string' ? v['client_email'].trim() : '';
  const privateKey = typeof v['private_key'] === 'string' ? v['private_key'] : '';
  if (!/^[^\s@]+@[^\s@]+$/.test(clientEmail))
    return { ok: false, message: 'the key has no client_email' };
  if (!privateKey.includes('-----BEGIN PRIVATE KEY-----'))
    return { ok: false, message: 'the key has no private_key' };
  // The signed assertion only ever goes to Google's token endpoint.
  if (v['token_uri'] !== undefined && v['token_uri'] !== GOOGLE_TOKEN_URL) {
    return { ok: false, message: `unexpected token_uri (expected ${GOOGLE_TOKEN_URL})` };
  }
  return { ok: true, key: { clientEmail, privateKey } };
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const utf8 = (text: string) => new TextEncoder().encode(text);

async function signAssertion(key: ServiceAccountKey, scope: string, nowS: number): Promise<string> {
  const pem = key.privateKey.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const header = base64url(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = base64url(
    utf8(
      JSON.stringify({
        iss: key.clientEmail,
        scope,
        aud: GOOGLE_TOKEN_URL,
        iat: nowS,
        exp: nowS + 3600,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    utf8(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
}

export type TokenResult =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly retryable: boolean; readonly message: string };

/** Tokens last an hour; reused per isolate until a minute before they expire. */
const tokenCache = new Map<string, { token: string; until: number }>();

export async function serviceAccountToken(
  key: ServiceAccountKey,
  options: { fetch: Fetch; nowMs: number; scope?: string },
): Promise<TokenResult> {
  const scope = options.scope ?? SHEETS_SCOPE;
  const cacheKey = `${key.clientEmail}\n${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached !== undefined && cached.until > options.nowMs)
    return { ok: true, accessToken: cached.token };
  let assertion: string;
  try {
    assertion = await signAssertion(key, scope, Math.floor(options.nowMs / 1000));
  } catch {
    return {
      ok: false,
      retryable: false,
      message: 'the private_key of the service account key is not valid',
    };
  }
  try {
    const response = await safeFetch(
      GOOGLE_TOKEN_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      },
      { fetchFn: options.fetch, timeoutMs: 10_000, maxBytes: 16 * 1024 },
    );
    const body = JSON.parse(new TextDecoder().decode(response.body) || '{}') as {
      access_token?: unknown;
      expires_in?: unknown;
      error_description?: unknown;
      error?: unknown;
    };
    if (response.status === 200 && typeof body.access_token === 'string') {
      const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
      tokenCache.set(cacheKey, {
        token: body.access_token,
        until: options.nowMs + (expiresIn - 60) * 1000,
      });
      return { ok: true, accessToken: body.access_token };
    }
    const reason =
      typeof body.error_description === 'string'
        ? body.error_description
        : String(body.error ?? response.status);
    return {
      ok: false,
      retryable: response.status === 429 || response.status >= 500,
      message: `Google refused the service account key: ${reason}`,
    };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      message: `token request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function clearServiceAccountTokens(): void {
  tokenCache.clear();
}

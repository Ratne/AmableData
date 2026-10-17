import { discover, type Fetch } from './discovery';
import { base64url, randomId, utf8 } from './encoding';
import { signJwt, type PrivateJwk } from './keys';

/**
 * OAuth for apps: authorization code (+ optional PKCE) and refresh, with
 * `private_key_jwt` client authentication (RFC 7523): no client secret, the
 * app signs a short assertion with its key published at `jwks_url`.
 */

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export interface AppCredentials {
  readonly appId: string;
  readonly key: PrivateJwk;
  /** Clock override (tests, known skew). */
  readonly now?: () => number;
}

export interface Installation {
  readonly id: string;
  readonly app_id: string;
  readonly status: string;
  readonly api_version: string;
  readonly tenant: { readonly id: string; readonly slug: string; readonly name?: string };
  readonly origin: string;
  readonly api_base: string;
}

export interface TokenSet {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly token_type: 'Bearer';
  readonly scope: string;
  readonly installation: Installation;
  /** Only on the first exchange: secret that signs every call the CRM makes to the app. Store it. */
  readonly webhook_secret?: string | null;
}

export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function clientAssertion(credentials: AppCredentials, tokenEndpoint: string, lifetimeSeconds = 120): Promise<string> {
  const now = Math.floor((credentials.now ?? Date.now)() / 1000);
  return signJwt(
    { iss: credentials.appId, sub: credentials.appId, aud: tokenEndpoint, iat: now, exp: now + lifetimeSeconds, jti: randomId() },
    credentials.key,
  );
}

/** PKCE pair: send `challenge` when starting, `verifier` when exchanging the code. */
export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomId(32);
  const digest = await crypto.subtle.digest('SHA-256', utf8(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

async function tokenRequest(origin: string, credentials: AppCredentials, params: Record<string, string>, fetcher: Fetch): Promise<TokenSet> {
  const { token_endpoint } = await discover(origin, fetcher);
  const response = await fetcher(token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      ...params,
      client_id: credentials.appId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(credentials, token_endpoint),
    }).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new OAuthError(response.status, String(body['error'] ?? 'token_error'), String(body['error_description'] ?? body['message'] ?? `HTTP ${String(response.status)}`));
  }
  return body as unknown as TokenSet;
}

/**
 * Install callback: the CRM redirects the admin to your `redirect_uri` with
 * `code`, `installation_id`, `tenant`, `iss` (installation origin) and `state`.
 * Check `state`, then exchange the code here.
 */
export function exchangeCode(
  input: { origin: string; code: string; redirectUri: string; codeVerifier?: string },
  credentials: AppCredentials,
  fetcher: Fetch = fetch,
): Promise<TokenSet> {
  return tokenRequest(
    input.origin,
    credentials,
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      ...(input.codeVerifier === undefined ? {} : { code_verifier: input.codeVerifier }),
    },
    fetcher,
  );
}

/** Refresh tokens rotate: store the new refresh token every time. */
export function refreshTokens(input: { origin: string; refreshToken: string }, credentials: AppCredentials, fetcher: Fetch = fetch): Promise<TokenSet> {
  return tokenRequest(input.origin, credentials, { grant_type: 'refresh_token', refresh_token: input.refreshToken }, fetcher);
}

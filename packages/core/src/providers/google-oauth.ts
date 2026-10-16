import {
  OAUTH_SCOPES,
  type OAuthAccessToken,
  type OAuthAccountRef,
  type OAuthConnectStart,
  type OAuthProviderId,
  type OAuthScope,
  type OAuthTokenProvider,
} from '../oauth';

/**
 * Bring-your-own Google OAuth app for self-hosted installations: the operator
 * registers a Google Cloud OAuth client (redirect URI
 * `<app origin>/oauth/google/callback`) and sets its id and secret. Refresh
 * tokens are stored encrypted in the installation (key/value store), never
 * leave it and are never returned to callers.
 *
 * Flow: `startConnect` stores a one-time state and returns Google's consent
 * URL; Google redirects to the fixed callback, `callbackRedirect` turns that
 * into the module's `returnUrl` + `state` + `code` (same contract as the other
 * providers); the page then calls `finishConnect`, which exchanges the code.
 */

export interface OAuthKeyValueStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Authenticated encryption of the stored grants (e.g. the installation SecretBox). */
export interface OAuthSealer {
  encrypt(plaintext: string, associatedData?: string): Promise<string>;
  decrypt(ciphertext: string, associatedData?: string): Promise<string>;
}

export type OAuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Must match the redirect URI registered on the OAuth client. */
  readonly redirectUri: string;
  readonly store: OAuthKeyValueStore;
  readonly sealer: OAuthSealer;
  readonly fetch: OAuthFetch;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const STATE_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 60_000;
const STATE_PREFIX = 'oauth_state:';
const ACCOUNT_PREFIX = 'oauth_account:';
const KNOWN_SCOPES = new Set<string>(Object.values(OAUTH_SCOPES));

interface PendingState {
  tenantId: string;
  provider: OAuthProviderId;
  scopes: OAuthScope[];
  returnUrl: string;
  expiresAt: number;
}

interface StoredGrant {
  tenantId: string;
  refreshToken: string;
  scopes: OAuthScope[];
  email: string | null;
  accessToken: string | null;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  id_token?: unknown;
  error?: unknown;
}

export class GoogleOAuthError extends Error {
  override readonly name = 'GoogleOAuthError';
  constructor(
    readonly code: 'invalid_state' | 'token_exchange_failed' | 'no_refresh_token',
    message: string,
  ) {
    super(message);
  }
}

function defaultRandomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function grantedScopes(raw: unknown, requested: readonly OAuthScope[]): OAuthScope[] {
  if (typeof raw !== 'string') return [...requested];
  return raw.split(' ').filter((s): s is OAuthScope => KNOWN_SCOPES.has(s));
}

/** Email claim of the ID token (received directly from Google's token endpoint over TLS). */
function emailOf(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const part = idToken.split('.')[1];
  if (part === undefined) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { email?: unknown };
    return typeof claims.email === 'string' ? claims.email : null;
  } catch {
    return null;
  }
}

export class GoogleOAuthTokenProvider implements OAuthTokenProvider {
  readonly available = true;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(private readonly config: GoogleOAuthConfig) {
    this.now = config.now ?? Date.now;
    this.randomId = config.randomId ?? defaultRandomId;
  }

  async startConnect(input: {
    tenantId: string;
    provider: OAuthProviderId;
    scopes: readonly OAuthScope[];
    returnUrl: string;
  }): Promise<OAuthConnectStart> {
    const state = this.randomId();
    const pending: PendingState = {
      tenantId: input.tenantId,
      provider: input.provider,
      scopes: [...input.scopes],
      returnUrl: input.returnUrl,
      expiresAt: this.now() + STATE_TTL_MS,
    };
    await this.config.store.put(`${STATE_PREFIX}${state}`, JSON.stringify(pending));
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', ['openid', 'email', ...input.scopes].join(' '));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('state', state);
    return { authorizeUrl: url.toString(), state };
  }

  private async pending(state: string): Promise<PendingState | null> {
    const raw = await this.config.store.get(`${STATE_PREFIX}${state}`);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as PendingState;
    if (parsed.expiresAt < this.now()) {
      await this.config.store.delete(`${STATE_PREFIX}${state}`);
      return null;
    }
    return parsed;
  }

  /**
   * Fixed callback (`/oauth/google/callback`): where the browser goes next —
   * the module's return URL with `state` and `code` (or `error`) — or null for
   * an unknown / expired state.
   */
  async callbackRedirect(params: URLSearchParams): Promise<string | null> {
    const state = params.get('state') ?? '';
    const pending = state === '' ? null : await this.pending(state);
    if (pending === null) return null;
    const target = new URL(pending.returnUrl);
    target.searchParams.set('state', state);
    const code = params.get('code');
    if (code !== null && code !== '') target.searchParams.set('code', code);
    else target.searchParams.set('error', params.get('error') ?? 'access_denied');
    return target.toString();
  }

  private async token(body: Record<string, string>): Promise<{ status: number; json: TokenResponse }> {
    const res = await this.config.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...body,
      }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    return { status: res.status, json };
  }

  private async save(accountId: string, grant: StoredGrant): Promise<void> {
    const sealed = await this.config.sealer.encrypt(JSON.stringify(grant), accountId);
    await this.config.store.put(`${ACCOUNT_PREFIX}${accountId}`, sealed);
  }

  private async load(account: OAuthAccountRef): Promise<StoredGrant | null> {
    const sealed = await this.config.store.get(`${ACCOUNT_PREFIX}${account.accountId}`);
    if (sealed === null) return null;
    const grant = JSON.parse(await this.config.sealer.decrypt(sealed, account.accountId)) as StoredGrant;
    return grant.tenantId === account.tenantId ? grant : null;
  }

  async finishConnect(input: { tenantId: string; state: string; code: string }): Promise<{
    account: OAuthAccountRef;
    email: string | null;
  }> {
    const pending = await this.pending(input.state);
    if (pending === null || pending.tenantId !== input.tenantId) {
      throw new GoogleOAuthError('invalid_state', 'unknown or expired OAuth state');
    }
    await this.config.store.delete(`${STATE_PREFIX}${input.state}`);
    const { status, json } = await this.token({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.config.redirectUri,
    });
    if (status !== 200 || typeof json.access_token !== 'string') {
      throw new GoogleOAuthError('token_exchange_failed', `Google token exchange failed (${String(status)})`);
    }
    if (typeof json.refresh_token !== 'string') {
      throw new GoogleOAuthError('no_refresh_token', 'Google returned no refresh token');
    }
    const accountId = `g_${this.randomId()}`;
    const email = emailOf(json.id_token);
    await this.save(accountId, {
      tenantId: input.tenantId,
      refreshToken: json.refresh_token,
      scopes: grantedScopes(json.scope, pending.scopes),
      email,
      accessToken: json.access_token,
      expiresAt: this.now() + (typeof json.expires_in === 'number' ? json.expires_in : 3600) * 1000,
    });
    return { account: { tenantId: input.tenantId, provider: 'google', accountId }, email };
  }

  async getAccessToken(account: OAuthAccountRef): Promise<OAuthAccessToken | null> {
    const grant = await this.load(account);
    if (grant === null) return null;
    const now = this.now();
    if (grant.accessToken !== null && grant.expiresAt - REFRESH_MARGIN_MS > now) {
      return { accessToken: grant.accessToken, expiresAt: grant.expiresAt, scopes: grant.scopes, stub: false };
    }
    const { status, json } = await this.token({ grant_type: 'refresh_token', refresh_token: grant.refreshToken });
    if (status === 400 || status === 401) {
      // invalid_grant: revoked by the user or expired — the account is gone.
      await this.config.store.delete(`${ACCOUNT_PREFIX}${account.accountId}`);
      return null;
    }
    if (status !== 200 || typeof json.access_token !== 'string') {
      throw new GoogleOAuthError('token_exchange_failed', `Google token refresh failed (${String(status)})`);
    }
    const next: StoredGrant = {
      ...grant,
      accessToken: json.access_token,
      expiresAt: now + (typeof json.expires_in === 'number' ? json.expires_in : 3600) * 1000,
      scopes: grantedScopes(json.scope, grant.scopes),
    };
    await this.save(account.accountId, next);
    return { accessToken: next.accessToken ?? '', expiresAt: next.expiresAt, scopes: next.scopes, stub: false };
  }

  async revoke(account: OAuthAccountRef): Promise<void> {
    const grant = await this.load(account);
    if (grant === null) return;
    await this.config.store.delete(`${ACCOUNT_PREFIX}${account.accountId}`);
    try {
      await this.config.fetch(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: grant.refreshToken }).toString(),
      });
    } catch {
      // Local grant already removed; Google expires unused refresh tokens on its own.
    }
  }
}

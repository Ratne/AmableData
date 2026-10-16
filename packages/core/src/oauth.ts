/**
 * OAuth access for third-party APIs used by tenant connections (Google Sheets
 * for forms, Google Calendar for bookings).
 *
 * The managed offering resolves tokens through the central OAuth apps of the
 * control plane; self-hosted installations plug their own app. Until that
 * service exists the installation ships `devOAuthProvider` (dev only): it
 * reports every account as connected with a fake token, and callers must not
 * reach the real Google APIs with it (`token.stub === true`).
 */

export type OAuthProviderId = 'google';

/** Scopes the product asks for, by capability. */
export const OAUTH_SCOPES = {
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  calendarRead: 'https://www.googleapis.com/auth/calendar.readonly',
} as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[keyof typeof OAUTH_SCOPES];

/** Reference to an account a tenant user connected (stored by the module, never the token). */
export interface OAuthAccountRef {
  readonly tenantId: string;
  readonly provider: OAuthProviderId;
  /** Opaque account id issued by the token service. */
  readonly accountId: string;
}

export interface OAuthAccessToken {
  readonly accessToken: string;
  /** Epoch ms. */
  readonly expiresAt: number;
  readonly scopes: readonly OAuthScope[];
  /** True for the dev stub: the token is fake and must not be sent to the provider. */
  readonly stub: boolean;
}

export interface OAuthConnectStart {
  /** Where the browser goes to grant access. */
  readonly authorizeUrl: string;
  readonly state: string;
}

export interface OAuthTokenProvider {
  /** Whether connecting accounts is possible on this installation. */
  readonly available: boolean;
  startConnect(input: {
    tenantId: string;
    provider: OAuthProviderId;
    scopes: readonly OAuthScope[];
    returnUrl: string;
  }): Promise<OAuthConnectStart>;
  /** Completes the grant; returns the account reference to store. */
  finishConnect(input: { tenantId: string; state: string; code: string }): Promise<{
    account: OAuthAccountRef;
    email: string | null;
  }>;
  /** A fresh access token, or null when the account was revoked / never connected. */
  getAccessToken(account: OAuthAccountRef): Promise<OAuthAccessToken | null>;
  revoke(account: OAuthAccountRef): Promise<void>;
}

/** Installations without an OAuth service: nothing can be connected. */
export const unavailableOAuthProvider: OAuthTokenProvider = {
  available: false,
  startConnect: () => Promise.reject(new Error('oauth_unavailable')),
  finishConnect: () => Promise.reject(new Error('oauth_unavailable')),
  getAccessToken: () => Promise.resolve(null),
  revoke: () => Promise.resolve(),
};

/**
 * Local development stub: "connecting" returns immediately to `returnUrl`
 * with a fake code, and every account yields a fake, clearly marked token.
 */
export function devOAuthProvider(now: () => number = Date.now): OAuthTokenProvider {
  return {
    available: true,
    startConnect: ({ tenantId, provider, returnUrl }) => {
      const state = `dev.${tenantId}.${provider}.${now()}`;
      const url = new URL(returnUrl);
      url.searchParams.set('state', state);
      url.searchParams.set('code', 'dev-code');
      return Promise.resolve({ authorizeUrl: url.toString(), state });
    },
    finishConnect: ({ tenantId, state }) =>
      Promise.resolve({
        account: { tenantId, provider: 'google', accountId: `dev-account:${state}` },
        email: 'dev-account@example.com',
      }),
    getAccessToken: () =>
      Promise.resolve({
        accessToken: 'dev-stub-token',
        expiresAt: now() + 3_600_000,
        scopes: Object.values(OAUTH_SCOPES),
        stub: true,
      }),
    revoke: () => Promise.resolve(),
  };
}

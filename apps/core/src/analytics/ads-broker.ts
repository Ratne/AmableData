import type { AdPlatform } from '@amable/api-types';
import type {
  OAuthBrokerProvider,
  OAuthFinishRequest,
  OAuthFinishResponse,
  OAuthRevokeRequest,
  OAuthStartRequest,
  OAuthStartResponse,
  OAuthTokenRequest,
  OAuthTokenResponse,
} from '@amable/core/platform';
import type { Env } from '../env';
import { ControlPlaneError, controlPlaneClient, type ControlPlaneClient } from '../platform/client';

/**
 * Ads OAuth through the central broker of the control plane
 * (`/v1/installation/oauth/*`): the control plane owns the ad platform app,
 * runs the authorization flow against its own fixed callback and keeps the
 * tokens; the installation stores only an opaque account reference and asks
 * for short-lived access tokens when syncing. An own app configured on the
 * installation always takes precedence (see `adPlatformClientsFor`).
 */

/** Upstream of the central broker backing an ad platform, or null when the platform is never brokered. */
export function brokerProviderOf(platform: AdPlatform): OAuthBrokerProvider | null {
  // Google Ads needs a per-operator developer token on every API call and
  // TikTok has no central upstream: both stay own-app only.
  return platform === 'meta' ? 'meta' : null;
}

/** Ad platforms served by the central broker on this installation (licensed only). */
export function brokeredAdPlatform(env: Env, platform: AdPlatform): boolean {
  if (brokerProviderOf(platform) === null) return false;
  return controlPlaneClient(env) !== null;
}

export class AdsBrokerError extends Error {
  override readonly name = 'AdsBrokerError';
  constructor(
    readonly code: 'unavailable' | 'invalid_grant',
    message: string,
  ) {
    super(message);
  }
}

export interface AdsBrokerTokens {
  readonly accessToken: string;
  /** Epoch ms. */
  readonly expiresAt: number;
}

export interface AdsOAuthBroker {
  start(input: {
    tenantId: string;
    platform: AdPlatform;
    scopes: readonly string[];
    returnUrl: string;
  }): Promise<{ authorizeUrl: string; state: string }>;
  finish(input: { tenantId: string; platform: AdPlatform; state: string; code: string }): Promise<{ accountId: string }>;
  /** Null when the account was revoked upstream or never connected (reconnect needed). */
  token(input: { tenantId: string; accountId: string }): Promise<AdsBrokerTokens | null>;
  /** Swallows "already gone"; any other failure throws `AdsBrokerError`. */
  revoke(input: { tenantId: string; accountId: string }): Promise<void>;
}

function unavailable(error: unknown): never {
  if (error instanceof ControlPlaneError) {
    throw new AdsBrokerError('unavailable', `ads broker: ${error.message}`);
  }
  throw error;
}

export function controlPlaneAdsBroker(client: ControlPlaneClient): AdsOAuthBroker {
  return {
    async start(input) {
      const provider = brokerProviderOf(input.platform);
      if (provider === null) throw new AdsBrokerError('unavailable', `ads broker: ${input.platform} is not brokered`);
      const body: OAuthStartRequest = {
        tenantId: input.tenantId,
        provider,
        scopes: input.scopes,
        returnUrl: input.returnUrl,
      };
      try {
        const res = await client.post<OAuthStartResponse>('/oauth/start', body);
        return { authorizeUrl: res.authorizeUrl, state: res.state };
      } catch (error) {
        return unavailable(error);
      }
    },

    async finish(input) {
      const provider = brokerProviderOf(input.platform);
      if (provider === null) throw new AdsBrokerError('unavailable', `ads broker: ${input.platform} is not brokered`);
      const body: OAuthFinishRequest = { tenantId: input.tenantId, state: input.state, code: input.code };
      let res: OAuthFinishResponse;
      try {
        res = await client.post<OAuthFinishResponse>('/oauth/finish', body);
      } catch (error) {
        if (error instanceof ControlPlaneError && error.status === 400) {
          throw new AdsBrokerError('invalid_grant', 'ads broker: invalid or expired authorization');
        }
        return unavailable(error);
      }
      if (res.account.provider !== provider || res.account.tenantId !== input.tenantId) {
        throw new AdsBrokerError('unavailable', 'ads broker: account mismatch');
      }
      return { accountId: res.account.accountId };
    },

    async token(input) {
      const body: OAuthTokenRequest = { tenantId: input.tenantId, accountId: input.accountId };
      try {
        const res = await client.post<OAuthTokenResponse>('/oauth/token', body);
        return { accessToken: res.accessToken, expiresAt: res.expiresAt };
      } catch (error) {
        if (error instanceof ControlPlaneError && error.status === 404) return null;
        return unavailable(error);
      }
    },

    async revoke(input) {
      const body: OAuthRevokeRequest = { tenantId: input.tenantId, accountId: input.accountId };
      try {
        await client.post<unknown>('/oauth/revoke', body);
      } catch (error) {
        if (error instanceof ControlPlaneError && error.status === 404) return;
        unavailable(error);
      }
    },
  };
}

/** The central broker when licensed, null otherwise (own app or nothing). */
export function adsOAuthBrokerFor(env: Env): AdsOAuthBroker | null {
  const client = controlPlaneClient(env);
  return client === null ? null : controlPlaneAdsBroker(client);
}

import {
  devOAuthProvider,
  unavailableOAuthProvider,
  type OAuthAccessToken,
  type OAuthAccountRef,
  type OAuthConnectStart,
  type OAuthProviderId,
  type OAuthScope,
  type OAuthTokenProvider,
} from '@amable/core';
import type {
  OAuthFinishRequest,
  OAuthFinishResponse,
  OAuthRevokeRequest,
  OAuthStartRequest,
  OAuthStartResponse,
  OAuthTokenRequest,
  OAuthTokenResponse,
} from '@amable/core/platform';
import type { Env } from '../env';
import { ControlPlaneError, controlPlaneClient, type ControlPlaneClient } from './client';

function isScope(value: string): value is OAuthScope {
  return value.startsWith('https://www.googleapis.com/auth/');
}

/**
 * OAuthTokenProvider backed by the control plane's central OAuth broker
 * (`/v1/installation/oauth/{start,finish,token,revoke}`). Tokens stay
 * encrypted on the control plane; this installation only receives short-lived
 * access tokens of its own accounts.
 */
export class ControlPlaneOAuthTokenProvider implements OAuthTokenProvider {
  readonly available = true;

  constructor(private readonly client: ControlPlaneClient) {}

  async startConnect(input: {
    tenantId: string;
    provider: OAuthProviderId;
    scopes: readonly OAuthScope[];
    returnUrl: string;
  }): Promise<OAuthConnectStart> {
    const body: OAuthStartRequest = {
      tenantId: input.tenantId,
      provider: input.provider,
      scopes: input.scopes,
      returnUrl: input.returnUrl,
    };
    const res = await this.client.post<OAuthStartResponse>('/oauth/start', body);
    return { authorizeUrl: res.authorizeUrl, state: res.state };
  }

  async finishConnect(input: {
    tenantId: string;
    state: string;
    code: string;
  }): Promise<{ account: OAuthAccountRef; email: string | null }> {
    const body: OAuthFinishRequest = input;
    const res = await this.client.post<OAuthFinishResponse>('/oauth/finish', body);
    if (res.account.provider !== 'google' || res.account.tenantId !== input.tenantId) {
      throw new ControlPlaneError(502, 'oauth_account_mismatch');
    }
    return {
      account: { tenantId: res.account.tenantId, provider: 'google', accountId: res.account.accountId },
      email: res.email,
    };
  }

  async getAccessToken(account: OAuthAccountRef): Promise<OAuthAccessToken | null> {
    const body: OAuthTokenRequest = { tenantId: account.tenantId, accountId: account.accountId };
    try {
      const res = await this.client.post<OAuthTokenResponse>('/oauth/token', body);
      return {
        accessToken: res.accessToken,
        expiresAt: res.expiresAt,
        scopes: res.scopes.filter(isScope),
        stub: false,
      };
    } catch (error) {
      if (error instanceof ControlPlaneError && error.status === 404) return null;
      throw error;
    }
  }

  async revoke(account: OAuthAccountRef): Promise<void> {
    const body: OAuthRevokeRequest = { tenantId: account.tenantId, accountId: account.accountId };
    try {
      await this.client.post<unknown>('/oauth/revoke', body);
    } catch (error) {
      if (error instanceof ControlPlaneError && error.status === 404) return;
      throw error;
    }
  }
}

/** Broker when licensed, the dev stub in dev, nothing otherwise (open source plugs its own app). */
export function platformOAuthProvider(env: Env): OAuthTokenProvider {
  const client = controlPlaneClient(env);
  if (client !== null) return new ControlPlaneOAuthTokenProvider(client);
  if (env.ENVIRONMENT === 'dev') return devOAuthProvider();
  return unavailableOAuthProvider;
}

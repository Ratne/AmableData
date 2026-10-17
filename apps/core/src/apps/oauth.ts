import { sha256Hex } from '@amable/auth';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { AppEnv } from '../middleware';
import { getAuth, requireAuth } from '../middleware/access';
import { appOriginOf } from '../providers/select';
import { AppError } from './errors';
import { currentWebhookSecret } from './events';
import { activateInstall } from './lifecycle';
import { installById, type AppInstall } from './store';
import {
  issueTokens,
  redeemCode,
  revokeToken,
  rotateRefreshToken,
  verifyClientAssertion,
  type TokenPair,
} from './tokens';

/**
 * OAuth server of the installation, for apps (`/api/apps/v1/*`, no cookies,
 * CSRF-exempt): token endpoint (authorization_code with optional PKCE,
 * refresh_token with rotation), revocation, and the app's own credentials.
 */

async function readParams(c: Context<AppEnv>): Promise<Record<string, string>> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }
  const form = await c.req.parseBody().catch(() => ({}));
  return Object.fromEntries(Object.entries(form).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

function oauthError(c: Context<AppEnv>, error: unknown) {
  if (error instanceof AppError) {
    c.header('cache-control', 'no-store');
    return c.json({ error: error.code, error_description: error.message }, error.status);
  }
  throw error;
}

async function tenantOf(c: Context<AppEnv>, tenantId: string) {
  const row = await c.env.DB.prepare(`SELECT id, slug, name FROM tenants WHERE id = ?`)
    .bind(tenantId)
    .first<{ id: string; slug: string; name: string }>();
  if (row === null) throw new AppError(400, 'invalid_grant', 'workspace not found');
  return row;
}

async function tokenResponse(c: Context<AppEnv>, install: AppInstall, tokens: TokenPair, extra: Record<string, unknown> = {}) {
  const tenant = await tenantOf(c, install.tenantId);
  c.header('cache-control', 'no-store');
  return c.json({
    ...tokens,
    token_type: 'Bearer',
    scope: install.scopes.join(' '),
    installation: {
      id: install.id,
      app_id: install.appId,
      status: install.status,
      api_version: install.apiVersion,
      tenant,
      origin: appOriginOf(c.env),
      api_base: `${appOriginOf(c.env)}/api/v2/t/${tenant.slug}`,
    },
    ...extra,
  });
}

export const appsOAuthRoutes = new Hono<AppEnv>();

appsOAuthRoutes.post('/token', async (c) => {
  const now = c.get('services').now();
  try {
    const p = await readParams(c);
    const assertion = {
      assertionType: p.client_assertion_type ?? null,
      assertion: p.client_assertion ?? null,
      clientId: p.client_id ?? null,
      nowMs: now,
    };
    if (p.grant_type === 'authorization_code') {
      if (p.code === undefined || p.redirect_uri === undefined) {
        throw new AppError(400, 'invalid_request', 'code and redirect_uri are required');
      }
      // The code identifies the install; the assertion must come from that app.
      const redeemed = await redeemCode(c.env.DB, {
        code: p.code,
        redirectUri: p.redirect_uri,
        codeVerifier: p.code_verifier ?? null,
        nowMs: now,
      });
      await verifyClientAssertion(c.env, redeemed.install, assertion);
      if (!['pending', 'active', 'paused'].includes(redeemed.install.status)) {
        throw new AppError(400, 'invalid_grant', 'the app is not installed');
      }
      const tokens = await issueTokens(c.env.DB, redeemed.install.id, now);
      const install = await activateInstall(c.env, redeemed.install, now);
      return await tokenResponse(c, install, tokens, { webhook_secret: await currentWebhookSecret(c.env, install.id) });
    }
    if (p.grant_type === 'refresh_token') {
      if (p.refresh_token === undefined) throw new AppError(400, 'invalid_request', 'refresh_token is required');
      // Verify the client before burning the refresh token.
      const peek = await c.env.DB.prepare(
        `SELECT install_id FROM app_tokens WHERE token_hash = ? AND kind = 'refresh'`,
      )
        .bind(await sha256Hex(p.refresh_token))
        .first<{ install_id: string }>();
      const owner = peek === null ? null : await installById(c.env.DB, peek.install_id);
      if (owner === null) throw new AppError(400, 'invalid_grant', 'unknown refresh token');
      await verifyClientAssertion(c.env, owner, assertion);
      if (!['active', 'paused', 'uninstalling'].includes(owner.status)) {
        throw new AppError(400, 'invalid_grant', 'the app is not installed');
      }
      const rotated = await rotateRefreshToken(c.env.DB, p.refresh_token, now);
      return await tokenResponse(c, owner, rotated.tokens);
    }
    throw new AppError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  } catch (error) {
    return oauthError(c, error);
  }
});

/** RFC 7009: always 200 for a well-formed request (no token oracle). */
appsOAuthRoutes.post('/revoke', async (c) => {
  const now = c.get('services').now();
  try {
    const p = await readParams(c);
    if (p.token === undefined || p.client_id === undefined) {
      throw new AppError(400, 'invalid_request', 'token and client_id are required');
    }
    const row = await c.env.DB.prepare(`SELECT install_id FROM app_tokens WHERE token_hash = ?`)
      .bind(await sha256Hex(p.token))
      .first<{ install_id: string }>();
    const install = row === null ? null : await installById(c.env.DB, row.install_id);
    if (install !== null && install.appId === p.client_id) {
      await verifyClientAssertion(c.env, install, {
        assertionType: p.client_assertion_type ?? null,
        assertion: p.client_assertion ?? null,
        clientId: p.client_id,
        nowMs: now,
      });
      await revokeToken(c.env.DB, install.id, p.token, now);
    }
    return c.body(null, 200);
  } catch (error) {
    return oauthError(c, error);
  }
});

appsOAuthRoutes.use('/installation', requireAuth({ apiKey: true }));
appsOAuthRoutes.use('/webhook-secret', requireAuth({ apiKey: true }));

function appAuth(c: Context<AppEnv>) {
  const auth = getAuth(c);
  if (auth.kind !== 'app') throw new AppError(403, 'app_token_required', 'this endpoint is for app access tokens');
  return auth.app;
}

/** The install behind the token: status, scopes, pending permissions, tenant. */
appsOAuthRoutes.get('/installation', async (c) => {
  try {
    const app = appAuth(c);
    const install = await installById(c.env.DB, app.installId);
    if (install === null) throw new AppError(404, 'not_found', 'install not found');
    const tenant = await tenantOf(c, install.tenantId);
    return c.json({
      id: install.id,
      app_id: install.appId,
      status: install.status,
      scopes: app.scopes,
      pending_scopes: install.pendingScopes ?? [],
      api_version: install.apiVersion,
      cleanup_until: install.cleanupUntil === null ? null : new Date(install.cleanupUntil).toISOString(),
      tenant,
      api_base: `${appOriginOf(c.env)}/api/v2/t/${tenant.slug}`,
    });
  } catch (error) {
    return oauthError(c, error);
  }
});

/** Current webhook secret (after `app.secret_rotated`); the previous one keeps signing for 24 hours. */
appsOAuthRoutes.get('/webhook-secret', async (c) => {
  try {
    const app = appAuth(c);
    c.header('cache-control', 'no-store');
    return c.json({ secret: await currentWebhookSecret(c.env, app.installId) });
  } catch (error) {
    return oauthError(c, error);
  }
});

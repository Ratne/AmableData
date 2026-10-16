import {
  CloudflareSystemEmailProvider,
  ConsoleSystemEmailProvider,
  devOAuthProvider,
  GoogleOAuthTokenProvider,
  NotifySystemEmailProvider,
  unavailableOAuthProvider,
  UnconfiguredSystemEmailProvider,
  type OAuthKeyValueStore,
  type OAuthSealer,
  type OAuthTokenProvider,
  type SystemEmailProvider,
} from '@amable/core';
import { getAuthServices } from '../auth/services';
import type { Env } from '../env';
import { controlPlaneClient } from '../platform/client';
import { ControlPlaneOAuthTokenProvider } from '../platform/oauth';
import { DEFAULT_CONTROL_PLANE_URL, platformLink } from '../platform/license';
import { resolveErrorSink } from '../platform/telemetry/config';

/**
 * One place where the installation picks its outside-world providers from the
 * environment. Every choice has a self-hosted default that needs no control
 * plane; the managed offering only differs by `LICENSE_KEY` (see
 * `providerMatrix` and the README matrix).
 */

export const GOOGLE_OAUTH_CALLBACK_PATH = '/oauth/google/callback';

// ------------------------------------------------------------ system email

export type SystemEmailKind = 'console' | 'cloudflare' | 'notify' | 'unconfigured';

const SYSTEM_EMAIL_HINT =
  'System email is not configured: add a `send_email` binding named SYSTEM_EMAIL plus SYSTEM_EMAIL_FROM (Cloudflare Email Sending), or a LICENSE_KEY for the managed notify service';

function hasBinding(env: Env): boolean {
  return env.SYSTEM_EMAIL !== undefined && (env.SYSTEM_EMAIL_FROM ?? '').trim() !== '';
}

/**
 * `SYSTEM_EMAIL_PROVIDER` = `auto` (default) | `cloudflare` | `notify` | `console`.
 * Auto: console in dev, else the own `send_email` binding when configured,
 * else the notify service when licensed. Console prints OTP codes and magic
 * links, so it is never honored outside dev.
 */
export function systemEmailKind(env: Env): SystemEmailKind {
  const isDev = env.ENVIRONMENT === 'dev';
  const wanted = (env.SYSTEM_EMAIL_PROVIDER ?? 'auto').trim().toLowerCase();
  if (wanted === 'console') return isDev ? 'console' : 'unconfigured';
  if (wanted === 'cloudflare') return hasBinding(env) ? 'cloudflare' : 'unconfigured';
  if (wanted === 'notify') return 'notify';
  if (isDev) return 'console';
  if (hasBinding(env)) return 'cloudflare';
  if (platformLink(env).mode === 'licensed') return 'notify';
  return 'unconfigured';
}

export function systemEmailProvider(env: Env): SystemEmailProvider {
  const kind = systemEmailKind(env);
  switch (kind) {
    case 'console':
      return new ConsoleSystemEmailProvider();
    case 'cloudflare': {
      const binding = env.SYSTEM_EMAIL;
      if (binding === undefined) return new UnconfiguredSystemEmailProvider(SYSTEM_EMAIL_HINT);
      return new CloudflareSystemEmailProvider({
        binding,
        from: (env.SYSTEM_EMAIL_FROM ?? '').trim(),
        ...(env.SYSTEM_EMAIL_FROM_NAME ? { fromName: env.SYSTEM_EMAIL_FROM_NAME } : {}),
      });
    }
    case 'notify':
      return new NotifySystemEmailProvider({
        endpoint:
          env.NOTIFY_ENDPOINT !== undefined && env.NOTIFY_ENDPOINT !== ''
            ? env.NOTIFY_ENDPOINT
            : `${(env.CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL).replace(/\/$/, '')}/v1/installation/notify`,
        licenseKey: env.LICENSE_KEY ?? '',
      });
    case 'unconfigured':
      return new UnconfiguredSystemEmailProvider(SYSTEM_EMAIL_HINT);
  }
}

// ------------------------------------------------------------------- OAuth

export type OAuthKind = 'google_own_app' | 'control_plane' | 'dev' | 'unavailable';

function ownGoogleApp(env: Env): { clientId: string; clientSecret: string } | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? '';
  return clientId !== '' && clientSecret !== '' ? { clientId, clientSecret } : null;
}

/** Own Google app when configured (both offerings), else the central broker when licensed, else the dev stub in dev. */
export function oauthKind(env: Env): OAuthKind {
  if (ownGoogleApp(env) !== null) return 'google_own_app';
  if (platformLink(env).mode === 'licensed') return 'control_plane';
  if (env.ENVIRONMENT === 'dev') return 'dev';
  return 'unavailable';
}

/** OAuth grants in the installation D1 (`installation_meta`), values already sealed by the caller. */
export function d1OAuthStore(db: D1Database): OAuthKeyValueStore {
  return {
    async get(key) {
      const row = await db.prepare(`SELECT value FROM installation_meta WHERE key = ?`).bind(key).first<{ value: string }>();
      return row?.value ?? null;
    },
    async put(key, value) {
      await db
        .prepare(
          `INSERT INTO installation_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .bind(key, value)
        .run();
    },
    async delete(key) {
      await db.prepare(`DELETE FROM installation_meta WHERE key = ?`).bind(key).run();
    },
  };
}

export function appOriginOf(env: Env): string {
  return (env.APP_ORIGIN ?? 'http://localhost:8787').replace(/\/$/, '');
}

export function googleOAuthProvider(env: Env, sealer: OAuthSealer): GoogleOAuthTokenProvider | null {
  const app = ownGoogleApp(env);
  if (app === null) return null;
  return new GoogleOAuthTokenProvider({
    ...app,
    redirectUri: `${appOriginOf(env)}${GOOGLE_OAUTH_CALLBACK_PATH}`,
    store: d1OAuthStore(env.DB),
    sealer,
    fetch: (input, init) => fetch(input, init),
  });
}

/** The installation SecretBox (`AUTH_ENCRYPTION_KEY`), resolved on first use. */
export function authSealer(env: Env): OAuthSealer {
  return {
    encrypt: async (plaintext, associatedData) =>
      (await getAuthServices(env)).secretBox.encrypt(plaintext, associatedData),
    decrypt: async (ciphertext, associatedData) =>
      (await getAuthServices(env)).secretBox.decrypt(ciphertext, associatedData),
  };
}

export function oauthTokenProvider(env: Env, sealer: OAuthSealer = authSealer(env)): OAuthTokenProvider {
  switch (oauthKind(env)) {
    case 'google_own_app':
      return googleOAuthProvider(env, sealer) ?? unavailableOAuthProvider;
    case 'control_plane': {
      const client = controlPlaneClient(env);
      if (client === null) return unavailableOAuthProvider;
      return new ControlPlaneOAuthTokenProvider(client);
    }
    case 'dev':
      return devOAuthProvider();
    case 'unavailable':
      return unavailableOAuthProvider;
  }
}

// ------------------------------------------------------------------ matrix

export interface ProviderMatrix {
  readonly offering: 'managed' | 'self_hosted';
  readonly emailMarketing: 'console' | 'postshiba';
  readonly systemEmail: SystemEmailKind;
  readonly quotaGuard: 'platform_wallet' | 'allow_all';
  readonly errorReporter: 'local' | 'control_plane' | 'url';
  readonly dnsAutomation: 'fake' | 'cloudflare_api' | 'manual';
  readonly oauth: OAuthKind;
  readonly payments: 'recorded_only';
}

/** What this installation uses, by capability (dev diagnostics and tests). */
export function providerMatrix(env: Env): ProviderMatrix {
  const licensed = platformLink(env).mode === 'licensed';
  const isDev = env.ENVIRONMENT === 'dev';
  return {
    offering: licensed ? 'managed' : 'self_hosted',
    emailMarketing: isDev ? 'console' : 'postshiba',
    systemEmail: systemEmailKind(env),
    quotaGuard: licensed ? 'platform_wallet' : 'allow_all',
    errorReporter: resolveErrorSink(env).kind,
    dnsAutomation: isDev ? 'fake' : (env.CLOUDFLARE_DNS_API_TOKEN ?? '') !== '' ? 'cloudflare_api' : 'manual',
    oauth: oauthKind(env),
    payments: 'recorded_only',
  };
}

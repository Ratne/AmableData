import { randomToken, sha256Hex } from '@amable/auth';
import { monotonicFactory } from 'ulid';
import type { Env } from '../env';
import { appOriginOf } from '../providers/select';
import { AppError } from './errors';
import { appFetch } from './http';
import { decodeJwt, verifyJwtSignature, type PublicJwk } from './jwt';
import { installRowById, toInstall, type AppInstall, type InstallRow } from './store';

/**
 * Credentials of an install: one-time authorization codes, short access tokens
 * (`amb_app_…`) and rotating refresh tokens (`amb_apr_…`), all stored as
 * SHA-256 hashes. Apps authenticate to the token endpoint with a JWT signed by
 * a key of their manifest's `jwks_url` (private_key_jwt, RFC 7523).
 */

const nextId = monotonicFactory();
export const ACCESS_TOKEN_PREFIX = 'amb_app_';
export const REFRESH_TOKEN_PREFIX = 'amb_apr_';
export const ACCESS_TOKEN_TTL_MS = 3600 * 1000;
export const REFRESH_TOKEN_TTL_MS = 180 * 86_400_000;
export const CODE_TTL_MS = 10 * 60 * 1000;
const ASSERTION_MAX_LIFETIME_S = 300;
const CLOCK_SKEW_S = 60;
const JWKS_TTL_MS = 10 * 60 * 1000;

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export function tokenEndpointUrl(env: Env): string {
  return `${appOriginOf(env)}/api/apps/v1/token`;
}

// ------------------------------------------------------------------- codes

export async function issueCode(
  db: D1Database,
  input: { installId: string; redirectUri: string; codeChallenge: string | null; userId: string; nowMs: number },
): Promise<string> {
  const code = `amb_code_${randomToken(32)}`;
  await db
    .prepare(
      `INSERT INTO app_oauth_codes (code_hash, install_id, redirect_uri, code_challenge, user_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(await sha256Hex(code), input.installId, input.redirectUri, input.codeChallenge, input.userId, input.nowMs + CODE_TTL_MS)
    .run();
  return code;
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Consumes a code (single use; a second use revokes what the first one issued). */
export async function redeemCode(
  db: D1Database,
  input: { code: string; redirectUri: string; codeVerifier: string | null; nowMs: number },
): Promise<{ install: AppInstall; userId: string | null }> {
  const hash = await sha256Hex(input.code);
  const row = await db
    .prepare(`SELECT * FROM app_oauth_codes WHERE code_hash = ?`)
    .bind(hash)
    .first<{ install_id: string; redirect_uri: string; code_challenge: string | null; user_id: string | null; expires_at: number; used_at: number | null }>();
  if (row === null || row.expires_at < input.nowMs) throw new AppError(400, 'invalid_grant', 'unknown or expired code');
  if (row.used_at !== null) {
    await db
      .prepare(`UPDATE app_tokens SET revoked_at = ? WHERE install_id = ? AND revoked_at IS NULL AND created_at >= ?`)
      .bind(input.nowMs, row.install_id, row.used_at)
      .run();
    throw new AppError(400, 'invalid_grant', 'code already used');
  }
  if (row.redirect_uri !== input.redirectUri) throw new AppError(400, 'invalid_grant', 'redirect_uri mismatch');
  if (row.code_challenge !== null) {
    if (input.codeVerifier === null || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) {
      throw new AppError(400, 'invalid_grant', 'code_verifier required');
    }
    if ((await s256(input.codeVerifier)) !== row.code_challenge) {
      throw new AppError(400, 'invalid_grant', 'code_verifier mismatch');
    }
  }
  const claimed = await db
    .prepare(`UPDATE app_oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL`)
    .bind(input.nowMs, hash)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) throw new AppError(400, 'invalid_grant', 'code already used');
  const install = await installRowById(db, row.install_id);
  if (install === null) throw new AppError(400, 'invalid_grant', 'install not found');
  return { install: toInstall(install), userId: row.user_id };
}

// ------------------------------------------------------------------ tokens

export interface TokenPair {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
}

export async function issueTokens(db: D1Database, installId: string, nowMs: number): Promise<TokenPair> {
  const access = `${ACCESS_TOKEN_PREFIX}${randomToken(32)}`;
  const refresh = `${REFRESH_TOKEN_PREFIX}${randomToken(32)}`;
  const insert = `INSERT INTO app_tokens (id, install_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`;
  await db.batch([
    db.prepare(insert).bind(`tok_${nextId(nowMs)}`, installId, 'access', await sha256Hex(access), nowMs + ACCESS_TOKEN_TTL_MS, nowMs),
    db.prepare(insert).bind(`tok_${nextId(nowMs)}`, installId, 'refresh', await sha256Hex(refresh), nowMs + REFRESH_TOKEN_TTL_MS, nowMs),
  ]);
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TOKEN_TTL_MS / 1000 };
}

interface TokenRow {
  id: string;
  install_id: string;
  kind: string;
  expires_at: number;
  revoked_at: number | null;
}

/**
 * Refresh rotation: the presented token is revoked and a new pair issued. A
 * refresh token used twice means it leaked, so every token of the install goes.
 */
export async function rotateRefreshToken(
  db: D1Database,
  token: string,
  nowMs: number,
): Promise<{ installId: string; tokens: TokenPair }> {
  const row = await db
    .prepare(`SELECT id, install_id, kind, expires_at, revoked_at FROM app_tokens WHERE token_hash = ?`)
    .bind(await sha256Hex(token))
    .first<TokenRow>();
  if (row === null || row.kind !== 'refresh' || row.expires_at < nowMs) {
    throw new AppError(400, 'invalid_grant', 'unknown or expired refresh token');
  }
  if (row.revoked_at !== null) {
    await db
      .prepare(`UPDATE app_tokens SET revoked_at = ? WHERE install_id = ? AND revoked_at IS NULL`)
      .bind(nowMs, row.install_id)
      .run();
    throw new AppError(400, 'invalid_grant', 'refresh token reused');
  }
  const claimed = await db
    .prepare(`UPDATE app_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(nowMs, row.id)
    .run();
  if ((claimed.meta.changes ?? 0) === 0) throw new AppError(400, 'invalid_grant', 'refresh token reused');
  return { installId: row.install_id, tokens: await issueTokens(db, row.install_id, nowMs) };
}

export async function revokeToken(db: D1Database, installId: string, token: string, nowMs: number): Promise<void> {
  await db
    .prepare(`UPDATE app_tokens SET revoked_at = ? WHERE token_hash = ? AND install_id = ? AND revoked_at IS NULL`)
    .bind(nowMs, await sha256Hex(token), installId)
    .run();
}

/** Install behind a valid access token (any status; the caller decides what it may do). */
export async function resolveAccessToken(
  db: D1Database,
  token: string,
  nowMs: number,
): Promise<{ tokenId: string; install: AppInstall } | null> {
  if (!token.startsWith(ACCESS_TOKEN_PREFIX) || token.length > 120) return null;
  const row = await db
    .prepare(
      `SELECT t.id AS token_id, t.expires_at AS token_expires_at, t.revoked_at AS token_revoked_at, t.kind AS token_kind, i.*
       FROM app_tokens t JOIN app_installs i ON i.id = t.install_id WHERE t.token_hash = ?`,
    )
    .bind(await sha256Hex(token))
    .first<InstallRow & { token_id: string; token_expires_at: number; token_revoked_at: number | null; token_kind: string }>();
  if (row === null || row.token_kind !== 'access' || row.token_revoked_at !== null || row.token_expires_at < nowMs) {
    return null;
  }
  return { tokenId: row.token_id, install: toInstall(row) };
}

// ------------------------------------------------------- client assertion

const jwksCache = new Map<string, { keys: PublicJwk[]; fetchedAt: number }>();

export function clearJwksCache(): void {
  jwksCache.clear();
}

async function fetchJwks(env: Env, url: string, nowMs: number, fresh: boolean): Promise<PublicJwk[]> {
  const cached = jwksCache.get(url);
  if (!fresh && cached !== undefined && nowMs - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const response = await appFetch(env, url, { headers: { accept: 'application/json' } }, { timeoutMs: 5000, maxBytes: 64 * 1024 });
  if (response.status !== 200) throw new AppError(401, 'invalid_client', `jwks_url answered ${String(response.status)}`);
  let keys: PublicJwk[];
  try {
    const parsed = JSON.parse(response.text) as { keys?: unknown };
    keys = Array.isArray(parsed.keys) ? (parsed.keys.filter((k) => typeof k === 'object' && k !== null) as PublicJwk[]) : [];
  } catch {
    throw new AppError(401, 'invalid_client', 'jwks_url is not valid JSON');
  }
  jwksCache.set(url, { keys, fetchedAt: nowMs });
  return keys;
}

/**
 * Verifies `client_assertion` for an install: signed by a key of the app's
 * JWKS, `iss` = `sub` = app id, `aud` = this token endpoint, short-lived and
 * never seen before (`jti`).
 */
export async function verifyClientAssertion(
  env: Env,
  install: AppInstall,
  input: { assertionType: string | null; assertion: string | null; clientId: string | null; nowMs: number },
): Promise<void> {
  if (input.assertionType !== CLIENT_ASSERTION_TYPE || input.assertion === null) {
    throw new AppError(401, 'invalid_client', 'private_key_jwt client authentication required');
  }
  if (input.clientId !== null && input.clientId !== install.appId) throw new AppError(401, 'invalid_client', 'client_id mismatch');
  const decoded = decodeJwt(input.assertion);
  if (decoded === null) throw new AppError(401, 'invalid_client', 'malformed client assertion');
  const { claims } = decoded;
  const now = Math.floor(input.nowMs / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const allowedAud = [tokenEndpointUrl(env), appOriginOf(env)];
  if (claims.iss !== install.appId || claims.sub !== install.appId) {
    throw new AppError(401, 'invalid_client', 'iss and sub must be the app id');
  }
  if (!aud.some((a) => typeof a === 'string' && allowedAud.includes(a))) {
    throw new AppError(401, 'invalid_client', 'aud must be the token endpoint');
  }
  const exp = typeof claims.exp === 'number' ? claims.exp : 0;
  const iat = typeof claims.iat === 'number' ? claims.iat : now;
  if (exp + CLOCK_SKEW_S < now || exp - iat > ASSERTION_MAX_LIFETIME_S || iat - CLOCK_SKEW_S > now) {
    throw new AppError(401, 'invalid_client', 'client assertion expired or too long-lived');
  }
  const jti = typeof claims.jti === 'string' && claims.jti.length >= 8 && claims.jti.length <= 128 ? claims.jti : null;
  if (jti === null) throw new AppError(401, 'invalid_client', 'jti required');

  const url = install.manifest.jwks_url;
  let valid = await verifyJwtSignature(decoded, await fetchJwks(env, url, input.nowMs, false));
  // The app may have just rotated its key: one fresh download before refusing.
  if (!valid) valid = await verifyJwtSignature(decoded, await fetchJwks(env, url, input.nowMs, true));
  if (!valid) throw new AppError(401, 'invalid_client', 'client assertion signature not valid');

  const stored = await env.DB.prepare(`INSERT OR IGNORE INTO app_assertions (jti, expires_at) VALUES (?, ?)`)
    .bind(`${install.appId}:${jti}`, (exp + CLOCK_SKEW_S) * 1000)
    .run();
  if ((stored.meta.changes ?? 0) === 0) throw new AppError(401, 'invalid_client', 'client assertion replayed');
}

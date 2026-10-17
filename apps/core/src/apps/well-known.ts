import { fromBase64, toBase64, toBase64Url } from '@amable/auth';
import { APP_API_VERSIONS, APP_EXTENSION_POINTS, CURRENT_APP_API_VERSION } from '@amable/core/apps';
import { getAuthServices } from '../auth/services';
import type { Env } from '../env';
import { appOriginOf } from '../providers/select';
import { signJwt, type JwtClaims, type PublicJwk } from './jwt';

/**
 * Identity of this installation towards apps: an Ed25519 key (private part
 * sealed in `installation_meta`) that signs iframe session tokens, published
 * with the discovery document at `/.well-known/amable-apps.json`.
 */

export const DISCOVERY_PATH = '/.well-known/amable-apps.json';
export const JWKS_PATH = '/.well-known/amable-apps/jwks.json';
const KEY_META = 'app_signing_key';
const KEY_AD = 'app-signing-key';

interface StoredKey {
  readonly kid: string;
  /** Sealed PKCS#8. */
  readonly private: string;
  /** Raw public key, base64url. */
  readonly public: string;
}

interface LoadedKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: PublicJwk;
}

let cached: { db: D1Database; key: LoadedKey } | null = null;

async function readStored(db: D1Database): Promise<StoredKey | null> {
  const row = await db.prepare(`SELECT value FROM installation_meta WHERE key = ?`).bind(KEY_META).first<{ value: string }>();
  if (row === null) return null;
  try {
    return JSON.parse(row.value) as StoredKey;
  } catch {
    return null;
  }
}

async function generate(env: Env): Promise<void> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const box = (await getAuthServices(env)).secretBox;
  const stored: StoredKey = {
    kid: `ins-${new Date(Date.now()).toISOString().slice(0, 10)}`,
    private: await box.encrypt(toBase64(pkcs8), KEY_AD),
    public: toBase64Url(raw),
  };
  // Concurrent first requests: the first writer wins, everybody reads it back.
  await env.DB.prepare(`INSERT OR IGNORE INTO installation_meta (key, value) VALUES (?, ?)`)
    .bind(KEY_META, JSON.stringify(stored))
    .run();
}

export async function installationKey(env: Env): Promise<LoadedKey> {
  if (cached?.db === env.DB) return cached.key;
  let stored = await readStored(env.DB);
  if (stored === null) {
    await generate(env);
    stored = await readStored(env.DB);
    if (stored === null) throw new Error('installation signing key unavailable');
  }
  const box = (await getAuthServices(env)).secretBox;
  const pkcs8 = fromBase64(await box.decrypt(stored.private, KEY_AD));
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const key: LoadedKey = {
    kid: stored.kid,
    privateKey,
    jwk: { kty: 'OKP', crv: 'Ed25519', x: stored.public, kid: stored.kid, alg: 'EdDSA', use: 'sig' },
  };
  cached = { db: env.DB, key };
  return key;
}

export async function installationJwks(env: Env): Promise<{ keys: PublicJwk[] }> {
  return { keys: [(await installationKey(env)).jwk] };
}

export async function signInstallationJwt(env: Env, claims: JwtClaims): Promise<string> {
  const key = await installationKey(env);
  return signJwt({ iss: appOriginOf(env), ...claims }, key.privateKey, key.kid);
}

export function discoveryDocument(env: Env): Record<string, unknown> {
  const origin = appOriginOf(env);
  return {
    issuer: origin,
    jwks_uri: `${origin}${JWKS_PATH}`,
    authorization_endpoint: `${origin}/apps/authorize`,
    token_endpoint: `${origin}/api/apps/v1/token`,
    revocation_endpoint: `${origin}/api/apps/v1/revoke`,
    api_base: `${origin}/api/v2`,
    version: env.APP_VERSION ?? null,
    api_versions: [...APP_API_VERSIONS],
    current_api_version: CURRENT_APP_API_VERSION,
    extension_points: [...APP_EXTENSION_POINTS],
    token_endpoint_auth_methods_supported: ['private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ['EdDSA', 'ES256', 'RS256'],
    code_challenge_methods_supported: ['S256'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
  };
}

export function handleWellKnown(request: Request, env: Env, pathname: string): Promise<Response> | Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=300',
    'access-control-allow-origin': '*',
  };
  if (pathname === DISCOVERY_PATH) return new Response(JSON.stringify(discoveryDocument(env)), { headers });
  return installationJwks(env).then((jwks) => new Response(JSON.stringify(jwks), { headers }));
}

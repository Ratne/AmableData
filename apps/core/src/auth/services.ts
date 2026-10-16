import {
  COMMON_BREACHED_PASSWORDS,
  createHibpBreachChecker,
  createSecretBox,
  createSiteverifyTurnstile,
  createStaticBreachChecker,
  createStaticTurnstile,
  sha256Hex,
  fromHex,
  toBase64,
  type PasswordBreachChecker,
  type PasswordHasher,
  type RateLimiter,
  type SecretBox,
  type TurnstileVerifier,
} from '@amable/auth';
import type { SystemEmailProvider } from '@amable/core';
import type { Env } from '../env';
import { systemEmailProvider } from '../providers/select';
import { createBindingRateLimiter, createD1RateLimiter } from './rate-limit';

/**
 * Everything the auth layer needs from the outside world, resolved once per
 * isolate from the Worker env. Tests replace the whole container through
 * `overrideAuthServices` (fake clock, captured emails, fast hasher, fakes for
 * Turnstile and the breach check — no network, ever).
 */
export interface AuthServices {
  now(): number;
  hasher: PasswordHasher;
  secretBox: SecretBox;
  /** Server-side secret used to HMAC short codes (email OTP, recovery codes). */
  pepper: string;
  breachChecker: PasswordBreachChecker;
  turnstile: TurnstileVerifier;
  /** Exact counters (D1): per-account limits. */
  limiter: RateLimiter;
  /** Coarse per-IP limits on auth endpoints (Workers binding when configured, else D1). */
  ipLimiter: RateLimiter;
  /** Per-key limits for API key traffic (Workers binding when configured, else D1). */
  apiLimiter: RateLimiter;
  email: SystemEmailProvider;
  turnstileSiteKey: string | null;
}

export class AuthConfigError extends Error {
  override readonly name = 'AuthConfigError';
}

type Factory = (env: Env) => Promise<AuthServices>;

const DEV_PEPPER = 'amable-dev-pepper-not-a-secret';

async function devEncryptionKey(): Promise<string> {
  return toBase64(fromHex(await sha256Hex('amable-dev-encryption-key-not-a-secret')));
}

const defaultFactory: Factory = async (env) => {
  const isDev = env.ENVIRONMENT === 'dev';

  let pepper = env.PASSWORD_PEPPER;
  if (pepper === undefined || pepper === '') {
    if (!isDev) throw new AuthConfigError('PASSWORD_PEPPER secret is not configured');
    console.warn('[auth] PASSWORD_PEPPER missing — using the public dev pepper (dev only)');
    pepper = DEV_PEPPER;
  }
  let encryptionKey = env.AUTH_ENCRYPTION_KEY;
  if (encryptionKey === undefined || encryptionKey === '') {
    if (!isDev) throw new AuthConfigError('AUTH_ENCRYPTION_KEY secret is not configured');
    console.warn('[auth] AUTH_ENCRYPTION_KEY missing — using the public dev key (dev only)');
    encryptionKey = await devEncryptionKey();
  }

  // Loaded lazily: the module imports a precompiled .wasm, which only the
  // Workers bundler understands.
  const { createWorkerPasswordHasher } = await import('./argon2-engine');
  const hasher = createWorkerPasswordHasher(pepper);

  const onlineBreachCheck = isDev ? env.HIBP_ENABLED === 'true' : env.HIBP_ENABLED !== 'false';
  const breachChecker = onlineBreachCheck
    ? createHibpBreachChecker({
        fetchFn: (input, init) => fetch(input, init),
        onError: (error) => console.warn('[auth] breach range check failed (fail-open)', error),
      })
    : createStaticBreachChecker(COMMON_BREACHED_PASSWORDS);

  let turnstile: TurnstileVerifier;
  if (env.TURNSTILE_SECRET_KEY !== undefined && env.TURNSTILE_SECRET_KEY !== '') {
    turnstile = createSiteverifyTurnstile({
      secretKey: env.TURNSTILE_SECRET_KEY,
      fetchFn: (input, init) => fetch(input, init),
    });
  } else {
    if (!isDev) console.warn('[auth] TURNSTILE_SECRET_KEY missing — bot verification disabled');
    turnstile = createStaticTurnstile();
  }

  const limiter = createD1RateLimiter(env.DB, Date.now);
  const ipLimiter =
    env.RL_AUTH !== undefined ? createBindingRateLimiter(env.RL_AUTH, limiter) : limiter;
  const apiLimiter =
    env.RL_API !== undefined ? createBindingRateLimiter(env.RL_API, limiter) : limiter;

  return {
    now: Date.now,
    hasher,
    secretBox: await createSecretBox(encryptionKey),
    pepper,
    breachChecker,
    turnstile,
    limiter,
    ipLimiter,
    apiLimiter,
    // Console only in dev (it prints codes and links); elsewhere the own
    // `send_email` binding or the licensed notify service (providers/select.ts).
    email: systemEmailProvider(env),
    turnstileSiteKey:
      env.TURNSTILE_SITE_KEY !== undefined && env.TURNSTILE_SITE_KEY !== ''
        ? env.TURNSTILE_SITE_KEY
        : null,
  };
};

let factory: Factory = defaultFactory;
const cache = new WeakMap<Env, Promise<AuthServices>>();

export function getAuthServices(env: Env): Promise<AuthServices> {
  let services = cache.get(env);
  if (services === undefined) {
    services = factory(env).catch((error: unknown) => {
      cache.delete(env);
      throw error;
    });
    cache.set(env, services);
  }
  return services;
}

/** Test hook: replaces the services factory (pass `null` to restore the default). */
export function overrideAuthServices(next: Factory | null): void {
  factory = next ?? defaultFactory;
}

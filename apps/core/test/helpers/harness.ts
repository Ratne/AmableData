import initArgon2 from '@phi-ag/argon2/node';
import {
  createArgon2idHasher,
  createSecretBox,
  createStaticBreachChecker,
  createStaticTurnstile,
  randomBytes,
  toBase64,
  totpCode,
  type TurnstileVerifier,
} from '@amable/auth';
import type { Role, SystemEmail } from '@amable/core';
import { createD1MigrationStore, installationMigrations, runMigrations } from '@amable/db';
import { app } from '../../src/app';
import { recoveryCodeHash } from '../../src/auth/challenge';
import { createD1RateLimiter } from '../../src/auth/rate-limit';
import { overrideAuthServices, type AuthServices } from '../../src/auth/services';
import {
  addMembership,
  createUser,
  enrollMfa,
  replaceRecoveryCodes,
  type UserRow,
} from '../../src/auth/store';
import type { Env } from '../../src/env';
import { createShimD1, type ShimD1 } from './d1-shim';

const argon2 = await initArgon2();

export const ORIGIN = 'http://localhost';
export const START = Date.UTC(2026, 9, 15, 12, 0, 0);

export interface Harness {
  env: Env;
  shim: ShimD1;
  services: AuthServices;
  emails: SystemEmail[];
  clock: { now: number; advance(ms: number): void };
  client(): TestClient;
}

export async function createHarness(options: { turnstile?: TurnstileVerifier } = {}): Promise<Harness> {
  const { shim, db } = createShimD1();
  await runMigrations(createD1MigrationStore(db, { metaTable: 'installation_meta' }), installationMigrations);
  const clock = {
    now: START,
    advance(ms: number) {
      this.now += ms;
    },
  };
  const now = () => clock.now;
  const emails: SystemEmail[] = [];
  const pepper = 'test-pepper';
  const services: AuthServices = {
    now,
    hasher: createArgon2idHasher({
      engine: argon2,
      pepper,
      params: { memoryKiB: 256, iterations: 1, parallelism: 1 },
    }),
    secretBox: await createSecretBox(toBase64(randomBytes(32))),
    pepper,
    breachChecker: createStaticBreachChecker(['correct horse battery']),
    turnstile: options.turnstile ?? createStaticTurnstile(),
    limiter: createD1RateLimiter(db, now),
    ipLimiter: createD1RateLimiter(db, now),
    apiLimiter: createD1RateLimiter(db, now),
    email: {
      send(email) {
        emails.push(email);
        return Promise.resolve();
      },
    },
    turnstileSiteKey: null,
  };
  const env = { DB: db, ENVIRONMENT: 'test' } as unknown as Env;
  overrideAuthServices(() => Promise.resolve(services));
  const harness: Harness = {
    env,
    shim,
    services,
    emails,
    clock,
    client: () => new TestClient(env),
  };
  return harness;
}

export interface TestResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

/** Fetch-like client with a cookie jar, the right Origin and the CSRF header. */
export class TestClient {
  readonly cookies = new Map<string, string>();
  readonly setCookieLog: string[] = [];

  constructor(private readonly env: Env) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<TestResponse> {
    const init: RequestInit = {
      method,
      headers: {
        origin: ORIGIN,
        'x-amable-csrf': '1',
        'user-agent': 'Mozilla/5.0 (Macintosh; Mac OS X) Chrome/130.0 Safari/537.36',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookies.size > 0
          ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
          : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const response = await app.request(`${ORIGIN}${path}`, init, this.env);
    for (const cookie of response.headers.getSetCookie()) {
      this.setCookieLog.push(cookie);
      const [pair = ''] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === '' || /max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { text };
      }
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  get(path: string, headers?: Record<string, string>) {
    return this.request('GET', path, undefined, headers);
  }
  post(path: string, body: unknown = {}, headers?: Record<string, string>) {
    return this.request('POST', path, body, headers);
  }
  patch(path: string, body: unknown, headers?: Record<string, string>) {
    return this.request('PATCH', path, body, headers);
  }
  delete(path: string, headers?: Record<string, string>) {
    return this.request('DELETE', path, undefined, headers);
  }
}

export const TEST_PASSWORD = 'a-long-test-password-1';
export const TEST_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export const TEST_RECOVERY = ['aaaaa-bbbbb', 'ccccc-ddddd', 'eeeee-fffff'];

export async function seedUser(
  h: Harness,
  input: { email: string; mfa?: 'totp' | 'email' | null; name?: string; locale?: string },
): Promise<UserRow> {
  const now = h.clock.now;
  const user = await createUser(h.env.DB, {
    email: input.email,
    name: input.name ?? null,
    locale: input.locale ?? 'en',
    passwordHash: await h.services.hasher.hash(TEST_PASSWORD),
    emailVerifiedAt: now,
    now,
  });
  const mfa = input.mfa === undefined ? 'totp' : input.mfa;
  if (mfa !== null) {
    await enrollMfa(
      h.env.DB,
      user.id,
      {
        method: mfa,
        totpSecretEnc:
          mfa === 'totp'
            ? await h.services.secretBox.encrypt(TEST_TOTP_SECRET, `totp:${user.id}`)
            : null,
        totpStep: null,
      },
      now,
    );
    const hashes = await Promise.all(TEST_RECOVERY.map((c) => recoveryCodeHash(h.services.pepper, c)));
    await replaceRecoveryCodes(h.env.DB, user.id, hashes, now);
  }
  return user;
}

export async function seedTenant(h: Harness, slug: string): Promise<{ id: string; slug: string }> {
  const id = `t_${slug}`;
  await h.env.DB.prepare(`INSERT INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, ?)`)
    .bind(id, slug, `Tenant ${slug}`, h.clock.now)
    .run();
  return { id, slug };
}

export async function addMember(h: Harness, userId: string, tenantId: string, role: Role) {
  await addMembership(h.env.DB, { userId, tenantId, role, invitedBy: null, now: h.clock.now });
}

export function currentTotp(h: Harness): Promise<string> {
  return totpCode(TEST_TOTP_SECRET, h.clock.now);
}

/** Password + TOTP login. Advances the clock one TOTP step first (replay protection). */
export async function login(h: Harness, email: string, client = h.client()): Promise<TestClient> {
  h.clock.advance(30_000);
  const first = await client.post('/api/auth/login', { email, password: TEST_PASSWORD });
  if (first.status !== 200) throw new Error(`login failed: ${first.status} ${JSON.stringify(first.body)}`);
  const second = await client.post('/api/auth/challenge/verify', {
    method: 'totp',
    code: await currentTotp(h),
  });
  if (second.status !== 200) {
    throw new Error(`2FA failed: ${second.status} ${JSON.stringify(second.body)}`);
  }
  return client;
}

/** Step-up with TOTP on an authenticated client. */
export async function stepUp(h: Harness, client: TestClient) {
  h.clock.advance(30_000);
  const start = await client.post('/api/auth/step-up/start');
  if (start.status !== 200) throw new Error(`step-up start: ${start.status}`);
  const verify = await client.post('/api/auth/step-up/verify', {
    method: 'totp',
    code: await currentTotp(h),
  });
  if (verify.status !== 200) {
    throw new Error(`step-up verify: ${verify.status} ${JSON.stringify(verify.body)}`);
  }
}

export function lastEmail(h: Harness, to?: string): SystemEmail {
  const list = to === undefined ? h.emails : h.emails.filter((e) => e.to === to);
  const email = list[list.length - 1];
  if (email === undefined) throw new Error('no email captured');
  return email;
}

export function tokenFromEmail(email: SystemEmail): string {
  const match = /#token=([A-Za-z0-9_-]+)/.exec(email.text);
  if (match?.[1] === undefined) throw new Error('no token in email');
  return match[1];
}

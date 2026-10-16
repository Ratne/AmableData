import initArgon2 from '@phi-ag/argon2/node';
import { describe, expect, it } from 'vitest';
import {
  checkCsrf,
  checkPasswordPolicy,
  createArgon2idHasher,
  createHibpBreachChecker,
  createPbkdf2Hasher,
  createSecretBox,
  createStaticBreachChecker,
  effectiveKeyPermissions,
  fromBase32,
  generateApiKey,
  generateNumericCode,
  generateRecoveryCodes,
  hotp,
  lockDurationMs,
  normalizeRecoveryCode,
  randomBytes,
  scopesExceedingRole,
  sessionState,
  newSessionTimes,
  signWebhook,
  toBase32,
  toBase64,
  utf8,
  verifyTotp,
  verifyWebhook,
} from '../src/index';

const argon2 = await initArgon2();

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  const rfcSecret = toBase32(utf8('12345678901234567890'));

  it('matches the RFC 4226 HOTP test vectors', async () => {
    const expected = ['755224', '287082', '359152', '969429', '338314'];
    for (const [counter, code] of expected.entries()) {
      expect(await hotp(rfcSecret, counter)).toBe(code);
    }
  });

  it('matches the RFC 6238 SHA-1 vector at T=59s (8 → 6 digits)', async () => {
    // RFC value 94287082 → last 6 digits.
    expect(await hotp(rfcSecret, 1)).toBe('287082');
    const result = await verifyTotp(rfcSecret, '287082', 59_000, null);
    expect(result).toEqual({ ok: true, step: 1 });
  });

  it('accepts ±1 step, refuses ±2 and replays', async () => {
    const now = 1_000 * 30_000;
    const prev = await hotp(rfcSecret, 999);
    const far = await hotp(rfcSecret, 998);
    expect((await verifyTotp(rfcSecret, prev, now, null)).ok).toBe(true);
    expect((await verifyTotp(rfcSecret, far, now, null)).ok).toBe(false);
    expect((await verifyTotp(rfcSecret, prev, now, 999)).ok).toBe(false);
  });

  it('round-trips base32', () => {
    const bytes = randomBytes(20);
    expect([...fromBase32(toBase32(bytes))]).toEqual([...bytes]);
  });
});

describe('passwords', () => {
  it('hashes with Argon2id at OWASP parameters and a pepper', async () => {
    const hasher = createArgon2idHasher({ engine: argon2, pepper: 'pepper-a' });
    const hash = await hasher.hash('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await hasher.verify(hash, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verify(hash, 'wrong')).toBe(false);
    expect(hasher.needsRehash(hash)).toBe(false);
    // Same hash, different pepper → unusable (a DB leak alone is not enough).
    const otherPepper = createArgon2idHasher({ engine: argon2, pepper: 'pepper-b' });
    expect(await otherPepper.verify(hash, 'correct horse battery staple')).toBe(false);
  });

  it('keeps an OWASP Argon2id verify well inside the Workers CPU budget', async () => {
    // Same WASM build and V8 engine as workerd. Measured ~14 ms median on an
    // Apple M4 Max; edge CPUs are slower, so the bound leaves a wide margin
    // under the 30 s Paid-plan default and below interactive latency.
    const hasher = createArgon2idHasher({ engine: argon2, pepper: 'pepper-a' });
    const hash = await hasher.hash('correct horse battery staple');
    const runs: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const started = performance.now();
      await hasher.verify(hash, 'correct horse battery staple');
      runs.push(performance.now() - started);
    }
    runs.sort((a, b) => a - b);
    expect(runs[2]).toBeLessThan(250);
  });

  it('verifies PBKDF2 fallback hashes and flags them for rehash', async () => {
    const pbkdf2 = createPbkdf2Hasher({ pepper: 'p', iterations: 1000 });
    const legacy = await pbkdf2.hash('some long password');
    const argon = createArgon2idHasher({
      engine: argon2,
      pepper: 'p',
      params: { memoryKiB: 256, iterations: 1, parallelism: 1 },
      pbkdf2Iterations: 1000,
    });
    expect(await argon.verify(legacy, 'some long password')).toBe(true);
    expect(argon.needsRehash(legacy)).toBe(true);
  });

  it('enforces length and breach policy', async () => {
    const breached = createStaticBreachChecker(['password1234567']);
    expect(await checkPasswordPolicy('short', breached)).toBe('too_short');
    expect(await checkPasswordPolicy('password1234567', breached)).toBe('breached');
    expect(await checkPasswordPolicy('x'.repeat(300), breached)).toBe('too_long');
    expect(await checkPasswordPolicy('a fine long passphrase', breached)).toBeNull();
  });

  it('sends only a 5-char SHA-1 prefix to the breach range API (k-anonymity)', async () => {
    const calls: string[] = [];
    // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
    const checker = createHibpBreachChecker({
      fetchFn: (url) => {
        calls.push(url);
        return Promise.resolve(new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:3\nAAAA:0\n'));
      },
    });
    expect(await checker.isBreached('password')).toBe(true);
    expect(calls).toEqual(['https://api.pwnedpasswords.com/range/5BAA6']);
    const failing = createHibpBreachChecker({ fetchFn: () => Promise.reject(new Error('offline')) });
    expect(await failing.isBreached('password')).toBe(false);
  });
});

describe('codes and tokens', () => {
  it('generates 6-digit codes and 10 distinct recovery codes', () => {
    expect(generateNumericCode()).toMatch(/^\d{6}$/);
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(normalizeRecoveryCode(' ABCDE-fghjk ')).toBe('abcdefghjk');
  });

  it('caps API key scopes at the creator role', async () => {
    const key = await generateApiKey();
    expect(key.key.startsWith(key.prefix)).toBe(true);
    expect(key.hash).not.toContain(key.key);
    expect(scopesExceedingRole(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
    expect([...effectiveKeyPermissions(['a', 'b'], ['b'])]).toEqual(['b']);
  });

  it('computes session states and doubling lock durations', () => {
    const times = newSessionTimes(0);
    expect(sessionState(times, 1)).toBe('valid');
    expect(sessionState(times, 7 * 86_400_000)).toBe('idle_expired');
    expect(lockDurationMs(0)).toBe(15 * 60_000);
    expect(lockDurationMs(1)).toBe(30 * 60_000);
    expect(lockDurationMs(99)).toBe(15 * 60_000 * 1024);
  });
});

describe('secret box (AES-GCM)', () => {
  it('encrypts, binds to associated data and rejects tampering', async () => {
    const box = await createSecretBox(toBase64(randomBytes(32)));
    const ct = await box.encrypt('JBSWY3DPEHPK3PXP', 'totp:user1');
    expect(ct.startsWith('v1.')).toBe(true);
    expect(await box.decrypt(ct, 'totp:user1')).toBe('JBSWY3DPEHPK3PXP');
    await expect(box.decrypt(ct, 'totp:user2')).rejects.toThrow();
    await expect(box.decrypt(`${ct.slice(0, -2)}AA`, 'totp:user1')).rejects.toThrow();
    await expect(createSecretBox(toBase64(randomBytes(16)))).rejects.toThrow();
  });
});

describe('CSRF check', () => {
  const allowed = ['https://crm.example.com'];
  it('lets safe methods through and requires origin + header otherwise', () => {
    expect(checkCsrf({ method: 'GET', origin: null, customHeader: null, allowedOrigins: allowed })).toBeNull();
    expect(checkCsrf({ method: 'POST', origin: null, customHeader: '1', allowedOrigins: allowed })).toBe(
      'missing_origin',
    );
    expect(
      checkCsrf({ method: 'POST', origin: 'https://evil.example', customHeader: '1', allowedOrigins: allowed }),
    ).toBe('bad_origin');
    expect(
      checkCsrf({ method: 'DELETE', origin: allowed[0] ?? '', customHeader: null, allowedOrigins: allowed }),
    ).toBe('missing_header');
    expect(
      checkCsrf({ method: 'PATCH', origin: allowed[0] ?? '', customHeader: '1', allowedOrigins: allowed }),
    ).toBeNull();
  });
});

describe('webhook signatures', () => {
  it('signs and verifies with tolerance, rotation and replay protection', async () => {
    const now = 1_760_000_000_000;
    const header = await signWebhook('secret-new', '{"a":1}', now);
    const seen = new Set<string>();
    const replayGuard = {
      markSeen: (id: string) => {
        if (seen.has(id)) return Promise.resolve(false);
        seen.add(id);
        return Promise.resolve(true);
      },
    };
    const ok = await verifyWebhook({
      secrets: ['secret-old', 'secret-new'],
      header,
      rawBody: '{"a":1}',
      nowMs: now + 1000,
      replayGuard,
    });
    expect(ok).toEqual({ ok: true });
    const replay = await verifyWebhook({ secrets: ['secret-new'], header, rawBody: '{"a":1}', nowMs: now, replayGuard });
    expect(replay).toEqual({ ok: false, reason: 'replayed' });
    const tampered = await verifyWebhook({ secrets: ['secret-new'], header, rawBody: '{"a":2}', nowMs: now });
    expect(tampered).toEqual({ ok: false, reason: 'bad_signature' });
    const stale = await verifyWebhook({ secrets: ['secret-new'], header, rawBody: '{"a":1}', nowMs: now + 301_000 });
    expect(stale).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
    expect(await verifyWebhook({ secrets: ['x'], header: 'garbage', rawBody: '' })).toEqual({
      ok: false,
      reason: 'malformed_header',
    });
  });
});

import type { RateLimiter, RateLimitRule } from '@amable/auth';

/**
 * Fixed-window counter in D1. One atomic UPSERT…RETURNING per hit, so parallel
 * requests cannot slip past the limit. Expired windows are swept lazily.
 */
export function createD1RateLimiter(db: D1Database, now: () => number): RateLimiter {
  const windowOf = (rule: RateLimitRule, key: string) => {
    const index = Math.floor(now() / rule.windowMs);
    return { id: `${rule.name}:${key}:${index}`, resetAt: (index + 1) * rule.windowMs };
  };
  return {
    async consume(rule, key) {
      const { id, resetAt } = windowOf(rule, key);
      const row = await db
        .prepare(
          `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET count = count + 1
           RETURNING count`,
        )
        .bind(id, resetAt)
        .first<{ count: number }>();
      if (Math.random() < 0.01) {
        await db.prepare(`DELETE FROM rate_limits WHERE expires_at < ?`).bind(now()).run();
      }
      const count = row?.count ?? 1;
      return { allowed: count <= rule.limit, retryAfterMs: Math.max(resetAt - now(), 0) };
    },
    async peek(rule, key) {
      const row = await db
        .prepare(`SELECT count FROM rate_limits WHERE key = ?`)
        .bind(windowOf(rule, key).id)
        .first<{ count: number }>();
      return row?.count ?? 0;
    },
  };
}

/**
 * Workers Rate Limiting binding adapter. The binding's limit/period are fixed
 * in wrangler.jsonc, so `rule.limit` only applies to the `peek` fallback.
 */
export function createBindingRateLimiter(binding: RateLimit, fallback: RateLimiter): RateLimiter {
  return {
    async consume(rule, key) {
      try {
        const { success } = await binding.limit({ key: `${rule.name}:${key}` });
        return { allowed: success, retryAfterMs: success ? 0 : 60_000 };
      } catch {
        return fallback.consume(rule, key);
      }
    },
  };
}

const MINUTE = 60_000;

/** Named rules — one place to tune every limit. */
export const RATE_RULES = {
  authIp: { name: 'auth_ip', limit: 30, windowMs: MINUTE },
  loginAccount: { name: 'login_account', limit: 10, windowMs: 15 * MINUTE },
  loginFailures: { name: 'login_fail', limit: 1_000_000, windowMs: 15 * MINUTE },
  magicLinkAccount: { name: 'magic_account', limit: 3, windowMs: 15 * MINUTE },
  resetAccount: { name: 'reset_account', limit: 3, windowMs: 60 * MINUTE },
  emailCodeMinute: { name: 'email_code_min', limit: 1, windowMs: MINUTE },
  emailCodeHour: { name: 'email_code_hour', limit: 5, windowMs: 60 * MINUTE },
  invitesTenant: { name: 'invites_tenant', limit: 50, windowMs: 60 * MINUTE },
  apiKey: { name: 'api_key', limit: 600, windowMs: MINUTE },
  liquidPreview: { name: 'liquid_preview', limit: 120, windowMs: MINUTE },
} as const satisfies Record<string, RateLimitRule>;

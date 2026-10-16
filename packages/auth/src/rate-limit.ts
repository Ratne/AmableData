/**
 * Rate limiting contract. Implementations:
 * - the Workers Rate Limiting binding (per-location, 10 s / 60 s windows) for
 *   coarse per-IP limits — adapter in apps/core;
 * - a D1 fixed-window counter for exact per-account limits (e.g. email codes:
 *   1/minute and 5/hour) and as the local fallback — apps/core;
 * - the in-memory limiter below for unit tests.
 */
export interface RateLimitRule {
  /** Logical bucket, e.g. "login:ip". */
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Milliseconds until the current window resets (best effort). */
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  /** Consumes one unit for `key` under `rule`. */
  consume(rule: RateLimitRule, key: string): Promise<RateLimitResult>;
  /** Reads the current count without consuming. */
  peek?(rule: RateLimitRule, key: string): Promise<number>;
}

export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, number>();
  const bucketKey = (rule: RateLimitRule, key: string) => {
    const window = Math.floor(now() / rule.windowMs);
    return { id: `${rule.name}:${key}:${window}`, resetAt: (window + 1) * rule.windowMs };
  };
  return {
    consume(rule, key) {
      const { id, resetAt } = bucketKey(rule, key);
      const count = (buckets.get(id) ?? 0) + 1;
      buckets.set(id, count);
      return Promise.resolve({ allowed: count <= rule.limit, retryAfterMs: resetAt - now() });
    },
    peek(rule, key) {
      return Promise.resolve(buckets.get(bucketKey(rule, key).id) ?? 0);
    },
  };
}

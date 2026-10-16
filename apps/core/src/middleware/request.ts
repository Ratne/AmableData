import type { Context } from 'hono';

/** Client IP as seen by Cloudflare (absent in local tests). */
export function clientIp(c: Context): string | null {
  return c.req.header('cf-connecting-ip') ?? null;
}

/** ISO country from request.cf (Workers runtime only). */
export function clientCountry(c: Context): string | null {
  const cf: unknown = (c.req.raw as Request & { cf?: unknown }).cf;
  if (typeof cf === 'object' && cf !== null && 'country' in cf && typeof cf.country === 'string') {
    return cf.country;
  }
  return null;
}

/** Runs a background task after the response when an ExecutionContext exists, inline otherwise. */
export async function defer(c: Context, task: Promise<unknown>): Promise<void> {
  const guarded = task.catch((error: unknown) => console.error('[deferred task failed]', error));
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    await guarded;
  }
}

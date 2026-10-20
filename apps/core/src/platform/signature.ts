import {
  CP_SIGNATURE_HEADER,
  DEV_CONTROL_PLANE_PUBLIC_KEY,
  importVerifyKey,
  verifyPlatformRequest,
} from '@amable/core/platform';
import type { Context } from 'hono';
import type { z } from 'zod';
import type { Env } from '../env';
import type { AppEnv } from '../middleware';

const keys = new Map<string, Promise<CryptoKey>>();

/** Public key of the control plane: configured one, or the public dev key with ENVIRONMENT=dev. */
export function controlPlaneVerifyKey(env: Env): Promise<CryptoKey> | null {
  const raw =
    env.CONTROL_PLANE_PUBLIC_KEY !== undefined && env.CONTROL_PLANE_PUBLIC_KEY !== ''
      ? env.CONTROL_PLANE_PUBLIC_KEY
      : env.ENVIRONMENT === 'dev'
        ? DEV_CONTROL_PLANE_PUBLIC_KEY
        : null;
  if (raw === null) return null;
  let key = keys.get(raw);
  if (key === undefined) {
    key = importVerifyKey(raw);
    keys.set(raw, key);
  }
  return key;
}

/**
 * Verifies a signed control plane → installation request and returns its raw
 * body, or null (the caller answers 401). The body is read once here.
 */
export async function verifiedControlPlaneBody(c: Context<AppEnv>): Promise<string | null> {
  const key = controlPlaneVerifyKey(c.env);
  if (key === null) return null;
  const body = await c.req.text();
  const check = await verifyPlatformRequest(await key, c.req.header(CP_SIGNATURE_HEADER), {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    body,
    nowMs: c.get('services').now(),
  });
  return check.ok ? body : null;
}

/**
 * Signed control plane JSON body validated against `schema`: the parsed data,
 * or the error response to return as is (401 signature, 400 JSON, 422 schema).
 */
export async function verifiedControlPlaneJson<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  const body = await verifiedControlPlaneBody(c);
  if (body === null) return { ok: false, response: c.json({ error: 'invalid_signature' }, 401) };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, response: c.json({ error: 'invalid_json' }, 400) };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, response: c.json({ error: 'validation_failed' }, 422) };
  return { ok: true, data: parsed.data };
}

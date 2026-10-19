import { WEBHOOK_SIGNATURE_HEADER } from '@amable/auth';
import { verifyEmailToken, type EmailTokenKind } from '@amable/core';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../env';
import { ensureInstallationMigrated } from '../migrate';
import type { MailOpName, MailResult } from './ops';
import { tokenSecrets, workspaceWebhookSecrets } from './runtime';

/**
 * Unauthenticated email endpoints of the core worker, outside `/api` (no
 * session, no CSRF): every request carries its own proof.
 * - `POST /hooks/email/postshiba/:tenantId` — provider delivery webhooks (HMAC signature).
 * - `POST /edge/email/*` — click / open / unsubscribe forwarded by the edge worker
 *   (signed tokens, verified here before reaching the tenant MailDb).
 */
export const EMAIL_PUBLIC_PREFIXES = ['/hooks/email/', '/edge/email/'] as const;

type PublicEnv = { Bindings: Env };

export const emailPublicApp = new Hono<PublicEnv>();

const MAX_BODY = 1024 * 1024;

/**
 * PostShiba signs `${timestamp}.${body}` and sends `X-Capsule-Timestamp` +
 * `X-Capsule-Signature: sha256=<hex>`; rewritten as `t=<ts>,v1=<hex>` for verifyWebhook.
 */
export function capsuleSignature(timestamp: string | undefined, signature: string | undefined): string | null {
  if (timestamp === undefined || signature === undefined) return null;
  const hex = signature.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^\d+$/.test(timestamp.trim()) || !/^[0-9a-f]{64}$/.test(hex)) return 'malformed';
  return `t=${timestamp.trim()},v1=${hex}`;
}

async function callMailDb(
  c: Context<PublicEnv>,
  tenantId: string,
  op: MailOpName,
  input: unknown,
): Promise<MailResult<unknown>> {
  return c.env.MAIL_DB.get(c.env.MAIL_DB.idFromName(tenantId)).mail(tenantId, op, input);
}

emailPublicApp.post('/hooks/email/postshiba/:tenantId', async (c) => {
  await ensureInstallationMigrated(c.env.DB);
  const tenantId = c.req.param('tenantId');
  const tenant = await c.env.DB.prepare(`SELECT id FROM tenants WHERE id = ?`).bind(tenantId).first();
  if (tenant === null) return c.json({ error: 'not_found' }, 404);
  const raw = await c.req.text();
  if (raw.length > MAX_BODY) return c.json({ error: 'payload_too_large' }, 413);
  const signature =
    capsuleSignature(c.req.header('x-capsule-timestamp'), c.req.header('x-capsule-signature')) ??
    c.req.header(WEBHOOK_SIGNATURE_HEADER) ??
    null;
  const result = await callMailDb(c, tenantId, 'webhooks.provider', {
    rawBody: raw,
    signature,
    secrets: await workspaceWebhookSecrets(c.env, tenantId),
  });
  if (!result.ok) {
    return c.json({ error: result.error.code }, result.error.status as ContentfulStatusCode);
  }
  return c.json(result.value, 200);
});

async function tokenTenant(c: Context<PublicEnv>, kind: EmailTokenKind): Promise<{ token: string; tenantId: string } | null> {
  const body: unknown = await c.req.json().catch(() => null);
  const token =
    typeof body === 'object' && body !== null && typeof (body as { token?: unknown }).token === 'string'
      ? (body as { token: string }).token
      : null;
  if (token === null) return null;
  const payload = await verifyEmailToken(tokenSecrets(c.env), token, kind);
  return payload === null ? null : { token, tenantId: payload.t };
}

emailPublicApp.post('/edge/email/click', async (c) => {
  const t = await tokenTenant(c, 'click');
  if (t === null) return c.json({ error: 'invalid_token' }, 400);
  const result = await callMailDb(c, t.tenantId, 'track.click', { token: t.token });
  const value = result.ok ? (result.value as { url: string } | null) : null;
  return value === null ? c.json({ error: 'invalid_token' }, 400) : c.json(value, 200);
});

emailPublicApp.post('/edge/email/open', async (c) => {
  const t = await tokenTenant(c, 'open');
  if (t === null) return c.json({ ok: false }, 200);
  const result = await callMailDb(c, t.tenantId, 'track.open', { token: t.token });
  return c.json({ ok: result.ok }, 200);
});

emailPublicApp.post('/edge/email/unsubscribe/info', async (c) => {
  const t = await tokenTenant(c, 'unsubscribe');
  if (t === null) return c.json({ valid: false, email: null, alreadyUnsubscribed: false }, 200);
  const result = await callMailDb(c, t.tenantId, 'unsubscribe.info', { token: t.token });
  return c.json(result.ok ? result.value : { valid: false, email: null, alreadyUnsubscribed: false }, 200);
});

emailPublicApp.post('/edge/email/unsubscribe', async (c) => {
  const body: unknown = await c.req.raw.clone().json().catch(() => null);
  const via =
    typeof body === 'object' && body !== null && (body as { via?: unknown }).via === 'one_click'
      ? 'one_click'
      : 'link';
  const t = await tokenTenant(c, 'unsubscribe');
  if (t === null) return c.json({ ok: false }, 400);
  const result = await callMailDb(c, t.tenantId, 'unsubscribe.confirm', { token: t.token, via });
  return c.json({ ok: result.ok && (result.value as { ok: boolean }).ok }, result.ok ? 200 : 400);
});

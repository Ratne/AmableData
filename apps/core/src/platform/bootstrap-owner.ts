import { AUTH_POLICY, randomToken, sha256Hex } from '@amable/auth';
import type { BootstrapOwnerRequest, BootstrapOwnerResponse } from '@amable/core/platform';
import { ulid } from 'ulid';
import { insertInvite, normalizeEmail } from '../auth/store';
import type { Env } from '../env';

export function workspaceSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : 'workspace';
}

/**
 * First workspace + owner invitation of a managed installation, the same bootstrap the
 * self-host script writes: the invitee then signs up through the invite flow (verified
 * email, own password, mandatory 2FA). Never adds an owner once anyone has signed up;
 * a new call before that replaces the previous bootstrap invitation.
 */
export async function bootstrapOwner(
  env: Env,
  input: BootstrapOwnerRequest,
  origin: string,
  now: number,
): Promise<BootstrapOwnerResponse> {
  const db = env.DB;
  if ((await db.prepare(`SELECT 1 AS x FROM users LIMIT 1`).first()) !== null) return { ok: true, status: 'has_users' };
  let tenant = await db
    .prepare(`SELECT id, name FROM tenants ORDER BY created_at, id LIMIT 1`)
    .first<{ id: string; name: string }>();
  if (tenant === null) {
    tenant = { id: ulid(now), name: input.workspaceName };
    await db
      .prepare(`INSERT INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, ?)`)
      .bind(tenant.id, workspaceSlug(input.workspaceName), tenant.name, now)
      .run();
  }
  await db.prepare(`UPDATE invites SET revoked_at = ? WHERE role = 'owner' AND invited_by IS NULL AND accepted_at IS NULL AND revoked_at IS NULL`).bind(now).run();
  const token = randomToken(32);
  const expiresAt = now + AUTH_POLICY.inviteTtlMs;
  await insertInvite(db, {
    tenantId: tenant.id,
    email: normalizeEmail(input.email),
    role: 'owner',
    invitedBy: null,
    locale: input.locale,
    createdAt: now,
    expiresAt,
    tokenHash: await sha256Hex(token),
  });
  return { ok: true, status: 'invited', url: `${origin}/invite#token=${token}`, expiresAt, workspace: tenant.name };
}

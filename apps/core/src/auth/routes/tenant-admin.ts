import {
  AUTH_POLICY,
  generateApiKey,
  randomToken,
  scopesExceedingRole,
  sha256Hex,
} from '@amable/auth';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Role } from '@amable/core';
import { resolveLocale, t } from '@amable/i18n';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  getAuth,
  getSessionAuth,
  getTenant,
  requirePermission,
  requireSession,
  requireStepUp,
  requireStepUpForSession,
} from '../../middleware/access';
import { callCrm } from '../../crm/api/core';
import { audit } from '../../middleware/audit';
import type { AppEnv } from '../../middleware/context';
import { jsonError } from '../../middleware/errors';
import { defer } from '../../middleware/request';
import { appOrigin } from '../../middleware/security';
import { parseJson } from '../../middleware/validate';
import { sendSystemEmail } from '../emails';
import { enforceLimit } from '../helpers';
import { RATE_RULES } from '../rate-limit';
import {
  findMembership,
  findUserById,
  insertApiKey,
  insertInvite,
  listApiKeys,
  listAudit,
  listMembers,
  listPendingInvites,
  normalizeEmail,
  removeMembership,
  revokeApiKey,
  revokeInvite,
  updateMembershipRole,
} from '../store';

/**
 * Tenant administration, mounted at /api/t/:slug (guards requireAuth +
 * requireTenant are applied by app.ts for the whole /t/:slug/* subtree).
 */
export const tenantAdminRoutes = new Hono<AppEnv>();

/** Who am I in this tenant — the UI hides what `permissions` does not grant. */
tenantAdminRoutes.get('/me', (c) => {
  const { tenant, role, permissions } = getTenant(c);
  return c.json({ tenant, role, permissions: [...permissions] });
});

/** Minimal member directory (assignment pickers) — any member. */
tenantAdminRoutes.get('/directory', async (c) => {
  const members = await listMembers(c.env.DB, getTenant(c).tenant.id);
  return c.json({ members: members.map((m) => ({ id: m.userId, name: m.name ?? m.email })) });
});

// --- members ------------------------------------------------------------------------------

tenantAdminRoutes.get('/members', requirePermission('users:manage'), async (c) => {
  const members = await listMembers(c.env.DB, getTenant(c).tenant.id);
  return c.json({ members });
});

/**
 * Role rules: only owners may touch owners or grant ownership (tenant:transfer);
 * there is always at least one owner (enforced in SQL).
 */
function canManageRole(actorRole: Role, targetCurrent: Role | null, targetNext: Role | null) {
  const touchesOwner = targetCurrent === 'owner' || targetNext === 'owner';
  return !touchesOwner || ROLE_PERMISSIONS[actorRole].includes('tenant:transfer');
}

tenantAdminRoutes.patch(
  '/members/:userId',
  requirePermission('users:manage'),
  requireStepUp(),
  async (c) => {
    const body = await parseJson(c, z.strictObject({ role: z.enum(ROLES) }));
    const { tenant, role: actorRole } = getTenant(c);
    const userId = c.req.param('userId');
    const current = await findMembership(c.env.DB, userId, tenant.id);
    if (current === null) return jsonError(c, 404, 'member_not_found');
    if (!canManageRole(actorRole, current, body.role)) return jsonError(c, 403, 'forbidden');
    if (current === body.role) return c.json({ ok: true });
    if (!(await updateMembershipRole(c.env.DB, tenant.id, userId, body.role))) {
      return jsonError(c, 409, 'last_owner');
    }
    await audit(c, 'tenant.member_role_changed', {
      target: userId,
      details: { from: current, to: body.role },
    });
    const member = await findUserById(c.env.DB, userId);
    if (member !== null) {
      const locale = resolveLocale(member.locale);
      await defer(
        c,
        sendSystemEmail(c.get('services'), member.email, locale, 'role_changed', {
          tenant: tenant.name,
          role: t(locale, `roles.${body.role}`),
        }),
      );
    }
    return c.json({ ok: true });
  },
);

tenantAdminRoutes.delete(
  '/members/:userId',
  requirePermission('users:manage'),
  requireStepUp(),
  async (c) => {
    const { tenant, role: actorRole } = getTenant(c);
    const userId = c.req.param('userId');
    const current = await findMembership(c.env.DB, userId, tenant.id);
    if (current === null) return jsonError(c, 404, 'member_not_found');
    if (!canManageRole(actorRole, current, null)) return jsonError(c, 403, 'forbidden');
    if (!(await removeMembership(c.env.DB, tenant.id, userId))) {
      return jsonError(c, 409, 'last_owner');
    }
    // Access ends immediately: membership is checked on every request.
    await audit(c, 'tenant.member_removed', { target: userId });
    return c.json({ ok: true });
  },
);

tenantAdminRoutes.post('/leave', requireSession(), async (c) => {
  const { tenant } = getTenant(c);
  const auth = getSessionAuth(c);
  if (!(await removeMembership(c.env.DB, tenant.id, auth.user.id))) {
    return jsonError(c, 409, 'last_owner');
  }
  await audit(c, 'tenant.member_left', { target: auth.user.id });
  return c.json({ ok: true });
});

// --- invites ------------------------------------------------------------------------------

tenantAdminRoutes.get('/invites', requirePermission('users:manage'), async (c) => {
  const invites = await listPendingInvites(
    c.env.DB,
    getTenant(c).tenant.id,
    c.get('services').now(),
  );
  return c.json({
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
    })),
  });
});

tenantAdminRoutes.post(
  '/invites',
  requirePermission('users:manage'),
  requireStepUp(),
  async (c) => {
    const body = await parseJson(
      c,
      z.strictObject({ email: z.string().trim().max(320).pipe(z.email()), role: z.enum(ROLES) }),
    );
    const services = c.get('services');
    const { tenant, role: actorRole } = getTenant(c);
    if (!canManageRole(actorRole, null, body.role)) return jsonError(c, 403, 'forbidden');
    await enforceLimit(services.limiter, RATE_RULES.invitesTenant, tenant.id);
    const inviter = getAuth(c).user;
    const email = normalizeEmail(body.email);
    const token = randomToken(32);
    const now = services.now();
    // Invitations go out in the workspace language (Settings > General), else the inviter's, until the invitee picks one.
    const workspaceLanguage = await callCrm(c, 'workspace.settings.get', {}).then(
      (settings) => settings.language,
      () => null,
    );
    const locale = resolveLocale(workspaceLanguage ?? inviter.locale);
    const id = await insertInvite(c.env.DB, {
      tenantId: tenant.id,
      email,
      role: body.role,
      invitedBy: inviter.id,
      locale,
      createdAt: now,
      expiresAt: now + AUTH_POLICY.inviteTtlMs,
      tokenHash: await sha256Hex(token),
    });
    await audit(c, 'tenant.invite_created', { target: id, details: { role: body.role } });
    await defer(
      c,
      sendSystemEmail(services, email, locale, 'invite', {
        tenant: tenant.name,
        inviter: inviter.name ?? inviter.email,
        role: t(locale, `roles.${body.role}`),
        url: `${appOrigin(c)}/invite#token=${token}`,
        days: Math.round(AUTH_POLICY.inviteTtlMs / 86_400_000),
      }),
    );
    return c.json({ id }, 201);
  },
);

tenantAdminRoutes.delete('/invites/:id', requirePermission('users:manage'), requireStepUpForSession(), async (c) => {
  const { tenant } = getTenant(c);
  const id = c.req.param('id');
  if (!(await revokeInvite(c.env.DB, tenant.id, id, c.get('services').now()))) {
    return jsonError(c, 404, 'invite_not_found');
  }
  await audit(c, 'tenant.invite_revoked', { target: id });
  return c.json({ ok: true });
});

// --- API keys -----------------------------------------------------------------------------

tenantAdminRoutes.get('/api-keys', requirePermission('api_keys:manage'), async (c) => {
  const keys = await listApiKeys(c.env.DB, getTenant(c).tenant.id);
  return c.json({
    apiKeys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      createdBy: k.createdBy,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
    })),
  });
});

tenantAdminRoutes.post(
  '/api-keys',
  requirePermission('api_keys:manage'),
  requireStepUp(),
  async (c) => {
    const body = await parseJson(
      c,
      z.strictObject({
        name: z.string().trim().min(1).max(80),
        scopes: z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length),
      }),
    );
    const { tenant, permissions } = getTenant(c);
    const auth = getSessionAuth(c);
    const scopes = [...new Set(body.scopes)];
    // A key can never be broader than the role of whoever creates it.
    const exceeding = scopesExceedingRole(scopes, permissions);
    if (exceeding.length > 0) {
      return jsonError(c, 403, 'scope_exceeds_role', { scopes: exceeding });
    }
    const generated = await generateApiKey();
    const id = await insertApiKey(c.env.DB, {
      tenantId: tenant.id,
      name: body.name,
      prefix: generated.prefix,
      hash: generated.hash,
      scopes,
      createdBy: auth.user.id,
      now: c.get('services').now(),
    });
    await audit(c, 'tenant.api_key_created', { target: id, details: { scopes: scopes.length } });
    // Shown exactly once.
    return c.json({ id, key: generated.key, prefix: generated.prefix, scopes }, 201);
  },
);

tenantAdminRoutes.delete('/api-keys/:id', requirePermission('api_keys:manage'), requireStepUp(), async (c) => {
  const { tenant } = getTenant(c);
  const id = c.req.param('id');
  if (!(await revokeApiKey(c.env.DB, tenant.id, id, c.get('services').now()))) {
    return jsonError(c, 404, 'api_key_not_found');
  }
  await audit(c, 'tenant.api_key_revoked', { target: id });
  return c.json({ ok: true });
});

// --- audit log ------------------------------------------------------------------------------

tenantAdminRoutes.get('/audit', requirePermission('audit:read'), async (c) => {
  const before = Number(c.req.query('before'));
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  const entries = await listAudit(c.env.DB, getTenant(c).tenant.id, {
    before: Number.isFinite(before) && before > 0 ? before : null,
    limit,
  });
  return c.json({ entries });
});

/** Route → permission table, used by the authorization tests and for documentation. */
export const TENANT_ADMIN_ROUTE_PERMISSIONS = [
  { method: 'GET', path: '/members', permission: 'users:manage' },
  { method: 'GET', path: '/invites', permission: 'users:manage' },
  { method: 'GET', path: '/api-keys', permission: 'api_keys:manage' },
  { method: 'GET', path: '/audit', permission: 'audit:read' },
] as const;


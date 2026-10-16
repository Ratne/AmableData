import { AUTH_POLICY, COOKIE_NAMES, describeUserAgent, randomToken, sha256Hex } from '@amable/auth';
import {
  ASSIST_GRANT_DEFAULT_DAYS,
  ASSIST_GRANT_MAX_DAYS,
  verifyAssistToken,
  type AssistGrantMirror,
} from '@amable/core/platform';
import { formatDateTime, resolveLocale } from '@amable/i18n';
import { Hono, type Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { ulid } from 'ulid';
import { z } from 'zod';
import { sendSystemEmail } from '../../auth/emails';
import {
  addMembership,
  createUser,
  findTenantById,
  findUserByEmail,
  insertAudit,
  insertSession,
  removeMembership,
} from '../../auth/store';
import type { Env } from '../../env';
import type { AppEnv } from '../../middleware';
import {
  audit,
  clientCountry,
  clientIp,
  defer,
  getSessionAuth,
  getTenant,
  jsonError,
  parseJson,
  requireStepUp,
} from '../../middleware';
import { ControlPlaneError, controlPlaneClient } from '../client';
import { platformLink } from '../license';
import { controlPlaneVerifyKey, verifiedControlPlaneBody } from '../signature';
import { actingUser, isSupportUserEmail, SUPPORT_EMAIL_DOMAIN } from './shared';

const DAY_MS = 86_400_000;
const REVOKE_PENDING_KEY = 'platform:assist_revoke_pending';

interface GrantRow {
  id: string;
  tenant_id: string;
  granted_by: string;
  reason: string;
  ticket_id: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
  mirrored_at: number | null;
  first_entry_at: number | null;
}

interface AssistSessionRow {
  jti: string;
  grant_id: string;
  staff_id: string;
  staff_name: string;
  user_id: string;
  session_public_id: string | null;
  created_at: number;
  expires_at: number;
  ended_at: number | null;
}

const grantInput = z.strictObject({
  days: z.number().int().min(1).max(ASSIST_GRANT_MAX_DAYS).optional(),
  reason: z.string().trim().min(1).max(500),
  ticketId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable().optional(),
});
const enterInput = z.strictObject({ token: z.string().min(10).max(4096) });
const revokeInput = z.strictObject({ grantId: z.string().min(1).max(64) });

function grantState(grant: GrantRow, now: number): 'active' | 'revoked' | 'expired' {
  if (grant.revoked_at !== null) return 'revoked';
  return grant.expires_at <= now ? 'expired' : 'active';
}

function publicGrant(grant: GrantRow, now: number) {
  return {
    id: grant.id,
    reason: grant.reason,
    ticketId: grant.ticket_id,
    grantedBy: grant.granted_by,
    createdAt: grant.created_at,
    expiresAt: grant.expires_at,
    revokedAt: grant.revoked_at,
    firstEntryAt: grant.first_entry_at,
    mirrored: grant.mirrored_at !== null,
    state: grantState(grant, now),
  };
}

function publicSession(row: AssistSessionRow) {
  return {
    id: row.jti,
    grantId: row.grant_id,
    staffName: row.staff_name,
    startedAt: row.created_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
  };
}

async function findGrant(db: D1Database, id: string): Promise<GrantRow | null> {
  return db.prepare(`SELECT * FROM platform_assist_grants WHERE id = ?`).bind(id).first<GrantRow>();
}

/** Assist sessions still backed by a live session row. */
async function activeSessions(db: D1Database, tenantId: string, now: number): Promise<AssistSessionRow[]> {
  const result = await db
    .prepare(
      `SELECT p.* FROM platform_assist_sessions p
       JOIN platform_assist_grants g ON g.id = p.grant_id
       JOIN sessions s ON s.public_id = p.session_public_id AND s.user_id = p.user_id
       WHERE g.tenant_id = ? AND p.ended_at IS NULL AND p.expires_at > ?
         AND s.expires_at > ? AND s.absolute_expires_at > ?
       ORDER BY p.created_at DESC`,
    )
    .bind(tenantId, now, now, now)
    .all<AssistSessionRow>();
  return result.results;
}

/**
 * Ends assist sessions (deleting their session rows) and removes the support
 * membership of every support user left without an open assist session in
 * that tenant.
 */
async function endAssistSessions(db: D1Database, rows: readonly AssistSessionRow[], now: number): Promise<void> {
  const users = new Map<string, string>();
  for (const row of rows) {
    if (row.session_public_id !== null) {
      await db
        .prepare(`DELETE FROM sessions WHERE user_id = ? AND public_id = ?`)
        .bind(row.user_id, row.session_public_id)
        .run();
    }
    await db
      .prepare(`UPDATE platform_assist_sessions SET ended_at = ? WHERE jti = ? AND ended_at IS NULL`)
      .bind(now, row.jti)
      .run();
    const grant = await findGrant(db, row.grant_id);
    if (grant !== null) users.set(row.user_id, grant.tenant_id);
  }
  for (const [userId, tenantId] of users) {
    const open = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM platform_assist_sessions p
         JOIN platform_assist_grants g ON g.id = p.grant_id
         WHERE p.user_id = ? AND g.tenant_id = ? AND p.ended_at IS NULL`,
      )
      .bind(userId, tenantId)
      .first<{ n: number }>();
    if ((open?.n ?? 0) === 0) await removeMembership(db, tenantId, userId);
  }
}

async function closeGrant(db: D1Database, grantId: string, now: number): Promise<void> {
  const rows = await db
    .prepare(`SELECT * FROM platform_assist_sessions WHERE grant_id = ? AND ended_at IS NULL`)
    .bind(grantId)
    .all<AssistSessionRow>();
  await endAssistSessions(db, rows.results, now);
}

/** Marks a grant revoked and closes its sessions; false when unknown or already revoked. */
async function revokeGrant(db: D1Database, grantId: string, by: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE platform_assist_grants SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(now, by, grantId)
    .run();
  await closeGrant(db, grantId, now);
  return result.meta.changes === 1;
}

async function mirrorGrant(
  env: Env,
  grant: GrantRow,
  tenantSlug: string,
  grantedBy: AssistGrantMirror['grantedBy'],
  now: number,
): Promise<boolean> {
  const cp = controlPlaneClient(env);
  if (cp === null) return false;
  const body: AssistGrantMirror = {
    grantId: grant.id,
    tenantId: grant.tenant_id,
    tenantSlug,
    grantedBy,
    reason: grant.reason,
    ticketId: grant.ticket_id,
    createdAt: new Date(grant.created_at).toISOString(),
    expiresAt: new Date(grant.expires_at).toISOString(),
  };
  try {
    await cp.post('/support/grants', body);
  } catch (error) {
    console.warn('[platform] assist grant mirror failed', error);
    return false;
  }
  await env.DB.prepare(`UPDATE platform_assist_grants SET mirrored_at = ? WHERE id = ?`)
    .bind(now, grant.id)
    .run();
  return true;
}

async function readPendingRevokes(db: D1Database): Promise<string[]> {
  const row = await db
    .prepare(`SELECT value FROM installation_meta WHERE key = ?`)
    .bind(REVOKE_PENDING_KEY)
    .first<{ value: string }>();
  if (row === null) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

async function writePendingRevokes(db: D1Database, ids: readonly string[]): Promise<void> {
  await db
    .prepare(
      `INSERT INTO installation_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(REVOKE_PENDING_KEY, JSON.stringify(ids.slice(-200)))
    .run();
}

/** Mirrors a local revoke to the control plane; queued for the sweep when it fails. */
async function mirrorRevoke(env: Env, grantId: string, actor: AssistGrantMirror['grantedBy'] | null) {
  const cp = controlPlaneClient(env);
  if (cp === null) return;
  try {
    await cp.post(`/support/grants/${grantId}/revoke`, actor === null ? {} : { actor });
  } catch (error) {
    console.warn('[platform] assist revoke mirror failed', error);
    const pending = await readPendingRevokes(env.DB);
    if (!pending.includes(grantId)) await writePendingRevokes(env.DB, [...pending, grantId]);
  }
}

function canManage(c: Context<AppEnv>): boolean {
  const { role } = getTenant(c);
  return (role === 'owner' || role === 'admin') && !isSupportUserEmail(getSessionAuth(c).user.email);
}

/** Support user of one staff member in one tenant: its sessions can never reach another tenant. */
function supportEmail(staffId: string, tenantId: string): string {
  const safe = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64);
  return `support+${safe(staffId)}.${safe(tenantId)}@${SUPPORT_EMAIL_DOMAIN}`;
}

/** `/t/:slug/platform/assist/*` (central guards + session only applied by the caller). */
export function assistTenantRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/assist/status', async (c) => {
    const now = c.get('services').now();
    const { tenant } = getTenant(c);
    const grants = await c.env.DB.prepare(
      `SELECT * FROM platform_assist_grants
       WHERE tenant_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    )
      .bind(tenant.id, now)
      .all<GrantRow>();
    const sessions = await activeSessions(c.env.DB, tenant.id, now);
    return c.json({
      available: platformLink(c.env).mode === 'licensed',
      canManage: canManage(c),
      supportSession: isSupportUserEmail(getSessionAuth(c).user.email),
      grants: grants.results.map((g) => ({ id: g.id, expiresAt: g.expires_at })),
      sessions: sessions.map(publicSession),
    });
  });

  routes.get('/assist/grants', async (c) => {
    if (!canManage(c)) return jsonError(c, 403, 'forbidden');
    const now = c.get('services').now();
    const { tenant } = getTenant(c);
    const grants = await c.env.DB.prepare(
      `SELECT * FROM platform_assist_grants WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50`,
    )
      .bind(tenant.id)
      .all<GrantRow>();
    const sessions = await c.env.DB.prepare(
      `SELECT p.* FROM platform_assist_sessions p JOIN platform_assist_grants g ON g.id = p.grant_id
       WHERE g.tenant_id = ? ORDER BY p.created_at DESC LIMIT 200`,
    )
      .bind(tenant.id)
      .all<AssistSessionRow>();
    const live = new Set((await activeSessions(c.env.DB, tenant.id, now)).map((s) => s.jti));
    return c.json({
      grants: grants.results.map((g) => publicGrant(g, now)),
      sessions: sessions.results.map((s) => ({ ...publicSession(s), active: live.has(s.jti) })),
    });
  });

  routes.post('/assist/grants', requireStepUp(), async (c) => {
    if (!canManage(c)) return jsonError(c, 403, 'forbidden');
    if (platformLink(c.env).mode !== 'licensed') return jsonError(c, 404, 'platform_unavailable');
    const input = await parseJson(c, grantInput);
    const now = c.get('services').now();
    const { tenant } = getTenant(c);
    const actor = actingUser(c);
    const grant: GrantRow = {
      id: ulid(now),
      tenant_id: tenant.id,
      granted_by: actor.userId,
      reason: input.reason,
      ticket_id: input.ticketId ?? null,
      created_at: now,
      expires_at: now + (input.days ?? ASSIST_GRANT_DEFAULT_DAYS) * DAY_MS,
      revoked_at: null,
      revoked_by: null,
      mirrored_at: null,
      first_entry_at: null,
    };
    await c.env.DB.prepare(
      `INSERT INTO platform_assist_grants (id, tenant_id, granted_by, reason, ticket_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(grant.id, grant.tenant_id, grant.granted_by, grant.reason, grant.ticket_id, grant.created_at, grant.expires_at)
      .run();
    await audit(c, 'support.assist_granted', {
      target: grant.id,
      details: { days: input.days ?? ASSIST_GRANT_DEFAULT_DAYS, ticketId: grant.ticket_id },
    });
    const mirrored = await mirrorGrant(c.env, grant, tenant.slug, actor, now);
    if (mirrored) grant.mirrored_at = now;
    return c.json({ grant: { ...publicGrant(grant, now), mirrored } }, 201);
  });

  routes.delete('/assist/grants/:id', async (c) => {
    if (!canManage(c)) return jsonError(c, 403, 'forbidden');
    const grant = await findGrant(c.env.DB, c.req.param('id'));
    if (grant === null || grant.tenant_id !== getTenant(c).tenant.id) return jsonError(c, 404, 'not_found');
    const now = c.get('services').now();
    const revoked = await revokeGrant(c.env.DB, grant.id, getSessionAuth(c).user.id, now);
    if (revoked) {
      await audit(c, 'support.assist_revoked', { target: grant.id, details: { source: 'tenant' } });
      await mirrorRevoke(c.env, grant.id, actingUser(c));
    }
    return c.json({ ok: true, revoked });
  });

  return routes;
}

function rejectEntry(c: Context<AppEnv>, reason: string): Response {
  return jsonError(c, 401, 'invalid_assist_token', { reason });
}

async function notifyOwners(c: Context<AppEnv>, tenant: { id: string; name: string }, staff: string, until: number) {
  const owners = await c.env.DB.prepare(
    `SELECT u.email, u.locale FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = ? AND m.role = 'owner' AND u.disabled_at IS NULL`,
  )
    .bind(tenant.id)
    .all<{ email: string; locale: string }>();
  const services = c.get('services');
  await Promise.all(
    owners.results.map((owner) => {
      const locale = resolveLocale(owner.locale);
      return sendSystemEmail(services, owner.email, locale, 'support_access_started', {
        tenant: tenant.name,
        staff,
        until: `${formatDateTime(locale, until, 'UTC')} UTC`,
      });
    }),
  );
}

/** Public entry (`/platform/assist/enter`) + signed revoke (`/platform/v1/assist/revoke`). */
export function mountAssistEntry(app: Hono<AppEnv>): void {
  // The token travels in the URL fragment, which survives this redirect and never reaches a log.
  app.get('/platform/assist/enter', (c) => c.redirect('/support-access', 302));

  app.post('/platform/assist/enter', async (c) => {
    const link = platformLink(c.env);
    if (link.mode !== 'licensed') return jsonError(c, 404, 'platform_unavailable');
    const { token } = await parseJson(c, enterInput);
    const key = controlPlaneVerifyKey(c.env);
    if (key === null) return rejectEntry(c, 'no_key');
    const services = c.get('services');
    const now = services.now();
    const check = await verifyAssistToken(await key, token, now);
    if (!check.ok) return rejectEntry(c, check.reason);
    const payload = check.payload;
    if (payload.iid !== link.installationId) return rejectEntry(c, 'wrong_installation');
    const grant = await findGrant(c.env.DB, payload.gid);
    if (grant === null || grant.tenant_id !== payload.tid) return rejectEntry(c, 'unknown_grant');
    const state = grantState(grant, now);
    if (state !== 'active') return rejectEntry(c, `grant_${state}`);
    const expiresAt = payload.exp * 1000;
    if (expiresAt > grant.expires_at) return rejectEntry(c, 'outlives_grant');
    const tenant = await findTenantById(c.env.DB, grant.tenant_id);
    if (tenant === null) return rejectEntry(c, 'unknown_grant');

    const email = supportEmail(payload.sid, tenant.id);
    const name = `amabledata support · ${payload.sname}`.slice(0, 120);
    const user =
      (await findUserByEmail(c.env.DB, email)) ??
      (await createUser(c.env.DB, { email, name, locale: 'en', passwordHash: null, emailVerifiedAt: null, now }));
    if (!isSupportUserEmail(user.email) || user.passwordHash !== null) return rejectEntry(c, 'unknown_grant');

    const claimed = await c.env.DB.prepare(
      `INSERT INTO platform_assist_sessions (jti, grant_id, staff_id, staff_name, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(jti) DO NOTHING`,
    )
      .bind(payload.jti, grant.id, payload.sid, payload.sname.slice(0, 120), user.id, now, expiresAt)
      .run();
    if (claimed.meta.changes !== 1) return rejectEntry(c, 'token_reused');

    await addMembership(c.env.DB, { userId: user.id, tenantId: tenant.id, role: 'admin', invitedBy: null, now });
    // Never more than admin, whatever the row held before.
    await c.env.DB.prepare(`UPDATE memberships SET role = 'admin' WHERE user_id = ? AND tenant_id = ?`)
      .bind(user.id, tenant.id)
      .run();
    await c.env.DB.prepare(`UPDATE users SET last_tenant_id = ? WHERE id = ?`).bind(tenant.id, user.id).run();

    const sessionToken = randomToken(32);
    const publicId = ulid(now);
    const userAgent = c.req.header('user-agent')?.slice(0, 512) ?? null;
    await insertSession(c.env.DB, {
      id: await sha256Hex(sessionToken),
      publicId,
      userId: user.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: Math.min(now + AUTH_POLICY.sessionIdleMs, expiresAt),
      absoluteExpiresAt: expiresAt,
      userAgent,
      deviceLabel: `${describeUserAgent(userAgent)} · support`.slice(0, 200),
      ip: clientIp(c),
      country: clientCountry(c),
      mfaMethod: 'assist',
      stepUpAt: null,
    });
    await c.env.DB.prepare(`UPDATE platform_assist_sessions SET session_public_id = ? WHERE jti = ?`)
      .bind(publicId, payload.jti)
      .run();
    setCookie(c, COOKIE_NAMES.session, sessionToken, {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: Math.max(1, Math.floor((expiresAt - now) / 1000)),
    });

    await insertAudit(c.env.DB, {
      tenantId: tenant.id,
      actorUserId: user.id,
      actorType: 'support',
      action: 'support.assist_entered',
      target: grant.id,
      details: { staffId: payload.sid, staffName: payload.sname.slice(0, 120), jti: payload.jti },
      ip: clientIp(c),
      now,
    });
    const first = await c.env.DB.prepare(
      `UPDATE platform_assist_grants SET first_entry_at = ? WHERE id = ? AND first_entry_at IS NULL`,
    )
      .bind(now, grant.id)
      .run();
    if (first.meta.changes === 1) await defer(c, notifyOwners(c, tenant, payload.sname, grant.expires_at));

    return c.json({ ok: true, redirect: `/t/${tenant.slug}/dashboard` });
  });

  app.post('/platform/v1/assist/revoke', async (c) => {
    const body = await verifiedControlPlaneBody(c);
    if (body === null) return c.json({ error: 'invalid_signature' }, 401);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = revokeInput.safeParse(json);
    if (!parsed.success) return c.json({ error: 'validation_failed' }, 422);
    const grant = await findGrant(c.env.DB, parsed.data.grantId);
    if (grant === null) return c.json({ ok: true, revoked: false });
    const now = c.get('services').now();
    const revoked = await revokeGrant(c.env.DB, grant.id, 'control_plane', now);
    if (revoked) {
      await insertAudit(c.env.DB, {
        tenantId: grant.tenant_id,
        actorUserId: null,
        actorType: 'support',
        action: 'support.assist_revoked',
        target: grant.id,
        details: { source: 'control_plane' },
        ip: null,
        now,
      });
    }
    return c.json({ ok: true, revoked });
  });
}

/** Cron: closes expired grants and sessions, retries pending mirrors and revokes. */
export async function sweepAssist(env: Env, nowMs: number): Promise<void> {
  const stale = await env.DB.prepare(
    `SELECT p.* FROM platform_assist_sessions p JOIN platform_assist_grants g ON g.id = p.grant_id
     WHERE p.ended_at IS NULL AND (p.expires_at <= ?1 OR g.expires_at <= ?1 OR g.revoked_at IS NOT NULL)`,
  )
    .bind(nowMs)
    .all<AssistSessionRow>();
  if (stale.results.length > 0) await endAssistSessions(env.DB, stale.results, nowMs);

  if (platformLink(env).mode !== 'licensed') return;
  const unmirrored = await env.DB.prepare(
    `SELECT g.*, t.slug AS tenant_slug FROM platform_assist_grants g JOIN tenants t ON t.id = g.tenant_id
     WHERE g.mirrored_at IS NULL AND g.revoked_at IS NULL AND g.expires_at > ? LIMIT 20`,
  )
    .bind(nowMs)
    .all<GrantRow & { tenant_slug: string }>();
  for (const grant of unmirrored.results) {
    const granter = await env.DB.prepare(
      `SELECT u.id, u.name, u.email, m.role FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = ? WHERE u.id = ?`,
    )
      .bind(grant.tenant_id, grant.granted_by)
      .first<{ id: string; name: string | null; email: string; role: string | null }>();
    if (granter === null) continue;
    await mirrorGrant(env, grant, grant.tenant_slug, {
      userId: granter.id,
      name: granter.name,
      email: granter.email,
      role: granter.role ?? 'owner',
      tenantId: grant.tenant_id,
    }, nowMs);
  }

  const pending = await readPendingRevokes(env.DB);
  if (pending.length === 0) return;
  const cp = controlPlaneClient(env);
  if (cp === null) return;
  const left: string[] = [];
  for (const id of pending) {
    try {
      await cp.post(`/support/grants/${id}/revoke`, {});
    } catch (error) {
      // A 4xx will never succeed (unknown or foreign grant): drop it.
      if (!(error instanceof ControlPlaneError) || error.status === 0 || error.status >= 500) left.push(id);
    }
  }
  await writePendingRevokes(env.DB, left);
}

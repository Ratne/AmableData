import { AUTH_POLICY, checkPasswordPolicy, randomToken, sha256Hex } from '@amable/auth';
import { LOCALES, THEMES } from '@amable/i18n';
import { Hono, type Context } from 'hono';
import { ulid } from 'ulid';
import { z } from 'zod';
import { getSessionAuth, requireAuth, requireSession, requireStepUp } from '../../middleware/access';
import { audit } from '../../middleware/audit';
import type { AppEnv } from '../../middleware/context';
import { HttpError, jsonError } from '../../middleware/errors';
import { defer } from '../../middleware/request';
import { appOrigin } from '../../middleware/security';
import { parseJson } from '../../middleware/validate';
import { updateNotice } from '../../platform/updates';
import {
  describeChallenge,
  regenerateRecoveryCodes,
  sendEmailCode,
  startSessionChallenge,
  startTotpEnrollment,
  verifyChallenge,
} from '../challenge';
import { sendSystemEmail } from '../emails';
import { meBody, verifyPasswordUniform } from '../helpers';
import { clearSessionCookie, rotateSession, setPrefsCookie } from '../sessions';
import {
  addMembership,
  deleteSessionByHash,
  deleteSessionByPublicId,
  deleteUserSessions,
  findPendingSessionChallenge,
  findTenantBySlug,
  findUserByEmail,
  findUserById,
  insertToken,
  listMemberships,
  listSessions,
  normalizeEmail,
  setLastTenant,
  setPassword,
  setSessionStepUp,
  updatePreferences,
  type ChallengePurpose,
  type UserRow,
} from '../store';
import { verifyFailure } from './public';

/** Signed-in account routes, mounted at /api. Sessions only — API keys never reach these. */
export const accountRoutes = new Hono<AppEnv>();

accountRoutes.use('/me', requireAuth(), requireSession());
accountRoutes.use('/me/*', requireAuth(), requireSession());
accountRoutes.use('/auth/step-up/*', requireAuth(), requireSession());
accountRoutes.use('/tenants', requireAuth(), requireSession());

async function currentUser(c: Context<AppEnv>): Promise<UserRow> {
  const user = await findUserById(c.env.DB, getSessionAuth(c).user.id);
  if (user === null) throw new HttpError(401, 'unauthenticated');
  return user;
}

accountRoutes.get('/me', async (c) => c.json(await meBody(c, await currentUser(c))));

// Only workspace owners administer a self-hosted installation, so only they see updates.
accountRoutes.get('/me/update', async (c) => {
  const memberships = await listMemberships(c.env.DB, getSessionAuth(c).user.id);
  if (!memberships.some((m) => m.role === 'owner')) return c.json({ update: null });
  return c.json({ update: await updateNotice(c.env) });
});

// --- preferences (language + theme) ------------------------------------------------------

const preferencesSchema = z
  .strictObject({ locale: z.enum(LOCALES).optional(), theme: z.enum(THEMES).optional() })
  .refine((v) => v.locale !== undefined || v.theme !== undefined, 'empty');

accountRoutes.patch('/me/preferences', async (c) => {
  const body = await parseJson(c, preferencesSchema);
  const auth = getSessionAuth(c);
  await updatePreferences(c.env.DB, auth.user.id, body, c.get('services').now());
  const user = await currentUser(c);
  setPrefsCookie(c, user.locale, user.theme);
  return c.json({ locale: user.locale, theme: user.theme });
});

// --- devices / sessions ----------------------------------------------------------------------

accountRoutes.get('/me/sessions', async (c) => {
  const auth = getSessionAuth(c);
  const sessions = await listSessions(c.env.DB, auth.user.id, c.get('services').now());
  return c.json({
    sessions: sessions.map((s) => ({
      id: s.publicId,
      device: s.deviceLabel,
      country: s.country,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      current: s.publicId === auth.session.publicId,
    })),
  });
});

accountRoutes.delete('/me/sessions/:id', async (c) => {
  const auth = getSessionAuth(c);
  const id = c.req.param('id');
  if (!(await deleteSessionByPublicId(c.env.DB, auth.user.id, id))) {
    return jsonError(c, 404, 'session_not_found');
  }
  if (id === auth.session.publicId) clearSessionCookie(c);
  await audit(c, 'auth.session_revoked', { tenantId: null, target: id });
  return c.json({ ok: true });
});

accountRoutes.post('/me/sessions/revoke-others', async (c) => {
  const auth = getSessionAuth(c);
  await deleteUserSessions(c.env.DB, auth.user.id, auth.session.hash);
  await audit(c, 'auth.sessions_revoked_others', { tenantId: null });
  return c.json({ ok: true });
});

// --- tenants: switcher + creation -------------------------------------------------------------

accountRoutes.get('/me/tenants', async (c) => {
  const auth = getSessionAuth(c);
  const memberships = await listMemberships(c.env.DB, auth.user.id);
  return c.json({
    tenants: memberships.map((m) => ({ slug: m.slug, name: m.name, role: m.role })),
  });
});

accountRoutes.post('/me/tenants/switch', async (c) => {
  const body = await parseJson(c, z.strictObject({ slug: z.string().min(1).max(64) }));
  const auth = getSessionAuth(c);
  const memberships = await listMemberships(c.env.DB, auth.user.id);
  const target = memberships.find((m) => m.slug === body.slug);
  if (target === undefined) return jsonError(c, 404, 'tenant_not_found');
  await setLastTenant(c.env.DB, auth.user.id, target.tenantId);
  return c.json({ slug: target.slug, path: `/t/${target.slug}` });
});

const slugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

/**
 * Creates a tenant with the caller as owner. Allowed for owners of an existing
 * tenant, or for anyone while the installation has no tenant yet (bootstrap).
 */
accountRoutes.post('/tenants', requireStepUp(), async (c) => {
  const body = await parseJson(
    c,
    z.strictObject({ name: z.string().trim().min(1).max(120), slug: slugSchema }),
  );
  const auth = getSessionAuth(c);
  const memberships = await listMemberships(c.env.DB, auth.user.id);
  const anyTenant = await c.env.DB.prepare(`SELECT 1 AS x FROM tenants LIMIT 1`).first();
  if (anyTenant !== null && !memberships.some((m) => m.role === 'owner')) {
    return jsonError(c, 403, 'forbidden');
  }
  if ((await findTenantBySlug(c.env.DB, body.slug)) !== null) {
    return jsonError(c, 409, 'slug_taken');
  }
  const now = c.get('services').now();
  const id = ulid(now);
  await c.env.DB.prepare(`INSERT INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, ?)`)
    .bind(id, body.slug, body.name, now)
    .run();
  await addMembership(c.env.DB, {
    userId: auth.user.id,
    tenantId: id,
    role: 'owner',
    invitedBy: null,
    now,
  });
  await audit(c, 'tenant.created', { tenantId: id, target: body.slug });
  return c.json({ slug: body.slug, name: body.name }, 201);
});

// --- step-up (re-enter the second factor) ---------------------------------------------------

async function loadSessionChallenge(c: Context<AppEnv>, purpose: ChallengePurpose) {
  const auth = getSessionAuth(c);
  const challenge = await findPendingSessionChallenge(
    c.env.DB,
    auth.session.publicId,
    purpose,
    c.get('services').now(),
  );
  if (challenge === null) throw new HttpError(401, 'no_challenge');
  return { auth, challenge, user: await currentUser(c) };
}

const verifySchema = z.strictObject({
  method: z.enum(['totp', 'email', 'recovery', 'enroll_totp', 'enroll_email']),
  code: z.string().min(1).max(64),
});

accountRoutes.post('/auth/step-up/start', async (c) => {
  const auth = getSessionAuth(c);
  const user = await currentUser(c);
  const challenge = await startSessionChallenge(c, user, auth.session.publicId, 'step_up');
  return c.json(describeChallenge(user, challenge));
});

accountRoutes.post('/auth/step-up/email-code', async (c) => {
  const { challenge, user } = await loadSessionChallenge(c, 'step_up');
  await sendEmailCode(c, user, challenge);
  return c.json({ ok: true });
});

accountRoutes.post('/auth/step-up/verify', async (c) => {
  const body = await parseJson(c, verifySchema);
  const { auth, challenge, user } = await loadSessionChallenge(c, 'step_up');
  const outcome = await verifyChallenge(c, user, challenge, body.method, body.code);
  if (outcome.status !== 'ok') {
    // Three wrong codes on a live session: treat it as compromised.
    if (outcome.status === 'cancelled') {
      await deleteSessionByHash(c.env.DB, auth.session.hash);
      clearSessionCookie(c);
    }
    return verifyFailure(c, outcome);
  }
  const newHash = await rotateSession(c, auth.session.hash);
  if (newHash === null) return jsonError(c, 401, 'unauthenticated');
  const now = c.get('services').now();
  await setSessionStepUp(c.env.DB, newHash, now);
  await audit(c, 'auth.step_up', { tenantId: null, details: { method: body.method } });
  return c.json({ ok: true, validUntil: now + AUTH_POLICY.stepUpMaxAgeMs });
});

// --- 2FA management (after step-up) -------------------------------------------------------

accountRoutes.post('/me/2fa/recovery-codes', requireStepUp(), async (c) => {
  const user = await currentUser(c);
  const codes = await regenerateRecoveryCodes(c, user.id);
  await audit(c, 'auth.recovery_codes_regenerated', { tenantId: null });
  await defer(
    c,
    sendSystemEmail(c.get('services'), user.email, user.locale, 'mfa_changed', {
      method: 'recovery codes',
    }),
  );
  return c.json({ recoveryCodes: codes });
});

accountRoutes.post('/me/2fa/start', requireStepUp(), async (c) => {
  const auth = getSessionAuth(c);
  const user = await currentUser(c);
  const challenge = await startSessionChallenge(c, user, auth.session.publicId, 'enroll');
  return c.json(describeChallenge(user, challenge));
});

accountRoutes.post('/me/2fa/totp-setup', async (c) => {
  const { challenge, user } = await loadSessionChallenge(c, 'enroll');
  return c.json(await startTotpEnrollment(c, user, challenge));
});

accountRoutes.post('/me/2fa/email-code', async (c) => {
  const { challenge, user } = await loadSessionChallenge(c, 'enroll');
  await sendEmailCode(c, user, challenge);
  return c.json({ ok: true });
});

accountRoutes.post('/me/2fa/verify', async (c) => {
  const body = await parseJson(c, verifySchema);
  const { auth, challenge, user } = await loadSessionChallenge(c, 'enroll');
  const outcome = await verifyChallenge(c, user, challenge, body.method, body.code);
  if (outcome.status !== 'ok') return verifyFailure(c, outcome);
  await deleteUserSessions(c.env.DB, user.id, auth.session.hash);
  return c.json({ ok: true, recoveryCodes: outcome.recoveryCodes });
});

// --- password & email change (after step-up) ------------------------------------------------

accountRoutes.post('/me/password', requireStepUp(), async (c) => {
  const body = await parseJson(
    c,
    z.strictObject({
      currentPassword: z.string().max(1024).optional(),
      newPassword: z.string().min(1).max(1024),
    }),
  );
  const services = c.get('services');
  const auth = getSessionAuth(c);
  const user = await currentUser(c);
  if (user.passwordHash !== null) {
    const ok = await verifyPasswordUniform(services, user.passwordHash, body.currentPassword ?? '');
    if (!ok) return jsonError(c, 401, 'invalid_credentials');
  }
  const policy = await checkPasswordPolicy(body.newPassword, services.breachChecker);
  if (policy !== null) return jsonError(c, 422, `password_${policy}`);
  await setPassword(c.env.DB, user.id, await services.hasher.hash(body.newPassword), services.now());
  await deleteUserSessions(c.env.DB, user.id, auth.session.hash);
  await rotateSession(c, auth.session.hash);
  await audit(c, 'auth.password_changed', { tenantId: null });
  await defer(c, sendSystemEmail(services, user.email, user.locale, 'password_changed', {}));
  return c.json({ ok: true });
});

accountRoutes.post('/me/email', requireStepUp(), async (c) => {
  const body = await parseJson(
    c,
    z.strictObject({ newEmail: z.string().trim().max(320).pipe(z.email()) }),
  );
  const services = c.get('services');
  const user = await currentUser(c);
  const newEmail = normalizeEmail(body.newEmail);
  if (newEmail !== user.email && (await findUserByEmail(c.env.DB, newEmail)) === null) {
    const token = randomToken(32);
    const now = services.now();
    await insertToken(c.env.DB, {
      hash: await sha256Hex(token),
      purpose: 'email_change',
      userId: user.id,
      email: newEmail,
      now,
      expiresAt: now + AUTH_POLICY.emailChangeTtlMs,
    });
    await defer(
      c,
      sendSystemEmail(services, newEmail, user.locale, 'email_change_verify', {
        url: `${appOrigin(c)}/auth/email#token=${token}`,
      }),
    );
  }
  await audit(c, 'auth.email_change_requested', { tenantId: null });
  return c.json({ ok: true }, 202);
});


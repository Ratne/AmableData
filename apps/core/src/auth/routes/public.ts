import { AUTH_POLICY, checkPasswordPolicy, randomToken, sha256Hex } from '@amable/auth';
import { resolveLocale } from '@amable/i18n';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { audit } from '../../middleware/audit';
import type { AppEnv } from '../../middleware/context';
import { HttpError, jsonError } from '../../middleware/errors';
import { clientIp, defer } from '../../middleware/request';
import { appOrigin } from '../../middleware/security';
import { parseJson } from '../../middleware/validate';
import {
  describeChallenge,
  sendEmailCode,
  startLoginChallenge,
  startTotpEnrollment,
  verifyChallenge,
  type VerifyMethod,
} from '../challenge';
import { sendSystemEmail } from '../emails';
import { accountKey, enforceLimit, meBody, verifyPasswordUniform } from '../helpers';
import { RATE_RULES } from '../rate-limit';
import {
  clearChallengeCookie,
  clearSessionCookie,
  issueSession,
  readChallengeToken,
  readSessionToken,
} from '../sessions';
import {
  acceptInvite,
  addMembership,
  consumeToken,
  createUser,
  deleteSessionByHash,
  deleteUserSessions,
  findChallenge,
  findInviteByTokenHash,
  findTenantById,
  findUserByEmail,
  findUserById,
  insertToken,
  invalidateTokens,
  normalizeEmail,
  setPassword,
  type UserRow,
} from '../store';

/** Unauthenticated (pre-session) auth flows, mounted at /api/auth and /api/invites. */
export const publicAuthRoutes = new Hono<AppEnv>();

const emailField = z.string().trim().max(320).pipe(z.email());
const turnstileField = z.string().max(2048).optional();
const passwordField = z.string().min(1).max(1024);
const tokenField = z.string().min(20).max(128);

function policyMessageCode(error: 'too_short' | 'too_long' | 'breached') {
  return `password_${error}`;
}

async function requireTurnstile(c: Context<AppEnv>, token: string | undefined) {
  const services = c.get('services');
  if (!services.turnstile.enabled) return;
  if (!(await services.turnstile.verify(token, clientIp(c)))) {
    throw new HttpError(403, 'turnstile_required');
  }
}

function lockedResponse(c: Context<AppEnv>, user: UserRow) {
  const now = c.get('services').now();
  if (user.lockedUntil !== null && user.lockedUntil > now) {
    return jsonError(c, 423, 'account_locked', { lockedUntil: user.lockedUntil });
  }
  return null;
}

publicAuthRoutes.get('/auth/config', (c) =>
  c.json({ turnstileSiteKey: c.get('services').turnstileSiteKey }),
);

// --- password login -----------------------------------------------------------------------

publicAuthRoutes.post('/auth/login', async (c) => {
  const body = await parseJson(
    c,
    z.strictObject({ email: emailField, password: passwordField, turnstileToken: turnstileField }),
  );
  const services = c.get('services');
  const ip = clientIp(c) ?? 'unknown';
  const email = normalizeEmail(body.email);
  const key = await accountKey(email);
  await enforceLimit(services.ipLimiter, RATE_RULES.authIp, ip);
  await enforceLimit(services.limiter, RATE_RULES.loginAccount, key);

  const failures = Math.max(
    (await services.limiter.peek?.(RATE_RULES.loginFailures, key)) ?? 0,
    (await services.limiter.peek?.(RATE_RULES.loginFailures, `ip:${ip}`)) ?? 0,
  );
  if (failures >= AUTH_POLICY.turnstileAfterFailedLogins) {
    await requireTurnstile(c, body.turnstileToken);
  }

  const user = await findUserByEmail(c.env.DB, email);
  const valid = await verifyPasswordUniform(services, user?.passwordHash ?? null, body.password);
  if (!valid || user === null || user.disabledAt !== null) {
    await services.limiter.consume(RATE_RULES.loginFailures, key);
    await services.limiter.consume(RATE_RULES.loginFailures, `ip:${ip}`);
    await audit(c, 'auth.login_failed', { actorUserId: user?.id ?? null, tenantId: null });
    return jsonError(c, 401, 'invalid_credentials', {
      turnstileRequired:
        services.turnstile.enabled && failures + 1 >= AUTH_POLICY.turnstileAfterFailedLogins,
    });
  }
  const locked = lockedResponse(c, user);
  if (locked !== null) return locked;

  if (user.passwordHash !== null && services.hasher.needsRehash(user.passwordHash)) {
    await setPassword(c.env.DB, user.id, await services.hasher.hash(body.password), services.now());
  }
  return c.json(await startLoginChallenge(c, user, 'password'));
});

// --- magic link ---------------------------------------------------------------------------

publicAuthRoutes.post('/auth/magic-link', async (c) => {
  const body = await parseJson(
    c,
    z.strictObject({ email: emailField, turnstileToken: turnstileField }),
  );
  const services = c.get('services');
  await enforceLimit(services.ipLimiter, RATE_RULES.authIp, clientIp(c) ?? 'unknown');
  await requireTurnstile(c, body.turnstileToken);
  const email = normalizeEmail(body.email);
  const limit = await services.limiter.consume(RATE_RULES.magicLinkAccount, await accountKey(email));

  const user = await findUserByEmail(c.env.DB, email);
  if (limit.allowed && user !== null && user.disabledAt === null) {
    const token = randomToken(32);
    const now = services.now();
    await insertToken(c.env.DB, {
      hash: await sha256Hex(token),
      purpose: 'magic_link',
      userId: user.id,
      email: null,
      now,
      expiresAt: now + AUTH_POLICY.magicLinkTtlMs,
    });
    await defer(
      c,
      sendSystemEmail(services, user.email, user.locale, 'magic_link', {
        url: `${appOrigin(c)}/auth/magic#token=${token}`,
        minutes: Math.round(AUTH_POLICY.magicLinkTtlMs / 60_000),
      }),
    );
  }
  // Identical answer whether or not the account exists (no enumeration).
  return c.json({ ok: true }, 202);
});

publicAuthRoutes.post('/auth/magic-link/consume', async (c) => {
  const body = await parseJson(c, z.strictObject({ token: tokenField }));
  const services = c.get('services');
  await enforceLimit(services.ipLimiter, RATE_RULES.authIp, clientIp(c) ?? 'unknown');
  const consumed = await consumeToken(
    c.env.DB,
    await sha256Hex(body.token),
    'magic_link',
    services.now(),
  );
  const user = consumed === null ? null : await findUserById(c.env.DB, consumed.userId);
  if (user === null || user.disabledAt !== null) return jsonError(c, 400, 'invalid_token');
  const locked = lockedResponse(c, user);
  if (locked !== null) return locked;
  if (user.emailVerifiedAt === null) {
    await c.env.DB.prepare(`UPDATE users SET email_verified_at = ? WHERE id = ?`)
      .bind(services.now(), user.id)
      .run();
  }
  // The magic link is only the first factor: 2FA still follows.
  return c.json(await startLoginChallenge(c, user, 'magic_link'));
});

// --- second factor ------------------------------------------------------------------------

async function loadLoginChallenge(c: Context<AppEnv>) {
  const token = readChallengeToken(c);
  if (token === undefined || token.length > 128) throw new HttpError(401, 'no_challenge');
  const challenge = await findChallenge(c.env.DB, await sha256Hex(token));
  const now = c.get('services').now();
  if (
    challenge === null ||
    challenge.purpose !== 'login' ||
    challenge.status !== 'pending' ||
    challenge.expiresAt <= now
  ) {
    clearChallengeCookie(c);
    throw new HttpError(401, 'no_challenge');
  }
  const user = await findUserById(c.env.DB, challenge.userId);
  if (user === null || user.disabledAt !== null) throw new HttpError(401, 'no_challenge');
  if (user.lockedUntil !== null && user.lockedUntil > now) {
    clearChallengeCookie(c);
    throw new HttpError(423, 'account_locked', { lockedUntil: user.lockedUntil });
  }
  return { challenge, user };
}

publicAuthRoutes.get('/auth/challenge', async (c) => {
  const { challenge, user } = await loadLoginChallenge(c);
  return c.json(describeChallenge(user, challenge));
});

publicAuthRoutes.post('/auth/challenge/email-code', async (c) => {
  const { challenge, user } = await loadLoginChallenge(c);
  await sendEmailCode(c, user, challenge);
  return c.json({ ok: true });
});

publicAuthRoutes.post('/auth/challenge/totp-setup', async (c) => {
  const { challenge, user } = await loadLoginChallenge(c);
  return c.json(await startTotpEnrollment(c, user, challenge));
});

const verifySchema = z.strictObject({
  method: z.enum(['totp', 'email', 'recovery', 'enroll_totp', 'enroll_email']),
  code: z.string().min(1).max(64),
});

/** Maps a failed verification to its HTTP response (shared with step-up and enroll). */
export function verifyFailure(
  c: Context<AppEnv>,
  outcome: Exclude<Awaited<ReturnType<typeof verifyChallenge>>, { status: 'ok' }>,
) {
  switch (outcome.status) {
    case 'wrong':
      return jsonError(c, 401, 'invalid_code', { attemptsLeft: outcome.attemptsLeft });
    case 'cancelled':
      return jsonError(c, 401, 'challenge_cancelled', {
        locked: outcome.locked,
        lockedUntil: outcome.lockedUntil,
      });
    case 'expired':
      return jsonError(c, 401, 'challenge_expired');
  }
}

publicAuthRoutes.post('/auth/challenge/verify', async (c) => {
  const body = await parseJson(c, verifySchema);
  await enforceLimit(c.get('services').ipLimiter, RATE_RULES.authIp, clientIp(c) ?? 'unknown');
  const { challenge, user } = await loadLoginChallenge(c);
  const method: VerifyMethod = body.method;
  const outcome = await verifyChallenge(c, user, challenge, method, body.code);
  if (outcome.status !== 'ok') {
    if (outcome.status !== 'wrong') clearChallengeCookie(c);
    return verifyFailure(c, outcome);
  }
  const fresh = (await findUserById(c.env.DB, user.id)) ?? user;
  await issueSession(c, fresh, fresh.mfaMethod ?? method);
  await audit(c, 'auth.login', {
    actorUserId: user.id,
    tenantId: null,
    details: { firstFactor: challenge.firstFactor, method },
  });
  return c.json({
    status: 'authenticated',
    recoveryCodes: outcome.recoveryCodes,
    ...(await meBody(c, fresh)),
  });
});

// --- logout ---------------------------------------------------------------------------------

publicAuthRoutes.post('/auth/logout', async (c) => {
  const token = readSessionToken(c);
  if (token !== undefined) await deleteSessionByHash(c.env.DB, await sha256Hex(token));
  clearSessionCookie(c);
  clearChallengeCookie(c);
  return c.json({ ok: true });
});

// --- password reset (email link only, 1 hour, single use) -------------------------------

publicAuthRoutes.post('/auth/password/forgot', async (c) => {
  const body = await parseJson(
    c,
    z.strictObject({ email: emailField, turnstileToken: turnstileField }),
  );
  const services = c.get('services');
  await enforceLimit(services.ipLimiter, RATE_RULES.authIp, clientIp(c) ?? 'unknown');
  await requireTurnstile(c, body.turnstileToken);
  const email = normalizeEmail(body.email);
  const limit = await services.limiter.consume(RATE_RULES.resetAccount, await accountKey(email));
  const user = await findUserByEmail(c.env.DB, email);
  if (limit.allowed && user !== null && user.disabledAt === null) {
    const token = randomToken(32);
    const now = services.now();
    // insertToken invalidates every previous reset token of this user.
    await insertToken(c.env.DB, {
      hash: await sha256Hex(token),
      purpose: 'password_reset',
      userId: user.id,
      email: null,
      now,
      expiresAt: now + AUTH_POLICY.passwordResetTtlMs,
    });
    await defer(
      c,
      sendSystemEmail(services, user.email, user.locale, 'password_reset', {
        url: `${appOrigin(c)}/auth/reset#token=${token}`,
      }),
    );
  }
  return c.json({ ok: true }, 202);
});

publicAuthRoutes.post('/auth/password/reset', async (c) => {
  const body = await parseJson(c, z.strictObject({ token: tokenField, password: passwordField }));
  const services = c.get('services');
  await enforceLimit(services.ipLimiter, RATE_RULES.authIp, clientIp(c) ?? 'unknown');
  // Policy first, so a weak password does not burn the single-use token.
  const policy = await checkPasswordPolicy(body.password, services.breachChecker);
  if (policy !== null) return jsonError(c, 422, policyMessageCode(policy));

  const now = services.now();
  const consumed = await consumeToken(c.env.DB, await sha256Hex(body.token), 'password_reset', now);
  const user = consumed === null ? null : await findUserById(c.env.DB, consumed.userId);
  if (user === null) return jsonError(c, 400, 'invalid_token');

  await setPassword(c.env.DB, user.id, await services.hasher.hash(body.password), now);
  await invalidateTokens(c.env.DB, user.id, 'password_reset', now);
  await invalidateTokens(c.env.DB, user.id, 'magic_link', now);
  await deleteUserSessions(c.env.DB, user.id);
  await audit(c, 'auth.password_reset', { actorUserId: user.id, tenantId: null });
  await defer(c, sendSystemEmail(services, user.email, user.locale, 'password_changed', {}));
  // No session is created: the user signs in again, with 2FA.
  return c.json({ ok: true });
});

// --- email change confirmation -------------------------------------------------------------

publicAuthRoutes.post('/auth/email/confirm', async (c) => {
  const body = await parseJson(c, z.strictObject({ token: tokenField }));
  const services = c.get('services');
  const now = services.now();
  const consumed = await consumeToken(c.env.DB, await sha256Hex(body.token), 'email_change', now);
  const user = consumed === null ? null : await findUserById(c.env.DB, consumed.userId);
  if (user === null || consumed === null || consumed.email === null) {
    return jsonError(c, 400, 'invalid_token');
  }
  if ((await findUserByEmail(c.env.DB, consumed.email)) !== null) {
    return jsonError(c, 409, 'email_taken');
  }
  const oldEmail = user.email;
  await c.env.DB.prepare(
    `UPDATE users SET email = ?, email_verified_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(consumed.email, now, now, user.id)
    .run();
  await deleteUserSessions(c.env.DB, user.id);
  await audit(c, 'auth.email_changed', { actorUserId: user.id, tenantId: null });
  await defer(
    c,
    sendSystemEmail(services, oldEmail, user.locale, 'email_changed', { newEmail: consumed.email }),
  );
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// --- invitations -----------------------------------------------------------------------------

async function loadInvite(c: Context<AppEnv>, token: string) {
  const invite = await findInviteByTokenHash(c.env.DB, await sha256Hex(token));
  const now = c.get('services').now();
  if (
    invite === null ||
    invite.acceptedAt !== null ||
    invite.revokedAt !== null ||
    invite.expiresAt <= now
  ) {
    throw new HttpError(400, 'invalid_invite');
  }
  const tenant = await findTenantById(c.env.DB, invite.tenantId);
  if (tenant === null) throw new HttpError(400, 'invalid_invite');
  return { invite, tenant };
}

publicAuthRoutes.post('/invites/peek', async (c) => {
  const body = await parseJson(c, z.strictObject({ token: tokenField }));
  await enforceLimit(c.get('services').ipLimiter, RATE_RULES.authIp, clientIp(c) ?? 'unknown');
  const { invite, tenant } = await loadInvite(c, body.token);
  const inviter = invite.invitedBy === null ? null : await findUserById(c.env.DB, invite.invitedBy);
  const existing = await findUserByEmail(c.env.DB, invite.email);
  return c.json({
    tenant: { slug: tenant.slug, name: tenant.name },
    email: invite.email,
    role: invite.role,
    inviter: inviter?.name ?? inviter?.email ?? null,
    accountExists: existing !== null,
    locale: invite.locale,
  });
});

/**
 * Existing account → must be signed in as the invited address, then the
 * membership is added. New account → created (email proven by the link),
 * optional password, then mandatory 2FA enrollment via a login challenge.
 */
publicAuthRoutes.post('/invites/accept', async (c) => {
  const body = await parseJson(
    c,
    z.strictObject({
      token: tokenField,
      name: z.string().trim().min(1).max(120).optional(),
      password: passwordField.optional(),
      turnstileToken: turnstileField,
    }),
  );
  const services = c.get('services');
  await enforceLimit(services.ipLimiter, RATE_RULES.authIp, clientIp(c) ?? 'unknown');
  const { invite, tenant } = await loadInvite(c, body.token);
  const now = services.now();
  const existing = await findUserByEmail(c.env.DB, invite.email);

  if (existing !== null) {
    const auth = c.get('auth');
    if (auth === undefined || auth.kind !== 'session' || auth.user.id !== existing.id) {
      return jsonError(c, 401, 'login_required', { email: invite.email });
    }
    if (!(await acceptInvite(c.env.DB, invite.id, now))) return jsonError(c, 400, 'invalid_invite');
    await addMembership(c.env.DB, {
      userId: existing.id,
      tenantId: tenant.id,
      role: invite.role,
      invitedBy: invite.invitedBy,
      now,
    });
    await audit(c, 'tenant.invite_accepted', {
      tenantId: tenant.id,
      actorUserId: existing.id,
      target: existing.id,
      details: { role: invite.role },
    });
    return c.json({ status: 'joined', slug: tenant.slug });
  }

  await requireTurnstile(c, body.turnstileToken);
  let passwordHash: string | null = null;
  if (body.password !== undefined) {
    const policy = await checkPasswordPolicy(body.password, services.breachChecker);
    if (policy !== null) return jsonError(c, 422, policyMessageCode(policy));
    passwordHash = await services.hasher.hash(body.password);
  }
  if (!(await acceptInvite(c.env.DB, invite.id, now))) return jsonError(c, 400, 'invalid_invite');
  const user = await createUser(c.env.DB, {
    email: invite.email,
    name: body.name ?? null,
    locale: resolveLocale(invite.locale),
    passwordHash,
    emailVerifiedAt: now,
    now,
  });
  await addMembership(c.env.DB, {
    userId: user.id,
    tenantId: tenant.id,
    role: invite.role,
    invitedBy: invite.invitedBy,
    now,
  });
  await audit(c, 'tenant.invite_accepted', {
    tenantId: tenant.id,
    actorUserId: user.id,
    target: user.id,
    details: { role: invite.role, newAccount: true },
  });
  return c.json({ slug: tenant.slug, ...(await startLoginChallenge(c, user, 'invite')) });
});

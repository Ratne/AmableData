import { ROLES, type Role } from '@amable/core';
import { ulid } from 'ulid';

/**
 * D1 data access for the auth layer — parameterized statements only. Columns
 * are mapped to camelCase rows here so the rest of the layer never sees SQL.
 */

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  locale: string;
  theme: string;
  passwordHash: string | null;
  emailVerifiedAt: number | null;
  mfaMethod: 'totp' | 'email' | null;
  totpSecretEnc: string | null;
  totpLastStep: number | null;
  failedChallenges: number;
  lockCount: number;
  lockedUntil: number | null;
  disabledAt: number | null;
  lastTenantId: string | null;
  createdAt: number;
}

interface RawUser {
  id: string;
  email: string;
  name: string | null;
  locale: string;
  theme: string;
  password_hash: string | null;
  email_verified_at: number | null;
  mfa_method: string | null;
  totp_secret_enc: string | null;
  totp_last_step: number | null;
  failed_challenges: number;
  lock_count: number;
  locked_until: number | null;
  disabled_at: number | null;
  last_tenant_id: string | null;
  created_at: number;
}

function mapUser(raw: RawUser): UserRow {
  return {
    id: raw.id,
    email: raw.email,
    name: raw.name,
    locale: raw.locale,
    theme: raw.theme,
    passwordHash: raw.password_hash,
    emailVerifiedAt: raw.email_verified_at,
    mfaMethod: raw.mfa_method === 'totp' || raw.mfa_method === 'email' ? raw.mfa_method : null,
    totpSecretEnc: raw.totp_secret_enc,
    totpLastStep: raw.totp_last_step,
    failedChallenges: raw.failed_challenges,
    lockCount: raw.lock_count,
    lockedUntil: raw.locked_until,
    disabledAt: raw.disabled_at,
    lastTenantId: raw.last_tenant_id,
    createdAt: raw.created_at,
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

// --- users -----------------------------------------------------------------

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  const raw = await db
    .prepare(`SELECT * FROM users WHERE email = ?`)
    .bind(normalizeEmail(email))
    .first<RawUser>();
  return raw === null ? null : mapUser(raw);
}

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  const raw = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<RawUser>();
  return raw === null ? null : mapUser(raw);
}

export async function createUser(
  db: D1Database,
  input: {
    email: string;
    name: string | null;
    locale: string;
    passwordHash: string | null;
    emailVerifiedAt: number | null;
    now: number;
  },
): Promise<UserRow> {
  const id = ulid(input.now);
  await db
    .prepare(
      `INSERT INTO users (id, email, name, locale, theme, password_hash, password_changed_at,
         email_verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'system', ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      normalizeEmail(input.email),
      input.name,
      input.locale,
      input.passwordHash,
      input.passwordHash === null ? null : input.now,
      input.emailVerifiedAt,
      input.now,
      input.now,
    )
    .run();
  const user = await findUserById(db, id);
  if (user === null) throw new Error('user insert failed');
  return user;
}

export async function setPassword(db: D1Database, userId: string, hash: string, now: number) {
  await db
    .prepare(
      `UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(hash, now, now, userId)
    .run();
}

export async function updatePreferences(
  db: D1Database,
  userId: string,
  prefs: { locale?: string; theme?: string },
  now: number,
) {
  await db
    .prepare(
      `UPDATE users SET locale = COALESCE(?, locale), theme = COALESCE(?, theme), updated_at = ?
       WHERE id = ?`,
    )
    .bind(prefs.locale ?? null, prefs.theme ?? null, now, userId)
    .run();
}

export async function enrollMfa(
  db: D1Database,
  userId: string,
  input: { method: 'totp' | 'email'; totpSecretEnc: string | null; totpStep: number | null },
  now: number,
) {
  await db
    .prepare(
      `UPDATE users SET mfa_method = ?, totp_secret_enc = ?, totp_last_step = ?,
         mfa_enrolled_at = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(input.method, input.totpSecretEnc, input.totpStep, now, now, userId)
    .run();
}

/** Atomically records a used TOTP step; false if the step was already used (replay). */
export async function claimTotpStep(db: D1Database, userId: string, step: number) {
  const result = await db
    .prepare(
      `UPDATE users SET totp_last_step = ?
       WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)`,
    )
    .bind(step, userId, step)
    .run();
  return result.meta.changes === 1;
}

/**
 * Registers a cancelled challenge. Third consecutive one locks the account for
 * 15 min × 2^previousLocks. One UPDATE (SQLite evaluates SET expressions on the
 * old row), so concurrent failures cannot skip the lock.
 */
export async function registerFailedChallenge(
  db: D1Database,
  userId: string,
  input: { threshold: number; baseMs: number; maxExponent: number; now: number },
): Promise<{ locked: boolean; lockedUntil: number | null }> {
  const row = await db
    .prepare(
      `UPDATE users SET
         failed_challenges = CASE WHEN failed_challenges + 1 >= ?1 THEN 0 ELSE failed_challenges + 1 END,
         locked_until = CASE WHEN failed_challenges + 1 >= ?1
           THEN ?2 + ?3 * (1 << MIN(lock_count, ?4)) ELSE locked_until END,
         lock_count = CASE WHEN failed_challenges + 1 >= ?1 THEN lock_count + 1 ELSE lock_count END
       WHERE id = ?5
       RETURNING failed_challenges, locked_until`,
    )
    .bind(input.threshold, input.now, input.baseMs, input.maxExponent, userId)
    .first<{ failed_challenges: number; locked_until: number | null }>();
  const lockedUntil = row?.locked_until ?? null;
  return { locked: lockedUntil !== null && lockedUntil > input.now, lockedUntil };
}

export async function clearFailedChallenges(db: D1Database, userId: string) {
  await db
    .prepare(`UPDATE users SET failed_challenges = 0, lock_count = 0 WHERE id = ?`)
    .bind(userId)
    .run();
}

// --- sessions ----------------------------------------------------------------

export interface SessionRow {
  id: string;
  publicId: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  userAgent: string | null;
  deviceLabel: string | null;
  ip: string | null;
  country: string | null;
  stepUpAt: number | null;
}

interface RawSession {
  id: string;
  public_id: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  absolute_expires_at: number;
  user_agent: string | null;
  device_label: string | null;
  ip: string | null;
  country: string | null;
  step_up_at: number | null;
}

function mapSession(raw: RawSession): SessionRow {
  return {
    id: raw.id,
    publicId: raw.public_id,
    userId: raw.user_id,
    createdAt: raw.created_at,
    lastSeenAt: raw.last_seen_at,
    expiresAt: raw.expires_at,
    absoluteExpiresAt: raw.absolute_expires_at,
    userAgent: raw.user_agent,
    deviceLabel: raw.device_label,
    ip: raw.ip,
    country: raw.country,
    stepUpAt: raw.step_up_at,
  };
}

export async function insertSession(
  db: D1Database,
  row: Omit<SessionRow, 'stepUpAt'> & { mfaMethod: string; stepUpAt: number | null },
) {
  await db
    .prepare(
      `INSERT INTO sessions (id, public_id, user_id, created_at, last_seen_at, expires_at,
         absolute_expires_at, user_agent, device_label, ip, country, mfa_method, step_up_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.publicId,
      row.userId,
      row.createdAt,
      row.lastSeenAt,
      row.expiresAt,
      row.absoluteExpiresAt,
      row.userAgent,
      row.deviceLabel,
      row.ip,
      row.country,
      row.mfaMethod,
      row.stepUpAt,
    )
    .run();
}

export async function findSessionByHash(db: D1Database, hash: string) {
  const raw = await db
    .prepare(`SELECT * FROM sessions WHERE id = ?`)
    .bind(hash)
    .first<RawSession>();
  return raw === null ? null : mapSession(raw);
}

export async function listSessions(db: D1Database, userId: string, now: number) {
  const result = await db
    .prepare(
      `SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? AND absolute_expires_at > ?
       ORDER BY last_seen_at DESC`,
    )
    .bind(userId, now, now)
    .all<RawSession>();
  return result.results.map(mapSession);
}

export async function touchSession(db: D1Database, hash: string, lastSeenAt: number, expiresAt: number) {
  await db
    .prepare(`UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`)
    .bind(lastSeenAt, expiresAt, hash)
    .run();
}

/** Rotation: the row keeps its public id, the token (and so its hash) changes. */
export async function rotateSessionHash(db: D1Database, oldHash: string, newHash: string) {
  const result = await db
    .prepare(`UPDATE sessions SET id = ? WHERE id = ?`)
    .bind(newHash, oldHash)
    .run();
  return result.meta.changes === 1;
}

export async function setSessionStepUp(db: D1Database, hash: string, at: number) {
  await db.prepare(`UPDATE sessions SET step_up_at = ? WHERE id = ?`).bind(at, hash).run();
}

export async function setLastTenant(db: D1Database, userId: string, tenantId: string | null) {
  await db.prepare(`UPDATE users SET last_tenant_id = ? WHERE id = ?`).bind(tenantId, userId).run();
}

export async function deleteSessionByHash(db: D1Database, hash: string) {
  await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(hash).run();
}

export async function deleteSessionByPublicId(db: D1Database, userId: string, publicId: string) {
  const result = await db
    .prepare(`DELETE FROM sessions WHERE user_id = ? AND public_id = ?`)
    .bind(userId, publicId)
    .run();
  return result.meta.changes === 1;
}

export async function deleteUserSessions(db: D1Database, userId: string, exceptHash?: string) {
  await db
    .prepare(`DELETE FROM sessions WHERE user_id = ? AND id != ?`)
    .bind(userId, exceptHash ?? '')
    .run();
}

// --- challenges ----------------------------------------------------------------

/** login: after the first factor; step_up: re-auth of a live session; enroll: 2FA change from settings. */
export type ChallengePurpose = 'login' | 'step_up' | 'enroll';
export type FirstFactor = 'password' | 'magic_link' | 'invite' | 'session';

export interface ChallengeRow {
  id: string;
  userId: string;
  purpose: ChallengePurpose;
  firstFactor: FirstFactor;
  sessionPublicId: string | null;
  status: 'pending' | 'completed' | 'cancelled';
  attempts: number;
  emailCodeHash: string | null;
  emailCodeExpiresAt: number | null;
  pendingTotpSecretEnc: string | null;
  createdAt: number;
  expiresAt: number;
}

interface RawChallenge {
  id: string;
  user_id: string;
  purpose: string;
  first_factor: string;
  session_public_id: string | null;
  status: string;
  attempts: number;
  email_code_hash: string | null;
  email_code_expires_at: number | null;
  pending_totp_secret_enc: string | null;
  created_at: number;
  expires_at: number;
}

function mapChallenge(raw: RawChallenge): ChallengeRow {
  return {
    id: raw.id,
    userId: raw.user_id,
    purpose: raw.purpose === 'step_up' || raw.purpose === 'enroll' ? raw.purpose : 'login',
    firstFactor:
      raw.first_factor === 'magic_link' ||
      raw.first_factor === 'invite' ||
      raw.first_factor === 'session'
        ? raw.first_factor
        : 'password',
    sessionPublicId: raw.session_public_id,
    status:
      raw.status === 'completed' || raw.status === 'cancelled' ? raw.status : 'pending',
    attempts: raw.attempts,
    emailCodeHash: raw.email_code_hash,
    emailCodeExpiresAt: raw.email_code_expires_at,
    pendingTotpSecretEnc: raw.pending_totp_secret_enc,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
  };
}

export async function insertChallenge(
  db: D1Database,
  input: {
    id: string;
    userId: string;
    purpose: ChallengePurpose;
    firstFactor: FirstFactor;
    sessionPublicId: string | null;
    now: number;
    expiresAt: number;
  },
) {
  // A user has at most one pending challenge per purpose: older ones die.
  await db.batch([
    db
      .prepare(
        `UPDATE auth_challenges SET status = 'cancelled', email_code_hash = NULL
         WHERE user_id = ? AND purpose = ? AND status = 'pending'`,
      )
      .bind(input.userId, input.purpose),
    db
      .prepare(
        `INSERT INTO auth_challenges (id, user_id, purpose, first_factor, session_public_id,
           created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.userId,
        input.purpose,
        input.firstFactor,
        input.sessionPublicId,
        input.now,
        input.expiresAt,
      ),
  ]);
}

export async function findPendingSessionChallenge(
  db: D1Database,
  sessionPublicId: string,
  purpose: ChallengePurpose,
  now: number,
) {
  const raw = await db
    .prepare(
      `SELECT * FROM auth_challenges WHERE session_public_id = ? AND purpose = ?
         AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(sessionPublicId, purpose, now)
    .first<RawChallenge>();
  return raw === null ? null : mapChallenge(raw);
}

export async function findChallenge(db: D1Database, id: string) {
  const raw = await db
    .prepare(`SELECT * FROM auth_challenges WHERE id = ?`)
    .bind(id)
    .first<RawChallenge>();
  return raw === null ? null : mapChallenge(raw);
}

/**
 * Reserves one OTP attempt atomically. Returns the attempt number (1-based) or
 * null when the challenge is no longer usable (cancelled, completed, expired,
 * or out of attempts) — parallel requests cannot exceed the maximum.
 */
export async function reserveAttempt(
  db: D1Database,
  id: string,
  maxAttempts: number,
  now: number,
): Promise<number | null> {
  const row = await db
    .prepare(
      `UPDATE auth_challenges SET attempts = attempts + 1
       WHERE id = ? AND status = 'pending' AND attempts < ? AND expires_at > ?
       RETURNING attempts`,
    )
    .bind(id, maxAttempts, now)
    .first<{ attempts: number }>();
  return row?.attempts ?? null;
}

/** pending → completed exactly once. */
export async function completeChallenge(db: D1Database, id: string) {
  const result = await db
    .prepare(
      `UPDATE auth_challenges SET status = 'completed', email_code_hash = NULL,
         pending_totp_secret_enc = NULL
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(id)
    .run();
  return result.meta.changes === 1;
}

/** pending → cancelled (also kills the email code). True if this call cancelled it. */
export async function cancelChallenge(db: D1Database, id: string) {
  const result = await db
    .prepare(
      `UPDATE auth_challenges SET status = 'cancelled', email_code_hash = NULL,
         pending_totp_secret_enc = NULL
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(id)
    .run();
  return result.meta.changes === 1;
}

export async function setChallengeEmailCode(
  db: D1Database,
  id: string,
  codeHash: string,
  expiresAt: number,
) {
  await db
    .prepare(
      `UPDATE auth_challenges SET email_code_hash = ?, email_code_expires_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .bind(codeHash, expiresAt, id)
    .run();
}

export async function setChallengePendingTotp(db: D1Database, id: string, secretEnc: string) {
  await db
    .prepare(
      `UPDATE auth_challenges SET pending_totp_secret_enc = ? WHERE id = ? AND status = 'pending'`,
    )
    .bind(secretEnc, id)
    .run();
}

// --- single-use email tokens ----------------------------------------------------

export type TokenPurpose = 'magic_link' | 'password_reset' | 'email_change';

export async function insertToken(
  db: D1Database,
  input: {
    hash: string;
    purpose: TokenPurpose;
    userId: string;
    email: string | null;
    now: number;
    expiresAt: number;
  },
) {
  // A new token of the same purpose invalidates the previous ones.
  await db.batch([
    db
      .prepare(
        `UPDATE auth_tokens SET invalidated_at = ?
         WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND invalidated_at IS NULL`,
      )
      .bind(input.now, input.userId, input.purpose),
    db
      .prepare(
        `INSERT INTO auth_tokens (id, purpose, user_id, email, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.hash, input.purpose, input.userId, input.email, input.now, input.expiresAt),
  ]);
}

/** Atomically consumes a token: valid, unexpired, unused, not invalidated. */
export async function consumeToken(
  db: D1Database,
  hash: string,
  purpose: TokenPurpose,
  now: number,
): Promise<{ userId: string; email: string | null } | null> {
  const row = await db
    .prepare(
      `UPDATE auth_tokens SET used_at = ?
       WHERE id = ? AND purpose = ? AND used_at IS NULL AND invalidated_at IS NULL
         AND expires_at > ?
       RETURNING user_id, email`,
    )
    .bind(now, hash, purpose, now)
    .first<{ user_id: string; email: string | null }>();
  return row === null ? null : { userId: row.user_id, email: row.email };
}

export async function invalidateTokens(db: D1Database, userId: string, purpose: TokenPurpose, now: number) {
  await db
    .prepare(
      `UPDATE auth_tokens SET invalidated_at = ?
       WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND invalidated_at IS NULL`,
    )
    .bind(now, userId, purpose)
    .run();
}

// --- recovery codes ----------------------------------------------------------------

export async function replaceRecoveryCodes(
  db: D1Database,
  userId: string,
  hashes: readonly string[],
  now: number,
) {
  await db.batch([
    db.prepare(`DELETE FROM recovery_codes WHERE user_id = ?`).bind(userId),
    ...hashes.map((hash) =>
      db
        .prepare(
          `INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(ulid(now), userId, hash, now),
    ),
  ]);
}

export async function consumeRecoveryCode(db: D1Database, userId: string, hash: string, now: number) {
  const result = await db
    .prepare(
      `UPDATE recovery_codes SET used_at = ?
       WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
    )
    .bind(now, userId, hash)
    .run();
  return result.meta.changes === 1;
}

export async function countRecoveryCodes(db: D1Database, userId: string) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- known devices -----------------------------------------------------------------

/** Records a device; true when it was never seen for this user. */
export async function rememberDevice(db: D1Database, userId: string, deviceKey: string, now: number) {
  const row = await db
    .prepare(
      `INSERT INTO known_devices (user_id, device_key, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, device_key) DO UPDATE SET last_seen_at = excluded.last_seen_at
       RETURNING first_seen_at`,
    )
    .bind(userId, deviceKey, now, now)
    .first<{ first_seen_at: number }>();
  return row?.first_seen_at === now;
}

export async function countKnownDevices(db: D1Database, userId: string) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM known_devices WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// --- tenants & memberships -----------------------------------------------------------

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
}

export interface MembershipRow {
  tenantId: string;
  slug: string;
  name: string;
  role: Role;
}

/** By current slug or by a former one (renamed workspace); the row always carries the current slug. */
export async function findTenantBySlug(db: D1Database, slug: string) {
  return db
    .prepare(
      `SELECT id, slug, name FROM tenants WHERE slug = ?
       UNION ALL
       SELECT t.id, t.slug, t.name FROM tenant_slug_aliases a JOIN tenants t ON t.id = a.tenant_id WHERE a.slug = ?
       LIMIT 1`,
    )
    .bind(slug, slug)
    .first<TenantRow>();
}

export async function findTenantById(db: D1Database, id: string) {
  return db.prepare(`SELECT id, slug, name FROM tenants WHERE id = ?`).bind(id).first<TenantRow>();
}

export async function findMembership(db: D1Database, userId: string, tenantId: string) {
  const row = await db
    .prepare(`SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?`)
    .bind(userId, tenantId)
    .first<{ role: string }>();
  return row !== null && isRole(row.role) ? row.role : null;
}

export async function listMemberships(db: D1Database, userId: string): Promise<MembershipRow[]> {
  const result = await db
    .prepare(
      `SELECT t.id AS tenant_id, t.slug, t.name, m.role FROM memberships m
       JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? ORDER BY t.name`,
    )
    .bind(userId)
    .all<{ tenant_id: string; slug: string; name: string; role: string }>();
  return result.results.flatMap((r) =>
    isRole(r.role) ? [{ tenantId: r.tenant_id, slug: r.slug, name: r.name, role: r.role }] : [],
  );
}

export interface MemberRow {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  createdAt: number;
}

export async function listMembers(db: D1Database, tenantId: string): Promise<MemberRow[]> {
  const result = await db
    .prepare(
      `SELECT u.id, u.email, u.name, m.role, m.created_at FROM memberships m
       JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? ORDER BY u.email`,
    )
    .bind(tenantId)
    .all<{ id: string; email: string; name: string | null; role: string; created_at: number }>();
  return result.results.flatMap((r) =>
    isRole(r.role)
      ? [{ userId: r.id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at }]
      : [],
  );
}

export async function countOwners(db: D1Database, tenantId: string) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ? AND role = 'owner'`)
    .bind(tenantId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function addMembership(
  db: D1Database,
  input: { userId: string; tenantId: string; role: Role; invitedBy: string | null; now: number },
) {
  await db
    .prepare(
      `INSERT INTO memberships (user_id, tenant_id, role, invited_by, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, tenant_id) DO NOTHING`,
    )
    .bind(input.userId, input.tenantId, input.role, input.invitedBy, input.now)
    .run();
}

/**
 * Role change that can never leave a tenant without an owner: the UPDATE only
 * applies when the target is not the last owner being demoted.
 */
export async function updateMembershipRole(
  db: D1Database,
  tenantId: string,
  userId: string,
  role: Role,
) {
  const result = await db
    .prepare(
      `UPDATE memberships SET role = ?1 WHERE tenant_id = ?2 AND user_id = ?3
         AND (role != 'owner' OR ?1 = 'owner'
              OR (SELECT COUNT(*) FROM memberships WHERE tenant_id = ?2 AND role = 'owner') > 1)`,
    )
    .bind(role, tenantId, userId)
    .run();
  return result.meta.changes === 1;
}

export async function removeMembership(db: D1Database, tenantId: string, userId: string) {
  const result = await db
    .prepare(
      `DELETE FROM memberships WHERE tenant_id = ?1 AND user_id = ?2
         AND (role != 'owner'
              OR (SELECT COUNT(*) FROM memberships WHERE tenant_id = ?1 AND role = 'owner') > 1)`,
    )
    .bind(tenantId, userId)
    .run();
  if (result.meta.changes === 1) {
    await db
      .prepare(`UPDATE users SET last_tenant_id = NULL WHERE id = ? AND last_tenant_id = ?`)
      .bind(userId, tenantId)
      .run();
  }
  return result.meta.changes === 1;
}

// --- invites ------------------------------------------------------------------------------

export interface InviteRow {
  id: string;
  tenantId: string;
  email: string;
  role: Role;
  invitedBy: string | null;
  locale: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
}

interface RawInvite {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  invited_by: string | null;
  locale: string;
  created_at: number;
  expires_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
}

function mapInvite(raw: RawInvite): InviteRow | null {
  if (!isRole(raw.role)) return null;
  return {
    id: raw.id,
    tenantId: raw.tenant_id,
    email: raw.email,
    role: raw.role,
    invitedBy: raw.invited_by,
    locale: raw.locale,
    createdAt: raw.created_at,
    expiresAt: raw.expires_at,
    acceptedAt: raw.accepted_at,
    revokedAt: raw.revoked_at,
  };
}

export async function insertInvite(
  db: D1Database,
  input: Omit<InviteRow, 'id' | 'acceptedAt' | 'revokedAt'> & { tokenHash: string },
) {
  const id = ulid(input.createdAt);
  await db.batch([
    // Re-inviting the same address replaces the pending invite.
    db
      .prepare(
        `UPDATE invites SET revoked_at = ? WHERE tenant_id = ? AND email = ?
           AND accepted_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(input.createdAt, input.tenantId, input.email),
    db
      .prepare(
        `INSERT INTO invites (id, tenant_id, email, role, token_hash, invited_by, locale,
           created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.tenantId,
        input.email,
        input.role,
        input.tokenHash,
        input.invitedBy,
        input.locale,
        input.createdAt,
        input.expiresAt,
      ),
  ]);
  return id;
}

export async function findInviteByTokenHash(db: D1Database, hash: string) {
  const raw = await db
    .prepare(`SELECT * FROM invites WHERE token_hash = ?`)
    .bind(hash)
    .first<RawInvite>();
  return raw === null ? null : mapInvite(raw);
}

export async function listPendingInvites(db: D1Database, tenantId: string, now: number) {
  const result = await db
    .prepare(
      `SELECT * FROM invites WHERE tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
         AND expires_at > ? ORDER BY created_at DESC`,
    )
    .bind(tenantId, now)
    .all<RawInvite>();
  return result.results.flatMap((r) => {
    const invite = mapInvite(r);
    return invite === null ? [] : [invite];
  });
}

/** Single use: pending → accepted exactly once. */
export async function acceptInvite(db: D1Database, id: string, now: number) {
  const result = await db
    .prepare(
      `UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL
         AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(now, id, now)
    .run();
  return result.meta.changes === 1;
}

export async function revokeInvite(db: D1Database, tenantId: string, id: string, now: number) {
  const result = await db
    .prepare(
      `UPDATE invites SET revoked_at = ? WHERE tenant_id = ? AND id = ?
         AND accepted_at IS NULL AND revoked_at IS NULL`,
    )
    .bind(now, tenantId, id)
    .run();
  return result.meta.changes === 1;
}

// --- API keys -------------------------------------------------------------------------------

export interface ApiKeyRow {
  id: string;
  tenantId: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

interface RawApiKey {
  id: string;
  tenant_id: string;
  name: string;
  prefix: string;
  scopes: string;
  created_by: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

function parseScopes(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function mapApiKey(raw: RawApiKey): ApiKeyRow {
  return {
    id: raw.id,
    tenantId: raw.tenant_id,
    name: raw.name,
    prefix: raw.prefix,
    scopes: parseScopes(raw.scopes),
    createdBy: raw.created_by,
    createdAt: raw.created_at,
    lastUsedAt: raw.last_used_at,
    revokedAt: raw.revoked_at,
  };
}

export async function insertApiKey(
  db: D1Database,
  input: {
    tenantId: string;
    name: string;
    prefix: string;
    hash: string;
    scopes: readonly string[];
    createdBy: string;
    now: number;
  },
) {
  const id = ulid(input.now);
  await db
    .prepare(
      `INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, scopes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.tenantId,
      input.name,
      input.prefix,
      input.hash,
      JSON.stringify(input.scopes),
      input.createdBy,
      input.now,
    )
    .run();
  return id;
}

export async function findApiKeyByHash(db: D1Database, hash: string) {
  const raw = await db
    .prepare(`SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`)
    .bind(hash)
    .first<RawApiKey>();
  return raw === null ? null : mapApiKey(raw);
}

export async function listApiKeys(db: D1Database, tenantId: string) {
  const result = await db
    .prepare(`SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC`)
    .bind(tenantId)
    .all<RawApiKey>();
  return result.results.map(mapApiKey);
}

export async function revokeApiKey(db: D1Database, tenantId: string, id: string, now: number) {
  const result = await db
    .prepare(
      `UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`,
    )
    .bind(now, tenantId, id)
    .run();
  return result.meta.changes === 1;
}

export async function touchApiKey(db: D1Database, id: string, now: number) {
  await db
    .prepare(
      `UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
    )
    .bind(now, id, now - 60_000)
    .run();
}

// --- audit ----------------------------------------------------------------------------------

export interface AuditEntry {
  tenantId: string | null;
  actorUserId: string | null;
  actorType: 'user' | 'api_key' | 'system' | 'support';
  action: string;
  target: string | null;
  details: Record<string, string | number | boolean | null> | null;
  ip: string | null;
  now: number;
}

export async function insertAudit(db: D1Database, entry: AuditEntry) {
  await db
    .prepare(
      `INSERT INTO audit_log (id, tenant_id, actor_user_id, actor_type, action, target, details,
         ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      ulid(entry.now),
      entry.tenantId,
      entry.actorUserId,
      entry.actorType,
      entry.action,
      entry.target,
      entry.details === null ? null : JSON.stringify(entry.details),
      entry.ip,
      entry.now,
    )
    .run();
}

export async function listAudit(
  db: D1Database,
  tenantId: string,
  input: { before: number | null; limit: number },
) {
  const result = await db
    .prepare(
      `SELECT id, actor_user_id, actor_type, action, target, details, ip, created_at
       FROM audit_log WHERE tenant_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(tenantId, input.before ?? Number.MAX_SAFE_INTEGER, input.limit)
    .all<{
      id: string;
      actor_user_id: string | null;
      actor_type: string | null;
      action: string;
      target: string | null;
      details: string | null;
      ip: string | null;
      created_at: number;
    }>();
  return result.results.map((r) => ({
    id: r.id,
    actorUserId: r.actor_user_id,
    actorType: r.actor_type,
    action: r.action,
    target: r.target,
    details: r.details,
    ip: r.ip,
    createdAt: r.created_at,
  }));
}

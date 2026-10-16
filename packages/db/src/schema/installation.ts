import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Drizzle schema for the installation D1 database.
 * Must stay in sync with packages/db/src/migrations/installation/ —
 * migrations are the source of truth, this schema is the typed query layer.
 */

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  /** UI + system email language, 'en' (default) or 'it'. */
  locale: text('locale').notNull().default('en'),
  /** 'light' | 'dark' | 'system'. */
  theme: text('theme').notNull().default('system'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  // 0003_auth
  /** Argon2id (or PBKDF2 fallback) hash, peppered; NULL for magic-link-only accounts. */
  passwordHash: text('password_hash'),
  passwordChangedAt: integer('password_changed_at'),
  emailVerifiedAt: integer('email_verified_at'),
  /** 'totp' | 'email' | NULL (enrollment pending — mandatory at next login). */
  mfaMethod: text('mfa_method'),
  mfaEnrolledAt: integer('mfa_enrolled_at'),
  /** AES-GCM ciphertext of the TOTP seed. */
  totpSecretEnc: text('totp_secret_enc'),
  totpLastStep: integer('totp_last_step'),
  failedChallenges: integer('failed_challenges').notNull().default(0),
  lockCount: integer('lock_count').notNull().default(0),
  lockedUntil: integer('locked_until'),
  disabledAt: integer('disabled_at'),
  lastTenantId: text('last_tenant_id'),
});

export const sessions = sqliteTable('sessions', {
  /** Hash of the opaque session token — never the token itself. */
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  /** Inactivity expiry (7 days, refreshed on use). */
  expiresAt: integer('expires_at').notNull(),
  /** Absolute expiry (30 days from login). */
  absoluteExpiresAt: integer('absolute_expires_at').notNull(),
  // 0003_auth
  /** Exposed in the device list instead of the hash. */
  publicId: text('public_id').unique(),
  userAgent: text('user_agent'),
  deviceLabel: text('device_label'),
  ip: text('ip'),
  country: text('country'),
  mfaMethod: text('mfa_method'),
  stepUpAt: integer('step_up_at'),
});

/** Second-factor challenges (login, step-up, 2FA change). Id = hash of the challenge cookie. */
export const authChallenges = sqliteTable('auth_challenges', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  firstFactor: text('first_factor').notNull(),
  sessionPublicId: text('session_public_id'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  emailCodeHash: text('email_code_hash'),
  emailCodeExpiresAt: integer('email_code_expires_at'),
  pendingTotpSecretEnc: text('pending_totp_secret_enc'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

/** Single-use email tokens: magic link, password reset, email change. Id = SHA-256 of the token. */
export const authTokens = sqliteTable('auth_tokens', {
  id: text('id').primaryKey(),
  purpose: text('purpose').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  email: text('email'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  invalidatedAt: integer('invalidated_at'),
});

export const recoveryCodes = sqliteTable('recovery_codes', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  createdAt: integer('created_at').notNull(),
  usedAt: integer('used_at'),
});

export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  invitedBy: text('invited_by'),
  locale: text('locale').notNull().default('en'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  acceptedAt: integer('accepted_at'),
  revokedAt: integer('revoked_at'),
});

export const knownDevices = sqliteTable(
  'known_devices',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceKey: text('device_key').notNull(),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.deviceKey] })],
);

export const rateLimits = sqliteTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Former slugs of renamed tenants, still resolved by public links and the API. */
export const tenantSlugAliases = sqliteTable('tenant_slug_aliases', {
  slug: text('slug').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
});

export const memberships = sqliteTable(
  'memberships',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** One of the fixed roles defined in @amable/core. */
    role: text('role').notNull(),
    invitedBy: text('invited_by'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.tenantId] })],
);

export const domains = sqliteTable('domains', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  hostname: text('hostname').notNull().unique(),
  /** 'app' | 'tracking' | 'sending'. */
  kind: text('kind').notNull(),
  /** 'pending' | 'verified'. */
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** Visible key prefix, e.g. "amb_live_x3…" — the full key is only shown once. */
  prefix: text('prefix').notNull(),
  keyHash: text('key_hash').notNull(),
  /** JSON array of permission strings, never broader than the creator's role. */
  scopes: text('scopes').notNull().default('[]'),
  createdBy: text('created_by'),
  createdAt: integer('created_at').notNull(),
  revokedAt: integer('revoked_at'),
  lastUsedAt: integer('last_used_at'),
});

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  /** NULL for platform-level events. */
  tenantId: text('tenant_id'),
  actorUserId: text('actor_user_id'),
  action: text('action').notNull(),
  target: text('target'),
  /** JSON payload — never secrets or full personal data. */
  details: text('details'),
  createdAt: integer('created_at').notNull(),
  /** 'user' | 'api_key' | 'system' | 'support'. */
  actorType: text('actor_type'),
  ip: text('ip'),
});

export const installationMeta = sqliteTable('installation_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

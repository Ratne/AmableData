import type { Migration } from '../types';

/**
 * Access & security: password + 2FA state on users, richer sessions (device
 * list, step-up), last opened tenant, second-factor challenges, single-use email
 * tokens (magic link, password reset, email change), recovery codes, tenant
 * invites, known devices, D1 rate-limit counters, API key / audit extras.
 *
 * Every secret-bearing column stores a hash (SHA-256 / HMAC) or an AES-GCM
 * ciphertext — never the raw token, code or TOTP secret.
 */
export const m0003Auth: Migration = {
  id: 3,
  name: 'auth',
  statements: [
    // users: credentials, 2FA and lockout counters.
    `ALTER TABLE users ADD COLUMN password_hash TEXT`,
    `ALTER TABLE users ADD COLUMN password_changed_at INTEGER`,
    `ALTER TABLE users ADD COLUMN email_verified_at INTEGER`,
    // 'totp' | 'email' | NULL (not enrolled yet: enrollment is mandatory at next login).
    `ALTER TABLE users ADD COLUMN mfa_method TEXT`,
    `ALTER TABLE users ADD COLUMN mfa_enrolled_at INTEGER`,
    `ALTER TABLE users ADD COLUMN totp_secret_enc TEXT`,
    `ALTER TABLE users ADD COLUMN totp_last_step INTEGER`,
    `ALTER TABLE users ADD COLUMN failed_challenges INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN lock_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN locked_until INTEGER`,
    `ALTER TABLE users ADD COLUMN disabled_at INTEGER`,
    // Tenant switcher: the last tenant opened, restored at the next sign-in.
    `ALTER TABLE users ADD COLUMN last_tenant_id TEXT`,

    // sessions: id stays the token hash; public_id is what the device list exposes.
    `ALTER TABLE sessions ADD COLUMN public_id TEXT`,
    `ALTER TABLE sessions ADD COLUMN user_agent TEXT`,
    `ALTER TABLE sessions ADD COLUMN device_label TEXT`,
    `ALTER TABLE sessions ADD COLUMN ip TEXT`,
    `ALTER TABLE sessions ADD COLUMN country TEXT`,
    `ALTER TABLE sessions ADD COLUMN mfa_method TEXT`,
    `ALTER TABLE sessions ADD COLUMN step_up_at INTEGER`,
    `CREATE UNIQUE INDEX idx_sessions_public_id ON sessions(public_id)`,

    `CREATE TABLE auth_challenges (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      first_factor TEXT NOT NULL,
      session_public_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      email_code_hash TEXT,
      email_code_expires_at INTEGER,
      pending_totp_secret_enc TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE INDEX idx_auth_challenges_user ON auth_challenges(user_id, status)`,

    `CREATE TABLE auth_tokens (
      id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      invalidated_at INTEGER
    )`,
    `CREATE INDEX idx_auth_tokens_user_purpose ON auth_tokens(user_id, purpose)`,

    `CREATE TABLE recovery_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      used_at INTEGER,
      UNIQUE (user_id, code_hash)
    )`,

    `CREATE TABLE invites (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      invited_by TEXT,
      locale TEXT NOT NULL DEFAULT 'en',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      accepted_at INTEGER,
      revoked_at INTEGER
    )`,
    `CREATE INDEX idx_invites_tenant ON invites(tenant_id, created_at)`,

    `CREATE TABLE known_devices (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_key TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, device_key)
    )`,

    // Fixed-window counters (exact per-account limits + local fallback for the binding).
    `CREATE TABLE rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE INDEX idx_rate_limits_expires ON rate_limits(expires_at)`,

    `ALTER TABLE api_keys ADD COLUMN last_used_at INTEGER`,
    `CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys(key_hash)`,

    // 'user' | 'api_key' | 'system' | 'support'.
    `ALTER TABLE audit_log ADD COLUMN actor_type TEXT`,
    `ALTER TABLE audit_log ADD COLUMN ip TEXT`,
    `CREATE INDEX idx_audit_log_actor ON audit_log(actor_user_id, created_at)`,
  ],
};

import type { Migration } from '../types';

/**
 * Installation-level D1 schema: global users, sessions, tenants, memberships,
 * domains, API keys, audit log and installation metadata.
 *
 * Column conventions: TEXT ULID primary keys, epoch-milliseconds INTEGER timestamps.
 */
export const m0001Init: Migration = {
  id: 1,
  name: 'init',
  statements: [
    `CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      locale TEXT NOT NULL DEFAULT 'en',
      theme TEXT NOT NULL DEFAULT 'system',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      absolute_expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE memberships (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      invited_by TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, tenant_id)
    )`,
    `CREATE TABLE domains (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      hostname TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    )`,
    `CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      target TEXT,
      details TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE installation_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ],
};

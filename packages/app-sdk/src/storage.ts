import { kvInstallStore, type InstallStore, type KeyValue } from './handler';
import { generateAppKey, type PrivateJwk } from './keys';

/**
 * Storage of an app that lives in the workspace's own Cloudflare account with
 * a single D1 database: installs, signing keys and small key-value data. D1 is
 * strongly consistent, which refresh tokens (rotated on every use) and keys
 * created once per deploy need; Workers KV can serve a stale value for a minute.
 */

/** The D1 subset the SDK uses (Cloudflare `D1Database`, or a test double). */
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
}

/** Key-value data with an optional time to live, as Workers KV `put` takes it. */
export interface ExpiringKeyValue extends KeyValue {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS amable_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS amable_kv_expires ON amable_kv (expires_at) WHERE expires_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS amable_app_keys (id INTEGER PRIMARY KEY CHECK (id = 1), keys TEXT NOT NULL, created_at INTEGER NOT NULL)`,
];

const ready = new WeakMap<SqlDatabase, Promise<void>>();
const SWEEP_RATE = 0.02;

/** Creates the SDK tables once per isolate (idempotent statements). */
export function ensureSdkTables(db: SqlDatabase): Promise<void> {
  let done = ready.get(db);
  if (done === undefined) {
    done = (async () => {
      for (const sql of SCHEMA) await db.prepare(sql).run();
    })();
    done.catch(() => ready.delete(db));
    ready.set(db, done);
  }
  return done;
}

export function d1KeyValue(db: SqlDatabase, now: () => number = Date.now): ExpiringKeyValue {
  return {
    async get(key) {
      await ensureSdkTables(db);
      const row = await db
        .prepare('SELECT value, expires_at FROM amable_kv WHERE key = ?')
        .bind(key)
        .first<{ value: string; expires_at: number | null }>();
      if (row === null) return null;
      if (row.expires_at !== null && row.expires_at <= now()) {
        await db.prepare('DELETE FROM amable_kv WHERE key = ? AND expires_at <= ?').bind(key, now()).run();
        return null;
      }
      return row.value;
    },
    async put(key, value, options) {
      await ensureSdkTables(db);
      const ttl = options?.expirationTtl;
      const expiresAt = ttl === undefined ? null : now() + ttl * 1000;
      await db
        .prepare(
          'INSERT INTO amable_kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
        )
        .bind(key, value, expiresAt)
        .run();
      // Apps without a cron still drop what expired, a few writes at a time.
      if (ttl !== undefined && Math.random() < SWEEP_RATE) await purgeExpiredKeyValues(db, now());
    },
    async delete(key) {
      await ensureSdkTables(db);
      await db.prepare('DELETE FROM amable_kv WHERE key = ?').bind(key).run();
    },
  };
}

/** Removes expired key-value rows (`put` also does it now and then). */
export async function purgeExpiredKeyValues(db: SqlDatabase, now: number = Date.now()): Promise<void> {
  await ensureSdkTables(db);
  await db.prepare('DELETE FROM amable_kv WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now).run();
}

export function d1InstallStore(db: SqlDatabase): InstallStore {
  return kvInstallStore(d1KeyValue(db));
}

/**
 * The app's signing keys (its identity at `jwks_url`), created on first use in
 * its database: a deploy needs no secret. The insert is atomic, so isolates
 * starting together on a fresh database all end up with the same keys.
 */
export async function storedAppKeys(db: SqlDatabase, options: { kid?: string; now?: number } = {}): Promise<PrivateJwk[]> {
  await ensureSdkTables(db);
  const read = () => db.prepare('SELECT keys FROM amable_app_keys WHERE id = 1').first<{ keys: string }>();
  let row = await read();
  if (row === null) {
    await db
      .prepare('INSERT OR IGNORE INTO amable_app_keys (id, keys, created_at) VALUES (1, ?, ?)')
      .bind(JSON.stringify([await generateAppKey(options.kid)]), options.now ?? Date.now())
      .run();
    row = await read();
  }
  if (row === null) throw new Error('signing keys not stored');
  return JSON.parse(row.keys) as PrivateJwk[];
}

/**
 * Keys of a Worker: `APP_KEYS` when the environment has them (apps hosted by
 * their developer), otherwise the ones kept in its database. Cached per
 * database; a failed read is retried at the next request.
 */
export function appKeysLoader(options: { kid?: string } = {}) {
  const cache = new WeakMap<SqlDatabase, Promise<PrivateJwk[]>>();
  return (env: { APP_KEYS?: string | undefined; DB: SqlDatabase }): Promise<PrivateJwk[]> => {
    if (env.APP_KEYS !== undefined && env.APP_KEYS.trim() !== '') return Promise.resolve(JSON.parse(env.APP_KEYS) as PrivateJwk[]);
    let keys = cache.get(env.DB);
    if (keys === undefined) {
      keys = storedAppKeys(env.DB, options);
      keys.catch(() => cache.delete(env.DB));
      cache.set(env.DB, keys);
    }
    return keys;
  };
}

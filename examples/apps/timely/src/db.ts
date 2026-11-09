/**
 * The D1 subset Timely uses, so tests can run the same SQL on node:sqlite.
 * Every row carries the installation id: an install never reads another's.
 */

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface SqlDb {
  prepare(sql: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<unknown[]>;
}

/** Rows per statement of a chunked write: each one stays far below the D1 30 s query cap. */
export const CHUNK_ROWS = 5000;

/**
 * Runs `statement` (a DELETE / UPDATE limited to CHUNK_ROWS rows that no longer
 * match once written) until it touches fewer rows, at most `maxRounds` times.
 * Returns the rows touched.
 */
export async function inChunks(statement: () => SqlStatement, maxRounds = 200): Promise<number> {
  let total = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const changes = (await statement().run()).meta.changes;
    total += changes;
    if (changes < CHUNK_ROWS) break;
  }
  return total;
}

export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    install_id TEXT NOT NULL,
    public_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    mode TEXT NOT NULL,
    duration_minutes INTEGER,
    fixed_end_at INTEGER,
    hard_end_at INTEGER,
    start_on TEXT NOT NULL,
    expiry TEXT NOT NULL,
    style TEXT NOT NULL,
    style_version INTEGER NOT NULL DEFAULT 1,
    offer_url TEXT,
    expired_url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS campaigns_install ON campaigns (install_id, deleted_at)',
  `CREATE TABLE IF NOT EXISTS deadlines (
    id TEXT PRIMARY KEY,
    install_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    contact_id TEXT,
    started_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    started_fired INTEGER NOT NULL DEFAULT 0,
    expired_fired INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE (campaign_id, subject)
  )`,
  'CREATE INDEX IF NOT EXISTS deadlines_due ON deadlines (expired_fired, deadline_at) WHERE contact_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS deadlines_unannounced ON deadlines (started_fired) WHERE contact_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS deadlines_contact ON deadlines (install_id, contact_id)',
  'CREATE INDEX IF NOT EXISTS deadlines_anon_expired ON deadlines (deadline_at) WHERE contact_id IS NULL',
  `CREATE TABLE IF NOT EXISTS action_runs (
    install_id TEXT NOT NULL,
    key TEXT NOT NULL,
    output TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (install_id, key)
  )`,
];

const ready = new WeakSet<SqlDb>();

/** Creates the tables once per isolate (idempotent statements). */
export async function ensureSchema(db: SqlDb): Promise<void> {
  if (ready.has(db)) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  ready.add(db);
}

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Random id from an unambiguous alphabet; 16 chars ≈ 80 bits. */
export function randomId(length = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => ALPHABET[b % 32]).join('');
}

/**
 * The D1 subset Quizly uses, so tests can run the same SQL on node:sqlite.
 * Every row carries the installation id: an install never reads another's.
 * Quizly stores no email: a session knows its contact only by CRM id.
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

export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS quizzes (
    id TEXT PRIMARY KEY,
    install_id TEXT NOT NULL,
    public_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    definition TEXT NOT NULL,
    form_ids TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS quizzes_install ON quizzes (install_id, deleted_at)',
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    install_id TEXT NOT NULL,
    quiz_id TEXT NOT NULL,
    preview INTEGER NOT NULL DEFAULT 0,
    contact_id TEXT,
    submission_id TEXT,
    score INTEGER,
    max_score INTEGER,
    result_label TEXT,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER,
    synced_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS sessions_quiz ON sessions (install_id, quiz_id, started_at)',
  'CREATE INDEX IF NOT EXISTS sessions_submission ON sessions (install_id, submission_id) WHERE submission_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS sessions_contact ON sessions (install_id, contact_id) WHERE contact_id IS NOT NULL',
  `CREATE TABLE IF NOT EXISTS session_answers (
    session_id TEXT NOT NULL,
    install_id TEXT NOT NULL,
    quiz_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    answer_id TEXT,
    value_text TEXT,
    tagged INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, step_id)
  )`,
  'CREATE INDEX IF NOT EXISTS answers_quiz ON session_answers (install_id, quiz_id, step_id)',
  `CREATE TABLE IF NOT EXISTS pending_links (
    install_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (install_id, submission_id)
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

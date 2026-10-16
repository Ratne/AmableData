import type { CrmContext } from './context';

/** Keys expire after 24 hours. */
const TTL_MS = 24 * 60 * 60 * 1000;
/** A started request that never completed (crash) frees its key after 60 s. */
const STALE_IN_PROGRESS_MS = 60 * 1000;

export type IdempotencyBegin =
  | { state: 'new' }
  | { state: 'replay'; status: number; body: string }
  | { state: 'in_progress' }
  | { state: 'mismatch' };

/**
 * Reserves an idempotency key for a request. Atomic because the DO is
 * single-threaded: two concurrent requests with the same key cannot both see
 * `new`. The key is scoped by the caller (the route prefixes it with the actor).
 */
export function idempotencyBegin(
  ctx: CrmContext,
  input: { key: string; requestHash: string },
): IdempotencyBegin {
  const now = ctx.now();
  ctx.db.run(`DELETE FROM crm_idempotency_keys WHERE created_at < ?`, now - TTL_MS);
  const row = ctx.db.all<{
    request_hash: string;
    status: number | null;
    response: string | null;
    created_at: number;
  }>(
    `SELECT request_hash, status, response, created_at FROM crm_idempotency_keys WHERE key = ?`,
    input.key,
  )[0];
  if (row === undefined) {
    ctx.db.run(
      `INSERT INTO crm_idempotency_keys (key, request_hash, created_at) VALUES (?, ?, ?)`,
      input.key,
      input.requestHash,
      now,
    );
    return { state: 'new' };
  }
  if (row.request_hash !== input.requestHash) return { state: 'mismatch' };
  if (row.status === null) {
    if (now - row.created_at > STALE_IN_PROGRESS_MS) {
      ctx.db.run(`UPDATE crm_idempotency_keys SET created_at = ? WHERE key = ?`, now, input.key);
      return { state: 'new' };
    }
    return { state: 'in_progress' };
  }
  return { state: 'replay', status: row.status, body: row.response ?? '' };
}

export function idempotencyComplete(
  ctx: CrmContext,
  input: { key: string; status: number; body: string },
): { stored: true } {
  ctx.db.run(
    `UPDATE crm_idempotency_keys SET status = ?, response = ? WHERE key = ?`,
    input.status,
    input.body,
    input.key,
  );
  return { stored: true };
}

/** Releases a key after a server error so the client can retry. */
export function idempotencyAbort(ctx: CrmContext, input: { key: string }): { released: true } {
  ctx.db.run(`DELETE FROM crm_idempotency_keys WHERE key = ? AND status IS NULL`, input.key);
  return { released: true };
}

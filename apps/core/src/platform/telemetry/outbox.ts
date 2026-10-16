import type { ErrorBatchRequest, ErrorEvent } from '@amable/core/platform';
import { monotonicFactory } from 'ulid';
import type { Env } from '../../env';
import { controlPlaneClient, ControlPlaneError, type FetchFn } from '../client';
import { reportingKnobs, resolveErrorSink, type ErrorSink } from './config';

/**
 * Local error outbox (`platform_error_outbox`): events are written first and
 * delivered in batches, so nothing is lost while the sink is unreachable.
 * Bounded in rows, event size, request size and attempts.
 */

export const MAX_OUTBOX_ROWS = 1_000;
export const MAX_ATTEMPTS = 12;
const MAX_EVENT_BYTES = 16_000;
const MAX_BODY_BYTES = 256_000;
const MAX_ROUNDS = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 6 * 3_600_000;

// Monotonic: rows written in the same millisecond keep their order (delivery is ordered by id).
const outboxId = monotonicFactory();

let sinkFetchOverride: FetchFn | null = null;

/** Test hook for the custom-URL sink (the control plane sink uses `overrideControlPlaneFetch`). */
export function overrideErrorSinkFetch(next: FetchFn | null): void {
  sinkFetchOverride = next;
}

/** Delay before the next attempt after `attempts` failed ones (30 s, 1 min, 2 min, … ≤ 6 h). */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

function shrink(event: ErrorEvent): ErrorEvent {
  if (JSON.stringify(event).length <= MAX_EVENT_BYTES) return event;
  return {
    ...event,
    message: event.message.slice(0, 300),
    frames: event.frames.slice(0, 15),
    breadcrumbs: event.breadcrumbs.slice(-10),
  };
}

export async function enqueueErrorEvent(env: Env, event: ErrorEvent, fingerprint: string, nowMs: number): Promise<void> {
  const payload = JSON.stringify(shrink(event));
  await env.DB.prepare(
    `INSERT INTO platform_error_outbox (id, fingerprint, payload, attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  )
    .bind(outboxId(nowMs), fingerprint.slice(0, 500), payload, nowMs, nowMs)
    .run();
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM platform_error_outbox`).first<{ n: number }>();
  const excess = (count?.n ?? 0) - MAX_OUTBOX_ROWS;
  if (excess > 0) {
    await env.DB.prepare(
      `DELETE FROM platform_error_outbox WHERE id IN
         (SELECT id FROM platform_error_outbox ORDER BY created_at ASC, id ASC LIMIT ?)`,
    )
      .bind(excess)
      .run();
  }
}

/** Events waiting in the outbox (heartbeat `pendingErrors`). */
export async function pendingErrorCount(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM platform_error_outbox`).first<{ n: number }>();
  return row?.n ?? 0;
}

type Delivery = 'ok' | 'retry' | 'rejected';

function classify(status: number): Delivery {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 0 || status >= 500 || status === 408 || status === 429) return 'retry';
  // Authentication / suspension may be fixed later; malformed batches never will.
  if (status === 401 || status === 402 || status === 403) return 'retry';
  return 'rejected';
}

async function deliver(env: Env, sink: Exclude<ErrorSink, { kind: 'local' }>, body: ErrorBatchRequest): Promise<Delivery> {
  if (sink.kind === 'control_plane') {
    const client = controlPlaneClient(env);
    if (client === null) return 'retry';
    try {
      await client.post('/errors', body);
      return 'ok';
    } catch (error) {
      return classify(error instanceof ControlPlaneError ? error.status : 0);
    }
  }
  const doFetch: FetchFn = sinkFetchOverride ?? ((input, init) => fetch(input, init));
  try {
    const res = await doFetch(sink.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return classify(res.status);
  } catch {
    return 'retry';
  }
}

interface OutboxRow {
  id: string;
  payload: string;
  attempts: number;
}

/** Delivers buffered error events to the configured sink (retry with backoff). */
export async function flushErrorOutbox(env: Env, nowMs: number): Promise<void> {
  const sink = resolveErrorSink(env);
  if (sink.kind === 'local') return;
  const { maxBatch } = await reportingKnobs(env, nowMs);
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const rows = (
      await env.DB.prepare(
        `SELECT id, payload, attempts FROM platform_error_outbox
          WHERE next_attempt_at <= ? ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
        .bind(nowMs, maxBatch)
        .all<OutboxRow>()
    ).results;
    if (rows.length === 0) return;

    const batch: OutboxRow[] = [];
    const events: ErrorEvent[] = [];
    const malformed: string[] = [];
    let bytes = 0;
    for (const row of rows) {
      let event: ErrorEvent;
      try {
        event = JSON.parse(row.payload) as ErrorEvent;
      } catch {
        malformed.push(row.id);
        continue;
      }
      if (events.length > 0 && bytes + row.payload.length > MAX_BODY_BYTES) break;
      bytes += row.payload.length;
      batch.push(row);
      events.push(event);
    }
    if (malformed.length > 0) await deleteRows(env, malformed);
    if (events.length === 0) continue;

    const outcome = await deliver(env, sink, { events });
    if (outcome === 'retry') {
      await scheduleRetry(env, batch, nowMs);
      return;
    }
    await deleteRows(
      env,
      batch.map((r) => r.id),
    );
    if (rows.length < maxBatch && batch.length === rows.length) return;
  }
}

async function deleteRows(env: Env, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await env.DB.batch(ids.map((id) => env.DB.prepare(`DELETE FROM platform_error_outbox WHERE id = ?`).bind(id)));
}

async function scheduleRetry(env: Env, rows: readonly OutboxRow[], nowMs: number): Promise<void> {
  const statements = rows.map((row) => {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) return env.DB.prepare(`DELETE FROM platform_error_outbox WHERE id = ?`).bind(row.id);
    return env.DB.prepare(`UPDATE platform_error_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?`).bind(
      attempts,
      nowMs + backoffMs(attempts),
      row.id,
    );
  });
  if (statements.length > 0) await env.DB.batch(statements);
}

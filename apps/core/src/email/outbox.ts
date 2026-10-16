import type {
  EmailEventPayloads,
  EmailEventType,
  EmailOutboxEvent,
  EventActor,
} from '@amable/core';
import { chunked, isoOf, parseJson, type MailDeps } from './context';

const SYSTEM: EventActor = { type: 'system', id: null };

/** Writes one email event in the MailDb outbox (same transaction as the change). */
export function emitEmailEvent<K extends EmailEventType>(
  deps: MailDeps,
  type: K,
  payload: EmailEventPayloads[K],
  actor: EventActor = SYSTEM,
): void {
  deps.db.run(
    `INSERT INTO mail_outbox (id, type, payload, actor_type, actor_id, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    deps.newId(),
    type,
    JSON.stringify(payload),
    actor.type,
    actor.id,
    deps.now(),
  );
}

interface OutboxRow {
  id: string;
  type: EmailEventType;
  payload: string;
  actor_type: EventActor['type'];
  actor_id: string | null;
  occurred_at: number;
}

/** Unacknowledged events in id order (at-least-once; consumers dedupe by id). */
export function pendingEmailEvents(
  deps: MailDeps,
  input: { limit?: number },
): EmailOutboxEvent[] {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = deps.db.all<OutboxRow>(
    `SELECT id, type, payload, actor_type, actor_id, occurred_at FROM mail_outbox
      WHERE acked_at IS NULL ORDER BY id LIMIT ?`,
    limit,
  );
  for (const ids of chunked(rows.map((r) => r.id))) {
    deps.db.run(
      `UPDATE mail_outbox SET attempts = attempts + 1 WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ...ids,
    );
  }
  return rows.map(
    (row) =>
      ({
        id: row.id,
        type: row.type,
        occurredAt: isoOf(row.occurred_at),
        actor: { type: row.actor_type, id: row.actor_id },
        payload: parseJson<Record<string, unknown>>(row.payload, {}),
      }) as unknown as EmailOutboxEvent,
  );
}

export function ackEmailEvents(deps: MailDeps, input: { ids: string[] }): { acked: number } {
  if (input.ids.length === 0) return { acked: 0 };
  const ids = input.ids.slice(0, 500);
  for (const chunk of chunked(ids)) {
    deps.db.run(
      `UPDATE mail_outbox SET acked_at = ? WHERE acked_at IS NULL AND id IN (${chunk.map(() => '?').join(', ')})`,
      deps.now(),
      ...chunk,
    );
  }
  return { acked: ids.length };
}

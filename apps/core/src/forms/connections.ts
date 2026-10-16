import type { ConnectorType, DeliveryStatus, FormConnection } from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import type { SqlValue } from '../crm/db/sql';
import { notFound } from '../crm/errors';
import { parseJson, toIso } from '../crm/util';
import { getFormRow } from './forms';
import type { ConnectionRow } from './submissions';

/**
 * Per-form connections. Configs arrive validated by the connector schema and
 * secrets arrive already encrypted by the worker (the DO never sees them in
 * clear); reads never return the ciphertext except to the processing worker.
 */

export function connectionRow(ctx: CrmContext, formId: string, id: string): ConnectionRow {
  const row = ctx.db.all<ConnectionRow>(
    `SELECT * FROM form_connections WHERE id = ? AND form_id = ? AND deleted_at IS NULL`,
    id,
    formId,
  )[0];
  if (row === undefined) throw notFound('connection', id);
  return row;
}

function lastDeliveries(
  ctx: CrmContext,
  ids: string[],
): Map<string, { status: DeliveryStatus; at: number }> {
  if (ids.length === 0) return new Map();
  const rows = ctx.db.all<{ connection_id: string; status: DeliveryStatus; updated_at: number }>(
    `SELECT connection_id, status, MAX(updated_at) AS updated_at FROM form_deliveries
     WHERE connection_id IN (${ids.map(() => '?').join(', ')}) GROUP BY connection_id`,
    ...ids,
  );
  return new Map(rows.map((r) => [r.connection_id, { status: r.status, at: r.updated_at }]));
}

export function serializeConnections(ctx: CrmContext, rows: ConnectionRow[]): FormConnection[] {
  const last = lastDeliveries(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.map((row) => {
    const delivery = last.get(row.id);
    return {
      id: row.id,
      form_id: row.form_id,
      type: row.type as ConnectorType,
      name: row.name,
      enabled: row.enabled === 1,
      config: parseJson<Record<string, unknown>>(row.config, {}),
      has_secret: row.secret_ciphertext !== null,
      secret_hint: row.secret_hint,
      last_delivery: delivery === undefined ? null : { status: delivery.status, at: toIso(delivery.at) },
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
    };
  });
}

export function listConnections(ctx: CrmContext, input: { formId: string }): FormConnection[] {
  getFormRow(ctx, input.formId);
  const rows = ctx.db.all<ConnectionRow>(
    `SELECT * FROM form_connections WHERE form_id = ? AND deleted_at IS NULL ORDER BY created_at, id`,
    input.formId,
  );
  return serializeConnections(ctx, rows);
}

export function getConnection(ctx: CrmContext, input: { formId: string; id: string }): FormConnection {
  const [connection] = serializeConnections(ctx, [connectionRow(ctx, input.formId, input.id)]);
  if (connection === undefined) throw notFound('connection', input.id);
  return connection;
}

/** Row with the encrypted secret, for the worker (test, rotate, processing). */
export function connectionForWorker(ctx: CrmContext, input: { formId: string; id: string }): ConnectionRow {
  return connectionRow(ctx, input.formId, input.id);
}

export interface CreateConnectionOpInput {
  id: string;
  formId: string;
  type: ConnectorType;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secretCiphertext: string | null;
  secretHint: string | null;
}

export function createConnection(ctx: CrmContext, input: CreateConnectionOpInput): FormConnection {
  getFormRow(ctx, input.formId);
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO form_connections
       (id, form_id, type, name, enabled, config, secret_ciphertext, secret_hint, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.formId,
    input.type,
    input.name,
    input.enabled ? 1 : 0,
    JSON.stringify(input.config),
    input.secretCiphertext,
    input.secretHint,
    ctx.actor.id,
    now,
    now,
  );
  return getConnection(ctx, { formId: input.formId, id: input.id });
}

export interface UpdateConnectionOpInput {
  formId: string;
  id: string;
  name?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  secretCiphertext?: string;
  secretHint?: string;
}

export function updateConnection(ctx: CrmContext, input: UpdateConnectionOpInput): FormConnection {
  const row = connectionRow(ctx, input.formId, input.id);
  const sets: string[] = [];
  const values: SqlValue[] = [];
  if (input.name !== undefined) {
    sets.push('name = ?');
    values.push(input.name);
  }
  if (input.enabled !== undefined) {
    sets.push('enabled = ?');
    values.push(input.enabled ? 1 : 0);
  }
  if (input.config !== undefined) {
    sets.push('config = ?');
    values.push(JSON.stringify(input.config));
  }
  if (input.secretCiphertext !== undefined) {
    sets.push('secret_ciphertext = ?', 'secret_hint = ?');
    values.push(input.secretCiphertext, input.secretHint ?? null);
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    values.push(ctx.now());
    ctx.db.run(`UPDATE form_connections SET ${sets.join(', ')} WHERE id = ?`, ...values, row.id);
  }
  return getConnection(ctx, { formId: input.formId, id: input.id });
}

export function deleteConnection(
  ctx: CrmContext,
  input: { formId: string; id: string },
): { id: string; deleted: true } {
  const row = connectionRow(ctx, input.formId, input.id);
  const now = ctx.now();
  ctx.db.run(
    `UPDATE form_connections SET deleted_at = ?, updated_at = ?, secret_ciphertext = NULL WHERE id = ?`,
    now,
    now,
    row.id,
  );
  return { id: row.id, deleted: true };
}

import type { TrafficSource, trafficSourceInputSchema } from '@amable/api-types';
import type { z } from 'zod';
import { first, type SqlDb } from '../db/sql';
import { newObjectId } from './config';

/**
 * Traffic sources of a site. Name, category and template are columns (listed
 * and filtered); fields, conversion config and modifiers live in `config`.
 * Archived sources keep resolving their links.
 */

export type TrafficSourceBody = z.output<typeof trafficSourceInputSchema>;
export type TrafficSourceStatus = TrafficSource['status'];

type StoredConfig = Omit<TrafficSourceBody, 'name' | 'category' | 'template'>;

interface TrafficSourceRow {
  id: string;
  name: string;
  category: string | null;
  template: TrafficSource['template'];
  status: TrafficSourceStatus;
  config: string;
  created_at: number;
  updated_at: number;
}

function toSource(row: TrafficSourceRow): TrafficSource {
  const config = JSON.parse(row.config) as StoredConfig;
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    template: row.template,
    ...config,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function configJson(body: TrafficSourceBody): string {
  const { name: _name, category: _category, template: _template, ...config } = body;
  return JSON.stringify(config);
}

export function getTrafficSource(db: SqlDb, id: string): TrafficSource | null {
  const row = first<TrafficSourceRow>(db, `SELECT * FROM traffic_sources WHERE id = ?`, id);
  return row === undefined ? null : toSource(row);
}

export function listTrafficSources(db: SqlDb, status?: TrafficSourceStatus): TrafficSource[] {
  const rows =
    status === undefined
      ? db.all<TrafficSourceRow>(`SELECT * FROM traffic_sources ORDER BY rowid`)
      : db.all<TrafficSourceRow>(
          `SELECT * FROM traffic_sources WHERE status = ? ORDER BY rowid`,
          status,
        );
  return rows.map(toSource);
}

export function createTrafficSource(
  db: SqlDb,
  body: TrafficSourceBody,
  now: number,
): TrafficSource {
  const id = newObjectId('ts');
  db.run(
    `INSERT INTO traffic_sources (id, name, category, template, status, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    id,
    body.name,
    body.category ?? null,
    body.template,
    configJson(body),
    now,
    now,
  );
  return getTrafficSource(db, id) as TrafficSource;
}

/** Full replace; a renamed custom field keeps its old name in `previous_name`. */
export function updateTrafficSource(
  db: SqlDb,
  id: string,
  body: TrafficSourceBody,
  now: number,
): TrafficSource | null {
  const current = getTrafficSource(db, id);
  if (current === null) return null;
  const before = new Map(current.fields.map((f) => [f.slot, f]));
  const fields = body.fields.map((f) => {
    const old = before.get(f.slot);
    if (old === undefined || old.name === f.name)
      return { ...f, previous_name: f.previous_name ?? old?.previous_name ?? null };
    return { ...f, previous_name: old.name };
  });
  db.run(
    `UPDATE traffic_sources SET name = ?, category = ?, template = ?, config = ?, updated_at = ? WHERE id = ?`,
    body.name,
    body.category ?? null,
    body.template,
    configJson({ ...body, fields }),
    now,
    id,
  );
  return getTrafficSource(db, id);
}

export function setTrafficSourceStatus(
  db: SqlDb,
  id: string,
  status: TrafficSourceStatus,
  now: number,
): TrafficSource | null {
  db.run(
    `UPDATE traffic_sources SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?`,
    status,
    status === 'archived' ? now : null,
    now,
    id,
  );
  return getTrafficSource(db, id);
}

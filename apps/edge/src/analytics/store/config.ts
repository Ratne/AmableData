import type {
  Alert,
  AnalyticsFilter,
  CreateAlertInput,
  CreateFunnelInput,
  CreateSegmentInput,
  Funnel,
  Segment,
  SiteKey,
  SiteKeyScope,
  UpdateAlertInput,
  UpdateFunnelInput,
  UpdateSegmentInput,
} from '@amable/api-types';
import { first, type SqlDb } from '../db/sql';
import { DAY_MS } from '../time';

/**
 * Saved objects of a site: funnels, segments, goal alerts, share links and
 * site API keys. Secrets never live here in clear except the alert webhook
 * signing secret (needed to sign deliveries); keys are SHA-256 hashes.
 */

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function newObjectId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += BASE32[b % 32];
  return `${prefix}_${out}`;
}

const iso = (ts: number | null): string | null => (ts === null ? null : new Date(ts).toISOString());

function parseArray<T>(raw: string): T[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

// -------------------------------------------------------------------- funnels

interface FunnelRow {
  id: string;
  name: string;
  steps: string;
  created_at: number;
  updated_at: number;
}

function toFunnel(row: FunnelRow): Funnel {
  return {
    id: row.id,
    name: row.name,
    steps: parseArray<Funnel['steps'][number]>(row.steps),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function normalizeSteps(steps: CreateFunnelInput['steps']): Funnel['steps'] {
  return steps.map((s) => ({
    type: s.type,
    value: s.value,
    match: s.type === 'goal' ? 'exact' : s.match,
    ...(s.label === undefined || s.label === '' ? {} : { label: s.label }),
  }));
}

export function listFunnels(db: SqlDb): Funnel[] {
  return db.all<FunnelRow>(`SELECT * FROM funnels ORDER BY created_at, id`).map(toFunnel);
}

export function getFunnel(db: SqlDb, id: string): Funnel | null {
  const row = first<FunnelRow>(db, `SELECT * FROM funnels WHERE id = ?`, id);
  return row === undefined ? null : toFunnel(row);
}

export function createFunnel(db: SqlDb, input: CreateFunnelInput, now: number): Funnel {
  const id = newObjectId('fn');
  db.run(
    `INSERT INTO funnels (id, name, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    input.name,
    JSON.stringify(normalizeSteps(input.steps)),
    now,
    now,
  );
  return getFunnel(db, id) as Funnel;
}

export function updateFunnel(db: SqlDb, id: string, patch: UpdateFunnelInput, now: number): Funnel | null {
  const current = getFunnel(db, id);
  if (current === null) return null;
  db.run(
    `UPDATE funnels SET name = ?, steps = ?, updated_at = ? WHERE id = ?`,
    patch.name ?? current.name,
    JSON.stringify(patch.steps === undefined ? current.steps : normalizeSteps(patch.steps)),
    now,
    id,
  );
  return getFunnel(db, id);
}

export function deleteFunnel(db: SqlDb, id: string): boolean {
  const existed = getFunnel(db, id) !== null;
  db.run(`DELETE FROM funnels WHERE id = ?`, id);
  return existed;
}

// ------------------------------------------------------------------- segments

interface SegmentRow {
  id: string;
  name: string;
  filters: string;
  created_at: number;
  updated_at: number;
}

function toSegment(row: SegmentRow): Segment {
  return {
    id: row.id,
    name: row.name,
    filters: parseArray<AnalyticsFilter>(row.filters),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export function listSegments(db: SqlDb): Segment[] {
  return db.all<SegmentRow>(`SELECT * FROM segments ORDER BY name, id`).map(toSegment);
}

function getSegment(db: SqlDb, id: string): Segment | null {
  const row = first<SegmentRow>(db, `SELECT * FROM segments WHERE id = ?`, id);
  return row === undefined ? null : toSegment(row);
}

export function createSegment(db: SqlDb, input: CreateSegmentInput, now: number): Segment {
  const id = newObjectId('sg');
  db.run(
    `INSERT INTO segments (id, name, filters, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    id,
    input.name,
    JSON.stringify(input.filters),
    now,
    now,
  );
  return getSegment(db, id) as Segment;
}

export function updateSegment(db: SqlDb, id: string, patch: UpdateSegmentInput, now: number): Segment | null {
  const current = getSegment(db, id);
  if (current === null) return null;
  db.run(
    `UPDATE segments SET name = ?, filters = ?, updated_at = ? WHERE id = ?`,
    patch.name ?? current.name,
    JSON.stringify(patch.filters ?? current.filters),
    now,
    id,
  );
  return getSegment(db, id);
}

export function deleteSegment(db: SqlDb, id: string): boolean {
  const existed = getSegment(db, id) !== null;
  db.run(`DELETE FROM segments WHERE id = ?`, id);
  return existed;
}

// --------------------------------------------------------------------- alerts

interface AlertRow {
  id: string;
  name: string;
  goal: string;
  enabled: number;
  email_recipients: string;
  webhook_url: string | null;
  webhook_secret: string | null;
  last_triggered_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface StoredAlert extends Alert {
  webhook_secret: string | null;
}

function toAlert(db: SqlDb, row: AlertRow, now: number): StoredAlert {
  const deliveries =
    first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM alert_deliveries WHERE alert_id = ? AND ts >= ?`,
      row.id,
      now - DAY_MS,
    )?.n ?? 0;
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    enabled: row.enabled === 1,
    email_recipients: parseArray<string>(row.email_recipients),
    webhook_url: row.webhook_url,
    webhook_secret: row.webhook_secret,
    last_triggered_at: iso(row.last_triggered_at),
    deliveries_24h: deliveries,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export function publicAlert(a: StoredAlert): Alert {
  const { webhook_secret: _secret, ...rest } = a;
  return rest;
}

export function listAlerts(db: SqlDb, now: number): StoredAlert[] {
  return db.all<AlertRow>(`SELECT * FROM alerts ORDER BY created_at, id`).map((r) => toAlert(db, r, now));
}

export function getAlert(db: SqlDb, id: string, now: number): StoredAlert | null {
  const row = first<AlertRow>(db, `SELECT * FROM alerts WHERE id = ?`, id);
  return row === undefined ? null : toAlert(db, row, now);
}

export function createAlert(
  db: SqlDb,
  input: CreateAlertInput,
  webhookSecret: string | null,
  now: number,
): StoredAlert {
  const id = newObjectId('al');
  db.run(
    `INSERT INTO alerts (id, name, goal, enabled, email_recipients, webhook_url, webhook_secret, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.goal,
    input.enabled ? 1 : 0,
    JSON.stringify([...new Set(input.email_recipients.map((e) => e.toLowerCase()))]),
    input.webhook_url,
    input.webhook_url === null ? null : webhookSecret,
    now,
    now,
  );
  return getAlert(db, id, now) as StoredAlert;
}

/** `webhookSecret` is used only when a webhook URL is set for the first time. */
export function updateAlert(
  db: SqlDb,
  id: string,
  patch: UpdateAlertInput,
  webhookSecret: string | null,
  now: number,
): { alert: StoredAlert; newSecret: string | null } | null {
  const current = getAlert(db, id, now);
  if (current === null) return null;
  const url = patch.webhook_url === undefined ? current.webhook_url : patch.webhook_url;
  const secret = url === null ? null : (current.webhook_secret ?? webhookSecret);
  db.run(
    `UPDATE alerts SET name = ?, goal = ?, enabled = ?, email_recipients = ?, webhook_url = ?, webhook_secret = ?,
       updated_at = ? WHERE id = ?`,
    patch.name ?? current.name,
    patch.goal ?? current.goal,
    (patch.enabled ?? current.enabled) ? 1 : 0,
    JSON.stringify(
      patch.email_recipients === undefined
        ? current.email_recipients
        : [...new Set(patch.email_recipients.map((e) => e.toLowerCase()))],
    ),
    url,
    secret,
    now,
    id,
  );
  return {
    alert: getAlert(db, id, now) as StoredAlert,
    newSecret: current.webhook_secret === null && secret !== null ? secret : null,
  };
}

/** New webhook secret for an alert with a webhook URL; null when the alert is missing or has no webhook. */
export function rotateAlertSecret(db: SqlDb, id: string, secret: string, now: number): StoredAlert | null {
  const current = getAlert(db, id, now);
  if (current === null || current.webhook_url === null) return null;
  db.run(`UPDATE alerts SET webhook_secret = ?, updated_at = ? WHERE id = ?`, secret, now, id);
  return getAlert(db, id, now);
}

export function deleteAlert(db: SqlDb, id: string): boolean {
  const existed = first<{ id: string }>(db, `SELECT id FROM alerts WHERE id = ?`, id) !== undefined;
  db.run(`DELETE FROM alerts WHERE id = ?`, id);
  db.run(`DELETE FROM alert_queue WHERE alert_id = ?`, id);
  return existed;
}

export function queueAlertTest(db: SqlDb, id: string, now: number): boolean {
  const row = first<{ goal: string }>(db, `SELECT goal FROM alerts WHERE id = ?`, id);
  if (row === undefined) return false;
  db.run(
    `INSERT INTO alert_queue (alert_id, goal, visitor_id, test, ts) VALUES (?, ?, NULL, 1, ?)`,
    id,
    row.goal,
    now,
  );
  return true;
}

// --------------------------------------------------------------------- shares

export interface ShareRow {
  id: string;
  name: string;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

export function listShares(db: SqlDb): ShareRow[] {
  return db.all<ShareRow>(`SELECT * FROM shares ORDER BY created_at DESC, id`);
}

export function createShare(db: SqlDb, name: string, now: number): ShareRow {
  const id = newObjectId('sh');
  db.run(`INSERT INTO shares (id, name, created_at) VALUES (?, ?, ?)`, id, name, now);
  return first<ShareRow>(db, `SELECT * FROM shares WHERE id = ?`, id) as ShareRow;
}

export function revokeShare(db: SqlDb, id: string, now: number): boolean {
  const row = first<ShareRow>(db, `SELECT * FROM shares WHERE id = ?`, id);
  if (row === undefined) return false;
  if (row.revoked_at === null) db.run(`UPDATE shares SET revoked_at = ? WHERE id = ?`, now, id);
  return true;
}

/** An active (not revoked) share; records the access. */
export function useShare(db: SqlDb, id: string, now: number): ShareRow | null {
  const row = first<ShareRow>(db, `SELECT * FROM shares WHERE id = ? AND revoked_at IS NULL`, id);
  if (row === undefined) return null;
  if (row.last_used_at === null || now - row.last_used_at > 60_000) {
    db.run(`UPDATE shares SET last_used_at = ? WHERE id = ?`, now, id);
  }
  return row;
}

// ------------------------------------------------------------------ site keys

interface SiteKeyRow {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

function toSiteKey(row: SiteKeyRow): SiteKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseArray<SiteKeyScope>(row.scopes),
    created_at: new Date(row.created_at).toISOString(),
    last_used_at: iso(row.last_used_at),
    revoked_at: iso(row.revoked_at),
  };
}

export function listSiteKeys(db: SqlDb): SiteKey[] {
  return db.all<SiteKeyRow>(`SELECT * FROM site_keys ORDER BY created_at DESC, id`).map(toSiteKey);
}

export function createSiteKey(
  db: SqlDb,
  input: { id: string; name: string; prefix: string; hash: string; scopes: SiteKeyScope[] },
  now: number,
): SiteKey {
  db.run(
    `INSERT INTO site_keys (id, name, prefix, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    input.id,
    input.name,
    input.prefix,
    input.hash,
    JSON.stringify([...new Set(input.scopes)].sort()),
    now,
  );
  return toSiteKey(first<SiteKeyRow>(db, `SELECT * FROM site_keys WHERE id = ?`, input.id) as SiteKeyRow);
}

export function revokeSiteKey(db: SqlDb, id: string, now: number): boolean {
  const row = first<SiteKeyRow>(db, `SELECT * FROM site_keys WHERE id = ?`, id);
  if (row === undefined) return false;
  if (row.revoked_at === null) db.run(`UPDATE site_keys SET revoked_at = ? WHERE id = ?`, now, id);
  return true;
}

/** Scopes of an active key with this hash (records the use), or null. */
export function verifySiteKey(db: SqlDb, hash: string, now: number): SiteKeyScope[] | null {
  const row = first<SiteKeyRow>(db, `SELECT * FROM site_keys WHERE hash = ? AND revoked_at IS NULL`, hash);
  if (row === undefined) return null;
  if (row.last_used_at === null || now - row.last_used_at > 60_000) {
    db.run(`UPDATE site_keys SET last_used_at = ? WHERE id = ?`, now, row.id);
  }
  return parseArray<SiteKeyScope>(row.scopes);
}

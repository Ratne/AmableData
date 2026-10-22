import { randomId, type SqlDb } from './db';
import { normalizeStyle, type TimerStyle } from './style';

/**
 * A campaign is one offer with one deadline rule: `evergreen` gives every
 * contact their own window from the moment they start, `fixed` ends for
 * everybody at the same instant.
 */

export const START_TRIGGERS = ['email_open', 'email_click', 'page_visit'] as const;
export type StartTrigger = (typeof START_TRIGGERS)[number];

export const EXPIRY_ACTIONS = ['zeros', 'message', 'hide', 'redirect'] as const;
export type ExpiryAction = (typeof EXPIRY_ACTIONS)[number];

export interface Campaign {
  readonly id: string;
  readonly installId: string;
  readonly publicId: string;
  readonly name: string;
  readonly mode: 'evergreen' | 'fixed';
  readonly durationMinutes: number | null;
  readonly fixedEndAt: number | null;
  /** Evergreen deadlines never go past it (end of the whole promotion). */
  readonly hardEndAt: number | null;
  /** Besides automations (always allowed), what starts a contact's countdown. */
  readonly startOn: readonly StartTrigger[];
  readonly expiry: ExpiryAction;
  readonly style: TimerStyle;
  readonly styleVersion: number;
  /** Where email links send the contact; the expired URL once the deadline passed. */
  readonly offerUrl: string | null;
  readonly expiredUrl: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface CampaignRow {
  id: string;
  install_id: string;
  public_id: string;
  name: string;
  mode: string;
  duration_minutes: number | null;
  fixed_end_at: number | null;
  hard_end_at: number | null;
  start_on: string;
  expiry: string;
  style: string;
  style_version: number;
  offer_url: string | null;
  expired_url: string | null;
  created_at: number;
  updated_at: number;
}

const parseJson = (value: string, fallback: unknown): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

function fromRow(row: CampaignRow): Campaign {
  const startOn = parseJson(row.start_on, []);
  return {
    id: row.id,
    installId: row.install_id,
    publicId: row.public_id,
    name: row.name,
    mode: row.mode === 'fixed' ? 'fixed' : 'evergreen',
    durationMinutes: row.duration_minutes,
    fixedEndAt: row.fixed_end_at,
    hardEndAt: row.hard_end_at,
    startOn: Array.isArray(startOn) ? START_TRIGGERS.filter((t) => startOn.includes(t)) : [],
    expiry: (EXPIRY_ACTIONS as readonly string[]).includes(row.expiry) ? (row.expiry as ExpiryAction) : 'zeros',
    style: normalizeStyle(parseJson(row.style, {})),
    styleVersion: row.style_version,
    offerUrl: row.offer_url,
    expiredUrl: row.expired_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** What the editor sends; validated by `parseCampaignInput`. */
export interface CampaignInput {
  readonly name: string;
  readonly mode: 'evergreen' | 'fixed';
  readonly durationMinutes: number | null;
  readonly fixedEndAt: number | null;
  readonly hardEndAt: number | null;
  readonly startOn: readonly StartTrigger[];
  readonly expiry: ExpiryAction;
  readonly style: TimerStyle;
  readonly offerUrl: string | null;
  readonly expiredUrl: string | null;
}

const MAX_DURATION_MINUTES = 366 * 24 * 60;

function url(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2000 || !URL.canParse(value)) return undefined;
  return /^https?:$/.test(new URL(value).protocol) ? value : undefined;
}

function instant(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseCampaignInput(raw: Record<string, unknown>): { ok: true; input: CampaignInput } | { ok: false; error: string } {
  const name = typeof raw['name'] === 'string' ? raw['name'].trim().slice(0, 120) : '';
  if (name === '') return { ok: false, error: 'name is required' };
  const mode = raw['mode'] === 'fixed' ? 'fixed' : 'evergreen';
  const duration = raw['duration_minutes'];
  const durationMinutes = typeof duration === 'number' && Number.isInteger(duration) ? duration : null;
  if (mode === 'evergreen' && (durationMinutes === null || durationMinutes < 1 || durationMinutes > MAX_DURATION_MINUTES)) {
    return { ok: false, error: 'duration_minutes must be between 1 minute and one year' };
  }
  const fixedEndAt = instant(raw['fixed_end_at']);
  const hardEndAt = instant(raw['hard_end_at']);
  if (fixedEndAt === undefined || hardEndAt === undefined) return { ok: false, error: 'invalid date' };
  if (mode === 'fixed' && fixedEndAt === null) return { ok: false, error: 'fixed_end_at is required for a fixed deadline' };
  const offerUrl = url(raw['offer_url']);
  const expiredUrl = url(raw['expired_url']);
  if (offerUrl === undefined || expiredUrl === undefined) return { ok: false, error: 'URLs must start with https:// or http://' };
  const expiry = (EXPIRY_ACTIONS as readonly string[]).includes(String(raw['expiry'])) ? (raw['expiry'] as ExpiryAction) : 'zeros';
  if (expiry === 'redirect' && expiredUrl === null) return { ok: false, error: 'set the expired page URL to redirect there' };
  const startOn = Array.isArray(raw['start_on']) ? START_TRIGGERS.filter((t) => (raw['start_on'] as unknown[]).includes(t)) : [];
  return {
    ok: true,
    input: {
      name,
      mode,
      durationMinutes: mode === 'evergreen' ? durationMinutes : null,
      fixedEndAt: mode === 'fixed' ? fixedEndAt : null,
      hardEndAt: mode === 'evergreen' ? hardEndAt : null,
      startOn,
      expiry,
      style: normalizeStyle(raw['style']),
      offerUrl,
      expiredUrl,
    },
  };
}

const COLUMNS =
  'id, install_id, public_id, name, mode, duration_minutes, fixed_end_at, hard_end_at, start_on, expiry, style, style_version, offer_url, expired_url, created_at, updated_at';

export async function listCampaigns(db: SqlDb, installId: string): Promise<Campaign[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM campaigns WHERE install_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`)
    .bind(installId)
    .all<CampaignRow>();
  return results.map(fromRow);
}

export async function getCampaign(db: SqlDb, installId: string, id: string): Promise<Campaign | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM campaigns WHERE install_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(installId, id)
    .first<CampaignRow>();
  return row === null ? null : fromRow(row);
}

export async function campaignByPublicId(db: SqlDb, publicId: string): Promise<Campaign | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM campaigns WHERE public_id = ? AND deleted_at IS NULL`)
    .bind(publicId)
    .first<CampaignRow>();
  return row === null ? null : fromRow(row);
}

export async function saveCampaign(
  db: SqlDb,
  installId: string,
  id: string | null,
  input: CampaignInput,
  now: number,
): Promise<Campaign | null> {
  const style = JSON.stringify(input.style);
  const values = [
    input.name,
    input.mode,
    input.durationMinutes,
    input.fixedEndAt,
    input.hardEndAt,
    JSON.stringify(input.startOn),
    input.expiry,
    style,
    input.offerUrl,
    input.expiredUrl,
  ];
  if (id === null) {
    const newId = `cmp_${randomId()}`;
    await db
      .prepare(
        `INSERT INTO campaigns (id, install_id, public_id, name, mode, duration_minutes, fixed_end_at, hard_end_at, start_on, expiry, style, offer_url, expired_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(newId, installId, randomId(), ...values, now, now)
      .run();
    return getCampaign(db, installId, newId);
  }
  const { meta } = await db
    .prepare(
      `UPDATE campaigns SET name = ?, mode = ?, duration_minutes = ?, fixed_end_at = ?, hard_end_at = ?, start_on = ?, expiry = ?,
         style_version = style_version + (CASE WHEN style = ? THEN 0 ELSE 1 END), style = ?, offer_url = ?, expired_url = ?, updated_at = ?
       WHERE install_id = ? AND id = ? AND deleted_at IS NULL`,
    )
    .bind(...values.slice(0, 7), style, style, ...values.slice(8), now, installId, id)
    .run();
  return meta.changes === 0 ? null : getCampaign(db, installId, id);
}

/** Soft-deletes the campaign (its public URLs stop answering) and drops its deadlines. */
export async function deleteCampaign(db: SqlDb, installId: string, id: string, now: number): Promise<boolean> {
  const [updated] = (await db.batch([
    db.prepare('UPDATE campaigns SET deleted_at = ? WHERE install_id = ? AND id = ? AND deleted_at IS NULL').bind(now, installId, id),
    db.prepare('DELETE FROM deadlines WHERE install_id = ? AND campaign_id = ?').bind(installId, id),
  ])) as Array<{ meta: { changes: number } }>;
  return (updated?.meta.changes ?? 0) > 0;
}

/** Everything of an install, after `app.uninstalled`. */
export async function eraseInstall(db: SqlDb, installId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM deadlines WHERE install_id = ?').bind(installId),
    db.prepare('DELETE FROM campaigns WHERE install_id = ?').bind(installId),
    db.prepare('DELETE FROM action_runs WHERE install_id = ?').bind(installId),
  ]);
}

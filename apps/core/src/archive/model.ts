/**
 * Event archive: shared names, retention defaults and R2 layout (worker and
 * Durable Object side). Rows older than the retention window of their family
 * are written to R2 as gzip JSONL, recorded in the `archive_catalog` of their
 * database, then deleted. A month leaves the database only once, whole: the
 * cutoff is always the first day of a month.
 */

export type ArchiveStream =
  | 'crm_activities'
  | 'form_submissions'
  | 'esign_events'
  | 'mail_messages'
  | 'mail_clicks';

export const ARCHIVE_STREAMS: readonly ArchiveStream[] = [
  'crm_activities',
  'form_submissions',
  'esign_events',
  'mail_messages',
  'mail_clicks',
];

export type ArchiveDb = 'tenant_db' | 'mail_db';

export const STREAM_DB: Readonly<Record<ArchiveStream, ArchiveDb>> = {
  crm_activities: 'tenant_db',
  form_submissions: 'tenant_db',
  esign_events: 'tenant_db',
  mail_messages: 'mail_db',
  mail_clicks: 'mail_db',
};

export const TENANT_ARCHIVE_STREAMS: readonly ArchiveStream[] = ARCHIVE_STREAMS.filter((s) => STREAM_DB[s] === 'tenant_db');
export const MAIL_ARCHIVE_STREAMS: readonly ArchiveStream[] = ARCHIVE_STREAMS.filter((s) => STREAM_DB[s] === 'mail_db');

/** Settings group of each stream (what the owner configures). */
export type RetentionFamily = 'crm_events' | 'email' | 'clicks' | 'submissions' | 'esign';

export const RETENTION_FAMILIES: readonly RetentionFamily[] = [
  'crm_events',
  'email',
  'clicks',
  'submissions',
  'esign',
];

export const STREAM_FAMILY: Readonly<Record<ArchiveStream, RetentionFamily>> = {
  crm_activities: 'crm_events',
  form_submissions: 'submissions',
  esign_events: 'esign',
  mail_messages: 'email',
  mail_clicks: 'clicks',
};

/** Months kept in the database; 0 keeps everything. Defaults need no configuration. */
export type RetentionSettings = Record<RetentionFamily, number>;

export const DEFAULT_RETENTION: Readonly<RetentionSettings> = {
  crm_events: 24,
  email: 24,
  clicks: 12,
  submissions: 12,
  esign: 24,
};

export const MIN_RETENTION_MONTHS = 3;
export const MAX_RETENTION_MONTHS = 120;

/** Consumed outbox rows (automation and analytics already read them) are deleted, not archived. */
export const OUTBOX_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows per R2 object: one partition of a month is split in parts of this size. */
export const PART_MAX_ROWS = 50_000;

/** Rows per RPC page between the worker and the Durable Object. */
export const PAGE_MAX_ROWS = 500;

/** UTF-16 characters per RPC page (rows are cut short of this). */
export const PAGE_MAX_CHARS = 4_000_000;

/** `yyyy-mm` (UTC) of an epoch ms timestamp. */
export function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `[from, to)` epoch ms bounds of a `yyyy-mm` month (UTC). */
export function monthRange(month: string): { from: number; to: number } {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  return { from: Date.UTC(year, index, 1), to: Date.UTC(year, index + 1, 1) };
}

/**
 * First instant still kept for a retention of `months`: the first day (UTC) of
 * the month `months` months before `now`. `null` keeps everything.
 */
export function cutoffFor(months: number, now: number): number | null {
  if (months <= 0) return null;
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1);
}

/** Cutoff of every stream for the tenant's settings (streams kept forever are left out). */
export function streamCutoffs(
  settings: RetentionSettings,
  now: number,
): Partial<Record<ArchiveStream, number>> {
  const out: Partial<Record<ArchiveStream, number>> = {};
  for (const stream of ARCHIVE_STREAMS) {
    const cutoff = cutoffFor(settings[STREAM_FAMILY[stream]], now);
    if (cutoff !== null) out[stream] = cutoff;
  }
  return out;
}

/** Validated settings: unknown keys dropped, missing ones defaulted, values clamped. */
export function normalizeRetention(raw: unknown): RetentionSettings {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_RETENTION };
  for (const family of RETENTION_FAMILIES) {
    const value = source[family];
    if (typeof value !== 'number' || !Number.isInteger(value)) continue;
    out[family] = value <= 0 ? 0 : Math.min(MAX_RETENTION_MONTHS, Math.max(MIN_RETENTION_MONTHS, value));
  }
  return out;
}

/** R2 key segment of an id: kept when made of safe characters, hex-encoded otherwise. */
export function keySegment(value: string): string {
  if (/^[A-Za-z0-9_-]{1,80}$/.test(value)) return value;
  return `x${Array.from(new TextEncoder().encode(value), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 160)}`;
}

/** Partition of a contact's activities: the last character of its id (ULIDs end with random bits). */
export function contactPartition(contactId: string): string {
  const last = Array.from(contactId).at(-1) ?? '';
  const ascii = /^[A-Z]$/.test(last) ? last.toLowerCase() : last;
  return `c-${(ascii.codePointAt(0) ?? 0).toString(16)}`;
}

/** Partition of messages and clicks: the broadcast, or `tx` for every other email. */
export function mailPartition(broadcastId: string | null): string {
  return broadcastId === null || broadcastId === '' ? 'tx' : broadcastId;
}

export function archivePrefix(tenantId: string): string {
  return `archive/${keySegment(tenantId)}/`;
}

export function archiveObjectKey(
  tenantId: string,
  stream: ArchiveStream,
  month: string,
  partition: string,
  part: number,
): string {
  return `${archivePrefix(tenantId)}${stream}/${month}/${keySegment(partition)}/${part}.jsonl.gz`;
}

export interface ArchiveCatalogEntry {
  stream: ArchiveStream;
  month: string;
  partition: string;
  part: number;
  object_key: string;
  rows: number;
  bytes: number;
  last_cursor: string | null;
  final: boolean;
  created_at: number;
}

/** One partition of a month still to be written, from part `part` after row `after`. */
export interface PendingPartition {
  partition: string;
  part: number;
  after: string | null;
}

export interface ArchivePlanStream {
  stream: ArchiveStream;
  month: string;
  pending: PendingPartition[];
}

export interface ArchiveRowsPage {
  rows: Record<string, unknown>[];
  /** Cursor of the last row returned (null when none). */
  last: string | null;
  /** True when the partition has more rows after `last`. */
  more: boolean;
}

export interface ArchiveMonthSummary {
  month: string;
  rows: number;
}

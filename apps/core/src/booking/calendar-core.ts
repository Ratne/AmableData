import type { Interval } from '@amable/booking';
import { OAUTH_SCOPES, type EmailSendRequest, type OAuthTokenProvider } from '@amable/core';
import type { SqlDb } from '../crm/db/sql';

/**
 * Logic of the `BookingCalendar` Durable Object (one per host calendar),
 * kept free of Workers APIs so it runs under vitest:
 * - caches the calendar's external busy time (Google Calendar free/busy
 *   through the central OAuth tokens; dev stub tokens never reach Google);
 * - stores reminder emails and sends them when due (the DO alarm);
 * - keeps an availability version, bumped on every change and pushed to the
 *   open booking widgets.
 */

export interface CalendarDoRef {
  tenantId: string;
  calendarId: string;
  hostUserId: string;
  googleAccountId: string | null;
  googleCalendarId: string | null;
}

export type SyncStatus = 'ok' | 'stub' | 'not_connected' | 'unavailable' | 'error';

export interface SyncResult {
  status: SyncStatus;
  busyCount: number;
  syncedAt: number | null;
  message: string | null;
}

export interface ReminderJob {
  /** Unique per booking and offset; re-scheduling replaces the booking's jobs. */
  id: string;
  fireAt: number;
  request: EmailSendRequest;
}

export interface CalendarDeps {
  db: SqlDb;
  now(): number;
  oauth: OAuthTokenProvider;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Sends a text frame to every open widget socket. */
  broadcast(message: string): void;
  setAlarm(at: number | null): Promise<void>;
  sendEmail(request: EmailSendRequest): Promise<void>;
}

/** Busy time older than this is refreshed before answering. */
export const BUSY_TTL_MS = 5 * 60_000;
/** Window of the external busy time kept in cache. */
export const BUSY_WINDOW_MS = 120 * 86_400_000;
const GOOGLE_FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS external_busy (start_at INTEGER NOT NULL, end_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    fire_at INTEGER NOT NULL,
    request TEXT NOT NULL,
    sent_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS reminders_due ON reminders (fire_at) WHERE sent_at IS NULL`,
];

export class CalendarCore {
  constructor(private readonly deps: CalendarDeps) {
    for (const statement of SCHEMA) deps.db.run(statement);
  }

  private meta(key: string): string | null {
    return this.deps.db.all<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.deps.db.run(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  version(): number {
    return Number(this.meta('version') ?? '0');
  }

  /** New availability version, pushed to the widgets. */
  bump(): number {
    const next = this.version() + 1;
    this.setMeta('version', String(next));
    this.deps.broadcast(JSON.stringify({ type: 'version', version: next }));
    return next;
  }

  lastSync(): SyncResult {
    const raw = this.meta('last_sync');
    if (raw === null) return { status: 'not_connected', busyCount: 0, syncedAt: null, message: null };
    return JSON.parse(raw) as SyncResult;
  }

  private replaceBusy(intervals: readonly Interval[]): void {
    this.deps.db.transaction(() => {
      this.deps.db.run(`DELETE FROM external_busy`);
      for (const i of intervals) this.deps.db.run(`INSERT INTO external_busy (start_at, end_at) VALUES (?, ?)`, i.start, i.end);
    });
  }

  private record(result: SyncResult, account: string | null): SyncResult {
    this.setMeta('last_sync', JSON.stringify(result));
    this.setMeta('sync_account', account ?? '');
    return result;
  }

  /** Refreshes the external busy time from Google Calendar (stub tokens: recorded as `stub`, nothing fetched). */
  async sync(ref: CalendarDoRef): Promise<SyncResult> {
    const now = this.deps.now();
    const before = this.busyCount();
    if (ref.googleAccountId === null) {
      this.replaceBusy([]);
      const result = this.record({ status: 'not_connected', busyCount: 0, syncedAt: now, message: null }, null);
      if (before > 0) this.bump();
      return result;
    }
    if (!this.deps.oauth.available) {
      return this.record({ status: 'unavailable', busyCount: before, syncedAt: now, message: 'OAuth is not available on this installation' }, ref.googleAccountId);
    }
    const token = await this.deps.oauth.getAccessToken({ tenantId: ref.tenantId, provider: 'google', accountId: ref.googleAccountId });
    if (token === null) {
      return this.record({ status: 'error', busyCount: before, syncedAt: now, message: 'the Google account is no longer connected' }, ref.googleAccountId);
    }
    if (token.stub) {
      this.replaceBusy([]);
      if (before > 0) this.bump();
      return this.record({ status: 'stub', busyCount: 0, syncedAt: now, message: 'skipped (dev stub)' }, ref.googleAccountId);
    }
    if (!token.scopes.includes(OAUTH_SCOPES.calendarRead) && !token.scopes.includes(OAUTH_SCOPES.calendar)) {
      return this.record({ status: 'error', busyCount: before, syncedAt: now, message: 'missing calendar scope' }, ref.googleAccountId);
    }
    try {
      const calendar = ref.googleCalendarId ?? 'primary';
      const response = await this.deps.fetch(GOOGLE_FREEBUSY_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${token.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          timeMin: new Date(now).toISOString(),
          timeMax: new Date(now + BUSY_WINDOW_MS).toISOString(),
          items: [{ id: calendar }],
        }),
      });
      if (!response.ok) {
        return this.record({ status: 'error', busyCount: before, syncedAt: now, message: `Google answered ${String(response.status)}` }, ref.googleAccountId);
      }
      const body = (await response.json()) as { calendars?: Record<string, { busy?: Array<{ start?: string; end?: string }> }> };
      const intervals: Interval[] = [];
      for (const item of body.calendars?.[calendar]?.busy ?? []) {
        const start = Date.parse(item.start ?? '');
        const end = Date.parse(item.end ?? '');
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) intervals.push({ start, end });
      }
      this.replaceBusy(intervals);
      this.bump();
      return this.record({ status: 'ok', busyCount: intervals.length, syncedAt: now, message: null }, ref.googleAccountId);
    } catch (error) {
      return this.record(
        { status: 'error', busyCount: before, syncedAt: now, message: error instanceof Error ? error.message : 'sync failed' },
        ref.googleAccountId,
      );
    }
  }

  private busyCount(): number {
    return this.deps.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM external_busy`)[0]?.n ?? 0;
  }

  /** External busy time overlapping `[from, to)`, refreshed first when stale or the account changed. */
  async busy(ref: CalendarDoRef, from: number, to: number): Promise<{ intervals: Interval[]; sync: SyncResult }> {
    const last = this.lastSync();
    const stale = last.syncedAt === null || this.deps.now() - last.syncedAt > BUSY_TTL_MS;
    const changed = (this.meta('sync_account') ?? '') !== (ref.googleAccountId ?? '');
    const sync = stale || changed ? await this.sync(ref) : last;
    const intervals = this.deps.db
      .all<{ start_at: number; end_at: number }>(
        `SELECT start_at, end_at FROM external_busy WHERE end_at > ? AND start_at < ? ORDER BY start_at`,
        from,
        to,
      )
      .map((r) => ({ start: r.start_at, end: r.end_at }));
    return { intervals, sync };
  }

  /** Replaces the pending reminders of a booking (empty list: cancel them) and bumps the version. */
  async bookingChanged(bookingId: string, reminders: readonly ReminderJob[]): Promise<number> {
    const now = this.deps.now();
    this.deps.db.transaction(() => {
      this.deps.db.run(`DELETE FROM reminders WHERE booking_id = ? AND sent_at IS NULL`, bookingId);
      for (const job of reminders) {
        if (job.fireAt <= now) continue;
        this.deps.db.run(
          `INSERT INTO reminders (id, booking_id, fire_at, request) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET fire_at = excluded.fire_at, request = excluded.request, sent_at = NULL`,
          job.id,
          bookingId,
          job.fireAt,
          JSON.stringify(job.request),
        );
      }
    });
    await this.deps.setAlarm(this.nextAlarm());
    return this.bump();
  }

  pendingReminders(): Array<{ id: string; bookingId: string; fireAt: number; request: EmailSendRequest }> {
    return this.deps.db
      .all<{ id: string; booking_id: string; fire_at: number; request: string }>(
        `SELECT id, booking_id, fire_at, request FROM reminders WHERE sent_at IS NULL ORDER BY fire_at, id`,
      )
      .map((r) => ({ id: r.id, bookingId: r.booking_id, fireAt: r.fire_at, request: JSON.parse(r.request) as EmailSendRequest }));
  }

  nextAlarm(): number | null {
    return this.deps.db.all<{ next: number | null }>(`SELECT MIN(fire_at) AS next FROM reminders WHERE sent_at IS NULL`)[0]?.next ?? null;
  }

  /** Alarm handler: sends due reminders (a failed send stays pending for the next alarm). */
  async fireDue(): Promise<number> {
    const now = this.deps.now();
    let sent = 0;
    for (const job of this.pendingReminders().filter((r) => r.fireAt <= now)) {
      try {
        await this.deps.sendEmail(job.request);
        this.deps.db.run(`UPDATE reminders SET sent_at = ? WHERE id = ?`, now, job.id);
        sent += 1;
      } catch (error) {
        console.error('[booking] reminder send failed', job.id, error);
      }
    }
    this.deps.db.run(`DELETE FROM reminders WHERE sent_at IS NOT NULL AND sent_at < ?`, now - 30 * 86_400_000);
    const next = this.nextAlarm();
    await this.deps.setAlarm(next !== null && next <= now ? now + 60_000 : next);
    return sent;
  }
}

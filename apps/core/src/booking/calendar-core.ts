import type { Interval } from '@amable/booking';
import { OAUTH_SCOPES, type EmailSendRequest, type OAuthTokenProvider } from '@amable/core';
import type { SqlDb } from '../crm/db/sql';

/**
 * Logic of the `BookingCalendar` Durable Object (one per host calendar),
 * kept free of Workers APIs so it runs under vitest:
 * - caches the calendar's external busy time (Google Calendar free/busy
 *   through the central OAuth tokens; dev stub tokens never reach Google);
 * - writes each booking as an event of the connected Google calendar
 *   (created, moved, deleted with the booking; retried by the alarm);
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
  /** Last failed booking write to Google Calendar, until a write succeeds. */
  writeError?: string | null;
  /** The connection cannot write events (granted before `calendar.events`): reconnect Google. */
  needsReconnect?: boolean;
}

interface WriteError {
  message: string;
  at: number;
  reconnect: boolean;
}

export interface ReminderJob {
  /** Unique per booking and offset; re-scheduling replaces the booking's jobs. */
  id: string;
  fireAt: number;
  request: EmailSendRequest;
}

/** Google Calendar event of a booking. */
export interface CalendarEventData {
  summary: string;
  description: string;
  location: string;
  start: number;
  end: number;
  timeZone: string;
  attendee: { email: string; name: string } | null;
}

/** Desired state of a booking's event in this calendar: `event: null` removes it. */
export interface CalendarEventChange {
  tenantId: string;
  /** This calendar, when the event belongs here; null removes it from wherever it was written. */
  ref: CalendarDoRef | null;
  event: CalendarEventData | null;
}

export interface CalendarEventState {
  bookingId: string;
  /** Google event id while the event exists in Google. */
  eventId: string | null;
  pending: boolean;
  attempts: number;
  lastError: string | null;
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
const GOOGLE_CALENDARS_URL = 'https://www.googleapis.com/calendar/v3/calendars';
/** Delay before the next event write attempt, indexed by the attempts already made − 1. */
export const EVENT_RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000] as const;

/** Google event id of a booking: hex of its id (event ids only allow `a-v` and `0-9`). */
export function googleEventId(bookingId: string): string {
  return `bk${[...new TextEncoder().encode(bookingId)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

type WriteOutcome = { ok: true } | { ok: false; retry: boolean; error: string; reconnect?: boolean };

const MISSING_WRITE_SCOPE = 'missing calendar.events scope: reconnect Google';
/** How often reading the status re-reads the granted scopes of the stored token. */
const SCOPE_CHECK_MS = 5 * 60_000;

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
  `CREATE TABLE IF NOT EXISTS calendar_events (
    booking_id TEXT PRIMARY KEY,
    account_id TEXT,
    calendar TEXT,
    desired TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER,
    last_error TEXT
  )`,
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
    const base: SyncResult = raw === null ? { status: 'not_connected', busyCount: 0, syncedAt: null, message: null } : (JSON.parse(raw) as SyncResult);
    return this.withWrites(base);
  }

  private withWrites(result: SyncResult): SyncResult {
    const raw = this.meta('write_error');
    const error = raw === null || raw === '' ? null : (JSON.parse(raw) as WriteError);
    return { ...result, writeError: error?.message ?? null, needsReconnect: error?.reconnect ?? false };
  }

  private setWriteError(error: WriteError | null): void {
    this.setMeta('write_error', error === null ? '' : JSON.stringify(error));
  }

  /** Flags a token without `calendar.events` (bookings cannot be written), and clears the flag once granted. */
  private checkWriteScope(scopes: readonly string[], now: number): void {
    this.setMeta('scope_checked_at', String(now));
    if (!scopes.includes(OAUTH_SCOPES.calendar)) {
      this.setWriteError({ message: MISSING_WRITE_SCOPE, at: now, reconnect: true });
    } else if (this.lastSync().needsReconnect === true) {
      this.setWriteError(null);
    }
  }

  /** Last sync and write health; re-reads the token scopes now and then, so a read-only grant shows at once. */
  async status(ref: CalendarDoRef): Promise<SyncResult> {
    const now = this.deps.now();
    const checkedAt = Number(this.meta('scope_checked_at') ?? 0);
    const sameAccount = this.meta('scope_checked_account') === ref.googleAccountId;
    if (ref.googleAccountId !== null && this.deps.oauth.available && (!sameAccount || now - checkedAt >= SCOPE_CHECK_MS)) {
      this.setMeta('scope_checked_at', String(now));
      this.setMeta('scope_checked_account', ref.googleAccountId);
      const token = await this.deps.oauth
        .getAccessToken({ tenantId: ref.tenantId, provider: 'google', accountId: ref.googleAccountId })
        .catch(() => null);
      if (token !== null && !token.stub) this.checkWriteScope(token.scopes, now);
    }
    return this.lastSync();
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
    return this.withWrites(result);
  }

  /** Refreshes the external busy time from Google Calendar (stub tokens: recorded as `stub`, nothing fetched). */
  async sync(ref: CalendarDoRef): Promise<SyncResult> {
    const now = this.deps.now();
    const before = this.busyCount();
    if (ref.googleAccountId === null) {
      this.setWriteError(null);
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
    this.checkWriteScope(token.scopes, now);
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

  /**
   * Replaces the pending reminders of a booking (empty list: cancel them),
   * writes its Google event when `change` is given, and bumps the version.
   */
  async bookingChanged(
    bookingId: string,
    reminders: readonly ReminderJob[],
    change?: CalendarEventChange,
  ): Promise<number> {
    const now = this.deps.now();
    let write = false;
    this.deps.db.transaction(() => {
      if (change !== undefined) write = this.queueEvent(bookingId, change, now);
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
    if (write) await this.writeEvent(bookingId);
    await this.deps.setAlarm(this.nextAlarm());
    return this.bump();
  }

  /** False when there is nothing to do (removing an event this calendar never had). */
  private queueEvent(bookingId: string, change: CalendarEventChange, now: number): boolean {
    const known = this.deps.db.all<{ account_id: string | null }>(
      `SELECT account_id FROM calendar_events WHERE booking_id = ?`,
      bookingId,
    )[0];
    const wanted = change.event !== null && change.ref !== null && change.ref.googleAccountId !== null;
    if (!wanted && (known === undefined || known.account_id === null)) {
      if (known !== undefined) this.deps.db.run(`DELETE FROM calendar_events WHERE booking_id = ?`, bookingId);
      return false;
    }
    this.deps.db.run(
      `INSERT INTO calendar_events (booking_id, desired, attempts, next_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(booking_id) DO UPDATE SET desired = excluded.desired, attempts = 0, next_at = excluded.next_at, last_error = NULL`,
      bookingId,
      JSON.stringify(change),
      now,
    );
    return true;
  }

  eventState(bookingId: string): CalendarEventState | null {
    const row = this.deps.db.all<{ account_id: string | null; desired: string | null; attempts: number; last_error: string | null }>(
      `SELECT account_id, desired, attempts, last_error FROM calendar_events WHERE booking_id = ?`,
      bookingId,
    )[0];
    if (row === undefined) return null;
    return {
      bookingId,
      eventId: row.account_id === null ? null : googleEventId(bookingId),
      pending: row.desired !== null,
      attempts: row.attempts,
      lastError: row.last_error,
    };
  }

  private async googleToken(ref: { tenantId: string; accountId: string }): Promise<{ token: string | null; outcome?: WriteOutcome }> {
    if (!this.deps.oauth.available) return { token: null, outcome: { ok: false, retry: false, error: 'OAuth is not available on this installation' } };
    const token = await this.deps.oauth.getAccessToken({ tenantId: ref.tenantId, provider: 'google', accountId: ref.accountId });
    if (token === null) return { token: null, outcome: { ok: false, retry: false, error: 'the Google account is no longer connected' } };
    if (token.stub) return { token: null, outcome: { ok: true } };
    if (!token.scopes.includes(OAUTH_SCOPES.calendar)) {
      return { token: null, outcome: { ok: false, retry: false, error: MISSING_WRITE_SCOPE, reconnect: true } };
    }
    return { token: token.accessToken };
  }

  private async googleCall(token: string, method: string, url: string, body?: unknown): Promise<Response> {
    return this.deps.fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private static failure(response: Response): WriteOutcome {
    const retry = response.status === 401 || response.status === 429 || response.status >= 500;
    return { ok: false, retry, error: `Google answered ${String(response.status)}` };
  }

  private async upsertGoogleEvent(tenantId: string, accountId: string, calendar: string, bookingId: string, event: CalendarEventData): Promise<WriteOutcome> {
    const { token, outcome } = await this.googleToken({ tenantId, accountId });
    if (token === null) return outcome ?? { ok: true };
    const id = googleEventId(bookingId);
    const base = `${GOOGLE_CALENDARS_URL}/${encodeURIComponent(calendar)}/events`;
    const body = {
      id,
      status: 'confirmed',
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: { dateTime: new Date(event.start).toISOString(), timeZone: event.timeZone },
      end: { dateTime: new Date(event.end).toISOString(), timeZone: event.timeZone },
      attendees: event.attendee === null ? [] : [{ email: event.attendee.email, displayName: event.attendee.name }],
      extendedProperties: { private: { amableBookingId: bookingId } },
    };
    // Update first: it also revives an event deleted by an earlier cancellation (same id).
    const updated = await this.googleCall(token, 'PUT', `${base}/${id}?sendUpdates=none`, body);
    if (updated.ok) return { ok: true };
    if (updated.status !== 404) return CalendarCore.failure(updated);
    const inserted = await this.googleCall(token, 'POST', `${base}?sendUpdates=none`, body);
    return inserted.ok ? { ok: true } : CalendarCore.failure(inserted);
  }

  private async deleteGoogleEvent(tenantId: string, accountId: string, calendar: string, bookingId: string): Promise<WriteOutcome> {
    const { token, outcome } = await this.googleToken({ tenantId, accountId });
    if (token === null) return outcome?.ok === false && !outcome.retry ? { ok: true } : (outcome ?? { ok: true });
    const url = `${GOOGLE_CALENDARS_URL}/${encodeURIComponent(calendar)}/events/${googleEventId(bookingId)}?sendUpdates=none`;
    const response = await this.googleCall(token, 'DELETE', url);
    return response.ok || response.status === 404 || response.status === 410 ? { ok: true } : CalendarCore.failure(response);
  }

  /** Brings a booking's Google event to its desired state; failures are retried by the alarm. */
  private async writeEvent(bookingId: string): Promise<void> {
    const row = this.deps.db.all<{ account_id: string | null; calendar: string | null; desired: string | null; attempts: number }>(
      `SELECT account_id, calendar, desired, attempts FROM calendar_events WHERE booking_id = ?`,
      bookingId,
    )[0];
    if (row === undefined || row.desired === null) return;
    const change = JSON.parse(row.desired) as CalendarEventChange;
    const ref = change.ref;
    const target =
      change.event !== null && ref !== null && ref.googleAccountId !== null
        ? { tenantId: change.tenantId, accountId: ref.googleAccountId, calendar: ref.googleCalendarId ?? 'primary' }
        : null;
    let written: { accountId: string | null; calendar: string | null } = { accountId: row.account_id, calendar: row.calendar };
    let outcome: WriteOutcome = { ok: true };
    try {
      const moved = row.account_id !== null && (target === null || target.accountId !== row.account_id || target.calendar !== row.calendar);
      if (moved && row.account_id !== null) {
        outcome = await this.deleteGoogleEvent(change.tenantId, row.account_id, row.calendar ?? 'primary', bookingId);
        if (outcome.ok) written = { accountId: null, calendar: null };
      }
      if (outcome.ok && target !== null && change.event !== null) {
        outcome = await this.upsertGoogleEvent(target.tenantId, target.accountId, target.calendar, bookingId, change.event);
        if (outcome.ok) written = { accountId: target.accountId, calendar: target.calendar };
      }
    } catch (error) {
      outcome = { ok: false, retry: true, error: error instanceof Error ? error.message : 'calendar write failed' };
    }
    const attempts = row.attempts + 1;
    if (outcome.ok) {
      if (this.withWrites({ status: 'ok', busyCount: 0, syncedAt: null, message: null }).writeError !== null) this.setWriteError(null);
      if (written.accountId === null) this.deps.db.run(`DELETE FROM calendar_events WHERE booking_id = ?`, bookingId);
      else {
        this.deps.db.run(
          `UPDATE calendar_events SET account_id = ?, calendar = ?, desired = NULL, attempts = ?, next_at = NULL, last_error = NULL WHERE booking_id = ?`,
          written.accountId,
          written.calendar,
          attempts,
          bookingId,
        );
      }
      return;
    }
    const retry = outcome.retry && attempts < EVENT_RETRY_MS.length + 1;
    const delay = EVENT_RETRY_MS[Math.min(attempts, EVENT_RETRY_MS.length) - 1] as number;
    this.deps.db.run(
      `UPDATE calendar_events SET account_id = ?, calendar = ?, desired = ?, attempts = ?, next_at = ?, last_error = ? WHERE booking_id = ?`,
      written.accountId,
      written.calendar,
      retry ? row.desired : null,
      attempts,
      retry ? this.deps.now() + delay : null,
      outcome.error.slice(0, 500),
      bookingId,
    );
    this.setWriteError({ message: outcome.error.slice(0, 500), at: this.deps.now(), reconnect: outcome.reconnect === true });
    console.error('[booking] calendar event write failed', bookingId, outcome.error);
  }

  pendingReminders(): Array<{ id: string; bookingId: string; fireAt: number; request: EmailSendRequest }> {
    return this.deps.db
      .all<{ id: string; booking_id: string; fire_at: number; request: string }>(
        `SELECT id, booking_id, fire_at, request FROM reminders WHERE sent_at IS NULL ORDER BY fire_at, id`,
      )
      .map((r) => ({ id: r.id, bookingId: r.booking_id, fireAt: r.fire_at, request: JSON.parse(r.request) as EmailSendRequest }));
  }

  nextAlarm(): number | null {
    return (
      this.deps.db.all<{ next: number | null }>(
        `SELECT MIN(at) AS next FROM (
           SELECT MIN(fire_at) AS at FROM reminders WHERE sent_at IS NULL
           UNION ALL SELECT MIN(next_at) FROM calendar_events WHERE desired IS NOT NULL
         )`,
      )[0]?.next ?? null
    );
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
    const dueEvents = this.deps.db.all<{ booking_id: string }>(
      `SELECT booking_id FROM calendar_events WHERE desired IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT 50`,
      now,
    );
    for (const { booking_id: bookingId } of dueEvents) await this.writeEvent(bookingId);
    const next = this.nextAlarm();
    await this.deps.setAlarm(next !== null && next <= now ? now + 60_000 : next);
    return sent;
  }
}

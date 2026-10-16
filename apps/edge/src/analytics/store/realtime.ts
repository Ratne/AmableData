import {
  REALTIME_WINDOW_MINUTES,
  type AnalyticsRealtime,
  type RealtimeClientMessage,
  type RealtimeEvent,
  type RealtimeServerMessage,
} from '@amable/api-types';
import { first, type SqlDb } from '../db/sql';
import { ONLINE_WINDOW_MS } from './query';

const iso = (ts: number): string => new Date(ts).toISOString();

/** Strips identities for public (share link) viewers. */
export function anonymizeEvent(e: RealtimeEvent): RealtimeEvent {
  return { ...e, label: null };
}

export function anonymizeSnapshot(s: AnalyticsRealtime): AnalyticsRealtime {
  return {
    ...s,
    visitors: s.visitors.map((v) => ({ ...v, name: null, contact_id: null })),
    events: s.events.map(anonymizeEvent),
  };
}

/** Visitors active in the last 30 minutes, recent events and top lists. */
export function realtimeSnapshot(db: SqlDb, siteId: string, currency: string, now: number): AnalyticsRealtime {
  const since = now - REALTIME_WINDOW_MINUTES * 60_000;
  const visitors = db
    .all<{
      visitor_id: string;
      session_id: string;
      country: string | null;
      region: string | null;
      city: string | null;
      latitude: number | null;
      longitude: number | null;
      page: string | null;
      hostname: string | null;
      referrer_host: string | null;
      channel: string;
      device: string | null;
      browser: string | null;
      os: string | null;
      started_at: number;
      last_seen: number;
      pageviews: number;
      revenue_minor: number;
      name: string | null;
      email: string | null;
      contact_id: string | null;
    }>(
      `SELECT s.visitor_id AS visitor_id, s.id AS session_id, s.country AS country, s.region AS region, s.city AS city,
         s.latitude AS latitude, s.longitude AS longitude, s.exit_path AS page, s.hostname AS hostname,
         s.referrer_host AS referrer_host, s.channel AS channel, s.device AS device, s.browser AS browser, s.os AS os,
         s.started_at AS started_at, s.last_seen AS last_seen, s.pageviews AS pageviews, s.revenue_minor AS revenue_minor,
         v.name AS name, v.email AS email, v.contact_id AS contact_id
       FROM sessions s JOIN visitors v ON v.id = s.visitor_id
       WHERE s.last_seen >= ? ORDER BY s.last_seen DESC LIMIT 300`,
      since,
    )
    .map((v) => ({
      visitor_id: v.visitor_id,
      session_id: v.session_id,
      country: v.country,
      region: v.region,
      city: v.city,
      latitude: v.latitude,
      longitude: v.longitude,
      page: v.page,
      hostname: v.hostname,
      referrer_host: v.referrer_host,
      channel: v.channel,
      device: v.device,
      browser: v.browser,
      os: v.os,
      started_at: iso(v.started_at),
      last_seen: iso(v.last_seen),
      pageviews: v.pageviews,
      revenue_minor: v.revenue_minor,
      name: v.name ?? v.email,
      contact_id: v.contact_id,
    }));
  const events = db
    .all<{
      type: 'pageview' | 'goal' | 'payment';
      ts: number;
      visitor_id: string;
      path: string | null;
      name: string | null;
      amount: number | null;
      currency: string | null;
      country: string | null;
      city: string | null;
      latitude: number | null;
      longitude: number | null;
      channel: string | null;
      device: string | null;
      label: string | null;
    }>(
      `SELECT e.type AS type, e.ts AS ts, e.visitor_id AS visitor_id, e.path AS path, e.name AS name, e.amount AS amount,
         e.currency AS currency, s.country AS country, s.city AS city, s.latitude AS latitude, s.longitude AS longitude,
         s.channel AS channel, s.device AS device, COALESCE(v.name, v.email) AS label
       FROM (
         SELECT 'pageview' AS type, ts, visitor_id, session_id, path, NULL AS name, NULL AS amount, NULL AS currency
           FROM pageviews WHERE ts >= ?
         UNION ALL
         SELECT 'goal', ts, visitor_id, session_id, path, name, NULL, NULL FROM goals
           WHERE ts >= ? AND name NOT IN ('payment', 'free_trial')
         UNION ALL
         SELECT 'payment', ts, visitor_id, session_id, NULL, NULL, amount_minor, currency FROM payments
           WHERE ts >= ? AND visitor_id IS NOT NULL
       ) e
       LEFT JOIN sessions s ON s.id = e.session_id
       LEFT JOIN visitors v ON v.id = e.visitor_id
       ORDER BY e.ts DESC LIMIT 60`,
      since,
      since,
      since,
    )
    .map(
      (e): RealtimeEvent => ({
        type: e.type,
        ts: iso(e.ts),
        visitor_id: e.visitor_id,
        path: e.path,
        name: e.name,
        country: e.country,
        city: e.city,
        latitude: e.latitude,
        longitude: e.longitude,
        channel: e.channel,
        device: e.device,
        amount_minor: e.amount,
        currency: e.currency,
        label: e.label,
      }),
    );
  const count = (column: string): Array<{ value: string | null; visitors: number }> =>
    db.all<{ value: string | null; visitors: number }>(
      `SELECT ${column} AS value, COUNT(DISTINCT visitor_id) AS visitors FROM sessions WHERE last_seen >= ?
       GROUP BY ${column} ORDER BY visitors DESC, value LIMIT 10`,
      since,
    );
  const online =
    first<{ n: number }>(db, `SELECT COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE last_seen >= ?`, now - ONLINE_WINDOW_MS)
      ?.n ?? 0;
  return {
    site_id: siteId,
    currency,
    online,
    window_minutes: REALTIME_WINDOW_MINUTES,
    visitors,
    events,
    countries: count('country'),
    pages: count('exit_path'),
    referrers: count('referrer_host'),
  };
}

/** Minimal socket surface used by the hub (a hibernatable WebSocket in the DO). */
export interface RealtimeSocket {
  send(message: string): void;
}

/**
 * Realtime fan-out over hibernatable WebSockets: the DO keeps no per-socket
 * state in memory (sockets are tagged `private` or `public` when accepted),
 * so it can hibernate between events. Pure logic, testable with fake sockets.
 */
export class RealtimeHub {
  constructor(
    private readonly sockets: (tag: 'private' | 'public') => readonly RealtimeSocket[],
    private readonly snapshot: () => AnalyticsRealtime,
  ) {}

  /** First message after accepting a socket. */
  greet(ws: RealtimeSocket, isPublic: boolean): void {
    const data = this.snapshot();
    send(ws, { type: 'snapshot', data: isPublic ? anonymizeSnapshot(data) : data });
  }

  /** Client messages: `ping` → `pong`, `snapshot` → a fresh snapshot; anything else is ignored. */
  onMessage(ws: RealtimeSocket, raw: string | ArrayBuffer, isPublic: boolean): void {
    if (typeof raw !== 'string' || raw.length > 1024) return;
    let msg: RealtimeClientMessage | null = null;
    try {
      const parsed = JSON.parse(raw) as { type?: unknown };
      if (parsed.type === 'ping' || parsed.type === 'snapshot') msg = { type: parsed.type };
    } catch {
      msg = null;
    }
    if (msg === null) return;
    if (msg.type === 'ping') send(ws, { type: 'pong' });
    else this.greet(ws, isPublic);
  }

  /** Pushes freshly ingested events to every connected viewer. Returns the number of deliveries. */
  broadcast(events: readonly RealtimeEvent[]): number {
    if (events.length === 0) return 0;
    let delivered = 0;
    for (const [tag, map] of [
      ['private', (e: RealtimeEvent) => e],
      ['public', anonymizeEvent],
    ] as const) {
      const targets = this.sockets(tag);
      if (targets.length === 0) continue;
      for (const e of events.slice(-50)) {
        const payload = JSON.stringify({ type: 'event', data: map(e) } satisfies RealtimeServerMessage);
        for (const ws of targets) {
          try {
            ws.send(payload);
            delivered += 1;
          } catch {
            // closed socket: the runtime cleans it up
          }
        }
      }
    }
    return delivered;
  }
}

function send(ws: RealtimeSocket, msg: RealtimeServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // closed socket
  }
}

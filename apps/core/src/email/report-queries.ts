import {
  ensureIndexes,
  ReportQueryError,
  runGeneric,
  type AggregateInput,
  type AggregateOutput,
  type GenericSpec,
} from '../reports/aggregate';
import { MailError, type MailDeps } from './context';

/**
 * Read-only aggregates of the MailDb for the report engine: email delivery
 * and engagement over time, broadcast performance, clicks per link. Additive
 * index on `mail_broadcasts.started_at`, created at first use.
 */

const MAIL_REPORT_INDEXES: ReadonlyArray<[string, string]> = [
  [
    'mail_broadcasts',
    `CREATE INDEX IF NOT EXISTS rpt_broadcasts_started ON mail_broadcasts (started_at)`,
  ],
];

const ENGAGEMENT = {
  delivered: 'COUNT(m.delivered_at)',
  opened: 'COUNT(m.opened_at)',
  clicked: 'COUNT(m.clicked_at)',
  bounced: 'COUNT(m.bounced_at)',
  complained: 'COUNT(m.complained_at)',
  unsubscribed: 'COUNT(m.unsubscribed_at)',
} as const;

function engagement(anchor: string): Record<string, { expr: string; anchor: string }> {
  return Object.fromEntries(Object.entries(ENGAGEMENT).map(([k, expr]) => [k, { expr, anchor }]));
}

function emailsSpec(): GenericSpec {
  const anchor = 'm.sent_at';
  return {
    from: 'mail_messages m',
    where: ['m.sent_at IS NOT NULL'],
    measures: { sent: { expr: 'COUNT(*)', anchor }, ...engagement(anchor) },
    dimensions: { source_type: { key: 'm.source_type' } },
    currencyColumn: null,
    bounded: ['source_type'],
  };
}

/**
 * Per-broadcast totals: counted from the live messages, or read from the frozen
 * row once the archive started moving the broadcast's messages to R2.
 */
const BROADCAST_TOTALS = `(
  SELECT broadcast_id, COUNT(*) AS total, COUNT(sent_at) AS sent, COUNT(delivered_at) AS delivered,
         COUNT(opened_at) AS opened, COUNT(clicked_at) AS clicked, COUNT(bounced_at) AS bounced,
         COUNT(complained_at) AS complained, COUNT(unsubscribed_at) AS unsubscribed
    FROM mail_messages
   WHERE broadcast_id IS NOT NULL AND broadcast_id NOT IN (SELECT broadcast_id FROM mail_broadcast_stats)
   GROUP BY broadcast_id
  UNION ALL
  SELECT broadcast_id, total, sent, delivered, opened, clicked, bounced, complained, unsubscribed
    FROM mail_broadcast_stats
)`;

function broadcastsSpec(): GenericSpec {
  const anchor = 'bc.started_at';
  const sum = (column: string) => ({ expr: `COALESCE(SUM(m.${column}), 0)`, anchor });
  return {
    from: `mail_broadcasts bc JOIN ${BROADCAST_TOTALS} m ON m.broadcast_id = bc.id`,
    where: ['bc.deleted_at IS NULL'],
    measures: {
      recipients: sum('total'),
      sent: sum('sent'),
      ...Object.fromEntries(Object.keys(ENGAGEMENT).map((k) => [k, sum(k)])),
    },
    dimensions: { broadcast: { key: 'bc.id', label: 'MAX(bc.name)' } },
    currencyColumn: null,
  };
}

/**
 * Clicks per (broadcast, link, message) from the live table, plus the frozen
 * per-link counts of archived broadcasts (no message ids: their unique clicks
 * are summed as frozen).
 */
const LINK_CLICKS = `(
  SELECT broadcast_id, url, message_id, COUNT(*) AS clicks, NULL AS frozen_unique
    FROM mail_clicks
   WHERE broadcast_id IS NOT NULL AND broadcast_id NOT IN (SELECT broadcast_id FROM mail_broadcast_stats)
   GROUP BY broadcast_id, url, message_id
  UNION ALL
  SELECT s.broadcast_id, json_extract(j.value, '$.url'), NULL, json_extract(j.value, '$.clicks'),
         json_extract(j.value, '$.unique_clicks')
    FROM mail_broadcast_stats s, json_each(s.links) j
   WHERE json_extract(j.value, '$.clicks') > 0
)`;

function linksSpec(broadcastId: string | null): GenericSpec {
  const anchor = broadcastId === null ? 'bc.started_at' : null;
  return {
    from: `${LINK_CLICKS} k JOIN mail_broadcasts bc ON bc.id = k.broadcast_id AND bc.deleted_at IS NULL${
      broadcastId === null ? '' : ' AND bc.id = ?'
    }`,
    fromParams: broadcastId === null ? [] : [broadcastId],
    where: [],
    measures: {
      clicks: { expr: 'COALESCE(SUM(k.clicks), 0)', anchor },
      unique_clicks: { expr: 'COUNT(DISTINCT k.message_id) + COALESCE(SUM(k.frozen_unique), 0)', anchor },
    },
    dimensions: {
      link:
        broadcastId === null
          ? { key: `k.broadcast_id || ' ' || k.url`, label: `MAX(bc.name) || ': ' || k.url` }
          : { key: 'k.url', label: 'k.url' },
    },
    currencyColumn: null,
  };
}

function broadcastOptions(deps: MailDeps): Array<{ value: string; label: string }> {
  return deps.db
    .all<{ id: string; name: string }>(
      `SELECT id, name FROM mail_broadcasts WHERE deleted_at IS NULL AND started_at IS NOT NULL
        ORDER BY started_at DESC LIMIT 100`,
    )
    .map((r) => ({ value: r.id, label: r.name }));
}

/** Aggregates one email source inside the MailDb DO. */
export function mailReportAggregate(deps: MailDeps, input: AggregateInput): AggregateOutput {
  ensureIndexes(deps.db, 'mail', MAIL_REPORT_INDEXES);
  const ctx = { db: deps.db, filter: null, currency: null };
  try {
    switch (input.source) {
      case 'emails':
        return runGeneric(emailsSpec(), ctx, input);
      case 'broadcasts':
        return runGeneric(broadcastsSpec(), ctx, input);
      case 'broadcast_links': {
        const broadcastId = input.params?.['broadcast_id'] ?? null;
        const out = runGeneric(linksSpec(broadcastId === '' ? null : broadcastId), ctx, input);
        out.options = { broadcast_id: broadcastOptions(deps) };
        return out;
      }
      default:
        throw new MailError(
          'bad_request',
          400,
          `source ${input.source} is not served by the mail database`,
        );
    }
  } catch (error) {
    if (error instanceof ReportQueryError)
      throw new MailError('validation_failed', 422, error.message);
    throw error;
  }
}

/** Report ops of the MailDb (spread into `mailOps`). */
export const mailReportOps = {
  'reports.aggregate': mailReportAggregate,
} satisfies Record<string, (deps: MailDeps, input: never) => unknown>;

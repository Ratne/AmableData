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

function broadcastsSpec(): GenericSpec {
  const anchor = 'bc.started_at';
  return {
    from: 'mail_broadcasts bc JOIN mail_messages m ON m.broadcast_id = bc.id',
    where: ['bc.deleted_at IS NULL'],
    measures: {
      recipients: { expr: 'COUNT(*)', anchor },
      sent: { expr: 'COUNT(m.sent_at)', anchor },
      ...engagement(anchor),
    },
    dimensions: { broadcast: { key: 'bc.id', label: 'MAX(bc.name)' } },
    currencyColumn: null,
  };
}

function linksSpec(broadcastId: string | null): GenericSpec {
  const anchor = broadcastId === null ? 'bc.started_at' : null;
  return {
    from: `mail_clicks k JOIN mail_broadcasts bc ON bc.id = k.broadcast_id AND bc.deleted_at IS NULL${
      broadcastId === null ? '' : ' AND bc.id = ?'
    }`,
    fromParams: broadcastId === null ? [] : [broadcastId],
    where: [],
    measures: {
      clicks: { expr: 'COUNT(*)', anchor },
      unique_clicks: { expr: 'COUNT(DISTINCT k.message_id)', anchor },
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

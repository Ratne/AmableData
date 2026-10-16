import type { CrmContext } from './context';
import {
  ensureIndexes,
  lit,
  runGeneric,
  tableExists,
  type AggregateInput,
  type AggregateOutput,
  type GenericSpec,
} from '../reports/aggregate';
import { filterFragment } from '../reports/filter';

/**
 * Read-only aggregates of the CRM tables for the report engine (contacts,
 * companies, tag applications, lead sources, pipeline, tasks, form
 * submissions). Additive: only `CREATE INDEX IF NOT EXISTS` on date anchors,
 * created at first use (see `ensureIndexes`), no migration.
 */

const CRM_REPORT_INDEXES: ReadonlyArray<[string, string]> = [
  [
    'crm_companies',
    `CREATE INDEX IF NOT EXISTS rpt_companies_created ON crm_companies (created_at)`,
  ],
  [
    'crm_activities',
    `CREATE INDEX IF NOT EXISTS rpt_activities_type_at ON crm_activities (type, occurred_at)`,
  ],
  [
    'crm_opportunities',
    `CREATE INDEX IF NOT EXISTS rpt_opportunities_created ON crm_opportunities (created_at)`,
  ],
  [
    'crm_opportunities',
    `CREATE INDEX IF NOT EXISTS rpt_opportunities_closed ON crm_opportunities (closed_at)`,
  ],
  ['crm_tasks', `CREATE INDEX IF NOT EXISTS rpt_tasks_created ON crm_tasks (created_at)`],
  ['crm_tasks', `CREATE INDEX IF NOT EXISTS rpt_tasks_completed ON crm_tasks (completed_at)`],
  [
    'form_submissions',
    `CREATE INDEX IF NOT EXISTS rpt_form_submissions_created ON form_submissions (created_at)`,
  ],
];

/** Display name of a contact id column (name, else email). */
export const CONTACT_NAME = (col: string): string =>
  `(SELECT COALESCE(NULLIF(TRIM(COALESCE(cn.given_name, '') || ' ' || COALESCE(cn.family_name, '')), ''), cn.primary_email, cn.id)
      FROM crm_contacts cn WHERE cn.id = ${col})`;

function contactsSpec(): GenericSpec {
  return {
    from: 'crm_contacts c',
    where: ['c.deleted_at IS NULL', 'c.merged_into_id IS NULL'],
    measures: { count: { expr: 'COUNT(*)', anchor: 'c.created_at' } },
    dimensions: {
      lead_source: {
        key: 'c.lead_source_id',
        label: '(SELECT ls.name FROM crm_lead_sources ls WHERE ls.id = c.lead_source_id)',
      },
      source_type: { key: 'c.source_type' },
      owner: { key: 'c.owner_id' },
      marketable_status: { key: 'c.marketable_status' },
      utm_source: { key: 'c.utm_source' },
    },
    currencyColumn: null,
    contactColumn: 'c.id',
    bounded: ['source_type', 'marketable_status'],
  };
}

function companiesSpec(): GenericSpec {
  return {
    from: 'crm_companies co',
    where: ['co.deleted_at IS NULL'],
    measures: { count: { expr: 'COUNT(*)', anchor: 'co.created_at' } },
    dimensions: { owner: { key: 'co.owner_id' } },
    currencyColumn: null,
    companyColumn: 'co.id',
  };
}

const APPLIED = `a.type = 'contact.tag_applied'`;

function tagsSpec(): GenericSpec {
  const tagId = `json_extract(a.data, '$.tagId')`;
  return {
    from: 'crm_activities a',
    where: [`a.type IN ('contact.tag_applied', 'contact.tag_removed')`],
    measures: {
      applications: {
        expr: `SUM(CASE WHEN ${APPLIED} THEN 1 ELSE 0 END)`,
        anchor: 'a.occurred_at',
      },
      removals: { expr: `SUM(CASE WHEN ${APPLIED} THEN 0 ELSE 1 END)`, anchor: 'a.occurred_at' },
      contacts: {
        expr: `COUNT(DISTINCT CASE WHEN ${APPLIED} THEN a.contact_id END)`,
        anchor: 'a.occurred_at',
      },
    },
    dimensions: {
      tag: {
        key: tagId,
        label: `COALESCE((SELECT t.name FROM crm_tags t WHERE t.id = ${tagId}), json_extract(a.data, '$.tagName'))`,
      },
    },
    currencyColumn: null,
    contactColumn: 'a.contact_id',
  };
}

function opportunitiesSpec(): GenericSpec {
  const open = `o.status = 'open'`;
  const won = `o.status = 'won'`;
  return {
    from: 'crm_opportunities o JOIN crm_pipeline_stages s ON s.id = o.stage_id',
    where: ['o.deleted_at IS NULL'],
    measures: {
      count: { expr: 'COUNT(*)', anchor: 'o.created_at' },
      value: { expr: 'COALESCE(SUM(o.value_minor), 0)', anchor: 'o.created_at' },
      open_count: { expr: `SUM(CASE WHEN ${open} THEN 1 ELSE 0 END)`, anchor: null },
      open_value: { expr: `SUM(CASE WHEN ${open} THEN o.value_minor ELSE 0 END)`, anchor: null },
      weighted_value: {
        expr: `SUM(CASE WHEN ${open} THEN (o.value_minor * s.probability + 50) / 100 ELSE 0 END)`,
        anchor: null,
      },
      won: { expr: `SUM(CASE WHEN ${won} THEN 1 ELSE 0 END)`, anchor: 'o.closed_at' },
      lost: { expr: `SUM(CASE WHEN o.status = 'lost' THEN 1 ELSE 0 END)`, anchor: 'o.closed_at' },
      won_value: {
        expr: `SUM(CASE WHEN ${won} THEN o.value_minor ELSE 0 END)`,
        anchor: 'o.closed_at',
      },
      cycle_ms_won: {
        expr: `SUM(CASE WHEN ${won} THEN o.closed_at - o.created_at ELSE 0 END)`,
        anchor: 'o.closed_at',
      },
    },
    dimensions: {
      stage: {
        key: 'o.stage_id',
        label: 's.name',
        sort: '(SELECT p.created_at FROM crm_pipelines p WHERE p.id = s.pipeline_id) * 1000 + s.position',
      },
      pipeline: {
        key: 'o.pipeline_id',
        label: '(SELECT p.name FROM crm_pipelines p WHERE p.id = o.pipeline_id)',
      },
      owner: { key: 'o.owner_id' },
      status: { key: 'o.status' },
    },
    currencyColumn: 'o.currency',
    moneyMeasures: ['value', 'open_value', 'weighted_value', 'won_value'],
    contactColumn: 'o.contact_id',
    bounded: ['stage', 'pipeline', 'owner', 'status'],
  };
}

function tasksSpec(now: number): GenericSpec {
  return {
    from: 'crm_tasks t',
    where: ['t.deleted_at IS NULL'],
    measures: {
      created: { expr: 'COUNT(*)', anchor: 't.created_at' },
      completed: {
        expr: 'SUM(CASE WHEN t.completed_at IS NOT NULL THEN 1 ELSE 0 END)',
        anchor: 't.completed_at',
      },
      overdue: {
        expr: `SUM(CASE WHEN t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at < ${lit(now)} THEN 1 ELSE 0 END)`,
        anchor: null,
      },
    },
    dimensions: {
      assignee: { key: 't.assigned_to' },
      type: { key: 't.type' },
      priority: { key: 't.priority' },
    },
    currencyColumn: null,
    contactColumn: 't.contact_id',
    bounded: ['assignee', 'type', 'priority'],
  };
}

function formsSpec(): GenericSpec {
  return {
    from: 'form_submissions f',
    where: ['f.deleted_at IS NULL'],
    measures: {
      submissions: { expr: 'COUNT(*)', anchor: 'f.created_at' },
      contacts: { expr: 'COUNT(DISTINCT f.contact_id)', anchor: 'f.created_at' },
      new_contacts: { expr: 'COALESCE(SUM(f.contact_created), 0)', anchor: 'f.created_at' },
    },
    dimensions: {
      form: {
        key: 'f.form_id',
        label: '(SELECT ff.name FROM form_forms ff WHERE ff.id = f.form_id)',
      },
      utm_source: { key: 'f.utm_source' },
    },
    currencyColumn: null,
    contactColumn: 'f.contact_id',
  };
}

function leadSourcesSpec(range: { from: number; to: number }, currency: string): GenericSpec {
  const inRange = `created_at >= ${lit(range.from)} AND created_at < ${lit(range.to)}`;
  return {
    from: `crm_contacts c LEFT JOIN (
             SELECT o.contact_id AS contact_id, SUM(o.paid_minor - o.refunded_minor) AS rev
               FROM crm_orders o
              WHERE o.deleted_at IS NULL AND o.status NOT IN ('draft', 'cancelled') AND o.currency = ?
                AND o.contact_id IN (SELECT id FROM crm_contacts WHERE ${inRange})
              GROUP BY o.contact_id) r ON r.contact_id = c.id`,
    fromParams: [currency],
    where: ['c.deleted_at IS NULL', 'c.merged_into_id IS NULL'],
    measures: {
      contacts: { expr: 'COUNT(*)', anchor: 'c.created_at' },
      customers: { expr: 'SUM(CASE WHEN r.rev > 0 THEN 1 ELSE 0 END)', anchor: 'c.created_at' },
      revenue: { expr: 'COALESCE(SUM(r.rev), 0)', anchor: 'c.created_at' },
    },
    dimensions: {
      lead_source: {
        key: 'c.lead_source_id',
        label: '(SELECT ls.name FROM crm_lead_sources ls WHERE ls.id = c.lead_source_id)',
      },
      utm_source: { key: 'c.utm_source' },
      source_type: { key: 'c.source_type' },
    },
    currencyColumn: null,
    contactColumn: 'c.id',
  };
}

/** Tenant default currency (e-commerce settings). */
export function defaultCurrency(ctx: CrmContext): string {
  return (
    ctx.db.all<{ value: string }>(
      `SELECT value FROM tenant_meta WHERE key = 'commerce.default_currency'`,
    )[0]?.value ?? 'EUR'
  );
}

function filterFor(ctx: CrmContext, spec: GenericSpec, input: AggregateInput) {
  if (spec.contactColumn !== undefined)
    return filterFragment(ctx, 'contact', input.filter, spec.contactColumn);
  if (spec.companyColumn !== undefined)
    return filterFragment(ctx, 'company', input.filter, spec.companyColumn);
  return null;
}

export function runSpec(
  ctx: CrmContext,
  spec: GenericSpec,
  input: AggregateInput,
  currency: string | null,
): AggregateOutput {
  return runGeneric(spec, { db: ctx.db, filter: filterFor(ctx, spec, input), currency }, input);
}

export const CRM_REPORT_SOURCES = [
  'contacts',
  'companies',
  'tags',
  'lead_sources',
  'opportunities',
  'tasks',
  'forms',
] as const;
export type CrmReportSource = (typeof CRM_REPORT_SOURCES)[number];

export function isCrmReportSource(source: string): source is CrmReportSource {
  return (CRM_REPORT_SOURCES as readonly string[]).includes(source);
}

/** Aggregates one CRM source inside the TenantDb DO. */
export function crmReportAggregate(
  ctx: CrmContext,
  input: AggregateInput & { source: CrmReportSource },
): AggregateOutput {
  ensureIndexes(ctx.db, 'crm', CRM_REPORT_INDEXES);
  switch (input.source) {
    case 'contacts':
      return runSpec(ctx, contactsSpec(), input, null);
    case 'companies':
      return runSpec(ctx, companiesSpec(), input, null);
    case 'tags':
      return runSpec(ctx, tagsSpec(), input, null);
    case 'tasks':
      return runSpec(ctx, tasksSpec(input.now), input, null);
    case 'forms':
      if (!tableExists(ctx.db, 'form_submissions')) {
        return {
          rows: [],
          totals: {},
          currency: null,
          currencies: [],
          truncated: false,
          emptyReason: 'source_unavailable',
        };
      }
      return runSpec(ctx, formsSpec(), input, null);
    case 'opportunities': {
      const currency = input.currency ?? defaultCurrency(ctx);
      const out = runSpec(ctx, opportunitiesSpec(), input, currency);
      out.currencies = ctx.db
        .all<{ c: string }>(
          `SELECT DISTINCT currency AS c FROM crm_opportunities WHERE deleted_at IS NULL ORDER BY 1 LIMIT 20`,
        )
        .map((r) => r.c);
      return out;
    }
    case 'lead_sources': {
      const currency = input.currency ?? defaultCurrency(ctx);
      const out = runSpec(ctx, leadSourcesSpec(input.range, currency), input, currency);
      out.currency = currency;
      return out;
    }
  }
}

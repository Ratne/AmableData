import {
  reportDefinitionSchema,
  type ChartType,
  type DashboardWidget,
  type ReportCategory,
  type ReportDefinitionInput,
  type ReportDefinition,
} from '@amable/api-types/reports';

/**
 * Built-in reports: stable ids (used by dashboards and the REST API), a
 * category, an English name/description (the SPA translates by id) and a
 * definition over the generic engine — nothing here is special-cased.
 */
export interface BuiltinReport {
  id: string;
  category: ReportCategory;
  name: string;
  description: string;
  chart: ChartType;
  definition: ReportDefinition;
}

function builtin(
  id: string,
  category: ReportCategory,
  chart: ChartType,
  name: string,
  description: string,
  definition: ReportDefinitionInput,
): BuiltinReport {
  return {
    id,
    category,
    chart,
    name,
    description,
    definition: reportDefinitionSchema.parse(definition),
  };
}

export const BUILTIN_REPORTS: readonly BuiltinReport[] = [
  // ------------------------------------------------------------------ sales
  builtin(
    'sales_daily',
    'sales',
    'line',
    'Daily sales',
    'Revenue, orders and average order value per day.',
    {
      source: 'orders',
      measures: ['revenue', 'count', 'avg_order_value'],
      dimension: 'date',
      granularity: 'day',
      date_range: { preset: 'last_30_days' },
      compare: 'previous_period',
    },
  ),
  builtin(
    'sales_monthly',
    'sales',
    'bar',
    'Monthly sales',
    'Revenue, net collected and orders per month, against the previous year.',
    {
      source: 'orders',
      measures: ['revenue', 'net', 'count'],
      dimension: 'date',
      granularity: 'month',
      date_range: { preset: 'last_12_months' },
      compare: 'previous_year',
    },
  ),
  builtin(
    'revenue_by_product',
    'sales',
    'bar',
    'Revenue by product',
    'Order line revenue and quantity per product.',
    {
      source: 'order_items',
      measures: ['revenue', 'quantity', 'orders'],
      dimension: 'product',
      date_range: { preset: 'last_12_months' },
    },
  ),
  builtin(
    'new_vs_renewals',
    'sales',
    'bar',
    'New vs renewals',
    'One-time sales, first subscription orders and renewals.',
    {
      source: 'orders',
      measures: ['revenue', 'count'],
      dimension: 'kind',
      date_range: { preset: 'last_12_months' },
    },
  ),
  builtin(
    'receivables_aging',
    'sales',
    'bar',
    'Receivables aging',
    'Open balances of unpaid and partially paid orders by days past due.',
    {
      source: 'receivables',
      measures: ['balance', 'count'],
      dimension: 'aging',
      date_range: { preset: 'all_time' },
    },
  ),
  builtin(
    'receivables_by_customer',
    'sales',
    'table',
    'Receivables by customer',
    'Who owes what: open and overdue balance per contact.',
    {
      source: 'receivables',
      measures: ['balance', 'overdue_balance', 'count'],
      dimension: 'contact',
      date_range: { preset: 'all_time' },
    },
  ),
  builtin(
    'customer_lifetime_value',
    'sales',
    'table',
    'Customer lifetime value',
    'Net revenue collected per customer over their whole history.',
    {
      source: 'customers',
      measures: ['lifetime_value', 'orders'],
      dimension: 'contact',
      date_range: { preset: 'all_time' },
    },
  ),
  builtin('refunds', 'sales', 'bar', 'Refunds', 'Refunded amount and count per month.', {
    source: 'refunds',
    measures: ['amount', 'count'],
    dimension: 'date',
    granularity: 'month',
    date_range: { preset: 'last_12_months' },
  }),
  builtin(
    'payments_by_method',
    'sales',
    'bar',
    'Payments by method',
    'Collected payments per payment method.',
    {
      source: 'payments',
      measures: ['amount', 'count', 'failed'],
      dimension: 'method',
      date_range: { preset: 'last_12_months' },
    },
  ),
  // ---------------------------------------------------------- subscriptions
  builtin(
    'subscription_mrr',
    'subscriptions',
    'line',
    'Subscription MRR',
    'Monthly and annual recurring revenue and active subscriptions.',
    {
      source: 'subscriptions',
      measures: ['mrr', 'arr', 'active'],
      dimension: 'date',
      granularity: 'month',
      date_range: { preset: 'last_12_months' },
    },
  ),
  builtin(
    'subscription_churn',
    'subscriptions',
    'line',
    'Subscription churn',
    'Churn rate, revenue churn, new and churned subscriptions.',
    {
      source: 'subscriptions',
      measures: ['churn_rate', 'revenue_churn_rate', 'new', 'churned'],
      dimension: 'date',
      granularity: 'month',
      date_range: { preset: 'last_12_months' },
    },
  ),
  builtin(
    'mrr_by_plan',
    'subscriptions',
    'bar',
    'MRR by plan',
    'Recurring revenue and subscriptions per plan at the end of the range.',
    {
      source: 'subscriptions',
      measures: ['mrr', 'active', 'churned'],
      dimension: 'plan',
      date_range: { preset: 'this_month' },
    },
  ),
  // -------------------------------------------------------------- marketing
  builtin(
    'broadcast_performance',
    'marketing',
    'table',
    'Broadcast performance',
    'Sent, open, click and unsubscribe rates per broadcast.',
    {
      source: 'broadcasts',
      measures: [
        'sent',
        'open_rate',
        'click_rate',
        'unsubscribe_rate',
        'opened',
        'clicked',
        'unsubscribed',
      ],
      dimension: 'broadcast',
      date_range: { preset: 'last_90_days' },
    },
  ),
  builtin(
    'broadcast_links',
    'marketing',
    'table',
    'Broadcast link clicks',
    'Clicks and unique clicks per link (one broadcast or all).',
    {
      source: 'broadcast_links',
      measures: ['clicks', 'unique_clicks'],
      dimension: 'link',
      date_range: { preset: 'last_90_days' },
    },
  ),
  builtin(
    'email_engagement',
    'marketing',
    'line',
    'Email engagement',
    'Emails sent, opened and clicked per week.',
    {
      source: 'emails',
      measures: ['sent', 'opened', 'clicked', 'open_rate', 'click_rate'],
      dimension: 'date',
      granularity: 'week',
      date_range: { preset: 'last_90_days' },
    },
  ),
  builtin(
    'form_conversions',
    'marketing',
    'bar',
    'Form conversions',
    'Submissions, contacts and new contacts per form.',
    {
      source: 'forms',
      measures: ['submissions', 'contacts', 'new_contacts'],
      dimension: 'form',
      date_range: { preset: 'last_90_days' },
    },
  ),
  builtin(
    'tag_applications',
    'crm',
    'line',
    'Tag applications over time',
    'Tags applied and removed per week.',
    {
      source: 'tags',
      measures: ['applications', 'removals'],
      dimension: 'date',
      granularity: 'week',
      date_range: { preset: 'last_90_days' },
    },
  ),
  builtin(
    'tags_by_tag',
    'crm',
    'bar',
    'Tag applications by tag',
    'Applications and tagged contacts per tag.',
    {
      source: 'tags',
      measures: ['applications', 'contacts'],
      dimension: 'tag',
      date_range: { preset: 'last_90_days' },
    },
  ),
  builtin('new_contacts', 'crm', 'bar', 'New contacts', 'Contacts created per month.', {
    source: 'contacts',
    measures: ['count'],
    dimension: 'date',
    granularity: 'month',
    date_range: { preset: 'last_12_months' },
    compare: 'previous_year',
  }),
  // ------------------------------------------------------------- automation
  builtin(
    'automation_performance',
    'automation',
    'table',
    'Automation performance',
    'Entered, completed, failed, active and step errors per automation.',
    {
      source: 'automations',
      measures: ['entered', 'completed', 'completion_rate', 'failed', 'active', 'errors'],
      dimension: 'automation',
      date_range: { preset: 'last_90_days' },
    },
  ),
  builtin(
    'automation_nodes',
    'automation',
    'table',
    'Automation node counters',
    'Entered, completed, active and errors per node and step of one automation.',
    {
      source: 'automation_nodes',
      measures: ['entered', 'completed', 'active', 'errors'],
      dimension: 'node',
      date_range: { preset: 'all_time' },
    },
  ),
  // --------------------------------------------------------------- pipeline
  builtin(
    'pipeline_by_stage',
    'pipeline',
    'funnel',
    'Opportunities by stage',
    'Open opportunities, value and weighted value per stage.',
    {
      source: 'opportunities',
      measures: ['open_count', 'open_value', 'weighted_value'],
      dimension: 'stage',
      date_range: { preset: 'all_time' },
    },
  ),
  builtin(
    'win_rate',
    'pipeline',
    'line',
    'Win rate',
    'Won, lost and win rate of closed opportunities per month.',
    {
      source: 'opportunities',
      measures: ['win_rate', 'won', 'lost', 'won_value'],
      dimension: 'date',
      granularity: 'month',
      date_range: { preset: 'last_12_months' },
    },
  ),
  builtin(
    'sales_velocity',
    'pipeline',
    'table',
    'Sales velocity',
    'Open deals × average won value × win rate ÷ cycle length, per pipeline.',
    {
      source: 'opportunities',
      measures: ['velocity_per_day', 'avg_cycle_days', 'win_rate', 'open_count', 'won_value'],
      dimension: 'pipeline',
      date_range: { preset: 'last_12_months' },
    },
  ),
  builtin(
    'tasks_overview',
    'pipeline',
    'table',
    'Tasks by assignee',
    'Tasks created, completed and overdue per assignee.',
    {
      source: 'tasks',
      measures: ['created', 'completed', 'overdue'],
      dimension: 'assignee',
      date_range: { preset: 'last_30_days' },
    },
  ),
  // ------------------------------------------------------------ attribution
  builtin(
    'lead_source_roi',
    'attribution',
    'table',
    'Lead source ROI',
    'Contacts, customers and revenue per lead source of the contacts acquired in the range.',
    {
      source: 'lead_sources',
      measures: ['contacts', 'customers', 'conversion_rate', 'revenue', 'revenue_per_contact'],
      dimension: 'lead_source',
      date_range: { preset: 'last_12_months' },
    },
  ),
  builtin(
    'revenue_by_channel',
    'attribution',
    'bar',
    'Revenue by channel',
    'Web revenue attributed to each channel (attribution model of the site).',
    {
      source: 'analytics',
      measures: ['revenue', 'conversions', 'visitors'],
      dimension: 'channel',
      date_range: { preset: 'last_30_days' },
    },
  ),
  builtin(
    'revenue_by_campaign',
    'attribution',
    'table',
    'Revenue by campaign',
    'Web revenue and conversions attributed to each campaign.',
    {
      source: 'analytics',
      measures: ['revenue', 'conversions', 'visitors'],
      dimension: 'campaign',
      date_range: { preset: 'last_30_days' },
    },
  ),
  builtin(
    'ad_campaign_roas',
    'attribution',
    'table',
    'Ad campaigns ROAS',
    'Ad spend, attributed revenue, ROAS and cost per acquisition per campaign.',
    {
      source: 'ad_campaigns',
      measures: ['spend', 'revenue', 'roas', 'customers', 'cost_per_acquisition'],
      dimension: 'campaign',
      date_range: { preset: 'last_30_days' },
    },
  ),
  builtin(
    'web_traffic',
    'attribution',
    'line',
    'Web traffic and revenue',
    'Visitors, pageviews and revenue of the tracked site per day.',
    {
      source: 'analytics',
      measures: ['visitors', 'pageviews', 'revenue'],
      dimension: 'date',
      granularity: 'day',
      date_range: { preset: 'last_30_days' },
    },
  ),
];

const BY_ID = new Map(BUILTIN_REPORTS.map((r) => [r.id, r]));

export function builtinReport(id: string): BuiltinReport | undefined {
  return BY_ID.get(id);
}

/**
 * Home dashboard when the tenant has no default one: the widgets the member
 * can read, packed on the 12-column grid.
 */
export function builtinHomeWidgets(canRead: (reportId: string) => boolean): DashboardWidget[] {
  const candidates: Array<Omit<DashboardWidget, 'layout'> & { w: number; h: number }> = [
    {
      id: 'kpi_revenue',
      type: 'kpi',
      title: null,
      report_id: 'sales_monthly',
      measures: ['revenue'],
      overrides: {
        date_range: { preset: 'this_month' },
        compare: 'previous_period',
        dimension: null,
      },
      w: 3,
      h: 2,
    },
    {
      id: 'kpi_mrr',
      type: 'kpi',
      title: null,
      report_id: 'subscription_mrr',
      measures: ['mrr'],
      overrides: {
        date_range: { preset: 'this_month' },
        compare: 'previous_period',
        dimension: null,
      },
      w: 3,
      h: 2,
    },
    {
      id: 'kpi_contacts',
      type: 'kpi',
      title: null,
      report_id: 'new_contacts',
      measures: ['count'],
      overrides: {
        date_range: { preset: 'this_month' },
        compare: 'previous_period',
        dimension: null,
      },
      w: 3,
      h: 2,
    },
    {
      id: 'kpi_emails',
      type: 'kpi',
      title: null,
      report_id: 'email_engagement',
      measures: ['sent'],
      overrides: {
        date_range: { preset: 'last_30_days' },
        compare: 'previous_period',
        dimension: null,
      },
      w: 3,
      h: 2,
    },
    {
      id: 'line_sales',
      type: 'line',
      title: null,
      report_id: 'sales_daily',
      measures: ['revenue'],
      w: 8,
      h: 4,
    },
    {
      id: 'funnel_pipeline',
      type: 'funnel',
      title: null,
      report_id: 'pipeline_by_stage',
      measures: ['open_count'],
      w: 4,
      h: 4,
    },
    {
      id: 'line_mrr',
      type: 'line',
      title: null,
      report_id: 'subscription_mrr',
      measures: ['mrr'],
      w: 6,
      h: 4,
    },
    {
      id: 'bar_products',
      type: 'bar',
      title: null,
      report_id: 'revenue_by_product',
      measures: ['revenue'],
      overrides: { limit: 8 },
      w: 6,
      h: 4,
    },
    {
      id: 'table_broadcasts',
      type: 'table',
      title: null,
      report_id: 'broadcast_performance',
      measures: ['sent', 'open_rate', 'click_rate'],
      overrides: { limit: 5 },
      w: 12,
      h: 4,
    },
  ];
  const widgets: DashboardWidget[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const { w, h, ...widget } of candidates) {
    if (!canRead(widget.report_id)) continue;
    if (x + w > 12) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    widgets.push({ ...widget, layout: { x, y, w, h } });
    x += w;
    rowHeight = Math.max(rowHeight, h);
  }
  return widgets;
}

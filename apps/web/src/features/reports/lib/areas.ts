import type { ReportCatalogEntry, ReportSource } from '@amable/api-types/reports';

/** Catalog sections of the reports page, in display order. */
export const REPORT_AREAS = [
  'custom',
  'sales',
  'subscriptions',
  'receivables',
  'clv',
  'broadcasts',
  'automations',
  'tags',
  'forms',
  'pipeline',
  'attribution',
] as const;
export type ReportArea = (typeof REPORT_AREAS)[number];

const AREA_BY_SOURCE: Readonly<Record<ReportSource, Exclude<ReportArea, 'custom'>>> = {
  orders: 'sales',
  order_items: 'sales',
  payments: 'sales',
  refunds: 'sales',
  subscriptions: 'subscriptions',
  receivables: 'receivables',
  customers: 'clv',
  emails: 'broadcasts',
  broadcasts: 'broadcasts',
  broadcast_links: 'broadcasts',
  automations: 'automations',
  automation_nodes: 'automations',
  tags: 'tags',
  contacts: 'tags',
  companies: 'tags',
  forms: 'forms',
  opportunities: 'pipeline',
  tasks: 'pipeline',
  lead_sources: 'attribution',
  analytics: 'attribution',
  ad_campaigns: 'attribution',
};

export function areaOf(entry: Pick<ReportCatalogEntry, 'kind' | 'definition'>): ReportArea {
  return entry.kind === 'custom' ? 'custom' : AREA_BY_SOURCE[entry.definition.source];
}

export interface AreaGroup {
  readonly area: ReportArea;
  readonly entries: readonly ReportCatalogEntry[];
}

/** Entries grouped by area (empty areas dropped), keeping the catalog order inside each area. */
export function groupByArea(entries: readonly ReportCatalogEntry[]): AreaGroup[] {
  const buckets = new Map<ReportArea, ReportCatalogEntry[]>();
  for (const entry of entries) {
    const area = areaOf(entry);
    buckets.set(area, [...(buckets.get(area) ?? []), entry]);
  }
  return REPORT_AREAS.flatMap((area) => {
    const list = buckets.get(area);
    return list === undefined ? [] : [{ area, entries: list }];
  });
}

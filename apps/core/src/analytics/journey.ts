import type { ContactJourney, JourneyItem, Touch } from '@amable/api-types';
import {
  siteStub,
  tenantSitesStub,
  type AnalyticsNamespace,
  type ContactActivity,
} from '@amable/app-edge/analytics';
import type { CrmJourneyFacts } from './crm-ops';

/**
 * Journey of a CRM contact across every site of the tenant (all visitors
 * linked to it) merged with its CRM side: orders, email opens/clicks, form
 * submissions and bookings from the contact timeline. Exposed to the contact
 * page (`ContactJourneyPanel`) with `analytics:journey_read`.
 */

const DIRECT = 'Direct';
const iso = (ts: number): string => new Date(ts).toISOString();

type RawTouch = ContactActivity['touches'][number];

function toTouch(t: RawTouch): Touch {
  return { ts: iso(t.ts), channel: t.channel, source: t.source, referrer_host: t.referrer_host, campaign: t.campaign };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function activityItem(a: CrmJourneyFacts['activities'][number]): JourneyItem {
  const kind: JourneyItem['kind'] =
    a.type === 'form.submitted' ? 'form' : a.type.startsWith('email.') ? 'email' : 'booking';
  const title = kind === 'email' ? a.type.slice('email.'.length) : a.type;
  const detail =
    str(a.data['subject']) ??
    str(a.data['url']) ??
    str(a.data['formName']) ??
    str(a.data['formId']) ??
    str(a.data['eventTypeName']) ??
    str(a.data['startsAt']);
  return {
    kind,
    ts: a.occurred_at,
    site_id: null,
    title,
    detail,
    channel: null,
    path: null,
    amount_minor: null,
    currency: null,
    ref: str(a.data['messageId']) ?? str(a.data['submissionId']) ?? str(a.data['bookingId']) ?? a.id,
  };
}

export async function contactJourney(
  ns: AnalyticsNamespace,
  tenantId: string,
  contactId: string,
  crm: CrmJourneyFacts,
  limit: number,
): Promise<ContactJourney> {
  const tenant = tenantSitesStub(ns, tenantId);
  const siteIds = await tenant.indexList();
  const links = await tenant.visitorsOfContact(contactId);
  const sites: ContactJourney['sites'] = [];
  const activities: ContactActivity[] = [];
  for (const id of siteIds) {
    const stub = siteStub(ns, id);
    const record = await stub.getSite();
    if (record === null || record.deleted || record.tenantId !== tenantId) continue;
    sites.push({ site_id: id, name: record.site.name, currency: record.site.currency });
    const activity = await stub.contactActivity(contactId, limit);
    if (activity !== null) activities.push(activity);
  }

  const touches = activities.flatMap((a) => a.touches).sort((a, b) => a.ts - b.ts);
  const firstTouch = touches[0];
  const lastNonDirect = [...touches].reverse().find((t) => t.channel !== DIRECT) ?? touches.at(-1);
  const firstVisit = activities
    .filter((a) => a.first_visit !== null)
    .sort((a, b) => (a.first_visit?.ts ?? 0) - (b.first_visit?.ts ?? 0))[0];

  const paidOrders = crm.orders.filter((o) => o.paid_minor > 0);
  const firstOrderPaid = paidOrders
    .map((o) => Date.parse(o.paid_at ?? o.order_date))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0];
  const firstWebPurchase = activities
    .map((a) => a.first_purchase_at)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)[0];
  const firstPurchase = [firstOrderPaid, firstWebPurchase]
    .filter((t): t is number => t !== undefined)
    .sort((a, b) => a - b)[0];
  const firstSeen = activities
    .map((a) => a.first_seen)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)[0];
  const start = Math.min(firstSeen ?? Number.POSITIVE_INFINITY, firstTouch?.ts ?? Number.POSITIVE_INFINITY);
  const startTs = Number.isFinite(start) ? start : null;
  const elapsed = firstPurchase === undefined || startTs === null ? null : Math.max(0, firstPurchase - startTs);

  // Revenue: CRM orders (net paid) + web payments not coming from CRM orders.
  const revenue = new Map<string, number>();
  for (const o of crm.orders) revenue.set(o.currency, (revenue.get(o.currency) ?? 0) + o.paid_minor - o.refunded_minor);
  const items: JourneyItem[] = [];
  for (const a of activities) {
    for (const item of a.items) {
      items.push(item);
      if (item.kind === 'payment' && item.currency !== null && item.amount_minor !== null) {
        revenue.set(item.currency, (revenue.get(item.currency) ?? 0) + item.amount_minor);
      }
    }
  }
  for (const o of crm.orders) {
    items.push({
      kind: 'order',
      ts: o.order_date,
      site_id: null,
      title: o.number,
      detail: o.status,
      channel: null,
      path: null,
      amount_minor: o.total_minor,
      currency: o.currency,
      ref: o.id,
    });
  }
  for (const a of crm.activities) items.push(activityItem(a));

  const sources = new Map<string, { channel: string; source: string | null; sessions: number }>();
  for (const a of activities) {
    for (const s of a.sources) {
      const key = `${s.channel}\u0000${s.source ?? ''}`;
      const cur = sources.get(key) ?? { channel: s.channel, source: s.source, sessions: 0 };
      cur.sessions += s.sessions;
      sources.set(key, cur);
    }
  }
  const pages = new Map<string, number>();
  for (const a of activities) for (const p of a.top_pages) pages.set(p.path, (pages.get(p.path) ?? 0) + p.count);
  const goals = new Map<string, { count: number; last_at: string }>();
  for (const a of activities) {
    for (const g of a.goal_totals) {
      const cur = goals.get(g.name);
      goals.set(g.name, {
        count: (cur?.count ?? 0) + g.count,
        last_at: cur === undefined || g.last_at > cur.last_at ? g.last_at : cur.last_at,
      });
    }
  }
  const predictions = activities.map((a) => a.prediction).filter((p) => p !== null);

  return {
    contact_id: contactId,
    sites,
    visitors: links.map((l) => ({
      site_id: l.siteId,
      visitor_id: l.visitorId,
      linked_at: iso(l.linkedAt),
      source: l.source,
    })),
    first_visit:
      firstVisit?.first_visit == null
        ? null
        : {
            ts: iso(firstVisit.first_visit.ts),
            site_id: firstVisit.site_id,
            channel: firstVisit.first_visit.channel,
            source: firstVisit.first_visit.source,
            referrer_host: firstVisit.first_visit.referrer_host,
            campaign: firstVisit.first_visit.campaign,
            entry_page: firstVisit.first_visit.entry_page,
          },
    totals: {
      sessions: activities.reduce((n, a) => n + a.sessions, 0),
      pageviews: activities.reduce((n, a) => n + a.pageviews, 0),
      goals: activities.reduce((n, a) => n + a.goals, 0),
      revenue: [...revenue]
        .filter(([, amount]) => amount !== 0)
        .map(([currency, amount_minor]) => ({ currency, amount_minor })),
      orders: crm.orders.length,
      emails_opened: crm.activities.filter((a) => a.type === 'email.opened').length,
      emails_clicked: crm.activities.filter((a) => a.type === 'email.link_clicked' || a.type === 'email.clicked').length,
    },
    sources: [...sources.values()].sort((a, b) => b.sessions - a.sessions),
    top_pages: [...pages]
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
      .slice(0, 10),
    goals: [...goals]
      .map(([name, g]) => ({ name, ...g }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    first_touch: firstTouch === undefined ? null : toTouch(firstTouch),
    last_non_direct_touch: lastNonDirect === undefined ? null : toTouch(lastNonDirect),
    time_to_conversion: {
      first_seen: startTs === null ? null : iso(startTs),
      first_purchase_at: firstPurchase === undefined ? null : iso(firstPurchase),
      sessions_before_purchase:
        firstPurchase === undefined || touches.length === 0
          ? null
          : Math.max(1, touches.filter((t) => t.ts <= firstPurchase).length),
      days_to_purchase: elapsed === null ? null : Math.round((elapsed / 86_400_000) * 100) / 100,
      hours_to_purchase: elapsed === null ? null : Math.round((elapsed / 3_600_000) * 100) / 100,
    },
    prediction: predictions.sort((a, b) => b.score - a.score)[0] ?? null,
    items: items.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit),
  };
}

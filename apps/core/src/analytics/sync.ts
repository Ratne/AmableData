import type { AlertWebhookPayload } from '@amable/api-types';
import {
  siteStub,
  tenantSitesStub,
  crmTransactionId,
  type AlertItem,
  type AlertTarget,
  type AnalyticsNamespace,
  type ContactVisitor,
  type CrmFact,
  type CrmLinkSource,
  type SiteRecord,
} from '@amable/app-edge/analytics';
import {
  ANALYTICS_AUTOMATION_EVENTS,
  AUTOMATION_EVENT_TYPES,
  verifyContactToken,
  type AnalyticsPageVisitedPayload,
  type AutomationInboundEvent,
  type OutboxEvent,
} from '@amable/core';
import { lookbackBound } from './crm-ops';

/**
 * CRM ↔ web analytics synchronisation of one tenant, run by the cron trigger,
 * after mutating REST requests (kick) and before contact journeys:
 *
 * 1. reads new TenantDb outbox events (own cursor in `tenant:<id>`; the
 *    automation engine's dispatch flag is never touched) and turns them into
 *    site facts: visitor ↔ contact links (form submissions, bookings), CRM
 *    payments and refunds (revenue), subscription lifecycle goals, merges;
 *    the emails and phones of linked contacts become identity keys of their
 *    visitors (cross-device merge on the site);
 * 2. drains each site's queues: identities to resolve (identify emails,
 *    `_amb_c` email-click tokens), automation events of identified visitors
 *    (web goals → `analytics.goal` on the Engine DO), goal alerts.
 */

export interface AlertDelivery {
  tenantId: string;
  site: { id: string; name: string };
  alert: AlertTarget;
  payload: AlertWebhookPayload;
}

export interface SyncPorts {
  ns: AnalyticsNamespace;
  /** TenantDb op as the system actor; throws on error results. */
  crm<T>(op: string, input: unknown): Promise<T>;
  /** Engine DO ingest of the tenant (null when the engine is not deployed). */
  engine: ((events: AutomationInboundEvent[]) => Promise<void>) | null;
  /** Secrets verifying `_amb_c` contact tokens (EMAIL_TOKEN_SECRET + previous). */
  contactTokenSecrets: readonly string[];
  deliverAlert(d: AlertDelivery): Promise<Array<{ channel: 'email' | 'webhook'; ok: boolean }>>;
  now(): number;
}

export interface SyncReport {
  outboxEvents: number;
  facts: number;
  linked: number;
  automationEvents: number;
  alertsDelivered: number;
  skipped: boolean;
}

/** Subscription events → reserved lifecycle goal names. */
export const LIFECYCLE_GOALS: Readonly<Record<string, string>> = {
  'subscription.started': 'subscription_started',
  'subscription.trial_started': 'trial_started',
  'subscription.trial_converted': 'trial_converted',
  'subscription.renewed': 'subscription_renewed',
  'subscription.upgraded': 'subscription_upgraded',
  'subscription.downgraded': 'subscription_downgraded',
  'subscription.cancel_scheduled': 'subscription_cancel_scheduled',
  'subscription.reactivated': 'subscription_reactivated',
  'subscription.paused': 'subscription_paused',
  'subscription.past_due': 'subscription_past_due',
  'subscription.ended': 'subscription_ended',
};

const OUTBOX_PAGE = 200;
const MAX_ROUNDS = 10;
const ALERT_THROTTLE_MS = 60_000;
const LEASE_MS = 60_000;

interface OutboxPage {
  events: OutboxEvent[];
  scanned: number;
  lastId: string | null;
  lastTs: number | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface ActiveSite {
  id: string;
  record: SiteRecord;
}

async function activeSites(ns: AnalyticsNamespace, tenantId: string): Promise<ActiveSite[]> {
  const ids = await tenantSitesStub(ns, tenantId).indexList();
  const out: ActiveSite[] = [];
  for (const id of ids) {
    const record = await siteStub(ns, id).getSite();
    if (record !== null && !record.deleted && record.tenantId === tenantId) out.push({ id, record });
  }
  return out;
}

/** Where a visitor id lives (sites knowing it). */
async function locateVisitors(
  ns: AnalyticsNamespace,
  sites: readonly ActiveSite[],
  visitorIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (visitorIds.length === 0) return out;
  for (const site of sites) {
    for (const vid of await siteStub(ns, site.id).knownVisitors([...visitorIds])) {
      const list = out.get(vid) ?? [];
      list.push(site.id);
      out.set(vid, list);
    }
  }
  return out;
}

class FactBatch {
  readonly bySite = new Map<string, CrmFact[]>();
  add(siteId: string, fact: CrmFact): void {
    const list = this.bySite.get(siteId) ?? [];
    list.push(fact);
    this.bySite.set(siteId, list);
  }
  get size(): number {
    let n = 0;
    for (const l of this.bySite.values()) n += l.length;
    return n;
  }
}

interface IdentifiedVisitor {
  siteId: string;
  visitorId: string;
  contactId: string;
  ts: number;
}

/** Sends the emails and phones of the contacts as identity keys of their visitors (merge + retro-link on the edge). */
async function sendContactIdentities(ports: SyncPorts, identified: readonly IdentifiedVisitor[]): Promise<void> {
  if (identified.length === 0) return;
  const contacts = await ports.crm<Array<{ id: string; emails: string[]; phones: string[] }>>(
    'analytics.contactIdentities',
    { ids: [...new Set(identified.map((i) => i.contactId))] },
  );
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const bySite = new Map<string, Array<{ visitor_id: string; email: string | null; phone: string | null; ts: number }>>();
  for (const i of identified) {
    const c = byId.get(i.contactId);
    if (c === undefined) continue;
    const list = bySite.get(i.siteId) ?? [];
    const rows = Math.max(c.emails.length, c.phones.length);
    for (let n = 0; n < rows; n += 1) {
      list.push({ visitor_id: i.visitorId, email: c.emails[n] ?? null, phone: c.phones[n] ?? null, ts: i.ts });
    }
    bySite.set(i.siteId, list);
  }
  for (const [siteId, items] of bySite) {
    if (items.length > 0) await siteStub(ports.ns, siteId).identifyVisitors(items);
  }
}

async function applyBatch(
  ports: SyncPorts,
  tenantId: string,
  batch: FactBatch,
): Promise<number> {
  const links: ContactVisitor[] = [];
  const identified: IdentifiedVisitor[] = [];
  for (const [siteId, facts] of batch.bySite) {
    const result = await siteStub(ports.ns, siteId).applyCrmFacts(facts);
    for (const l of result?.linked ?? []) {
      links.push({ siteId, visitorId: l.visitorId, contactId: l.contactId, linkedAt: l.ts, source: l.source });
      identified.push({ siteId, visitorId: l.visitorId, contactId: l.contactId, ts: l.ts });
    }
    for (const f of facts) {
      if (f.kind === 'payment' && f.visitorId !== null && f.contactId !== null) {
        identified.push({ siteId, visitorId: f.visitorId, contactId: f.contactId, ts: f.ts });
      }
    }
  }
  if (links.length > 0) await tenantSitesStub(ports.ns, tenantId).registerLinks(links);
  await sendContactIdentities(ports, identified);
  return links.length;
}

/** Maps outbox events to site facts. */
async function factsFromOutbox(
  ports: SyncPorts,
  tenantId: string,
  sites: readonly ActiveSite[],
  events: readonly OutboxEvent[],
): Promise<FactBatch> {
  const batch = new FactBatch();
  const defaultSite = sites[0]?.id;
  if (defaultSite === undefined) return batch;
  const payloadOf = (e: OutboxEvent): Record<string, unknown> => e.payload as unknown as Record<string, unknown>;
  const visitorIds = [...new Set(events.map((e) => str(payloadOf(e)['visitorId'])).filter((v): v is string => v !== null))];
  const located = await locateVisitors(ports.ns, sites, visitorIds);
  const tenant = tenantSitesStub(ports.ns, tenantId);
  const contactSites = new Map<string, ContactVisitor[]>();
  const linksOf = async (contactId: string): Promise<ContactVisitor[]> => {
    let list = contactSites.get(contactId);
    if (list === undefined) {
      list = await tenant.visitorsOfContact(contactId);
      contactSites.set(contactId, list);
    }
    return list;
  };
  /** Site of a person: where its visitor id lives, else its latest linked visitor, else none. */
  const siteFor = async (
    visitorId: string | null,
    contactId: string | null,
  ): Promise<{ siteId: string; visitorId: string | null } | null> => {
    const known = visitorId === null ? undefined : located.get(visitorId)?.[0];
    if (known !== undefined) return { siteId: known, visitorId };
    if (contactId !== null) {
      const latest = [...(await linksOf(contactId))].sort((a, b) => b.linkedAt - a.linkedAt)[0];
      if (latest !== undefined) return { siteId: latest.siteId, visitorId: latest.visitorId };
    }
    return null;
  };

  for (const e of events) {
    const p = payloadOf(e);
    const ts = Date.parse(e.occurredAt);
    const contactId = str(p['contactId']);
    const visitorId = str(p['visitorId']);
    switch (e.type) {
      case 'form.submitted':
      case 'appointment.booked': {
        if (contactId === null || visitorId === null) break;
        const source: CrmLinkSource = e.type === 'form.submitted' ? 'form' : 'booking';
        for (const siteId of located.get(visitorId) ?? []) {
          batch.add(siteId, { kind: 'link', id: `${e.id}:${siteId}`, contactId, visitorId, source, ts });
        }
        break;
      }
      case 'payment.recorded': {
        const paymentId = str(p['paymentId']);
        if (paymentId === null) break;
        const target = (await siteFor(visitorId, contactId)) ?? { siteId: defaultSite, visitorId: null };
        batch.add(target.siteId, {
          kind: 'payment',
          id: e.id,
          transactionId: crmTransactionId(paymentId),
          contactId,
          visitorId: visitorId !== null && located.has(visitorId) ? visitorId : target.visitorId,
          orderId: str(p['orderId']),
          amountMinor: num(p['amountMinor']),
          currency: str(p['currency']) ?? 'EUR',
          renewal: p['renewal'] === true,
          ts,
        });
        break;
      }
      case 'refund.recorded': {
        const paymentId = str(p['paymentId']);
        // Every site applies it only if it holds the payment / order.
        for (const site of sites) {
          batch.add(site.id, {
            kind: 'refund',
            id: `${e.id}:${site.id}`,
            transactionId: paymentId === null ? null : crmTransactionId(paymentId),
            orderId: str(p['orderId']),
            amountMinor: num(p['amountMinor']),
            ts,
          });
        }
        break;
      }
      case 'contact.merged': {
        const merged = Array.isArray(p['mergedContactIds'])
          ? (p['mergedContactIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        if (contactId === null || merged.length === 0) break;
        for (const site of sites) {
          batch.add(site.id, { kind: 'merge', id: `${e.id}:${site.id}`, fromContactIds: merged, toContactId: contactId, ts });
        }
        await tenant.mergeContactLinks(merged, contactId);
        break;
      }
      default: {
        const goal = LIFECYCLE_GOALS[e.type];
        if (goal === undefined) break;
        const target = await siteFor(visitorId, contactId);
        if (target === null || target.visitorId === null) break;
        const params: Record<string, string | number | boolean> = {};
        for (const key of ['subscriptionId', 'planId', 'productId', 'orderId'] as const) {
          const v = str(p[key]);
          if (v !== null) params[key] = v;
        }
        if (typeof p['amountMinor'] === 'number') params['amount_minor'] = p['amountMinor'];
        batch.add(target.siteId, {
          kind: 'goal',
          id: e.id,
          name: goal,
          contactId,
          visitorId: target.visitorId,
          params,
          ts,
        });
      }
    }
  }
  return batch;
}

async function syncOutbox(ports: SyncPorts, tenantId: string, sites: readonly ActiveSite[], report: SyncReport): Promise<void> {
  const tenant = tenantSitesStub(ports.ns, tenantId);
  const cursor = await tenant.syncCursor();
  let after = cursor === null ? '' : lookbackBound(cursor.ts);
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const page = await ports.crm<OutboxPage>('analytics.outboxSince', { after, limit: OUTBOX_PAGE });
    if (page.lastId === null || page.lastTs === null) break;
    const fresh = new Set(await tenant.claimEvents(page.events.map((e) => e.id)));
    const events = page.events.filter((e) => fresh.has(e.id));
    report.outboxEvents += events.length;
    if (events.length > 0) {
      const batch = await factsFromOutbox(ports, tenantId, sites, events);
      report.facts += batch.size;
      report.linked += await applyBatch(ports, tenantId, batch);
    }
    if (cursor === null || page.lastTs >= cursor.ts) await tenant.setSyncCursor({ ts: page.lastTs, id: page.lastId });
    after = page.lastId;
    if (page.scanned < OUTBOX_PAGE) break;
  }
}

async function goalEventId(siteId: string, kind: string, visitorId: string, ts: number, name: string): Promise<string> {
  return `an_${(await sha256Hex(`${siteId}|${kind}|${visitorId}|${ts}|${name}`)).slice(0, 32)}`;
}

const ENGINE_TYPES: ReadonlySet<string> = new Set<string>(AUTOMATION_EVENT_TYPES);

/** Builds an Engine event for a page visit once the engine declares the type. */
function pageVisitEvent(
  id: string,
  occurredAt: string,
  payload: AnalyticsPageVisitedPayload,
): AutomationInboundEvent | null {
  if (!ENGINE_TYPES.has(ANALYTICS_AUTOMATION_EVENTS.pageVisited)) return null;
  // Typed by the engine's own union as soon as it adds the event (see @amable/core/analytics).
  return { id, type: ANALYTICS_AUTOMATION_EVENTS.pageVisited, occurredAt, payload } as unknown as AutomationInboundEvent;
}

async function drainSite(
  ports: SyncPorts,
  tenantId: string,
  site: ActiveSite,
  report: SyncReport,
): Promise<void> {
  const stub = siteStub(ports.ns, site.id);
  const work = await stub.pullCoreWork(200);

  // 1. identities → visitor ↔ contact links
  if (work.identities.length > 0) {
    const batch = new FactBatch();
    const emails = work.identities.filter((i) => i.kind === 'email').map((i) => i.value);
    const byEmail = new Map(
      (emails.length === 0
        ? []
        : await ports.crm<Array<{ email: string; contactId: string }>>('analytics.contactsByEmail', { emails })
      ).map((m) => [m.email, m.contactId]),
    );
    const tokenContacts = new Map<number, string>();
    for (const item of work.identities.filter((i) => i.kind === 'contact_token')) {
      const payload = await verifyContactToken(ports.contactTokenSecrets, item.value, { nowMs: ports.now() });
      if (payload !== null && payload.t === tenantId) tokenContacts.set(item.id, payload.c);
    }
    const tokenIds = [...new Set(tokenContacts.values())];
    const live = new Set(
      (tokenIds.length === 0
        ? []
        : await ports.crm<Array<{ id: string; deleted: boolean }>>('analytics.contactsBrief', { ids: tokenIds })
      )
        .filter((c) => !c.deleted)
        .map((c) => c.id),
    );
    for (const item of work.identities) {
      const contactId = item.kind === 'email' ? byEmail.get(item.value) : tokenContacts.get(item.id);
      if (contactId === undefined || (item.kind === 'contact_token' && !live.has(contactId))) continue;
      batch.add(site.id, {
        kind: 'link',
        id: `id:${site.id}:${item.visitorId}:${item.kind}:${item.ts}`,
        contactId,
        visitorId: item.visitorId,
        source: item.kind === 'email' ? 'identify' : 'email',
        ts: item.ts,
      });
    }
    report.linked += await applyBatch(ports, tenantId, batch);
  }

  // 2. automation events of identified visitors
  const engineEvents: AutomationInboundEvent[] = [];
  for (const item of work.automation) {
    const occurredAt = new Date(item.ts).toISOString();
    if (item.kind === 'goal' && item.name !== null) {
      engineEvents.push({
        id: await goalEventId(site.id, 'goal', item.visitorId, item.ts, item.name),
        type: 'analytics.goal',
        occurredAt,
        payload: { contactId: item.contactId, siteId: site.id, goalName: item.name },
      });
    } else if (item.kind === 'pageview' && item.path !== null) {
      const event = pageVisitEvent(
        await goalEventId(site.id, 'page', item.visitorId, item.ts, item.path),
        occurredAt,
        {
          contactId: item.contactId,
          siteId: site.id,
          visitorId: item.visitorId,
          hostname: item.hostname,
          path: item.path,
          url: typeof item.params?.['url'] === 'string' ? item.params['url'] : null,
        },
      );
      if (event !== null) engineEvents.push(event);
    }
  }
  if (engineEvents.length > 0 && ports.engine !== null) await ports.engine(engineEvents);
  report.automationEvents += ports.engine === null ? 0 : engineEvents.length;

  // 3. goal alerts (one delivery per alert per minute, completions aggregated)
  const ackAlerts: number[] = [];
  const groups = new Map<string, AlertItem[]>();
  for (const a of work.alerts) {
    const list = groups.get(a.alertId) ?? [];
    list.push(a);
    groups.set(a.alertId, list);
  }
  for (const [alertId, items] of groups) {
    const target = work.alertTargets.find((t) => t.id === alertId);
    const test = items.some((i) => i.test);
    if (target === undefined || (!target.enabled && !test)) {
      ackAlerts.push(...items.map((i) => i.id));
      continue;
    }
    const now = ports.now();
    if (!test && target.lastTriggeredAt !== null && now - target.lastTriggeredAt < ALERT_THROTTLE_MS) continue;
    const real = items.filter((i) => !i.test);
    const payload: AlertWebhookPayload = {
      type: 'analytics.goal_alert',
      alert_id: alertId,
      site_id: site.id,
      goal: target.goal,
      count: real.length,
      first_at: new Date(Math.min(...items.map((i) => i.ts))).toISOString(),
      last_at: new Date(Math.max(...items.map((i) => i.ts))).toISOString(),
      visitor_ids: [...new Set(real.map((i) => i.visitorId).filter((v): v is string => v !== null))].slice(0, 50),
      test: real.length === 0,
    };
    const results = await ports.deliverAlert({
      tenantId,
      site: { id: site.id, name: site.record.site.name },
      alert: target,
      payload,
    });
    await stub.recordAlertDelivery(alertId, results);
    report.alertsDelivered += results.filter((r) => r.ok).length;
    ackAlerts.push(...items.map((i) => i.id));
  }

  await stub.ackCoreWork({
    identities: work.identities.map((i) => i.id),
    automation: work.automation.map((i) => i.id),
    alerts: ackAlerts,
  });
}

/** One synchronisation pass of a tenant (no-op while another pass holds the lease). */
export async function syncTenant(ports: SyncPorts, tenantId: string): Promise<SyncReport> {
  const report: SyncReport = {
    outboxEvents: 0,
    facts: 0,
    linked: 0,
    automationEvents: 0,
    alertsDelivered: 0,
    skipped: false,
  };
  const tenant = tenantSitesStub(ports.ns, tenantId);
  const holder = crypto.randomUUID();
  if (!(await tenant.acquireSyncLease(holder, LEASE_MS))) return { ...report, skipped: true };
  try {
    const sites = await activeSites(ports.ns, tenantId);
    if (sites.length === 0) return report;
    await syncOutbox(ports, tenantId, sites, report);
    const started = ports.now();
    for (const site of sites) {
      await drainSite(ports, tenantId, site, report);
      await tenant.clearDirtySite(site.id, started);
    }
    return report;
  } finally {
    await tenant.releaseSyncLease(holder);
  }
}

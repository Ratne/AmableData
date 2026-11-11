import { z } from '@hono/zod-openapi';
import {
  serverEventSchema,
  suppressionOutcomeSchema,
  suppressionRequestSchema,
  v1LeadResultSchema,
  v1LeadSchema,
  v1RefundResultSchema,
  v1RefundSchema,
  v1SaleResultSchema,
  v1SaleSchema,
  type V1Lead,
  type V1Sale,
} from '@amable/api-types';
import {
  enrichServerEvent,
  eventIdOf,
  normalizePhoneKey,
  occurredAt,
  siteStub,
  tenantSitesStub,
  toMinor,
  type AnalyticsNamespace,
  type ProfileField,
  type RegistryMessage,
} from '@amable/app-edge/analytics';
import type { Context } from 'hono';
import { callCrm, createCrmRouter, crmRoute, idempotency, json, jsonBody } from '../crm/api/core';
import { CrmError } from '../crm/errors';
import { getTenant, HttpError, type AppEnv } from '../middleware';
import { registerTenant } from './registry';
import { runSuppression } from './routes-suppressions';
import { syncPorts } from './runtime';
import type { SaleDecision } from './sales-ops';
import { ingestServerEvents } from './server-ingest';
import { edgeUnreachableAs503 } from './service';
import { dispatchRefund, dispatchSale } from './sales-dispatch';
import { applyBatch, FactBatch, type SyncPorts } from './sync';

/**
 * Workspace server API (`/api/v1`): leads, sales and events from the client's
 * backend, authenticated by a workspace API key with `tracking:ingest`.
 *
 * Placement of a lead or sale: the given `site_id`, else the site that knows
 * `visitor_id`, else the site where a visitor linked to the contact was seen
 * last; a sale's placement is stored with the sale and reused on every retry.
 */

type Ctx = Context<AppEnv>;

function ns(c: Ctx): AnalyticsNamespace {
  const namespace = c.env.ANALYTICS;
  if (namespace === undefined) throw new HttpError(503, 'analytics_unavailable');
  return namespace;
}

function tenantIdOf(c: Ctx): string {
  return getTenant(c).tenant.id;
}

function portsOf(c: Ctx): SyncPorts {
  return syncPorts(c.env, ns(c), tenantIdOf(c));
}

interface Placement {
  siteId: string | null;
  visitorId: string | null;
  decidedBy: SaleDecision;
}

async function checkedSite(c: Ctx, siteId: string | undefined): Promise<string | null> {
  if (siteId === undefined) return null;
  const sites = await tenantSitesStub(ns(c), tenantIdOf(c)).indexList();
  if (!sites.includes(siteId)) throw new CrmError('not_found', `site ${siteId} not found`);
  return siteId;
}

/** Site of a tracker visitor id: its contact link first, then every site of the workspace. */
async function siteOfVisitor(c: Ctx, visitorId: string): Promise<string | null> {
  const tenant = tenantSitesStub(ns(c), tenantIdOf(c));
  const linked = await tenant.contactsOfVisitors([visitorId]);
  if (linked[0] !== undefined) return linked[0].siteId;
  for (const siteId of await tenant.indexList()) {
    if ((await siteStub(ns(c), siteId).knownVisitors([visitorId])).length > 0) return siteId;
  }
  return null;
}

/** Visitor of the contact seen most recently, over every site (null when never linked). */
async function lastTouch(
  c: Ctx,
  contactId: string,
  onlySite: string | null,
): Promise<{ siteId: string; visitorId: string } | null> {
  const links = await tenantSitesStub(ns(c), tenantIdOf(c)).visitorsOfContact(contactId);
  const bySite = new Map<string, string[]>();
  for (const l of links) {
    if (onlySite !== null && l.siteId !== onlySite) continue;
    bySite.set(l.siteId, [...(bySite.get(l.siteId) ?? []), l.visitorId]);
  }
  let best: { siteId: string; visitorId: string; lastSeen: number } | null = null;
  for (const [siteId, ids] of bySite) {
    for (const v of await siteStub(ns(c), siteId).visitorsLastSeen(ids)) {
      if (best === null || v.lastSeen > best.lastSeen)
        best = { siteId, visitorId: v.visitorId, lastSeen: v.lastSeen };
    }
  }
  return best === null ? null : { siteId: best.siteId, visitorId: best.visitorId };
}

async function place(
  c: Ctx,
  input: { site_id?: string | undefined; visitor_id?: string | undefined },
  contactId: string | null,
): Promise<Placement> {
  const forced = await checkedSite(c, input.site_id);
  const visitorId = input.visitor_id ?? null;
  if (forced !== null) {
    if (visitorId !== null) return { siteId: forced, visitorId, decidedBy: 'forced' };
    const touch = contactId === null ? null : await lastTouch(c, contactId, forced);
    return { siteId: forced, visitorId: touch?.visitorId ?? null, decidedBy: 'forced' };
  }
  if (visitorId !== null) {
    const siteId = await siteOfVisitor(c, visitorId);
    if (siteId !== null) return { siteId, visitorId, decidedBy: 'visitor' };
  }
  const touch = contactId === null ? null : await lastTouch(c, contactId, null);
  if (touch !== null) return { ...touch, decidedBy: 'last_touch' };
  return { siteId: null, visitorId: null, decidedBy: 'unattributed' };
}

/** Site where the browser already recorded this transaction: the sale joins that payment. */
async function siteOfPayment(c: Ctx, transactionId: string): Promise<Placement | null> {
  for (const siteId of await tenantSitesStub(ns(c), tenantIdOf(c)).indexList()) {
    const payment = await siteStub(ns(c), siteId).paymentOf(transactionId);
    if (payment !== null) return { siteId, visitorId: payment.visitorId, decidedBy: 'existing' };
  }
  return null;
}

function profileOf(input: V1Lead | V1Sale): Partial<Record<ProfileField, string>> {
  const profile: Partial<Record<ProfileField, string>> = {};
  const set = (field: ProfileField, value: string | undefined) => {
    if (value !== undefined) profile[field] = value;
  };
  set('given_name', input.first_name);
  set('family_name', input.last_name);
  set('full_name', input.name);
  set('street', input.street);
  set('city', input.city);
  set('region', input.region);
  set('postal_code', input.postal_code);
  set('country', input.country);
  return profile;
}

/** Creates or enriches the contact of the call (no contact data: null). */
async function registerContact(
  c: Ctx,
  ports: SyncPorts,
  eid: string,
  source: 'lead' | 'sale',
  input: V1Lead | V1Sale,
  visitor: { siteId: string; visitorId: string } | null,
  ts: number,
): Promise<{ contactId: string | null; created: boolean }> {
  const email = input.email?.trim().toLowerCase() ?? null;
  const phone = input.phone === undefined ? null : normalizePhoneKey(input.phone);
  if (input.phone !== undefined && phone === null) {
    throw new CrmError('validation_failed', 'phone: not a valid phone number');
  }
  const profile = profileOf(input);
  if (email === null && phone === null && (visitor === null || Object.keys(profile).length === 0)) {
    return { contactId: null, created: false };
  }
  const message: RegistryMessage = {
    v: 1,
    eid,
    tenantId: tenantIdOf(c),
    siteId: visitor?.siteId ?? '',
    visitorId: visitor?.visitorId ?? null,
    ts,
    source,
    email,
    phone,
    userId: null,
    profile,
  };
  const [result] = await registerTenant(ports, tenantIdOf(c), [message]);
  return { contactId: result?.contactId ?? null, created: result?.created ?? false };
}

/** Visitor given by the caller, located on its site (null when no site knows it yet). */
async function givenVisitor(
  c: Ctx,
  input: { site_id?: string | undefined; visitor_id?: string | undefined },
): Promise<{ siteId: string; visitorId: string } | null> {
  if (input.visitor_id === undefined) return null;
  const siteId =
    (await checkedSite(c, input.site_id)) ?? (await siteOfVisitor(c, input.visitor_id));
  return siteId === null ? null : { siteId, visitorId: input.visitor_id };
}

const tags = ['Server API'];

export const v1Api = createCrmRouter();
v1Api.use('*', edgeUnreachableAs503());
v1Api.use('*', idempotency());

v1Api.openapi(
  crmRoute('tracking:ingest', {
    method: 'post',
    path: '/leads',
    tags,
    summary: 'Record a lead',
    description:
      'Creates or enriches the contact (email, phone, name, address) and records a `lead` goal on its visitor — `visitor_id`, or the contact visitor seen last. `event_id` (or `Idempotency-Key`) makes retries no-ops.',
    request: { body: jsonBody(v1LeadSchema) },
    responses: { 201: json(v1LeadResultSchema, 'Lead recorded') },
  }),
  async (c) => {
    const input = c.req.valid('json');
    const ports = portsOf(c);
    const now = ports.now();
    const ts = occurredAt(input.occurred_at, now);
    const eid = `v1lead:${input.event_id ?? crypto.randomUUID()}`;
    const visitor = await givenVisitor(c, input);
    const { contactId, created } = await registerContact(c, ports, eid, 'lead', input, visitor, ts);
    const target = await place(c, input, contactId);
    if (target.siteId !== null && target.visitorId !== null) {
      const params: Record<string, string | number | boolean> = { ...(input.params ?? {}) };
      if (input.source !== undefined) params.source = input.source;
      const batch = new FactBatch();
      batch.add(target.siteId, {
        kind: 'goal',
        id: eid,
        name: 'lead',
        contactId,
        visitorId: target.visitorId,
        params: Object.keys(params).length === 0 ? null : params,
        ts,
      });
      await applyBatch(ports, tenantIdOf(c), batch);
    }
    return c.json(
      { contact_id: contactId, created, site_id: target.siteId, visitor_id: target.visitorId },
      201,
    );
  },
);

v1Api.openapi(
  crmRoute('tracking:ingest', {
    method: 'post',
    path: '/sales',
    tags,
    summary: 'Record a sale',
    description:
      'One sale per `transaction_id`: the contact is created or enriched, the site is decided once (`site_id`, the visitor site, or the contact visitor seen last) and stored; a retry returns the stored sale with `duplicate: true`. A browser purchase already recorded with the same transaction id is the same payment: the sale stays on its site (`attribution: existing`).',
    request: { body: jsonBody(v1SaleSchema) },
    responses: {
      201: json(v1SaleResultSchema, 'Sale recorded'),
      200: json(v1SaleResultSchema, 'Sale already recorded'),
    },
  }),
  async (c) => {
    const input = c.req.valid('json');
    const ports = portsOf(c);
    const amountMinor = toMinor(input.amount, input.currency);
    let sale = await callCrm(c, 'analytics.getSale', { transactionId: input.transaction_id });
    let duplicate = sale !== null;
    if (sale === null) {
      const ts = occurredAt(input.occurred_at, ports.now());
      const visitor = await givenVisitor(c, input);
      const eid = `v1sale:${input.transaction_id}`;
      const { contactId } = await registerContact(c, ports, eid, 'sale', input, visitor, ts);
      const target =
        (await siteOfPayment(c, input.transaction_id)) ?? (await place(c, input, contactId));
      const recorded = await callCrm(c, 'analytics.recordSale', {
        transactionId: input.transaction_id,
        contactId,
        amountMinor,
        currency: input.currency,
        orderId: input.order_id ?? null,
        renewal: input.renewal ?? false,
        occurredAt: ts,
        siteId: target.siteId,
        visitorId: target.visitorId,
        decidedBy: target.decidedBy,
      });
      sale = recorded.sale;
      duplicate = !recorded.created;
    }
    if (duplicate && (sale.amount_minor !== amountMinor || sale.currency !== input.currency)) {
      throw new CrmError(
        'conflict',
        `transaction ${input.transaction_id} was recorded with a different amount`,
      );
    }
    await dispatchSale(ports, tenantIdOf(c), sale.transaction_id);
    return c.json(
      {
        transaction_id: sale.transaction_id,
        contact_id: sale.contact_id,
        site_id: sale.site_id,
        visitor_id: sale.visitor_id,
        attribution: sale.decided_by,
        duplicate,
      },
      duplicate ? 200 : 201,
    );
  },
);

const fromMinor = (minor: number, currency: string) => minor / toMinor(1, currency);

v1Api.openapi(
  crmRoute('tracking:ingest', {
    method: 'post',
    path: '/sales/{transaction_id}/refunds',
    tags,
    summary: 'Refund a sale',
    description:
      'Once per `refund_id`; without `amount` the rest of the sale is refunded (capped at what is left). Applied on the site the sale went to.',
    request: {
      params: z.object({ transaction_id: z.string().min(1).max(255) }),
      body: jsonBody(v1RefundSchema),
    },
    responses: {
      201: json(v1RefundResultSchema, 'Refund recorded'),
      200: json(v1RefundResultSchema, 'Refund already recorded'),
    },
  }),
  async (c) => {
    const { transaction_id: transactionId } = c.req.valid('param');
    const input = c.req.valid('json');
    const ports = portsOf(c);
    const current = await callCrm(c, 'analytics.getSale', { transactionId });
    if (current === null) throw new CrmError('not_found', `sale ${transactionId} not found`);
    const { refund, sale, created } = await callCrm(c, 'analytics.recordRefund', {
      refundId: input.refund_id,
      transactionId,
      amountMinor: input.amount === undefined ? null : toMinor(input.amount, current.currency),
      occurredAt: occurredAt(input.occurred_at, ports.now()),
    });
    await dispatchRefund(ports, tenantIdOf(c), refund.refund_id);
    return c.json(
      {
        refund_id: refund.refund_id,
        transaction_id: transactionId,
        amount: fromMinor(refund.amount_minor, sale.currency),
        refunded_total: fromMinor(sale.refunded_minor, sale.currency),
        duplicate: !created,
      },
      created ? 201 : 200,
    );
  },
);

v1Api.openapi(
  crmRoute('tracking:ingest', {
    method: 'post',
    path: '/suppressions',
    tags,
    summary: 'Opt a person out of web tracking',
    description:
      'Forwards an opt-out or erasure request from the client backend: same contract as the workspace suppressions (visitor id, contact id, email or phone). `purge` (erasure, irreversible) also needs `tracking:erase` on the key; without it send `purge: false`.',
    request: { body: jsonBody(suppressionRequestSchema) },
    responses: { 200: json(suppressionOutcomeSchema, 'Applied on every site') },
  }),
  async (c) => {
    const input = c.req.valid('json');
    if (input.purge && !getTenant(c).can('tracking:erase')) {
      throw new HttpError(403, 'forbidden', { missing: ['tracking:erase'] });
    }
    return c.json(await runSuppression(c, input), 200);
  },
);

const v1EventSchema = z
  .object({ site_id: z.string().min(1).max(64) })
  .and(serverEventSchema.refine((e) => e.type !== 'crawler', 'crawler hits go to /e/server'));

v1Api.openapi(
  crmRoute('tracking:ingest', {
    method: 'post',
    path: '/events',
    tags,
    summary: 'Send a server event to a site',
    description:
      'Goals, payments, identify and server-side pageviews of one site (`site_id`), with the same contract as the site ingest: contact data goes to the workspace, the site receives hashes. `event_id` makes retries no-ops.',
    request: { body: jsonBody(v1EventSchema) },
    responses: { 202: json(z.object({ ok: z.literal(true) }), 'Event accepted') },
  }),
  async (c) => {
    const { site_id: siteId, ...event } = c.req.valid('json');
    await checkedSite(c, siteId);
    const config = await siteStub(ns(c), siteId).edgeConfig();
    if (config === null || config.tenantId !== tenantIdOf(c)) {
      throw new CrmError('not_found', `site ${siteId} not found`);
    }
    const now = Date.now();
    const pageview = event.type === 'pageview';
    const enriched = await enrichServerEvent(event, config, {
      eid: eventIdOf('server', event.type, event.event_id),
      now,
      ts: occurredAt(event.occurred_at, now),
      ip: pageview ? event.ip : '0.0.0.0',
      userAgent: pageview ? event.user_agent : '',
      geo: { country: null, region: null, city: null, latitude: null, longitude: null },
    });
    await ingestServerEvents(c.env, ns(c), config, [enriched]);
    return c.json({ ok: true as const }, 202);
  },
);

import { signContactToken, type AutomationInboundEvent } from '@amable/core';
import type { AnalyticsNamespace } from '@amable/app-edge/analytics';
import { verifyWebhook } from '@amable/auth';
import { monotonicFactory } from 'ulid';
import { beforeEach, describe, expect, it } from 'vitest';
import { ev, FakeAnalyticsNamespace, siteInit, T0 } from '../../../edge/test/helpers';
import { deliverAlert, type AlertTransport } from '../../src/analytics/alerts';
import { syncTenant, type AlertDelivery, type SyncPorts } from '../../src/analytics/sync';
import type { CrmOpName } from '../../src/crm/ops';
import { createTestTenant, type TestTenant } from '../crm/helpers';

const TENANT = 'tenant_1';
const SITE = 'st_aaaaaaaaaaaaaaaaaaaa';
const SITE_B = 'st_bbbbbbbbbbbbbbbbbbbb';
const SECRET = 'test-contact-token-secret';
const MIN = 60_000;
const range = { from: '2026-10-01', to: '2026-10-31' };

interface World {
  ns: FakeAnalyticsNamespace;
  t: TestTenant;
  clock: { now: number };
  engine: AutomationInboundEvent[];
  alerts: AlertDelivery[];
  ports: SyncPorts;
  emit(type: string, payload: Record<string, unknown>, at?: number): void;
}

function world(): World {
  const clock = { now: T0 + 10 * MIN };
  const ns = new FakeAnalyticsNamespace(() => clock.now);
  const t = createTestTenant();
  const engine: AutomationInboundEvent[] = [];
  const alerts: AlertDelivery[] = [];
  const nextId = monotonicFactory();
  ns.store(`site:${SITE}`).initSite(siteInit());
  ns.store(`tenant:${TENANT}`).indexAdd(SITE);
  return {
    ns,
    t,
    clock,
    engine,
    alerts,
    ports: {
      ns: ns as unknown as AnalyticsNamespace,
      crm: <T>(op: string, input: unknown) => Promise.resolve(structuredClone(t.op(op as CrmOpName, input as never)) as T),
      engine: (events) => {
        engine.push(...events);
        return Promise.resolve();
      },
      contactTokenSecrets: [SECRET],
      deliverAlert: (d) => {
        alerts.push(d);
        return Promise.resolve([{ channel: 'webhook' as const, ok: true }]);
      },
      now: () => clock.now,
    },
    emit(type, payload, at = clock.now) {
      t.db.run(
        `INSERT INTO crm_outbox (id, type, payload, actor_type, actor_id, occurred_at) VALUES (?, ?, ?, 'system', NULL, ?)`,
        nextId(at),
        type,
        JSON.stringify(payload),
        at,
      );
    },
  };
}

const site = (w: World) => w.ns.store(`site:${SITE}`);
const revenue = (w: World, s = site(w)): number => {
  const o = s.overview(range);
  return o.ok ? o.value.revenue_minor : -1;
};

describe('CRM → analytics sync', () => {
  let w: World;
  beforeEach(() => {
    w = world();
    site(w).ingest([ev({ vid: 'visitor-1', sid: 's1', ts: T0, channel: 'Email' })], []);
  });

  it('links visitors from form submissions and attributes CRM payments (idempotent)', async () => {
    w.emit('form.submitted', { formId: 'f1', submissionId: 'sub1', contactId: 'c1', visitorId: 'visitor-1', fields: {}, source: {}, contactCreated: true });
    w.emit('payment.recorded', {
      paymentId: 'pay1', orderId: 'o1', contactId: 'c1', visitorId: null, amountMinor: 4900, currency: 'EUR',
      method: 'card', transactionId: null, subscriptionId: null, renewal: false,
    });
    const first = await syncTenant(w.ports, TENANT);
    expect(first).toMatchObject({ outboxEvents: 2, linked: 1, skipped: false });
    expect(revenue(w)).toBe(4900);
    expect(await w.ns.get(w.ns.idFromName(`tenant:${TENANT}`))['visitorsOfContact']?.('c1' as never)).toEqual([
      expect.objectContaining({ siteId: SITE, visitorId: 'visitor-1', source: 'form' }),
    ]);
    // Re-running (cursor lookback re-reads the same events) changes nothing.
    const again = await syncTenant(w.ports, TENANT);
    expect(again.outboxEvents).toBe(0);
    expect(revenue(w)).toBe(4900);
    // A refund of that payment, then a lifecycle goal of a subscription.
    w.clock.now += MIN;
    w.emit('refund.recorded', { refundId: 'r1', orderId: 'o1', paymentId: 'pay1', transactionId: null, full: false, contactId: 'c1', amountMinor: 900, currency: 'EUR', visitorId: null });
    w.emit('subscription.trial_started', { subscriptionId: 'sub1', productId: 'p', planId: 'pl', interval: 'month', intervalCount: 1, contactId: 'c1', amountMinor: 1000, currency: 'EUR', visitorId: null, trialEndsAt: 'x' });
    await syncTenant(w.ports, TENANT);
    expect(revenue(w)).toBe(4000);
    const goals = site(w).breakdown(range, 'goal', 10);
    expect(goals.ok && goals.value.rows.map((r) => r.value).sort()).toEqual(['payment', 'trial_started']);
  });

  it('links visitors from bookings; unknown visitors and missing ids link nothing', async () => {
    const facts = {
      appointmentId: 'apt1', bookingId: 'bkg1', eventTypeId: 'et1', calendarId: 'cal1', ownerId: 'u1',
      startsAt: new Date(T0 + 86_400_000).toISOString(), endsAt: new Date(T0 + 86_400_000 + 1_800_000).toISOString(),
      timeZone: 'Europe/Rome', source: {},
    };
    w.emit('appointment.booked', { ...facts, contactId: 'c2', visitorId: 'visitor-1' });
    w.emit('appointment.booked', { ...facts, bookingId: 'bkg2', contactId: 'c3', visitorId: 'visitor-unknown' });
    w.emit('appointment.booked', { ...facts, bookingId: 'bkg3', contactId: 'c4', visitorId: null });
    const r = await syncTenant(w.ports, TENANT);
    expect(r).toMatchObject({ outboxEvents: 3, linked: 1 });
    expect(site(w).visitorProfile('visitor-1')?.visitor.contact_id).toBe('c2');
    expect(await w.ns.get(w.ns.idFromName(`tenant:${TENANT}`))['visitorsOfContact']?.('c2' as never)).toEqual([
      expect.objectContaining({ siteId: SITE, visitorId: 'visitor-1', source: 'booking' }),
    ]);
  });

  it('sends unattributed revenue to the first site and refunds it across sites', async () => {
    w.ns.store(`site:${SITE_B}`).initSite(siteInit({ siteId: SITE_B }));
    w.ns.store(`tenant:${TENANT}`).indexAdd(SITE_B);
    w.emit('payment.recorded', { paymentId: 'pay9', orderId: 'o9', contactId: 'cx', visitorId: null, amountMinor: 1000, currency: 'EUR', method: 'cash', transactionId: null, subscriptionId: null, renewal: false });
    w.emit('refund.recorded', { refundId: 'r9', orderId: 'o9', paymentId: null, transactionId: null, full: true, contactId: 'cx', amountMinor: 1000, currency: 'EUR', visitorId: null });
    w.emit('payment.recorded', { paymentId: 'pay10', orderId: 'o10', contactId: 'cx', visitorId: null, amountMinor: 700, currency: 'EUR', method: 'cash', transactionId: null, subscriptionId: null, renewal: false });
    await syncTenant(w.ports, TENANT);
    expect(revenue(w)).toBe(700);
    expect(revenue(w, w.ns.store(`site:${SITE_B}`))).toBe(0);
  });

  it('resolves identify emails and email-click tokens to contacts', async () => {
    const ann = w.t.op('contacts.create', { given_name: 'Ann', emails: [{ email: 'ann@example.com' }] });
    const bob = w.t.op('contacts.create', { given_name: 'Bob', emails: [{ email: 'bob@example.com' }] });
    const token = await signContactToken(SECRET, TENANT, bob.id, w.clock.now);
    const foreign = await signContactToken(SECRET, 'other_tenant', bob.id, w.clock.now);
    const forged = await signContactToken('wrong-secret', TENANT, bob.id, w.clock.now);
    site(w).ingest(
      [
        ev({ vid: 'visitor-1', sid: 's1', ts: T0 + MIN, type: 'identify', identity: { userId: 'u', email: 'Ann@Example.com', name: null, traits: null } }),
        ev({ vid: 'visitor-2', sid: 's2', ts: T0 + MIN, contactToken: token }),
        ev({ vid: 'visitor-3', sid: 's3', ts: T0 + MIN, contactToken: foreign }),
        ev({ vid: 'visitor-4', sid: 's4', ts: T0 + MIN, contactToken: forged }),
      ],
      [],
    );
    const r = await syncTenant(w.ports, TENANT);
    expect(r.linked).toBe(2);
    expect(site(w).visitorProfile('visitor-1')?.visitor.contact_id).toBe(ann.id);
    expect(site(w).visitorProfile('visitor-2')?.visitor.contact_id).toBe(bob.id);
    expect(site(w).visitorProfile('visitor-3')?.visitor.contact_id).toBeNull();
    expect(site(w).visitorProfile('visitor-4')?.visitor.contact_id).toBeNull();
    expect(site(w).hasCoreWork()).toBe(false);
  });

  it('publishes web goals of identified visitors to the automation engine', async () => {
    w.emit('form.submitted', { formId: 'f1', submissionId: 'sub1', contactId: 'c1', visitorId: 'visitor-1', fields: {}, source: {}, contactCreated: false });
    await syncTenant(w.ports, TENANT);
    site(w).ingest(
      [
        ev({ vid: 'visitor-1', sid: 's1', ts: T0 + 2 * MIN, type: 'goal', name: 'webinar_signup' }),
        ev({ vid: 'visitor-1', sid: 's1', ts: T0 + 3 * MIN, path: '/thanks' }),
      ],
      [],
    );
    await syncTenant(w.ports, TENANT);
    const goals = w.engine.filter((e) => e.type === 'analytics.goal');
    expect(goals).toEqual([
      expect.objectContaining({
        type: 'analytics.goal',
        payload: { contactId: 'c1', siteId: SITE, goalName: 'webinar_signup' },
      }),
    ]);
    expect(goals[0]?.id).toMatch(/^an_[0-9a-f]{32}$/);
    // Stable ids: the engine dedupes a redelivery.
    expect(new Set(w.engine.map((e) => e.id)).size).toBe(w.engine.length);
  });

  it('delivers goal alerts once per minute with aggregated completions', async () => {
    const created = site(w).createAlert(
      { name: 'Signups', goal: 'signup', enabled: true, email_recipients: [], webhook_url: 'https://hooks.example.com/x' },
      'whsec_test',
    );
    site(w).ingest(
      [
        ev({ vid: 'visitor-1', sid: 's1', ts: T0 + MIN, type: 'goal', name: 'signup' }),
        ev({ vid: 'visitor-9', sid: 's9', ts: T0 + 2 * MIN, type: 'goal', name: 'signup' }),
      ],
      [],
    );
    await syncTenant(w.ports, TENANT);
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0]?.payload).toMatchObject({ goal: 'signup', count: 2, test: false, visitor_ids: ['visitor-1', 'visitor-9'] });
    // Throttled: a new completion within the minute waits for the next pass.
    site(w).ingest([ev({ vid: 'visitor-1', sid: 's1', ts: T0 + 3 * MIN, type: 'goal', name: 'signup' })], []);
    await syncTenant(w.ports, TENANT);
    expect(w.alerts).toHaveLength(1);
    w.clock.now += 2 * MIN;
    await syncTenant(w.ports, TENANT);
    expect(w.alerts).toHaveLength(2);
    expect(site(w).listAlerts()[0]).toMatchObject({ id: created.alert.id, deliveries_24h: 2 });
    // Test deliveries bypass the throttle.
    site(w).testAlert(created.alert.id);
    await syncTenant(w.ports, TENANT);
    expect(w.alerts.at(-1)?.payload).toMatchObject({ test: true, count: 0 });
  });

  it('skips a pass while another one holds the lease', async () => {
    w.ns.store(`tenant:${TENANT}`).acquireSyncLease('someone-else', 60_000);
    expect((await syncTenant(w.ports, TENANT)).skipped).toBe(true);
  });
});

describe('alert delivery', () => {
  it('emails members only and signs webhooks', async () => {
    const sent: string[] = [];
    const posts: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    const transport: AlertTransport = {
      email: { send: (m) => (sent.push(m.to), Promise.resolve()) },
      memberEmails: () => Promise.resolve(new Set(['owner@example.com'])),
      post: (url, body, headers) => (posts.push({ url, body, headers }), Promise.resolve(200)),
      now: () => T0,
      appOrigin: 'https://app.example.com',
    };
    const results = await deliverAlert(transport, {
      tenantId: TENANT,
      site: { id: SITE, name: 'Example' },
      alert: {
        id: 'al_1',
        name: 'Signups',
        goal: 'signup',
        enabled: true,
        emailRecipients: ['owner@example.com', 'stranger@evil.test'],
        webhookUrl: 'https://hooks.example.com/x',
        webhookSecret: 'whsec_1',
        lastTriggeredAt: null,
      },
      payload: {
        type: 'analytics.goal_alert',
        alert_id: 'al_1',
        site_id: SITE,
        goal: 'signup',
        count: 1,
        first_at: new Date(T0).toISOString(),
        last_at: new Date(T0).toISOString(),
        visitor_ids: ['v'],
        test: false,
      },
    });
    expect(results).toEqual([
      { channel: 'email', ok: true },
      { channel: 'webhook', ok: true },
    ]);
    expect(sent).toEqual(['owner@example.com']);
    const post = posts[0];
    if (post === undefined) throw new Error('no webhook');
    const verified = await verifyWebhook({
      secrets: ['whsec_1'],
      header: post.headers['Amable-Signature'] ?? null,
      rawBody: post.body,
      nowMs: T0,
    });
    expect(verified).toEqual({ ok: true });
  });
});

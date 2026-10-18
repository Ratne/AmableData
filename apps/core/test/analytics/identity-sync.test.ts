import type { AnalyticsNamespace } from '@amable/app-edge/analytics';
import { monotonicFactory } from 'ulid';
import { describe, expect, it } from 'vitest';
import { ev, FakeAnalyticsNamespace, siteInit, T0 } from '../../../edge/test/helpers';
import { syncTenant, type SyncPorts } from '../../src/analytics/sync';
import type { CrmOpName } from '../../src/crm/ops';
import { createTestTenant } from '../crm/helpers';

const TENANT = 'tenant_1';
const SITE = 'st_aaaaaaaaaaaaaaaaaaaa';
const MIN = 60_000;
const DAY = 86_400_000;

describe('CRM → analytics identity keys', () => {
  it('sends the emails and phones of linked contacts, merging the visitor with an earlier device', async () => {
    const clock = { now: T0 + 3 * DAY };
    const ns = new FakeAnalyticsNamespace(() => clock.now);
    const t = createTestTenant();
    const nextId = monotonicFactory();
    const site = ns.store(`site:${SITE}`);
    site.initSite(siteInit());
    ns.store(`tenant:${TENANT}`).indexAdd(SITE);
    const ports: SyncPorts = {
      ns: ns as unknown as AnalyticsNamespace,
      crm: <T>(op: string, input: unknown) => Promise.resolve(structuredClone(t.op(op as CrmOpName, input as never)) as T),
      engine: null,
      contactTokenSecrets: [],
      deliverAlert: () => Promise.resolve([]),
      now: () => clock.now,
    };

    // Day 0: anonymous click and phone opt-in on the phone browser.
    site.ingest([ev({ vid: 'v-mobile', sid: 's-m', ts: T0, firstSeen: T0 })], []);
    site.recordTouch({
      id: 'hit_1', ts: T0, visitor_id: 'v-mobile', session_id: 's-m', funnel_id: 'fg_1', node_id: 'n1',
      traffic_source_id: 'ts_paid', kind: 'entrance',
    });
    site.ingest(
      [ev({ vid: 'v-mobile', sid: 's-m', ts: T0 + MIN, type: 'identify', identity: { userId: null, email: null, name: null, traits: { phone: '+39 333 123 4567' } } })],
      [],
    );
    // Day 3: the desktop visitor submits a form; the CRM contact holds the same phone.
    site.ingest([ev({ vid: 'v-desktop', sid: 's-d', ts: clock.now, firstSeen: clock.now })], []);
    const contact = t.op('contacts.create', {
      given_name: 'Mario',
      emails: [{ email: 'Mario@Example.com' }],
      phones: [{ number: '+39 333 1234567' }],
    });
    t.db.run(
      `INSERT INTO crm_outbox (id, type, payload, actor_type, actor_id, occurred_at) VALUES (?, 'form.submitted', ?, 'system', NULL, ?)`,
      nextId(clock.now),
      JSON.stringify({ formId: 'f1', submissionId: 'sub1', contactId: contact.id, visitorId: 'v-desktop', fields: {}, source: {}, contactCreated: true }),
      clock.now,
    );

    expect(await syncTenant(ports, TENANT)).toMatchObject({ linked: 1 });
    expect(site.findVisitorsByKey('phone', '+393331234567').map((k) => k.visitor_id).sort()).toEqual(['v-desktop', 'v-mobile']);
    expect(site.findVisitorsByKey('email', 'mario@example.com').map((k) => k.visitor_id)).toEqual(['v-desktop']);
    expect(site.resolveVisitorGroup('v-desktop')).toEqual(['v-mobile', 'v-desktop']);
    expect(site.listTouchesByVisitor(site.resolveVisitorGroup('v-desktop')).map((x) => x.traffic_source_id)).toEqual(['ts_paid']);
    const journey = site.contactActivity(contact.id, 50);
    expect(journey?.merged_visitor_ids).toEqual(['v-mobile']);
    expect(journey?.funnel_touches?.map((x) => x.id)).toEqual(['hit_1']);
  });
});

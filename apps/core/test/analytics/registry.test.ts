import {
  splitPii,
  type AnalyticsNamespace,
  type RegistryMessage,
} from '@amable/app-edge/analytics';
import { beforeEach, describe, expect, it } from 'vitest';
import { ev, FakeAnalyticsNamespace, siteInit, T0 } from '../../../edge/test/helpers';
import { registerTenant } from '../../src/analytics/registry';
import { syncTenant, type SyncPorts } from '../../src/analytics/sync';
import type { CrmOpName } from '../../src/crm/ops';
import { createTestTenant } from '../crm/helpers';

const TENANT = 'tenant_1';
const SITE = 'st_aaaaaaaaaaaaaaaaaaaa';
const MIN = 60_000;

let ns: FakeAnalyticsNamespace;
let t: ReturnType<typeof createTestTenant>;
let ports: SyncPorts;
const site = () => ns.store(`site:${SITE}`);

beforeEach(() => {
  ns = new FakeAnalyticsNamespace(() => T0 + 10 * MIN);
  t = createTestTenant();
  site().initSite(siteInit());
  ns.store(`tenant:${TENANT}`).indexAdd(SITE);
  ports = {
    ns: ns as unknown as AnalyticsNamespace,
    crm: <T>(op: string, input: unknown) =>
      Promise.resolve(structuredClone(t.op(op as CrmOpName, input as never)) as T),
    engine: null,
    contactTokenSecrets: [],
    deliverAlert: () => Promise.resolve([]),
    now: () => T0 + 10 * MIN,
  };
});

/** An identify as the edge produces it: the hashed event for the site, the clear data for the registry. */
function identify(
  vid: string,
  ts: number,
  data: { email?: string; name?: string; traits?: Record<string, string> },
) {
  const event = ev({
    vid,
    sid: `s-${vid}`,
    ts,
    type: 'identify',
    identity: {
      userId: null,
      email: data.email ?? null,
      name: data.name ?? null,
      traits: data.traits ?? null,
    },
  });
  const registry = splitPii(event, TENANT) as RegistryMessage;
  return { event, registry };
}

function contactRow(id: string) {
  return t.db.all<{ given_name: string | null; family_name: string | null; source_type: string }>(
    `SELECT given_name, family_name, source_type FROM crm_contacts WHERE id = ?`,
    id,
  )[0];
}

describe('web registry', () => {
  it('creates the contact from the clear data and links the visitor; replays are no-ops', async () => {
    const a = identify('v-1', T0, {
      email: 'Ada@Example.com',
      name: 'Ada Lovelace',
      traits: { phone: '+39 333 123 4567', city: 'Milano', plan: 'pro' },
    });
    site().ingest([ev({ vid: 'v-1', sid: 's-v-1', ts: T0 - MIN }), a.event], []);
    const [r] = await registerTenant(ports, TENANT, [a.registry]);
    expect(r?.created).toBe(true);
    const contactId = r?.contactId as string;
    expect(contactRow(contactId)).toEqual({
      given_name: 'Ada',
      family_name: 'Lovelace',
      source_type: 'web',
    });
    const contact = t.op('contacts.get', { id: contactId });
    expect(contact.emails.map((e) => e.email)).toEqual(['ada@example.com']);
    expect(contact.phones.map((p) => p.number)).toEqual(['+393331234567']);
    expect(contact.addresses).toEqual([expect.objectContaining({ locality: 'Milano' })]);
    expect(site().visitorProfile('v-1')?.visitor.contact_id).toBe(contactId);

    expect(await registerTenant(ports, TENANT, [a.registry])).toEqual([
      { eid: a.registry.eid, contactId, created: false },
    ]);
    expect(t.db.all(`SELECT id FROM crm_contacts`)).toHaveLength(1);
    // The site never stored the clear data.
    expect(JSON.stringify(site().visitorProfile('v-1'))).not.toMatch(/ada@|Lovelace|Milano/i);
  });

  it('never overwrites a name typed by a person; a newer web value replaces an older web value', async () => {
    const manual = t.op('contacts.create', {
      given_name: 'Maria',
      emails: [{ email: 'mr@example.com' }],
    });
    const first = identify('v-1', T0, { email: 'mr@example.com', name: 'Mario Rossi' });
    await registerTenant(ports, TENANT, [first.registry]);
    expect(contactRow(manual.id)).toMatchObject({ given_name: 'Maria', family_name: 'Rossi' });

    const newer = identify('v-1', T0 + MIN, {
      email: 'mr@example.com',
      traits: { last_name: 'Bianchi' },
    });
    const older = identify('v-1', T0 - MIN, {
      email: 'mr@example.com',
      traits: { last_name: 'Verdi' },
    });
    await registerTenant(ports, TENANT, [newer.registry]);
    await registerTenant(ports, TENANT, [older.registry]);
    expect(contactRow(manual.id)).toMatchObject({ given_name: 'Maria', family_name: 'Bianchi' });

    t.op('contacts.update', { id: manual.id, data: { family_name: 'Neri' } });
    await registerTenant(ports, TENANT, [
      identify('v-1', T0 + 2 * MIN, { email: 'mr@example.com', traits: { last_name: 'Gialli' } })
        .registry,
    ]);
    expect(contactRow(manual.id)).toMatchObject({ family_name: 'Neri' });
  });

  it('a registration ahead of the analytics event is linked later by the hashed identity drain', async () => {
    const a = identify('v-late', T0, { email: 'late@example.com' });
    const [r] = await registerTenant(ports, TENANT, [a.registry]);
    expect(site().visitorProfile('v-late')).toBeNull();
    site().ingest([ev({ vid: 'v-late', sid: 's-v-late', ts: T0 - MIN }), a.event], []);
    expect(
      site()
        .pullCoreWork()
        .identities.map((i) => i.kind),
    ).toEqual(['email_hash']);
    await syncTenant(ports, TENANT);
    expect(site().visitorProfile('v-late')?.visitor.contact_id).toBe(r?.contactId);
  });

  it('materializes a compact web journey on the contact: link, one row per session, goals', async () => {
    const a = identify('v-1', T0, { email: 'j@example.com' });
    site().ingest([ev({ vid: 'v-1', sid: 's-v-1', ts: T0 - MIN }), a.event], []);
    const [r] = await registerTenant(ports, TENANT, [a.registry]);
    const contactId = r?.contactId as string;
    site().ingest(
      [
        ev({ vid: 'v-1', sid: 's-v-1', ts: T0 + MIN, path: '/prezzi' }),
        ev({ vid: 'v-1', sid: 's-v-1', ts: T0 + 2 * MIN, path: '/demo' }),
        ev({ vid: 'v-1', sid: 's-v-1', ts: T0 + 3 * MIN, path: '/prezzi' }),
        ev({
          vid: 'v-1',
          sid: 's-v-1',
          ts: T0 + 4 * MIN,
          type: 'goal',
          name: 'lead',
          path: '/demo',
        }),
      ],
      [],
    );
    const work = site().pullCoreWork();
    await syncTenant(ports, TENANT);
    const items = work.automation.map((i) => ({ ...i, kind: i.kind }));
    // A redelivery of the same items changes nothing.
    t.op('analytics.recordWebTimeline' as CrmOpName, { siteId: SITE, items } as never);

    const web = t
      .op('timeline', { subject: 'contact', id: contactId, limit: 50 })
      .data.filter((x) => x.type.startsWith('web.'));
    expect(web.map((x) => x.type)).toEqual(['web.goal', 'web.session', 'web.linked']);
    expect(web[1]?.data).toMatchObject({
      siteId: SITE,
      sessionId: 's-v-1',
      pages: 2,
      landing: '/prezzi',
      lastPath: '/demo',
    });
    expect(web[0]?.data).toMatchObject({ goal: 'lead' });
    // Timestamps with a fraction of a millisecond (server events, imports) still get an id.
    const fractional = items.map((i) => ({ ...i, ts: i.ts + 0.5 }));
    expect(() =>
      t.op('analytics.recordWebTimeline' as CrmOpName, { siteId: SITE, items: fractional } as never),
    ).not.toThrow();
  });

  it('profile data without email or phone enriches the contact the visitor is linked to', async () => {
    const a = identify('v-1', T0, { email: 'p@example.com' });
    site().ingest([ev({ vid: 'v-1', sid: 's-v-1', ts: T0 - MIN }), a.event], []);
    const [r] = await registerTenant(ports, TENANT, [a.registry]);
    const named = identify('v-1', T0 + MIN, { traits: { first_name: 'Pia' } });
    expect(named.registry.email).toBeNull();
    await registerTenant(ports, TENANT, [named.registry]);
    expect(contactRow(r?.contactId as string)).toMatchObject({ given_name: 'Pia' });
    const orphan = identify('v-unknown', T0, { traits: { first_name: 'Nobody' } });
    expect(await registerTenant(ports, TENANT, [orphan.registry])).toEqual([
      { eid: orphan.registry.eid, contactId: null, created: false },
    ]);
  });
});

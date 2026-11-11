import { describe, expect, it } from 'vitest';
import { ingestMessages } from '../src/analytics/pipeline';
import { splitPii, type RegistryMessage } from '../src/analytics/registry';
import { sha256Hex } from '../src/analytics/store/identity';
import type { AnalyticsMessage } from '../src/analytics/types';
import type { Env } from '../src/env';
import { edgeEnv, ev, FakeAnalyticsNamespace, FakeQueue, SITE_ID, siteInit, T0 } from './helpers';

const TENANT = 'tn_1';
const CONFIG = { tenantId: TENANT, suppressed: { visitors: [], keys: [] } };

describe('registry split', () => {
  it('keeps only hashes in the analytics event and sends the clear contact data to the registry', () => {
    const event = ev({
      type: 'identify',
      identity: {
        userId: 'u-1',
        email: ' Ada@Example.com ',
        name: 'Ada Lovelace',
        traits: {
          phone: '+39 333 123 4567',
          first_name: 'Ada',
          citta: 'Milano',
          plan: 'pro',
          product_name: 'kit',
        },
      },
    });
    const registry = splitPii(event, TENANT);
    expect(event.identity).toEqual({
      userId: 'u-1',
      email: sha256Hex('ada@example.com'),
      name: null,
      traits: { phone: sha256Hex('+393331234567'), plan: 'pro', product_name: 'kit' },
    });
    expect(registry).toEqual<RegistryMessage>({
      v: 1,
      eid: event.eid,
      tenantId: TENANT,
      siteId: SITE_ID,
      visitorId: 'visitor-1',
      ts: T0,
      source: 'identify',
      email: 'ada@example.com',
      phone: '+393331234567',
      userId: 'u-1',
      profile: { full_name: 'Ada Lovelace', given_name: 'Ada', city: 'Milano' },
    });
    expect(JSON.stringify(event)).not.toMatch(/ada@|Lovelace|Milano|333 123/i);
  });

  it('a payment without visitor id still reaches the registry; goal params lose contact data only', () => {
    const payment = ev({
      type: 'payment',
      vid: '',
      payment: {
        amountMinor: 100,
        currency: 'EUR',
        transactionId: 'tx',
        email: 'Buyer@Example.com',
        customerId: null,
        renewal: false,
        refunded: false,
        freeTrial: false,
      },
    });
    expect(splitPii(payment, TENANT)).toMatchObject({
      source: 'payment',
      visitorId: null,
      email: 'buyer@example.com',
    });
    expect(payment.payment?.email).toBe(sha256Hex('buyer@example.com'));

    const goal = ev({
      type: 'goal',
      name: 'lead',
      data: {
        plan_name: 'pro',
        email: 'x@y.co',
        note: 'write to x@y.co',
        cognome: 'Rossi',
        value: 3,
      },
    });
    expect(splitPii(goal, TENANT)).toBeNull();
    expect(goal.data).toEqual({ plan_name: 'pro', value: 3 });
    expect(splitPii(ev(), TENANT)).toBeNull();
  });
});

describe('contact data in URLs and user ids', () => {
  it('drops contact params from page and referrer URLs, and treats an email user id as an email', () => {
    const event = ev({
      type: 'identify',
      url: 'https://www.example.com/thanks?invitee_email=a%40b.co&utm_source=x&ref=c%40d.io&cap=20100',
      referrer: 'https://book.example.com/?phone=%2B39333&x=1',
      identity: { userId: 'Bea@Example.com', email: null, name: null, traits: null },
    });
    const registry = splitPii(event, TENANT);
    expect(event.url).toBe('https://www.example.com/thanks?utm_source=x');
    expect(event.referrer).toBe('https://book.example.com/?x=1');
    expect(event.identity).toMatchObject({ userId: null, email: sha256Hex('bea@example.com') });
    expect(registry?.email).toBe('bea@example.com');
  });
});

describe('ingestMessages', () => {
  function setup(registryFails = false) {
    const ns = new FakeAnalyticsNamespace(() => T0);
    ns.store(`site:${SITE_ID}`).initSite(siteInit());
    const analytics = new FakeQueue();
    const registry: RegistryMessage[] = [];
    const env: Env = {
      ...edgeEnv(ns, analytics),
      REGISTRY_QUEUE: {
        sendBatch: (msgs: Iterable<{ body: RegistryMessage }>) => {
          if (registryFails) return Promise.reject(new Error('registry down'));
          for (const m of msgs) registry.push(m.body);
          return Promise.resolve();
        },
      } as unknown as Queue<RegistryMessage>,
    };
    return { env, analytics, registry };
  }
  const identify = (): AnalyticsMessage => ({
    kind: 'event',
    event: ev({
      type: 'identify',
      identity: { userId: null, email: 'ada@example.com', name: null, traits: null },
    }),
  });

  it('sends the registry first, then the hashed events', async () => {
    const { env, analytics, registry } = setup();
    await ingestMessages(env, CONFIG, [identify(), { kind: 'event', event: ev() }]);
    expect(registry.map((r) => r.email)).toEqual(['ada@example.com']);
    expect(analytics.sent).toHaveLength(2);
    expect(JSON.stringify(analytics.sent)).not.toContain('ada@example.com');
  });

  it('drops tombstoned visitors and identities before the registry and the queue', async () => {
    const { env, analytics, registry } = setup();
    const byVisitor = { tenantId: TENANT, suppressed: { visitors: [ev().vid], keys: [] } };
    await ingestMessages(env, byVisitor, [identify(), { kind: 'event', event: ev() }]);
    expect(registry).toHaveLength(0);
    expect(analytics.sent).toHaveLength(0);
    const byEmail = {
      tenantId: TENANT,
      suppressed: { visitors: [], keys: [sha256Hex('ada@example.com')] },
    };
    await ingestMessages(env, byEmail, [
      identify(),
      { kind: 'event', event: ev({ vid: 'other-visitor' }) },
    ]);
    expect(registry).toHaveLength(0);
    expect(analytics.sent).toHaveLength(1);
  });

  it('fails the request (client retries) without queueing analytics when the registry refuses', async () => {
    const { env, analytics } = setup(true);
    await expect(ingestMessages(env, CONFIG, [identify()])).rejects.toThrow('registry down');
    expect(analytics.sent).toHaveLength(0);
  });
});

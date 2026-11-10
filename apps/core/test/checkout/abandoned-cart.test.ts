import type { CheckoutDefinition } from '@amable/checkout';
import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices, type AuthServices } from '../../src/auth/services';
import { triggerMatches } from '../../src/automation/goals';
import { TRIGGER_EVENTS } from '../../src/automation/graph';
import { checkoutGatewayHandlers } from '../../src/checkout/gateway';
import { LEAD_RETENTION_MS, nextLeadDue } from '../../src/checkout/leads';
import { overrideCommerceRuntime } from '../../src/commerce/stripe/runtime';
import type { Env } from '../../src/env';
import type { GatewayContext } from '../../src/public/context';
import { commerceWorld, eventsOf, type CommerceWorld } from '../commerce/helpers';

const PAGE = 'https://shop.example.com/buy';
const BUYER = { email: 'Mary@Example.com', given_name: 'Mary', family_name: 'Shelley', phone: '' };
const HOUR = 3_600_000;

function gateway(w: CommerceWorld) {
  overrideAuthServices(async () => ({ now: () => w.t.clock.now }) as unknown as AuthServices);
  overrideCommerceRuntime(() => ({
    now: () => w.t.clock.now,
    secretBox: { encrypt: async (p: string) => p, decrypt: async (p: string) => p } as never,
    fetch: async () => new Response('{}', { status: 500 }),
    limiter: { consume: async () => ({ allowed: true }) } as never,
  }));
  const ctx = {
    env: { ENVIRONMENT: 'dev' } as unknown as Env,
    executionCtx: { waitUntil: () => undefined } as unknown as ExecutionContext,
    tenant: { id: 'tenant_test', slug: 'demo', name: 'Demo' },
    client: {
      ip: null,
      userAgent: null,
      country: null,
      visitorId: 'v_cart',
      referer: null,
      acceptLanguage: 'en',
    },
    tenantDb: () => {
      throw new Error('not used');
    },
    crm: async (op: string, input: unknown) =>
      (w.t.op as (op: string, input: unknown) => unknown)(op, input),
  } as unknown as GatewayContext;
  return (op: string, input: unknown): Promise<unknown> => {
    const handler = checkoutGatewayHandlers[op];
    if (handler === undefined) throw new Error(`no handler ${op}`);
    return handler(ctx, input);
  };
}

function setup(
  abandoned: { enabled: boolean; delay_minutes?: number } = { enabled: true, delay_minutes: 60 },
) {
  const w = commerceWorld();
  w.t.clock.now = Date.now();
  const call = gateway(w);
  const accountId = w.t.op('bankAccounts.create', {
    label: 'Main',
    holder: 'Demo Srl',
    iban: 'IT60 X054 2811 1010 0000 0123 456',
    bic: '',
    bank_name: '',
    instructions: '',
  }).id;
  const checkout = w.t.op('checkouts.create', {
    name: 'Launch',
    status: 'active',
    definition: {
      items: [{ id: 'i1', kind: 'product', ref_id: w.course }],
      settings: { abandoned_cart: abandoned },
      payments: { card: false, bank_transfer: { enabled: true, account_id: accountId } },
    },
  });
  const lead = (buyer: Partial<typeof BUYER> = {}) =>
    call('checkout.lead', {
      checkoutId: checkout.id,
      payload: { buyer: { ...BUYER, ...buyer }, meta: { page_url: PAGE } },
    });
  const sweep = () => w.t.op('checkout.abandonLeads', {});
  const leads = () =>
    w.t.db.all<{ email: string; status: string; amount_minor: number; session_id: string | null }>(
      `SELECT email, status, amount_minor, session_id FROM crm_checkout_leads ORDER BY created_at`,
    );
  return { w, call, checkout, lead, sweep, leads };
}

afterEach(() => {
  overrideCommerceRuntime(null);
  overrideAuthServices(null);
});

describe('abandoned cart', () => {
  it('keeps the email without a contact, then creates it and emits checkout.abandoned after the delay', async () => {
    const { w, checkout, lead, sweep, leads } = setup();
    const contactsBefore = w.t.op('contacts.list', { limit: 50 }).data.length;
    await expect(lead()).resolves.toEqual({ ok: true });
    expect(leads()).toEqual([
      { email: 'mary@example.com', status: 'open', amount_minor: 24_278, session_id: null },
    ]);
    expect(w.t.op('contacts.list', { limit: 50 }).data).toHaveLength(contactsBefore);

    // Not yet due.
    w.t.clock.now += 59 * 60_000;
    expect(sweep()).toMatchObject({ abandoned: 0 });

    w.t.clock.now += 2 * 60_000;
    expect(sweep()).toEqual({ abandoned: 1, deleted: 0, tenantId: 'tenant_test' });
    const [event] = eventsOf(w.t, 'checkout.abandoned');
    expect(event?.payload).toMatchObject({
      checkoutId: checkout.id,
      amountMinor: 24_278,
      currency: 'EUR',
      productIds: [w.course],
      pageUrl: PAGE,
      visitorId: 'v_cart',
    });
    const contact = w.t.op('contacts.get', { id: String(event?.payload['contactId']) });
    expect(contact).toMatchObject({ given_name: 'Mary', family_name: 'Shelley' });
    expect(contact.tag_ids).toEqual([]);
    const timeline = w.t.db.all<{ type: string }>(
      `SELECT type FROM crm_activities WHERE contact_id = ? AND type = 'checkout.abandoned'`,
      contact.id,
    );
    expect(timeline).toHaveLength(1);
    expect(leads()[0]?.status).toBe('abandoned');

    // Once only.
    w.t.clock.now += HOUR;
    expect(sweep()).toMatchObject({ abandoned: 0 });
  });

  it('a purchase converts the cart: no event', async () => {
    const { w, call, checkout, lead, sweep, leads } = setup();
    await lead();
    const session = (await call('checkout.session', {
      checkoutId: checkout.id,
      payload: { buyer: BUYER, payment_method: 'bank_transfer', meta: { page_url: PAGE } },
    })) as { session_token: string };
    await call('checkout.complete', { token: session.session_token });
    expect(leads()[0]?.status).toBe('converted');
    w.t.clock.now += 2 * HOUR;
    expect(sweep()).toMatchObject({ abandoned: 0 });
    expect(eventsOf(w.t, 'checkout.abandoned')).toHaveLength(0);
  });

  it('ignores checkouts without the option, honeypots and invalid emails', async () => {
    const off = setup({ enabled: false });
    await expect(off.lead()).resolves.toEqual({ ok: true });
    expect(off.leads()).toHaveLength(0);

    const on = setup();
    await on.call('checkout.lead', {
      checkoutId: on.checkout.id,
      payload: { buyer: BUYER, hp: 'bot' },
    });
    await on.lead({ email: 'not-an-email' });
    expect(on.leads()).toHaveLength(0);
  });

  it('typing again pushes the delay; a recent abandoned cart is not reopened, an old one is', async () => {
    const { w, lead, sweep, leads } = setup();
    await lead();
    w.t.clock.now += 50 * 60_000;
    await lead({ given_name: 'Mary W.' });
    w.t.clock.now += 20 * 60_000;
    expect(sweep()).toMatchObject({ abandoned: 0 });
    w.t.clock.now += 45 * 60_000;
    expect(sweep()).toMatchObject({ abandoned: 1 });

    await lead();
    expect(leads()[0]?.status).toBe('abandoned');
    w.t.clock.now += 25 * HOUR;
    await lead();
    expect(leads()[0]?.status).toBe('open');
    w.t.clock.now += 2 * HOUR;
    expect(sweep()).toMatchObject({ abandoned: 1 });
    expect(eventsOf(w.t, 'checkout.abandoned')).toHaveLength(2);
  });

  it('drops the email when the option is turned off before the delay', async () => {
    const { w, checkout, lead, sweep, leads } = setup();
    await lead();
    const current = {
      definition: w.t.op('checkouts.get', { id: checkout.id })
        .definition as unknown as CheckoutDefinition,
    };
    w.t.op('checkouts.update', {
      id: checkout.id,
      data: {
        definition: {
          ...current.definition,
          settings: {
            ...current.definition.settings,
            abandoned_cart: { enabled: false, delay_minutes: 60 },
          },
        },
      },
    });
    w.t.clock.now += 2 * HOUR;
    expect(sweep()).toMatchObject({ abandoned: 0 });
    expect(leads()).toHaveLength(0);
  });

  it('schedules the alarm and deletes old rows', async () => {
    const { w, lead, sweep, leads } = setup();
    expect(nextLeadDue(w.t.db)).toBeNull();
    const start = w.t.clock.now;
    await lead();
    const due = nextLeadDue(w.t.db) ?? 0;
    expect(due - start).toBeGreaterThanOrEqual(HOUR);
    expect(due - start).toBeLessThan(HOUR + 1000);
    w.t.clock.now += 2 * HOUR;
    sweep();
    const purge = nextLeadDue(w.t.db) ?? 0;
    expect(purge - start).toBeGreaterThanOrEqual(LEAD_RETENTION_MS);
    expect(purge - start).toBeLessThan(LEAD_RETENTION_MS + 1000);
    w.t.clock.now = purge + 1;
    expect(sweep()).toMatchObject({ deleted: 1 });
    expect(leads()).toHaveLength(0);
  });

  it('trigger "checkout_abandoned" listens to the event, optionally for some checkouts', () => {
    expect(TRIGGER_EVENTS.checkout_abandoned).toEqual(['checkout.abandoned']);
    const event = {
      id: 'e1',
      type: 'checkout.abandoned',
      occurredAt: new Date().toISOString(),
      payload: { checkoutId: 'chk_a' },
    };
    expect(triggerMatches({ type: 'checkout_abandoned' }, event)).toBe(true);
    expect(triggerMatches({ type: 'checkout_abandoned', checkout_ids: ['chk_a'] }, event)).toBe(
      true,
    );
    expect(triggerMatches({ type: 'checkout_abandoned', checkout_ids: ['chk_b'] }, event)).toBe(
      false,
    );
  });
});

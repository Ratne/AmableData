import { afterEach, describe, expect, it } from 'vitest';
import { overrideAuthServices, type AuthServices } from '../../src/auth/services';
import { processCheckoutConversions } from '../../src/checkout/conversions';
import { checkoutGatewayHandlers } from '../../src/checkout/gateway';
import { overrideCommerceRuntime } from '../../src/commerce/stripe/runtime';
import type { Env } from '../../src/env';
import type { FormsRuntime } from '../../src/forms/runtime';
import type { GatewayContext } from '../../src/public/context';
import { commerceWorld, type CommerceWorld } from '../commerce/helpers';

const TENANT = 'tenant_test';

function gateway(w: CommerceWorld) {
  overrideAuthServices(async () => ({ now: () => w.t.clock.now }) as unknown as AuthServices);
  overrideCommerceRuntime(() => ({
    now: () => w.t.clock.now,
    secretBox: { encrypt: async (p: string) => `enc:${p}`, decrypt: async (e: string) => e.replace(/^enc:/, '') } as never,
    fetch: async () => new Response('{}', { status: 400 }),
    limiter: { consume: async () => ({ allowed: true }) } as never,
  }));
  const ctx = {
    env: { ENVIRONMENT: 'dev' } as unknown as Env,
    executionCtx: { waitUntil: () => undefined } as unknown as ExecutionContext,
    tenant: { id: TENANT, slug: 'demo', name: 'Demo' },
    client: { ip: '198.51.100.9', userAgent: 'Mozilla/5.0 (Buyer)', country: null, visitorId: 'v_ads', referer: null, acceptLanguage: 'it' },
    tenantDb: () => {
      throw new Error('not used');
    },
    crm: async (op: string, input: unknown) => (w.t.op as (op: string, input: unknown) => unknown)(op, input),
  } as unknown as GatewayContext;
  return (op: string, input: unknown): Promise<unknown> => {
    const handler = checkoutGatewayHandlers[op];
    if (handler === undefined) throw new Error(`no handler ${op}`);
    return handler(ctx, input);
  };
}

/** Env whose TenantDb stub runs the ops on the in-memory tenant. */
function tenantEnv(w: CommerceWorld): Env {
  const stub = {
    crm: async (op: string, _actor: unknown, input: unknown) => {
      try {
        return { ok: true, value: (w.t.op as (op: string, input: unknown) => unknown)(op, input) };
      } catch (error) {
        return { ok: false, error: { code: 'internal', message: String(error) } };
      }
    },
  };
  return { TENANT_DB: { idFromName: () => 'id', get: () => stub } } as unknown as Env;
}

afterEach(() => {
  overrideCommerceRuntime(null);
  overrideAuthServices(null);
});

describe('checkout server-side conversions', () => {
  it('sends a paid checkout order once as Purchase to Meta and TikTok, with cookies, click ids, IP and value', async () => {
    const w = commerceWorld();
    w.t.clock.now = Date.now();
    const call = gateway(w);
    const accountId = w.t.op('bankAccounts.create', {
      label: 'Main',
      holder: 'Demo Srl',
      iban: 'IT60 X054 2811 1010 0000 0123 456',
      bic: 'BPMOIT22',
      bank_name: 'Banca Demo',
      instructions: '',
    }).id;
    const c = w.t.op('checkouts.create', {
      name: 'Launch',
      status: 'active',
      definition: {
        items: [{ id: 'i1', kind: 'product', ref_id: w.course }],
        payments: { card: false, bank_transfer: { enabled: true, account_id: accountId } },
      },
    });
    for (const [type, config] of [
      ['facebook_capi', { pixel_id: '1234567890', event_name: 'Purchase', test_event_code: '', send_external_id: true, default_calling_code: '39' }],
      ['tiktok_events', { pixel_code: 'CABC123XYZ', event_name: 'Purchase', test_event_code: '', send_external_id: true, default_calling_code: '39' }],
    ] as const) {
      w.t.op('checkoutConnections.create', {
        id: `conn_${type}`,
        checkoutId: c.id,
        type,
        name: type,
        enabled: true,
        config,
        secretCiphertext: `enc:token-${type}`,
        secretHint: '…oken',
      });
    }

    const session = (await call('checkout.session', {
      checkoutId: c.id,
      payload: {
        buyer: { email: 'Buyer@Example.com', given_name: 'Mary', family_name: 'Shelley', phone: '333 1234567' },
        payment_method: 'bank_transfer',
        tracking: { utm_source: 'tiktok', ttclid: 'TTCLID1', fbclid: 'FBCLID1' },
        meta: { page_url: 'https://shop.example.com/buy', fbp: 'fb.1.1700000000000.42', ttp: 'TTP_COOKIE' },
      },
    })) as { session_token: string };
    await call('checkout.complete', { token: session.session_token });
    const order = w.t.op('orders.list', { limit: 10 }).data[0];
    if (order === undefined) throw new Error('order missing');

    const env = tenantEnv(w);
    const calls: Array<{ url: string; body: string; headers: Headers }> = [];
    const runtime = {
      now: () => w.t.clock.now,
      secretBox: { decrypt: async (e: string) => e.replace(/^enc:/, '') },
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, body: String(init?.body ?? ''), headers: new Headers(init?.headers) });
        return url.includes('tiktok')
          ? Response.json({ code: 0, message: 'OK' })
          : Response.json({ events_received: 1, fbtrace_id: 'trace' });
      },
    } as unknown as FormsRuntime;

    // Not paid yet: nothing to send.
    expect(await processCheckoutConversions(env, TENANT, order.id, { attempt: 1, final: false, runtime })).toEqual({ retry: false });
    expect(calls).toHaveLength(0);

    w.t.op('payments.record', { orderId: order.id, data: { amount_minor: order.total_minor, method: 'bank_transfer' } });
    const paidEvents = w.t
      .op('events.pending', { limit: 100 })
      .filter((e) => e.type === 'order.paid' && (e.payload as { orderId?: string }).orderId === order.id);
    expect(paidEvents.map((e) => e.payload)).toEqual([expect.objectContaining({ source: 'checkout', renewal: false })]);

    expect(await processCheckoutConversions(env, TENANT, order.id, { attempt: 1, final: false, runtime })).toEqual({ retry: false });
    expect(calls).toHaveLength(2);
    const meta = calls.find((x) => x.url.includes('graph.facebook.com'));
    const tiktok = calls.find((x) => x.url.includes('business-api.tiktok.com'));
    expect(meta?.url).toContain('/1234567890/events');
    expect(meta?.body).toContain('Purchase');
    expect(meta?.body).toContain(order.id);
    expect(meta?.body).toContain('fb.1.1700000000000.42');
    expect(meta?.body).toContain('FBCLID1');
    expect(meta?.body).toContain('198.51.100.9');
    expect(meta?.body).not.toContain('Buyer@Example.com');
    expect(tiktok?.headers.get('access-token')).toBe('token-tiktok_events');
    const tiktokBody = JSON.parse(tiktok?.body ?? '{}') as { data: Array<{ event: string; event_id: string; properties: Record<string, unknown>; user: Record<string, unknown> }> };
    expect(tiktokBody.data[0]).toMatchObject({
      event: 'Purchase',
      event_id: order.id,
      properties: { value: order.total_minor / 100, currency: 'EUR' },
      user: { ttclid: 'TTCLID1', ttp: 'TTP_COOKIE', ip: '198.51.100.9', user_agent: 'Mozilla/5.0 (Buyer)' },
    });

    const listed = w.t.op('checkoutConnections.list', { checkoutId: c.id });
    expect(listed.map((x) => x.last_delivery?.status)).toEqual(['success', 'success']);
    expect(listed.every((x) => !('secret_ciphertext' in x))).toBe(true);

    // Delivered once: a redelivered event sends nothing.
    await processCheckoutConversions(env, TENANT, order.id, { attempt: 1, final: false, runtime });
    expect(calls).toHaveLength(2);
  });
});

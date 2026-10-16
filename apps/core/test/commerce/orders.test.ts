import { describe, expect, it } from 'vitest';
import { commerceWorld, DAY, eventsOf, failure } from './helpers';

describe('orders: totals, drafts and invoices', () => {
  it('prices lines from the catalog with discount, per-line tax and untaxed shipping', () => {
    const w = commerceWorld();
    w.t.op('promoCodes.create', { code: 'save10', kind: 'percent', percent_bps: 1000 });
    const order = w.t.op('orders.create', {
      contact_id: w.contactId,
      items: [
        { product_id: w.course },
        { product_id: w.mug, quantity: 3 },
        { name: 'Gift wrap', unit_price_minor: 199, quantity: 1 },
      ],
      promo_code: 'SAVE10',
      shipping_minor: 690,
    });
    // subtotal 19900 + 3750 + 199 = 23849; 10% = 2384.9 -> 2385
    expect(order.subtotal_minor).toBe(23_849);
    expect(order.discount_minor).toBe(2_385);
    expect(order.items.map((i) => i.discount_minor).reduce((a, b) => a + b, 0)).toBe(2_385);
    const course = order.items[0];
    const mug = order.items[1];
    expect(course).toMatchObject({ name: 'Analytics Course', sku: 'CO-1', tax_rate_bps: 2200 });
    expect(mug).toMatchObject({ quantity: 3, unit_price_minor: 1_250, subtotal_minor: 3_750 });
    expect(order.tax_minor).toBe(order.items.reduce((a, i) => a + i.tax_minor, 0));
    expect(order.total_minor).toBe(23_849 - 2_385 + order.tax_minor + 690);
    expect(order).toMatchObject({
      status: 'unpaid',
      currency: 'EUR',
      source: 'manual',
      promo_code: 'SAVE10',
      paid_minor: 0,
      balance_minor: order.total_minor,
      number: 'ORD-000001',
    });
    expect(order.invoice?.number).toBe('INV-2026-00001');
  });

  it('validates lines, currencies and contacts', () => {
    const w = commerceWorld();
    const usd = w.t.op('products.create', {
      name: 'US item',
      price_minor: 100,
      currency: 'USD',
    }).id;
    expect(
      failure(() =>
        w.t.op('orders.create', {
          contact_id: w.contactId,
          items: [{ product_id: w.course }, { product_id: usd }],
        }),
      ).code,
    ).toBe('validation_failed');
    expect(
      failure(() => w.t.op('orders.create', { contact_id: w.contactId, items: [{ name: 'x' }] }))
        .message,
    ).toContain('unit_price_minor');
    expect(
      failure(() =>
        w.t.op('orders.create', { contact_id: 'nope', items: [{ product_id: w.course }] }),
      ).code,
    ).toBe('validation_failed');
  });

  it('keeps drafts editable, finalizes them once and deletes only drafts', () => {
    const w = commerceWorld();
    const draft = w.t.op('orders.create', {
      contact_id: w.contactId,
      status: 'draft',
      items: [{ product_id: w.mug }],
    });
    expect(draft.status).toBe('draft');
    expect(draft.invoice).toBeNull();
    expect(eventsOf(w.t, 'order.created')).toHaveLength(0);

    const added = w.t.op('orders.addItem', { id: draft.id, data: { product_id: w.course } });
    expect(added.items).toHaveLength(2);
    expect(added.subtotal_minor).toBe(1_250 + 19_900);
    const removed = w.t.op('orders.removeItem', { id: draft.id, itemId: added.items[0]?.id ?? '' });
    expect(removed.items.map((i) => i.name)).toEqual(['Analytics Course']);
    const edited = w.t.op('orders.update', { id: draft.id, data: { shipping_minor: 500 } });
    expect(edited.total_minor).toBe(19_900 + 4_378 + 500);

    const final = w.t.op('orders.finalize', { id: draft.id });
    expect(final.status).toBe('unpaid');
    expect(final.invoice).not.toBeNull();
    expect(final.due_at).not.toBeNull();
    expect(eventsOf(w.t, 'order.created')).toHaveLength(1);
    expect(failure(() => w.t.op('orders.finalize', { id: draft.id })).code).toBe('conflict');
    expect(
      failure(() => w.t.op('orders.update', { id: draft.id, data: { shipping_minor: 0 } })).code,
    ).toBe('conflict');
    // Finalized orders still accept notes and custom fields.
    expect(w.t.op('orders.update', { id: draft.id, data: { notes: 'Call first' } }).notes).toBe(
      'Call first',
    );
    expect(failure(() => w.t.op('orders.delete', { id: draft.id })).code).toBe('conflict');

    const other = w.t.op('orders.create', {
      contact_id: w.contactId,
      status: 'draft',
      items: [{ product_id: w.mug }],
    });
    expect(w.t.op('orders.delete', { id: other.id })).toEqual({ id: other.id, deleted: true });
  });

  it('numbers invoices per tenant, gapless, restarting every year with the configured prefix', () => {
    const w = commerceWorld();
    const make = () =>
      w.t.op('orders.create', { contact_id: w.contactId, items: [{ product_id: w.mug }] });
    expect(make().invoice?.number).toBe('INV-2026-00001');
    // A draft consumes an order number but never an invoice number.
    w.t.op('orders.create', {
      contact_id: w.contactId,
      status: 'draft',
      items: [{ product_id: w.mug }],
    });
    // A rolled-back mutation does not burn a number either.
    failure(() =>
      w.t.op('orders.create', {
        contact_id: w.contactId,
        items: [{ product_id: w.mug }],
        promo_code: 'NONE',
      }),
    );
    expect(make().invoice?.number).toBe('INV-2026-00002');
    w.t.op('commerce.settings.update', { invoice_prefix: 'FT-', order_prefix: 'A' });
    w.t.clock.now = Date.UTC(2027, 0, 2);
    const nextYear = make();
    expect(nextYear.invoice?.number).toBe('FT-2027-00001');
    expect(nextYear.number).toBe('A000004');
    const invoices = w.t.op('invoices.list', { limit: 10 });
    expect(invoices.data.map((i) => i.number)).toEqual([
      'FT-2027-00001',
      'INV-2026-00002',
      'INV-2026-00001',
    ]);
    expect(w.t.op('invoices.list', { limit: 10, year: 2026 }).data).toHaveLength(2);
    const page = w.t.op('invoices.list', { limit: 2 });
    expect(
      w.t.op('invoices.list', { limit: 2, cursor: page.next_cursor ?? '' }).data[0]?.number,
    ).toBe('INV-2026-00001');
  });
});

describe('settings: default tax rate', () => {
  it('applies to new products created without a tax rate', () => {
    const w = commerceWorld();
    expect(w.t.op('commerce.settings.get', {}).default_tax_rate_bps).toBe(0);
    const updated = w.t.op('commerce.settings.update', { default_tax_rate_bps: 2200 });
    expect(updated.default_tax_rate_bps).toBe(2200);
    const implicit = w.t.op('products.create', { name: 'Poster', price_minor: 1500 });
    expect(implicit.tax_rate_bps).toBe(2200);
    const explicit = w.t.op('products.create', {
      name: 'E-book',
      price_minor: 900,
      tax_rate_bps: 400,
    });
    expect(explicit.tax_rate_bps).toBe(400);
  });
});

describe('promo codes: limits and validity', () => {
  it('enforces total and per-contact limits; drafts never reserve; cancellation releases', () => {
    const w = commerceWorld();
    const promo = w.t.op('promoCodes.create', {
      code: 'ONCE',
      kind: 'fixed',
      amount_minor: 500,
      currency: 'EUR',
      max_redemptions: 2,
      max_per_contact: 1,
    });
    const order = (contact: string, status?: 'draft') =>
      w.t.op('orders.create', {
        contact_id: contact,
        items: [{ product_id: w.course }],
        promo_code: 'once',
        ...(status === undefined ? {} : { status }),
      });
    const draft = order(w.contactId, 'draft');
    expect(draft.discount_minor).toBe(500);
    expect(w.t.op('promoCodes.get', { id: promo.id }).redemptions).toBe(0);
    const first = order(w.contactId);
    expect(w.t.op('promoCodes.get', { id: promo.id }).redemptions).toBe(1);
    // Per contact: the draft cannot be finalized any more.
    expect(failure(() => w.t.op('orders.finalize', { id: draft.id })).message).toContain(
      'maximum number of times by this contact',
    );
    order(w.otherContactId);
    const third = w.t.op('contacts.create', { given_name: 'Third' }).id;
    expect(failure(() => order(third)).message).toContain('redemption limit');
    w.t.op('orders.cancel', { id: first.id, data: { reason: 'test' } });
    expect(w.t.op('promoCodes.get', { id: promo.id }).redemptions).toBe(1);
    expect(order(third).discount_minor).toBe(500);
  });

  it('checks the validity window, minimum subtotal, product restriction and currency', () => {
    const w = commerceWorld();
    const now = w.t.clock.now;
    w.t.op('promoCodes.create', {
      code: 'LATER',
      kind: 'percent',
      percent_bps: 5000,
      starts_at: new Date(now + DAY).toISOString(),
      ends_at: new Date(now + 2 * DAY).toISOString(),
    });
    w.t.op('promoCodes.create', {
      code: 'BIG',
      kind: 'percent',
      percent_bps: 2000,
      min_subtotal_minor: 10_000,
    });
    w.t.op('promoCodes.create', {
      code: 'MUGS',
      kind: 'percent',
      percent_bps: 5000,
      product_ids: [w.mug],
    });
    w.t.op('promoCodes.create', {
      code: 'USD5',
      kind: 'fixed',
      amount_minor: 500,
      currency: 'USD',
    });
    const create = (code: string, items = [{ product_id: w.mug }]) =>
      w.t.op('orders.create', { contact_id: w.contactId, items, promo_code: code });
    expect(failure(() => create('LATER')).message).toContain('not valid yet');
    w.t.clock.now = now + DAY + 1000;
    expect(create('LATER').discount_minor).toBe(625);
    w.t.clock.now = now + 3 * DAY;
    expect(failure(() => create('LATER')).message).toContain('expired');
    expect(failure(() => create('BIG')).message).toContain('at least 10000');
    expect(create('BIG', [{ product_id: w.course }]).discount_minor).toBe(3_980);
    const mixed = create('MUGS', [{ product_id: w.course }, { product_id: w.mug }]);
    expect(mixed.items.map((i) => i.discount_minor)).toEqual([0, 625]);
    expect(failure(() => create('MUGS', [{ product_id: w.course }])).message).toContain(
      'does not apply',
    );
    expect(failure(() => create('USD5')).message).toContain('only applies to USD');
    expect(failure(() => create('NOPE')).message).toContain('unknown promo code');
    w.t.op('promoCodes.update', {
      id: w.t.op('promoCodes.list', { limit: 10 }).data.find((p) => p.code === 'BIG')?.id ?? '',
      data: { active: false },
    });
    expect(failure(() => create('BIG', [{ product_id: w.course }])).message).toContain(
      'not active',
    );
  });
});

describe('payments and refunds', () => {
  it('moves through partially_paid / paid / refunded and emits money events once', () => {
    const w = commerceWorld();
    const order = w.t.op('orders.create', {
      contact_id: w.contactId,
      items: [{ product_id: w.course }],
      analytics_visitor_id: 'v_123',
    });
    const total = order.total_minor; // 19900 + 22% = 24278
    expect(total).toBe(24_278);
    const p1 = w.t.op('payments.record', {
      orderId: order.id,
      data: { amount_minor: 10_000, method: 'bank_transfer', transaction_id: 'tx-1' },
    });
    expect(w.t.op('orders.get', { id: order.id })).toMatchObject({
      status: 'partially_paid',
      paid_minor: 10_000,
      balance_minor: total - 10_000,
    });
    expect(
      failure(() =>
        w.t.op('payments.record', {
          orderId: order.id,
          data: { amount_minor: total, method: 'card' },
        }),
      ).message,
    ).toContain('open balance');
    w.t.op('payments.record', {
      orderId: order.id,
      data: { amount_minor: total - 10_000, method: 'card', transaction_id: 'tx-2' },
    });
    const paid = w.t.op('orders.get', { id: order.id });
    expect(paid).toMatchObject({ status: 'paid', balance_minor: 0 });
    expect(paid.paid_at).not.toBeNull();
    expect(w.t.op('invoices.get', { id: paid.invoice?.id ?? '' }).status).toBe('paid');
    expect(
      failure(() =>
        w.t.op('payments.record', { orderId: order.id, data: { amount_minor: 1, method: 'card' } }),
      ).code,
    ).toBe('conflict');

    // Partial refund keeps `paid`; refunding the rest makes it `refunded`.
    const r1 = w.t.op('refunds.record', {
      orderId: order.id,
      data: { amount_minor: 4_000, payment_id: p1.id },
    });
    expect(r1.amount_minor).toBe(4_000);
    expect(w.t.op('payments.get', { id: p1.id }).refunded_minor).toBe(4_000);
    expect(
      failure(() =>
        w.t.op('refunds.record', {
          orderId: order.id,
          data: { amount_minor: 7_000, payment_id: p1.id },
        }),
      ).message,
    ).toContain('refundable 6000');
    expect(w.t.op('orders.get', { id: order.id })).toMatchObject({
      status: 'paid',
      refunded_minor: 4_000,
    });
    const rest = w.t.op('refunds.record', { orderId: order.id, data: { reason: 'returned' } });
    expect(rest.amount_minor).toBe(total - 4_000);
    expect(w.t.op('orders.get', { id: order.id })).toMatchObject({
      status: 'refunded',
      refunded_minor: total,
      balance_minor: 0,
    });
    expect(
      failure(() => w.t.op('refunds.record', { orderId: order.id, data: {} })).message,
    ).toContain('nothing to refund');

    const events = eventsOf(
      w.t,
      'order.created',
      'payment.recorded',
      'order.paid',
      'refund.recorded',
    );
    expect(events.map((e) => e.type)).toEqual([
      'order.created',
      'payment.recorded',
      'payment.recorded',
      'order.paid',
      'refund.recorded',
      'refund.recorded',
    ]);
    expect(events[3]?.payload).toMatchObject({
      orderId: order.id,
      contactId: w.contactId,
      amountMinor: total,
      currency: 'EUR',
      visitorId: 'v_123',
      productIds: [w.course],
      renewal: false,
    });
    expect(events[1]?.payload).toMatchObject({
      paymentId: p1.id,
      amountMinor: 10_000,
      method: 'bank_transfer',
      transactionId: 'tx-1',
      visitorId: 'v_123',
    });
    expect(events[4]?.payload).toMatchObject({ amountMinor: 4_000, full: false });
    expect(events[5]?.payload).toMatchObject({ amountMinor: total - 4_000, full: true });
    // Money events land on the contact timeline too.
    const timeline = w.t.op('timeline', { subject: 'contact', id: w.contactId, limit: 50 });
    expect(timeline.data.map((a) => a.type)).toContain('order.paid');
  });

  it('is idempotent by transaction id', () => {
    const w = commerceWorld();
    const order = w.t.op('orders.create', {
      contact_id: w.contactId,
      items: [{ product_id: w.mug }],
    });
    const data = { amount_minor: 500, method: 'card' as const, transaction_id: 'ch_1' };
    const first = w.t.op('payments.record', { orderId: order.id, data });
    const again = w.t.op('payments.record', { orderId: order.id, data });
    expect(again.id).toBe(first.id);
    expect(w.t.op('orders.get', { id: order.id }).paid_minor).toBe(500);
    expect(eventsOf(w.t, 'payment.recorded')).toHaveLength(1);
    expect(
      failure(() =>
        w.t.op('payments.record', { orderId: order.id, data: { ...data, amount_minor: 600 } }),
      ).code,
    ).toBe('conflict');
    const refund = { amount_minor: 100, transaction_id: 're_1' };
    const r1 = w.t.op('refunds.record', { orderId: order.id, data: refund });
    expect(w.t.op('refunds.record', { orderId: order.id, data: refund }).id).toBe(r1.id);
    expect(w.t.op('orders.get', { id: order.id }).refunded_minor).toBe(100);
  });

  it('rejects payments on drafts and cancelled orders; cancels only orders holding no money', () => {
    const w = commerceWorld();
    const draft = w.t.op('orders.create', {
      contact_id: w.contactId,
      status: 'draft',
      items: [{ product_id: w.mug }],
    });
    expect(
      failure(() =>
        w.t.op('payments.record', { orderId: draft.id, data: { amount_minor: 1, method: 'cash' } }),
      ).message,
    ).toContain('draft');
    const order = w.t.op('orders.create', {
      contact_id: w.contactId,
      items: [{ product_id: w.mug }],
    });
    w.t.op('payments.record', { orderId: order.id, data: { amount_minor: 100, method: 'cash' } });
    expect(failure(() => w.t.op('orders.cancel', { id: order.id, data: {} })).message).toContain(
      'refund them',
    );
    w.t.op('refunds.record', { orderId: order.id, data: {} });
    const cancelled = w.t.op('orders.cancel', { id: order.id, data: { reason: 'dup' } });
    expect(cancelled.status).toBe('cancelled');
    expect(w.t.op('invoices.get', { id: cancelled.invoice?.id ?? '' }).status).toBe('void');
    expect(eventsOf(w.t, 'order.cancelled')).toHaveLength(1);
    expect(
      failure(() =>
        w.t.op('payments.record', { orderId: order.id, data: { amount_minor: 1, method: 'cash' } }),
      ).code,
    ).toBe('conflict');
  });

  it('marks zero-total orders paid on creation', () => {
    const w = commerceWorld();
    const free = w.t.op('orders.create', {
      contact_id: w.contactId,
      items: [{ name: 'Free sample', unit_price_minor: 0 }],
    });
    expect(free.status).toBe('paid');
    expect(eventsOf(w.t, 'order.created', 'order.paid').map((e) => e.type)).toEqual([
      'order.created',
      'order.paid',
    ]);
  });
});

describe('orders in search', () => {
  it('indexes orders for full-text and exposes order fields to the query builder', () => {
    const w = commerceWorld();
    const a = w.t.op('orders.create', {
      contact_id: w.contactId,
      items: [{ product_id: w.course }],
      notes: 'priority customer',
    });
    const b = w.t.op('orders.create', {
      contact_id: w.otherContactId,
      items: [{ product_id: w.mug }],
    });
    w.t.op('payments.record', {
      orderId: b.id,
      data: { amount_minor: b.total_minor, method: 'card' },
    });

    const global = w.t.op('search.global', { q: 'lovelace', types: ['order'], limit: 10 });
    expect(global.data.map((h) => h.id)).toEqual([a.id]);
    expect(w.t.op('orders.list', { limit: 10, q: 'mug' }).data.map((o) => o.id)).toEqual([b.id]);
    expect(w.t.op('orders.list', { limit: 10, q: 'priority' }).data.map((o) => o.id)).toEqual([
      a.id,
    ]);

    const result = w.t.op('search.query', {
      entity: 'order',
      filter: {
        type: 'group',
        op: 'and',
        conditions: [
          { type: 'field', field: 'status', operator: 'equals', value: 'paid' },
          { type: 'field', field: 'total_minor', operator: 'gte', value: 1000 },
          { type: 'field', field: 'product_id', operator: 'equals', value: w.mug },
        ],
      },
      columns: ['number', 'contact_name', 'total_minor', 'status'],
    });
    expect(result.data).toEqual([
      {
        id: b.id,
        number: b.number,
        contact_name: 'Grace Hopper',
        total_minor: b.total_minor,
        status: 'paid',
      },
    ]);
    expect(w.t.op('orders.list', { limit: 10, status: 'unpaid' }).data.map((o) => o.id)).toEqual([
      a.id,
    ]);
    expect(
      failure(() =>
        w.t.op('search.query', {
          entity: 'order',
          filter: {
            type: 'group',
            op: 'and',
            conditions: [{ type: 'field', field: 'status', operator: 'equals', value: 'weird' }],
          },
        }),
      ).code,
    ).toBe('validation_failed');
    // Custom fields on orders work in the builder too.
    w.t.op('customFields.create', {
      entity: 'order',
      data: { key: 'channel', label: 'Channel', type: 'TEXT' },
    });
    w.t.op('orders.update', { id: a.id, data: { custom_fields: { channel: 'phone' } } });
    expect(
      w.t
        .op('search.query', {
          entity: 'order',
          filter: {
            type: 'group',
            op: 'and',
            conditions: [
              { type: 'field', field: 'custom.channel', operator: 'equals', value: 'phone' },
            ],
          },
        })
        .data.map((r) => r['id']),
    ).toEqual([a.id]);
  });
});

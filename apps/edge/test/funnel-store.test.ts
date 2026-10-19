import type {
  FunnelGraphInput,
  FunnelTouch,
  OutboundPayload,
  TrafficSourceInput,
} from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { analyticsMigrations } from '../src/analytics/migrations';
import { OUTBOUND_CLAIM_LEASE_MS } from '../src/analytics/store/outbound';
import { ANALYTICS_DO_RPC_METHODS, createStore, siteInit, T0 } from './helpers';

const DAY = 86_400_000;

function graphInput(name = 'Main funnel'): FunnelGraphInput {
  return {
    name,
    nodes: [
      { id: 'n_traffic', kind: 'traffic', config: {} },
      {
        id: 'n_lander',
        kind: 'page_group',
        config: {
          page_type: 'lander',
          pages: [{ id: 'p1', name: 'Lander', url: 'https://example.com/l', weight: 1 }],
        },
      },
    ],
    edges: [{ id: 'e1', from: 'n_traffic', to: 'n_lander', via: { type: 'default' } }],
  };
}

function sourceInput(name = 'Paid social'): TrafficSourceInput {
  return {
    name,
    template: 'meta',
    reserved_fields: {
      campaign: { url_param: 'cid', source_token: '{{campaign.id}}' },
      external: { url_param: 'fbclid', source_token: '', append: false },
    },
    fields: [{ slot: 'c1', name: 'adset', url_param: 'adset', source_token: '{{adset.id}}' }],
  };
}

function touch(overrides: Partial<FunnelTouch> = {}): FunnelTouch {
  return {
    id: 'hit_1',
    ts: T0,
    visitor_id: 'visitor-1',
    session_id: 'session-1',
    funnel_id: 'fg_1',
    node_id: 'n_lander',
    page_id: 'p1',
    traffic_source_id: 'ts_1',
    kind: 'view',
    campaign: 'cmp_1',
    external_click_id: 'click-abc',
    fields: { c1: 'adset-1' },
    cost_minor: 12,
    ...overrides,
  };
}

const payload: OutboundPayload = {
  event_name: 'Purchase',
  event_time: T0,
  value_minor: 4900,
  currency: 'EUR',
  click_ids: {},
};

describe('migration 3', () => {
  it('is appended as id 3', () => {
    expect(analyticsMigrations.map((m) => m.id).slice(0, 3)).toEqual([1, 2, 3]);
  });

  it('exposes every new store method as a DO RPC', () => {
    for (const name of [
      'createFunnelGraph',
      'updateFunnelGraph',
      'archiveFunnelGraph',
      'conditionValues',
      'createTrafficSource',
      'recordTouch',
      'recordTouches',
      'listTouchesByVisitor',
      'recordConversionFromPostback',
      'upsertAdConnection',
      'upsertAdEntities',
      'upsertAdSpend',
      'listAdSpend',
      'enqueueOutbound',
      'claimOutboundBatch',
      'settleOutbound',
      'upsertIdentityKeys',
      'findVisitorsByKey',
      'addToBlacklist',
      'isBlacklisted',
    ]) {
      expect(ANALYTICS_DO_RPC_METHODS.has(name), name).toBe(true);
    }
  });
});

describe('funnel graphs', () => {
  it('creates, reads, lists, updates with optimistic version, archives and restores', () => {
    const clock = { now: T0 };
    const { store } = createStore(clock);
    const created = store.createFunnelGraph(graphInput());
    if (!created.ok) throw new Error(created.error.message);
    const g = created.value;
    expect(g).toMatchObject({
      name: 'Main funnel',
      version: 1,
      status: 'active',
      created_at: T0,
      updated_at: T0,
    });
    expect(g.id).toMatch(/^fg_[a-z2-7]{16}$/);
    expect(g.nodes).toHaveLength(2);
    expect(store.getFunnelGraph(g.id)).toEqual(g);

    clock.now = T0 + 1000;
    const updated = store.updateFunnelGraph(g.id, { ...graphInput('Renamed'), version: 1 });
    expect(updated.ok && updated.value).toMatchObject({
      name: 'Renamed',
      version: 2,
      updated_at: T0 + 1000,
    });
    expect(store.getFunnelGraph(g.id, 1)?.name).toBe('Main funnel');
    expect(store.getFunnelGraph(g.id, 2)?.name).toBe('Renamed');

    expect(store.listFunnelGraphs()).toEqual([
      {
        id: g.id,
        name: 'Renamed',
        group_id: null,
        status: 'active',
        version: 2,
        node_count: 2,
        updated_at: T0 + 1000,
      },
    ]);

    expect(store.archiveFunnelGraph(g.id)?.status).toBe('archived');
    expect(store.listFunnelGraphs('active')).toEqual([]);
    expect(store.listFunnelGraphs('archived')).toHaveLength(1);
    expect(store.restoreFunnelGraph(g.id)?.status).toBe('active');
    expect(store.archiveFunnelGraph('fg_missing')).toBeNull();
  });

  it('rejects a stale version with conflict and leaves the graph untouched', () => {
    const { store } = createStore();
    const created = store.createFunnelGraph(graphInput());
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.id;
    expect(store.updateFunnelGraph(id, { ...graphInput('A'), version: 1 }).ok).toBe(true);
    const stale = store.updateFunnelGraph(id, { ...graphInput('B'), version: 1 });
    expect(stale).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(store.getFunnelGraph(id)).toMatchObject({ name: 'A', version: 2 });
    expect(store.updateFunnelGraph('fg_missing', { ...graphInput(), version: 1 })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('validates the input with the contract schema', () => {
    const { store } = createStore();
    const bad = store.createFunnelGraph({ ...graphInput(), nodes: [] });
    expect(bad).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    const dup = store.createFunnelGraph({
      ...graphInput(),
      nodes: [
        { id: 'x', kind: 'traffic', config: {} },
        { id: 'x', kind: 'action_proxy', config: {} },
      ],
    });
    expect(dup.ok).toBe(false);
    expect(store.listFunnelGraphs()).toEqual([]);
  });

  it('suggests condition values: tags of tag nodes and visitors, cities, campaigns', () => {
    const { store, db } = createStore();
    const base = graphInput();
    store.createFunnelGraph({
      ...base,
      nodes: [
        ...base.nodes,
        { id: 'n_tag', kind: 'tag', config: { add: ['lead'], remove: ['cold'] } },
        { id: 'n_old', kind: 'tag', deleted_at: T0, config: { add: ['gone'], remove: [] } },
      ],
    });
    store.applyVisitorTags('v1', ['vip', 'lead']);
    store.recordTouches([touch({ id: 'a', campaign: 'spring' }), touch({ id: 'b', campaign: 'spring' })]);
    for (const [id, city] of [['s1', 'Rome'], ['s2', 'Rome'], ['s3', 'Milan'], ['s4', null]] as const) {
      db.run(
        `INSERT INTO sessions (id, visitor_id, session_number, started_at, last_seen, channel, city) VALUES (?, 'v1', 1, ?, ?, 'direct', ?)`,
        id,
        T0,
        T0,
        city,
      );
    }
    expect(store.conditionValues('tag')).toEqual(['lead', 'cold', 'vip']);
    expect(store.conditionValues('city')).toEqual(['Rome', 'Milan']);
    expect(store.conditionValues('city', 1)).toEqual(['Rome']);
    expect(store.conditionValues('region')).toEqual([]);
    expect(store.conditionValues('campaign')).toEqual(['spring']);
    expect(store.conditionValues('os' as never)).toEqual([]);
  });
});

describe('traffic sources', () => {
  it('creates, reads, lists, updates (keeping renamed field names) and archives', () => {
    const { store } = createStore();
    const created = store.createTrafficSource(sourceInput());
    if (!created.ok) throw new Error(created.error.message);
    const s = created.value;
    expect(s).toMatchObject({
      name: 'Paid social',
      template: 'meta',
      status: 'active',
      cost_type: 'cpc',
    });
    expect(s.id).toMatch(/^ts_/);
    expect(s.reserved_fields.external).toEqual({
      url_param: 'fbclid',
      source_token: '',
      append: false,
    });
    expect(store.getTrafficSource(s.id)).toEqual(s);

    const renamed = store.updateTrafficSource(s.id, {
      ...sourceInput('Paid social EU'),
      fields: [{ slot: 'c1', name: 'ad_group', url_param: 'adset', source_token: '{{adset.id}}' }],
    });
    expect(renamed.ok && renamed.value.fields[0]).toMatchObject({
      name: 'ad_group',
      previous_name: 'adset',
    });
    expect(renamed.ok && renamed.value.name).toBe('Paid social EU');

    expect(store.archiveTrafficSource(s.id)?.status).toBe('archived');
    expect(store.listTrafficSources('active')).toEqual([]);
    expect(store.listTrafficSources()).toHaveLength(1);
    expect(store.restoreTrafficSource(s.id)?.status).toBe('active');
    expect(store.updateTrafficSource('ts_missing', sourceInput())).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('rejects reserved URL parameters', () => {
    const { store } = createStore();
    const input = sourceInput();
    const bad = store.createTrafficSource({
      ...input,
      reserved_fields: { ...input.reserved_fields, campaign: { url_param: 'vid' } },
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
  });
});

describe('touches', () => {
  it('records touches idempotently and lists them by visitor and range', () => {
    const { store } = createStore();
    expect(store.recordTouch(touch())).toEqual({ ok: true, value: { id: 'hit_1', created: true } });
    expect(store.recordTouch(touch({ kind: 'click' }))).toEqual({
      ok: true,
      value: { id: 'hit_1', created: false },
    });
    expect(store.getTouch('hit_1')?.kind).toBe('view');

    const batch = store.recordTouches([
      touch({ id: 'hit_1' }),
      touch({ id: 'hit_2', ts: T0 + 10, kind: 'action', action_number: 2, funnel_id: 'fg_2' }),
      touch({
        id: 'hit_3',
        ts: T0 + 20,
        visitor_id: 'visitor-2',
        fields: null,
        traffic_source_id: null,
      }),
    ]);
    expect(batch).toEqual({ ok: true, value: { inserted: 2, duplicates: 1 } });

    expect(store.listTouchesByVisitor('visitor-1').map((t) => t.id)).toEqual(['hit_1', 'hit_2']);
    expect(store.listTouchesByVisitor(['visitor-1', 'visitor-2']).map((t) => t.id)).toEqual([
      'hit_1',
      'hit_2',
      'hit_3',
    ]);
    expect(store.getTouch('hit_1')).toEqual({ ...touch(), action_number: null });
    expect(store.getTouch('hit_3')).toMatchObject({ fields: null, traffic_source_id: null });

    expect(
      store.listTouches({ from: T0, to: T0 + 100, funnel_id: 'fg_2' }).map((t) => t.id),
    ).toEqual(['hit_2']);
    expect(store.listTouches({ from: T0 + 5, to: T0 + 100 }).map((t) => t.id)).toEqual([
      'hit_2',
      'hit_3',
    ]);
    expect(
      store
        .listTouches({ from: T0, to: T0 + 100, traffic_source_id: 'ts_1', kind: 'view' })
        .map((t) => t.id),
    ).toEqual(['hit_1']);
  });

  it('rejects an invalid touch and a batch containing one', () => {
    const { store } = createStore();
    expect(store.recordTouch(touch({ kind: 'bogus' as FunnelTouch['kind'] }))).toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    });
    const batch = store.recordTouches([touch({ id: 'ok' }), touch({ id: 'bad', cost_minor: -1 })]);
    expect(batch).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(store.getTouch('ok')).toBeNull();
  });
});

describe('postback conversions', () => {
  it('updates on the same hit + tx and creates another conversion for another tx', () => {
    const clock = { now: T0 };
    const { store } = createStore(clock);
    store.recordTouch(touch());
    const first = store.recordConversionFromPostback({
      hit: 'hit_1',
      tx: 'T1',
      revenue_minor: 1000,
      currency: 'EUR',
    });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.created).toBe(true);

    clock.now = T0 + 5000;
    const again = store.recordConversionFromPostback({
      hit: 'hit_1',
      tx: 'T1',
      revenue_minor: 1500,
      status: 'pending',
    });
    expect(again).toEqual({ ok: true, value: { id: first.value.id, created: false } });

    const other = store.recordConversionFromPostback({
      hit: 'hit_1',
      tx: 'T2',
      revenue_minor: 300,
    });
    expect(other.ok && other.value.created).toBe(true);

    const list = store.listConversions({ hit: 'hit_1' });
    expect(list).toHaveLength(2);
    expect(store.getConversion(first.value.id)).toMatchObject({
      tx: 'T1',
      event: 'sale',
      status: 'pending',
      revenue_minor: 1500,
      ts: T0 + 5000,
      received_at: T0,
      updated_at: T0 + 5000,
      // attribution context comes from the hit's touch
      visitor_id: 'visitor-1',
      funnel_id: 'fg_1',
      node_id: 'n_lander',
      page_id: 'p1',
      traffic_source_id: 'ts_1',
    });
  });

  it('dedups a postback without tx and keeps custom events apart', () => {
    const { store } = createStore();
    const a = store.recordConversionFromPostback({ hit: 'hit_9', revenue_minor: 100 });
    const b = store.recordConversionFromPostback({ hit: 'hit_9', tx: null, revenue_minor: 200 });
    const ev = store.recordConversionFromPostback({
      hit: 'hit_9',
      event: 'event:1',
      revenue_minor: 0,
    });
    expect(a.ok && b.ok && b.value).toEqual({ id: a.ok ? a.value.id : '', created: false });
    expect(ev.ok && ev.value.created).toBe(true);
    expect(
      store.listConversions({ hit: 'hit_9' }).map((c) => [c.event, c.tx, c.revenue_minor]),
    ).toEqual([
      ['sale', '', 200],
      ['event:1', '', 0],
    ]);
    // no touch for this hit: attribution context stays empty
    expect(store.listConversions({ hit: 'hit_9' })[0]?.visitor_id).toBeNull();
    expect(
      store.recordConversionFromPostback({ hit: 'hit_9', event: 'refund', revenue_minor: 1 }).ok,
    ).toBe(false);
  });
});

describe('ad connections, entities and spend', () => {
  it('upserts connections by id, patching only the given fields', () => {
    const clock = { now: T0 };
    const { store } = createStore(clock);
    const c = store.upsertAdConnection({
      id: 'conn_1',
      platform: 'meta',
      account_id: 'act_1',
      account_name: 'Main',
      currency: 'EUR',
      metadata: { pixel_id: 'px_1' },
    });
    expect(c.ok && c.value).toMatchObject({
      status: 'active',
      account_name: 'Main',
      metadata: { pixel_id: 'px_1' },
      created_at: T0,
    });
    clock.now = T0 + 1;
    const patched = store.upsertAdConnection({
      id: 'conn_1',
      platform: 'meta',
      account_id: 'act_1',
      status: 'auth_expired',
      last_error: 'token',
    });
    expect(patched.ok && patched.value).toMatchObject({
      status: 'auth_expired',
      last_error: 'token',
      account_name: 'Main',
      metadata: { pixel_id: 'px_1' },
      created_at: T0,
      updated_at: T0 + 1,
    });
    store.upsertAdConnection({ id: 'conn_2', platform: 'google', account_id: '123-456' });
    expect(store.listAdConnections().map((x) => x.id)).toEqual(['conn_1', 'conn_2']);
    expect(store.listAdConnections('google').map((x) => x.id)).toEqual(['conn_2']);
    expect(store.getAdConnection('conn_1')?.platform).toBe('meta');
    expect(
      store.upsertAdConnection({ id: 'x', platform: 'other' as 'meta', account_id: 'a' }).ok,
    ).toBe(false);
  });

  it('upserts entities on platform + external id', () => {
    const { store } = createStore();
    store.upsertAdEntities(
      [
        {
          platform: 'meta',
          level: 'campaign',
          external_id: 'c1',
          name: 'Spring',
          status: 'ACTIVE',
        },
        {
          platform: 'meta',
          level: 'adset',
          external_id: 's1',
          parent_external_id: 'c1',
          name: 'IT 25-44',
          status: 'ACTIVE',
        },
      ],
      'conn_1',
    );
    store.upsertAdEntities([
      {
        platform: 'meta',
        level: 'campaign',
        external_id: 'c1',
        name: 'Spring sale',
        status: 'PAUSED',
        budget_minor: 5000,
      },
    ]);
    const all = store.listAdEntities({ platform: 'meta' });
    expect(all).toHaveLength(2);
    expect(store.listAdEntities({ level: 'campaign' })[0]).toMatchObject({
      name: 'Spring sale',
      status: 'PAUSED',
      budget_minor: 5000,
      connection_id: 'conn_1',
    });
    expect(store.listAdEntities({ parent_external_id: 'c1' }).map((e) => e.external_id)).toEqual([
      's1',
    ]);
    expect(
      store.upsertAdEntities([
        { platform: 'meta', level: 'campaign', external_id: '', name: 'x', status: 'x' },
      ]).ok,
    ).toBe(false);
  });

  it('upserts daily spend idempotently and overwrites a re-synced day', () => {
    const { store, db } = createStore();
    const day = {
      platform: 'meta' as const,
      entity_external_id: 'c1',
      day: '2026-10-14',
      spend_minor: 1000,
      clicks: 10,
    };
    store.upsertAdSpend([day, { ...day, day: '2026-10-15', spend_minor: 500 }]);
    store.upsertAdSpend([day]);
    expect(db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ad_spend_daily`)[0]?.n).toBe(2);

    store.upsertAdSpend([
      {
        ...day,
        spend_minor: 1200,
        reported_conversions: 3,
        reported_revenue_minor: 9000,
        currency: 'EUR',
      },
    ]);
    expect(store.listAdSpend({ from: '2026-10-14', to: '2026-10-14' })).toEqual([
      {
        platform: 'meta',
        entity_external_id: 'c1',
        day: '2026-10-14',
        spend_minor: 1200,
        currency: 'EUR',
        clicks: 10,
        impressions: null,
        reported_conversions: 3,
        reported_revenue_minor: 9000,
      },
    ]);
    expect(store.listAdSpend({ from: '2026-10-01', to: '2026-10-31' }).map((r) => r.day)).toEqual([
      '2026-10-14',
      '2026-10-15',
    ]);
    expect(store.listAdSpend({ from: '2026-10-01', to: '2026-10-31', platform: 'google' })).toEqual(
      [],
    );
    expect(store.upsertAdSpend([{ ...day, spend_minor: -1 }]).ok).toBe(false);
  });
});

describe('outbound conversions', () => {
  const job = (eventId: string) => ({
    platform: 'meta' as const,
    connection_id: 'conn_1',
    kind: 'purchase' as const,
    payload,
    event_id: eventId,
  });

  it('dedups on event_id', () => {
    const { store } = createStore();
    const a = store.enqueueOutbound(job('ev_1'));
    const b = store.enqueueOutbound(job('ev_1'));
    expect(a.ok && a.value.created).toBe(true);
    expect(b).toEqual({ ok: true, value: { id: a.ok ? a.value.id : '', created: false } });
    expect(store.listOutbound()).toHaveLength(1);
    expect(
      store.enqueueOutbound({ ...job('ev_2'), payload: { ...payload, event_name: '' } }).ok,
    ).toBe(false);
  });

  it('claims due pending jobs with a lease and settles them', () => {
    const clock = { now: T0 };
    const { store } = createStore(clock);
    const a = store.enqueueOutbound(job('ev_a'));
    const b = store.enqueueOutbound(job('ev_b'));
    store.enqueueOutbound({ ...job('ev_later'), next_attempt_at: T0 + 60_000 });
    if (!a.ok || !b.ok) throw new Error('enqueue failed');

    const claimed = store.claimOutboundBatch(T0, 10);
    expect(claimed.map((j) => j.event_id)).toEqual(['ev_a', 'ev_b']);
    expect(claimed[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      next_attempt_at: T0 + OUTBOUND_CLAIM_LEASE_MS,
      payload,
    });
    // leased: a second claim does not see them
    expect(store.claimOutboundBatch(T0 + 1, 10)).toEqual([]);

    clock.now = T0 + 100;
    expect(store.settleOutbound(a.value.id, { status: 'sent' })).toMatchObject({
      status: 'sent',
      sent_at: T0 + 100,
      next_attempt_at: null,
    });
    expect(
      store.settleOutbound(b.value.id, {
        status: 'retry',
        error: 'rate limited',
        next_attempt_at: T0 + 30_000,
      }),
    ).toMatchObject({
      status: 'pending',
      last_error: 'rate limited',
      attempts: 1,
    });

    expect(store.claimOutboundBatch(T0 + 60_000, 10).map((j) => j.event_id)).toEqual([
      'ev_b',
      'ev_later',
    ]);
    expect(store.claimOutboundBatch(T0 + 60_000, 1)).toEqual([]);
    expect(
      store.settleOutbound(b.value.id, { status: 'failed', error: 'bad request' }),
    ).toMatchObject({ status: 'failed', attempts: 2 });

    expect(store.listOutbound({ status: 'failed' }).map((j) => j.event_id)).toEqual(['ev_b']);
    expect(store.listOutbound({ status: 'sent', platform: 'meta' }).map((j) => j.event_id)).toEqual(
      ['ev_a'],
    );
    expect(store.listOutbound({ event_id: 'ev_later' })).toHaveLength(1);
    expect(store.settleOutbound('ob_missing', { status: 'sent' })).toBeNull();
  });
});

describe('identity keys and blacklist', () => {
  it('upserts keys once per visitor and finds visitors by key', () => {
    const { store } = createStore();
    const r = store.upsertIdentityKeys([
      { key_type: 'email', key_value: 'ada@example.com', visitor_id: 'v1', first_seen: T0 + 10 },
      { key_type: 'email', key_value: 'ada@example.com', visitor_id: 'v2', first_seen: T0 + 20 },
      { key_type: 'phone', key_value: '+393331234567', visitor_id: 'v2', first_seen: T0 + 20 },
    ]);
    expect(r).toEqual({ ok: true, value: { added: 3 } });
    expect(
      store.upsertIdentityKeys([
        { key_type: 'email', key_value: 'ada@example.com', visitor_id: 'v1', first_seen: T0 },
      ]),
    ).toEqual({
      ok: true,
      value: { added: 0 },
    });
    expect(store.findVisitorsByKey('email', 'ada@example.com')).toEqual([
      { key_type: 'email', key_value: 'ada@example.com', visitor_id: 'v1', first_seen: T0 },
      { key_type: 'email', key_value: 'ada@example.com', visitor_id: 'v2', first_seen: T0 + 20 },
    ]);
    expect(store.findVisitorsByKey('phone', '+390000000000')).toEqual([]);
    expect(store.listIdentityKeys('v2').map((k) => k.key_type)).toEqual(['email', 'phone']);
    expect(
      store.upsertIdentityKeys([
        { key_type: 'fax' as 'email', key_value: 'x', visitor_id: 'v', first_seen: T0 },
      ]).ok,
    ).toBe(false);
  });

  it('blacklists keys and applies visitor tags', () => {
    const { store } = createStore();
    store.addToBlacklist([{ key_type: 'email', key_value: 'gone@example.com' }]);
    store.addToBlacklist([{ key_type: 'email', key_value: 'gone@example.com' }]);
    expect(store.isBlacklisted([{ key_type: 'email', key_value: 'gone@example.com' }])).toBe(true);
    expect(
      store.isBlacklisted([
        { key_type: 'phone', key_value: '+391' },
        { key_type: 'email', key_value: 'gone@example.com' },
      ]),
    ).toBe(true);
    expect(store.isBlacklisted([{ key_type: 'email', key_value: 'ok@example.com' }])).toBe(false);
    expect(store.listBlacklist()).toHaveLength(1);
    store.removeFromBlacklist([{ key_type: 'email', key_value: 'gone@example.com' }]);
    expect(store.isBlacklisted([{ key_type: 'email', key_value: 'gone@example.com' }])).toBe(false);

    expect(store.applyVisitorTags('v1', ['vip', 'lead'])).toEqual(['lead', 'vip']);
    expect(store.applyVisitorTags('v1', ['buyer'], ['lead'])).toEqual(['buyer', 'vip']);
    expect(store.listVisitorTags('v1')).toEqual(['buyer', 'vip']);
  });
});

describe('retention of anonymous touches', () => {
  it('deletes anonymous touches older than 90 days and keeps identified ones', async () => {
    const clock = { now: T0 };
    const { store, db } = createStore(clock);
    store.initSite(siteInit({ retentionDays: 0 }));
    const old = T0 - 91 * DAY;
    store.recordTouches([
      touch({ id: 'old_anon', ts: old, visitor_id: 'anon' }),
      touch({ id: 'recent_anon', ts: T0 - 10 * DAY, visitor_id: 'anon' }),
      touch({ id: 'old_known', ts: old, visitor_id: 'known' }),
      touch({ id: 'old_later_known', ts: old, visitor_id: 'later' }),
      touch({ id: 'old_contact', ts: old, visitor_id: 'contact' }),
    ]);
    store.upsertIdentityKeys([
      { key_type: 'email', key_value: 'k@example.com', visitor_id: 'known', first_seen: old },
    ]);
    // a session key alone does not identify a visitor
    store.upsertIdentityKeys([
      { key_type: 'session', key_value: 's1', visitor_id: 'anon', first_seen: old },
    ]);
    expect(store.recordTouch(touch({ id: 'new_known', ts: old, visitor_id: 'known' })).ok).toBe(
      true,
    );
    // identified outside the identity keys: CRM contact link on the visitor row
    db.run(
      `INSERT INTO visitors (id, first_seen, last_seen, contact_id) VALUES ('contact', ?, ?, 'ct_1')`,
      old,
      old,
    );

    const result = await store.retention(null);
    expect(result?.anonymous_touches).toBe(2);
    const left = db.all<{ id: string; identified: number }>(
      `SELECT id, identified FROM touches ORDER BY id`,
    );
    expect(left).toEqual([
      { id: 'new_known', identified: 1 },
      { id: 'old_contact', identified: 1 },
      { id: 'old_known', identified: 1 },
      { id: 'recent_anon', identified: 0 },
    ]);
  });
});

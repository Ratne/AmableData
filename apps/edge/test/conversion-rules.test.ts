import type { ConversionRule, CreateConversionRuleInput } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import {
  backfillRule,
  getRule,
  normalizeRulePath,
  pageMatches,
} from '../src/analytics/store/conversion-rules';
import type { AnalyticsStore } from '../src/analytics/store/index';
import { createStore, ev, siteInit, SITE_ID, T0 } from './helpers';
import { createSources, D, touch } from './reports-fixture';

const DAY = 86_400_000;
const range = { from: '2026-10-01', to: '2026-10-31' };

function setup() {
  const clock = { now: T0 + 10 * DAY };
  const { store, db } = createStore(clock);
  store.initSite(siteInit());
  return { store, db, clock };
}

function rule(store: AnalyticsStore, input: CreateConversionRuleInput): ConversionRule {
  const r = store.createConversionRule(input);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const ad = {
  campaignId: 'c1',
  adSetId: 'as1',
  adId: 'ad1',
  placement: null,
  keyword: null,
  network: null,
};

/** v1: lands on /landing from a Meta ad, comes back directly two days later and reaches /grazie. */
function journey(store: AnalyticsStore, vid = 'v1', offset = 0) {
  store.ingest(
    [
      ev({
        vid,
        sid: `${vid}-s1`,
        ts: T0 + offset,
        path: '/landing',
        channel: 'Paid social',
        paid: true,
        ad,
      }),
      ev({ vid, sid: `${vid}-s2`, ts: T0 + offset + DAY, path: '/blog', sessionNumber: 2 }),
      ev({ vid, sid: `${vid}-s3`, ts: T0 + offset + 2 * DAY, path: '/grazie', sessionNumber: 3 }),
      ev({
        vid,
        sid: `${vid}-s3`,
        ts: T0 + offset + 2 * DAY + 60_000,
        path: '/grazie/',
        sessionNumber: 3,
      }),
    ],
    [],
  );
}

describe('conversion rule paths', () => {
  it('normalizes paths and URLs like the ingest stores them', () => {
    expect(normalizeRulePath('https://www.shop.it/grazie/?ok=1#top', 'exact')).toEqual({
      path: '/grazie',
      hostname: 'www.shop.it',
    });
    expect(normalizeRulePath('grazie?x', 'starts_with')).toEqual({
      path: '/grazie',
      hostname: null,
    });
    expect(normalizeRulePath('/app#/done?x=1', 'exact')).toEqual({
      path: '/app#/done',
      hostname: null,
    });
    expect(normalizeRulePath('grazie', 'contains')).toEqual({ path: 'grazie', hostname: null });
    expect(normalizeRulePath('https://', 'exact')).toBeNull();
  });

  it('matches exact (trailing slash too), prefix, substring and hostname', () => {
    const exact = { match: 'exact' as const, value: '/grazie', hostname: null };
    expect(pageMatches(exact, 'a.com', '/grazie')).toBe(true);
    expect(pageMatches(exact, 'a.com', '/grazie/')).toBe(true);
    expect(pageMatches(exact, 'a.com', '/grazie/2')).toBe(false);
    expect(
      pageMatches({ ...exact, match: 'starts_with', value: '/checkout' }, null, '/checkout/ok'),
    ).toBe(true);
    expect(
      pageMatches({ ...exact, match: 'contains', value: 'thank' }, null, '/en/thank-you'),
    ).toBe(true);
    const host = { ...exact, hostname: 'shop.it' };
    expect(pageMatches(host, 'www.shop.it', '/grazie')).toBe(true);
    expect(pageMatches(host, 'blog.shop.it', '/grazie')).toBe(false);
  });
});

describe('conversion rules', () => {
  it('validates and numbers the rules; goal values become goal names', () => {
    const { store } = setup();
    const page = rule(store, { name: 'Acquisto completato', value: '/grazie' });
    expect(page).toMatchObject({
      key: 'acquisto_completato',
      event: 'event:100',
      count: 'once',
      enabled: true,
    });
    const goal = rule(store, { name: 'Acquisto completato', trigger: 'goal', value: 'Sign Up' });
    expect(goal).toMatchObject({
      key: 'acquisto_completato_2',
      value: 'sign_up',
      event: 'event:101',
    });
    const bad = store.createConversionRule({ name: 'x', value: 'https://' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
    expect(store.updateConversionRule(page.id, { enabled: false })).toMatchObject({
      ok: true,
      value: { enabled: false },
    });
    expect(store.updateConversionRule('cr_missing', { enabled: false })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('converts a return visit once, records the rule goal and credits the earlier ad session', () => {
    const { store, db } = setup();
    store.upsertAdEntities([
      { platform: 'meta', level: 'campaign', external_id: 'c1', name: 'Spring', status: 'ACTIVE' },
    ]);
    const r = rule(store, { name: 'Acquisto completato', value: '/grazie' });
    journey(store);
    const rows = db.all<{ event: string; source: string; visitor_id: string }>(
      `SELECT event, source, visitor_id FROM conversion_log`,
    );
    expect(rows).toEqual([{ event: r.event, source: 'rule', visitor_id: 'v1' }]);
    const goals = db.all<{ name: string; params: string }>(`SELECT name, params FROM goals`);
    expect(goals).toEqual([
      { name: 'acquisto_completato', params: JSON.stringify({ rule: r.id }) },
    ]);
    expect(
      db.all<{ goals: number; pageviews: number }>(
        `SELECT goals, pageviews FROM sessions WHERE id = 'v1-s3'`,
      ),
    ).toEqual([{ goals: 1, pageviews: 2 }]);

    const first = store.conversionReport(range, { dimension: 'ad_campaign', model: 'first_touch' });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.totals).toEqual({
      conversions: 1,
      persons: 1,
      value_minor: 0,
      conversion_rate: 1,
    });
    expect(first.value.breakdown).toEqual([
      { value: 'c1', label: 'Spring', conversions: 1, value_minor: 0 },
    ]);
    expect(first.value.recent[0]).toMatchObject({
      rule_id: r.id,
      trigger: '/grazie',
      entry_page: '/landing',
      ad_campaign: 'c1',
      ad: 'ad1',
      first_touch: { channel: 'Paid social' },
      last_non_direct_touch: { channel: 'Paid social' },
    });
    const last = store.conversionReport(range, { dimension: 'ad_campaign', model: 'last_touch' });
    expect(last.ok && last.value.breakdown).toEqual([
      { value: null, label: null, conversions: 1, value_minor: 0 },
    ]);
    const lastNonDirect = store.conversionReport(range, {
      dimension: 'channel',
      model: 'last_non_direct',
    });
    expect(lastNonDirect.ok && lastNonDirect.value.breakdown[0]?.value).toBe('Paid social');
  });

  it('counts every match with `every` and carries the fixed value', () => {
    const { store } = setup();
    rule(store, {
      name: 'Thanks',
      value: 'grazie',
      match: 'contains',
      count: 'every',
      value_minor: 500,
    });
    journey(store);
    const report = store.conversionReport(range);
    expect(report.ok && report.value.totals).toEqual({
      conversions: 2,
      persons: 1,
      value_minor: 1000,
      conversion_rate: 1,
    });
  });

  it('triggers goal rules from browser and CRM goals, never from rule goals', () => {
    const { store, db } = setup();
    rule(store, { name: 'Pagina lead', value: '/grazie' });
    rule(store, { name: 'Da goal regola', trigger: 'goal', value: 'pagina_lead' });
    const signup = rule(store, { name: 'Signup', trigger: 'goal', value: 'signup' });
    const lead = rule(store, { name: 'Lead', trigger: 'goal', value: 'lead', count: 'every' });
    journey(store);
    store.ingest(
      [ev({ vid: 'v1', sid: 'v1-s3', type: 'goal', name: 'signup', ts: T0 + 3 * DAY })],
      [],
    );
    store.applyCrmFacts([
      {
        kind: 'goal',
        id: 'g1',
        name: 'lead',
        contactId: null,
        visitorId: 'v1',
        params: null,
        ts: T0 + 3 * DAY,
      },
    ]);
    const events = db
      .all<{ event: string }>(`SELECT event FROM conversion_log ORDER BY event`)
      .map((r) => r.event);
    expect(events).toEqual(['event:100', signup.event, lead.event].sort());
  });

  it('backfills past pageviews once per visitor or per pageview, idempotently', () => {
    const { store, db } = setup();
    journey(store, 'v1');
    journey(store, 'v2', 3 * DAY);
    const once = rule(store, { name: 'Once', value: '/grazie', backfill: true });
    expect(once.backfilled).toBe(2);
    const firstTs = db.all<{ ts: number }>(
      `SELECT ts FROM conversion_log WHERE event = ? AND visitor_id = 'v1'`,
      once.event,
    );
    expect(firstTs).toEqual([{ ts: T0 + 2 * DAY }]);
    const every = rule(store, { name: 'Every', value: '/grazie', count: 'every', backfill: true });
    expect(every.backfilled).toBe(4);
    expect(backfillRule(db, getRule(db, every.id)!, 'EUR', T0)).toBe(0);
    // Live ingest of a new matching pageview adds exactly one more.
    store.ingest(
      [ev({ vid: 'v1', sid: 'v1-s4', ts: T0 + 6 * DAY, path: '/grazie', sessionNumber: 4 })],
      [],
    );
    const n = db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM conversion_log WHERE event = ?`,
      every.event,
    );
    expect(n).toEqual([{ n: 5 }]);
  });

  it('deletes the conversions with the rule and reuses its event number', () => {
    const { store, db } = setup();
    const r = rule(store, { name: 'Thanks', value: '/grazie' });
    journey(store);
    expect(store.deleteConversionRule(r.id)).toBe(true);
    expect(db.all(`SELECT 1 FROM conversion_log`)).toEqual([]);
    expect(rule(store, { name: 'Again', value: '/x' }).event).toBe(r.event);
    expect(store.listConversionRules()).toHaveLength(1);
  });

  it('merges the visitors of a CRM contact into one person', () => {
    const { store } = setup();
    rule(store, { name: 'Thanks', value: '/grazie' });
    store.ingest(
      [ev({ vid: 'laptop', sid: 'l1', ts: T0, path: '/landing', channel: 'Paid social', ad })],
      [],
    );
    store.ingest([ev({ vid: 'phone', sid: 'p1', ts: T0 + DAY, path: '/grazie' })], []);
    store.applyCrmFacts([
      { kind: 'link', id: 'l-a', contactId: 'ct_1', visitorId: 'laptop', source: 'form', ts: T0 },
      {
        kind: 'link',
        id: 'l-b',
        contactId: 'ct_1',
        visitorId: 'phone',
        source: 'form',
        ts: T0 + DAY,
      },
    ]);
    const report = store.conversionReport(range, {
      dimension: 'ad_campaign',
      model: 'first_touch',
    });
    if (!report.ok) throw new Error(report.error.message);
    expect(report.value.totals.persons).toBe(1);
    expect(report.value.breakdown[0]?.value).toBe('c1');
  });

  it('filters by rule and by session filters', () => {
    const { store } = setup();
    const a = rule(store, { name: 'A', value: '/grazie' });
    rule(store, { name: 'B', value: '/blog' });
    journey(store);
    const one = store.conversionReport(range, { rule_id: a.id });
    expect(one.ok && one.value.rules.map((r) => [r.name, r.conversions])).toEqual([['A', 1]]);
    const all = store.conversionReport(range);
    expect(all.ok && all.value.totals.conversions).toBe(2);
    const filtered = store.conversionReport(
      { ...range, filters: [{ dimension: 'country', op: 'is', value: 'FR' }] },
      {},
    );
    expect(filtered.ok && filtered.value.totals.conversions).toBe(0);
    expect(store.conversionReport(range, { rule_id: 'cr_nope' })).toMatchObject({ ok: false });
  });
});

describe('custom conversions on hosted pages', () => {
  it('fire on the connected domain and on the /p/<slug> fallback URL', () => {
    const { store, db } = setup();
    const domain = rule(store, { name: 'Grazie shop', value: 'https://shop.acme.test/grazie' });
    const fallback = rule(store, { name: 'Grazie fallback', value: '/p/acme/grazie', match: 'starts_with' });
    store.ingest(
      [
        ev({ vid: 'v1', sid: 'v1-s1', ts: T0, hostname: 'shop.acme.test', path: '/grazie' }),
        ev({ vid: 'v1', sid: 'v1-s1', ts: T0 + 1000, hostname: 'other.acme.test', path: '/grazie' }),
        ev({ vid: 'v2', sid: 'v2-s1', ts: T0, hostname: 'e.acme.test', path: '/p/acme/grazie/ordine' }),
      ],
      [],
    );
    const rows = db.all<{ event: string; visitor_id: string }>(
      `SELECT event, visitor_id FROM conversion_log ORDER BY visitor_id`,
    );
    expect(rows).toEqual([
      { event: domain.event, visitor_id: 'v1' },
      { event: fallback.event, visitor_id: 'v2' },
    ]);
  });
});

describe('custom conversions in the ads performance report', () => {
  it('credits rule conversions to the arrival touches with cost per conversion', () => {
    const { store } = createStore({ now: D(20) });
    store.initSite(siteInit());
    const { meta } = createSources(store);
    const thanks = rule(store, { name: 'Thanks', value: '/grazie' });
    const other = rule(store, { name: 'Other', value: '/other' });
    store.recordTouches([
      touch('a', D(2), meta, 'm1', { cost_minor: 40 }),
      touch('b', D(2), meta, 'm1', { cost_minor: 40 }),
    ]);
    store.ingest([ev({ vid: 'a', sid: 'a-s', ts: D(3), path: '/grazie', firstSeen: D(3) })], []);
    const run = (extra: Record<string, unknown> = {}) => {
      const r = store.adsPerformanceReport({
        site_id: SITE_ID,
        from: '2026-10-01',
        to: '2026-10-31',
        group_by: 'campaign',
        ...extra,
      });
      if (!r.ok) throw new Error(r.error.message);
      return r.value.rows.find((row) => row.key === 'm1');
    };
    expect(run()).toMatchObject({
      visits: 2,
      cost_minor: 80,
      conversions: 1,
      cost_per_conversion_minor: 80,
      conversion_rate: 0.5,
    });
    expect(run({ conversion_id: thanks.id })?.conversions).toBe(1);
    expect(run({ conversion_id: other.id })).toMatchObject({
      conversions: 0,
      cost_per_conversion_minor: null,
    });
  });
});

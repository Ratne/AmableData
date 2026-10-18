import { createHash } from 'node:crypto';
import type { FunnelTouch } from '@amable/api-types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  identityKeyRefs,
  normalizeEmailKey,
  normalizePhoneKey,
  sha256Hex,
  visitorOrigins,
} from '../src/analytics/store/identity';
import type { EnrichedEvent } from '../src/analytics/types';
import { createStore, ev, siteInit, T0 } from './helpers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const nodeSha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function touch(overrides: Partial<FunnelTouch> = {}): FunnelTouch {
  return {
    id: 'hit_1',
    ts: T0,
    visitor_id: 'v-click',
    session_id: 's-click',
    funnel_id: 'fg_1',
    node_id: 'n_lander',
    page_id: 'p1',
    traffic_source_id: 'ts_paid',
    kind: 'entrance',
    campaign: 'cmp_1',
    external_click_id: 'click-abc',
    fields: null,
    cost_minor: 40,
    ...overrides,
  };
}

const pageview = (vid: string, sid: string, ts: number, extra: Partial<EnrichedEvent> = {}): EnrichedEvent =>
  ev({ vid, sid, ts, firstSeen: ts, ...extra });

const identify = (
  vid: string,
  sid: string,
  ts: number,
  id: { email?: string; phone?: string },
): EnrichedEvent =>
  ev({
    vid,
    sid,
    ts,
    firstSeen: null,
    type: 'identify',
    identity: {
      userId: null,
      email: id.email ?? null,
      name: null,
      traits: id.phone === undefined ? null : { phone: id.phone },
    },
  });

const payment = (vid: string, sid: string, ts: number, tx: string, email: string | null = null): EnrichedEvent =>
  ev({
    vid,
    sid,
    ts,
    firstSeen: null,
    type: 'payment',
    payment: {
      amountMinor: 9900,
      currency: 'EUR',
      transactionId: tx,
      email,
      customerId: null,
      renewal: false,
      refunded: false,
      freeTrial: false,
    },
  });

describe('identity normalization', () => {
  it('computes SHA-256 synchronously (matches node:crypto)', () => {
    for (const s of ['', 'abc', 'mario.rossi@example.com', 'à è ì ò ù — 😀', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(1000)]) {
      expect(sha256Hex(s)).toBe(nodeSha(s));
    }
  });

  it('normalizes emails (trim + lower-case) and phones (E.164)', () => {
    expect(normalizeEmailKey('  Mario.Rossi@Example.COM ')).toBe('mario.rossi@example.com');
    expect(normalizeEmailKey('not-an-email')).toBeNull();
    expect(normalizePhoneKey('+39 333 123 4567')).toBe('+393331234567');
    expect(normalizePhoneKey('0039 (333) 123-4567')).toBe('+393331234567');
    expect(normalizePhoneKey('abc')).toBeNull();
  });

  it('stores a plain email also as its SHA-256; a hashed he= stays a single email key', () => {
    const hash = nodeSha('mario.rossi@example.com');
    expect(identityKeyRefs({ email: 'Mario.Rossi@example.com', phone: '+39 333 1234567' })).toEqual([
      { key_type: 'email', key_value: 'mario.rossi@example.com' },
      { key_type: 'email', key_value: hash },
      { key_type: 'phone', key_value: '+393331234567' },
    ]);
    expect(identityKeyRefs({ landingEmail: hash.toUpperCase() })).toEqual([{ key_type: 'email', key_value: hash }]);
    // A clear he= email comes from a URL: only its hash is kept.
    expect(identityKeyRefs({ landingEmail: ' Mario.Rossi@example.com' })).toEqual([{ key_type: 'email', key_value: hash }]);
    expect(identityKeyRefs({ email: 'bad', phone: 'x' })).toEqual([]);
  });
});

describe('identity merge and retro-attribution', () => {
  const clock = { now: T0 };
  let store: ReturnType<typeof createStore>['store'];
  let db: ReturnType<typeof createStore>['db'];

  beforeEach(() => {
    clock.now = T0;
    ({ store, db } = createStore(clock));
    store.initSite(siteInit());
  });

  const identifiedFlag = (id: string): number | undefined =>
    db.all<{ identified: number }>(`SELECT identified FROM touches WHERE id = ?`, id)[0]?.identified;

  it('anonymous click, then an order days later with the same phone on another device: one journey, click credited', async () => {
    // Day 0: anonymous click on a paid source, opt-in with the phone a few minutes later.
    store.ingest([pageview('v-click', 's-click', T0)], []);
    expect(store.recordTouch(touch()).ok).toBe(true);
    expect(identifiedFlag('hit_1')).toBe(0);
    store.ingest([identify('v-click', 's-click', T0 + 5 * MIN, { phone: '+39 333 123 4567' })], []);
    // Day 3: another device identifies with the same number (other format) and pays.
    const later = T0 + 3 * DAY;
    clock.now = later;
    const r = store.ingest(
      [
        pageview('v-phone', 's-phone', later),
        identify('v-phone', 's-phone', later + MIN, { phone: '0039 333 1234567' }),
        payment('v-phone', 's-phone', later + 2 * MIN, 'tx-1'),
      ],
      [],
    );
    expect(r.ingested).toBe(3);

    const graph = store.visitorIdentityGraph('v-phone');
    expect(graph).toMatchObject({ origin_visitor_id: 'v-click', visitor_ids: ['v-click', 'v-phone'] });
    expect(graph?.merges).toEqual([
      { child_visitor_id: 'v-phone', origin_visitor_id: 'v-click', mechanism: 'phone', active: true, created_at: later + MIN },
    ]);
    expect(store.resolveVisitorGroup('v-click')).toEqual(['v-click', 'v-phone']);

    // The journey of the group starts with the original click: first-touch credit goes to its source.
    const journey = store.listTouchesByVisitor(store.resolveVisitorGroup('v-phone'));
    expect(journey.map((t) => [t.id, t.traffic_source_id])).toEqual([['hit_1', 'ts_paid']]);
    expect(identifiedFlag('hit_1')).toBe(1);
    const paidBy = db.all<{ visitor_id: string }>(`SELECT visitor_id FROM payments WHERE transaction_id = 'tx-1'`);
    expect(store.resolveVisitorGroup(paidBy[0]?.visitor_id ?? '')).toContain('v-click');

    // The identified click survives the anonymous-touch retention.
    store.recordTouch(touch({ id: 'hit_anon', visitor_id: 'v-nobody', session_id: 's-x' }));
    clock.now = T0 + 120 * DAY;
    await store.retention(null);
    expect(store.getTouch('hit_1')).not.toBeNull();
    expect(store.getTouch('hit_anon')).toBeNull();
  });

  it('orders from the CRM (phone of the contact) merge too', () => {
    store.ingest([pageview('v-click', 's-click', T0)], []);
    store.recordTouch(touch());
    store.ingest([identify('v-click', 's-click', T0 + MIN, { phone: '+393331234567' })], []);
    store.ingest([pageview('v-shop', 's-shop', T0 + 2 * DAY)], []);
    expect(
      store.identifyVisitors([
        { visitor_id: 'v-shop', email: 'Buyer@Example.com', phone: '+39 333 123 4567', ts: T0 + 2 * DAY },
        { visitor_id: 'v-unknown', phone: '+393331234567', ts: T0 },
        { visitor_id: 'v-shop', email: 'nope', ts: T0 },
      ]),
    ).toEqual({ ok: true, value: { added: 3, merged: 1, skipped: 2 } });
    expect(store.resolveVisitorGroup('v-shop')).toEqual(['v-click', 'v-shop']);
    expect(store.identifyVisitors([{ visitor_id: '', ts: 1 }]).ok).toBe(false);
  });

  it('the visitor first seen earlier becomes origin, whatever the order of identification', () => {
    store.ingest([pageview('v-old', 's-old', T0), pageview('v-new', 's-new', T0 + DAY)], []);
    store.ingest([identify('v-new', 's-new', T0 + DAY + MIN, { email: 'a@example.com' })], []);
    store.ingest([identify('v-old', 's-old', T0 + DAY + 2 * MIN, { email: 'A@example.com' })], []);
    expect(store.visitorIdentityGraph('v-new')).toMatchObject({
      origin_visitor_id: 'v-old',
      merges: [expect.objectContaining({ child_visitor_id: 'v-new', origin_visitor_id: 'v-old', mechanism: 'email' })],
    });
  });

  it('merges cross-device through a hashed he= landing link (session of the click)', () => {
    store.ingest([pageview('v-desktop', 's-desk', T0), identify('v-desktop', 's-desk', T0 + MIN, { email: ' Mario.Rossi@Example.com' })], []);
    const hash = nodeSha('mario.rossi@example.com');
    // Mobile opens the email link: the landing URL carries he= (anonymous touch first).
    const t1 = T0 + DAY;
    store.recordTouch(touch({ id: 'hit_mobile', visitor_id: 'v-mobile', session_id: 's-mob', ts: t1 - MIN }));
    store.ingest([pageview('v-mobile', 's-mob', t1, { url: `https://www.example.com/offer?he=${hash}` })], []);
    expect(store.visitorIdentityGraph('v-mobile')).toMatchObject({
      origin_visitor_id: 'v-desktop',
      visitor_ids: ['v-desktop', 'v-mobile'],
    });
    expect(identifiedFlag('hit_mobile')).toBe(1);
    // The structured `la.he` of the tracker payload works as well, plain or hashed.
    store.ingest(
      [{ ...pageview('v-tablet', 's-tab', t1 + HOUR), la: { he: 'MARIO.ROSSI@example.com' } } as EnrichedEvent],
      [],
    );
    expect(store.resolveVisitorGroup('v-tablet')).toEqual(['v-desktop', 'v-mobile', 'v-tablet']);
  });

  it('merges by shared session id, and only while the mechanism is enabled', () => {
    store.ingest([pageview('v-a', 's-shared', T0), identify('v-a', 's-shared', T0 + MIN, { phone: '+393330000001' })], []);
    store.ingest([identify('v-b', 's-shared', T0 + 2 * MIN, { phone: '+393330000002' })], []);
    expect(store.visitorIdentityGraph('v-b')?.merges).toEqual([
      expect.objectContaining({ child_visitor_id: 'v-b', origin_visitor_id: 'v-a', mechanism: 'session', active: true }),
    ]);

    expect(store.getIdentitySettings()).toEqual({ email: true, phone: true, session: true });
    expect(store.updateIdentitySettings({ session: false })).toEqual({
      ok: true,
      value: { email: true, phone: true, session: false },
    });
    expect(store.updateIdentitySettings({ ip: true } as never).ok).toBe(false);
    store.ingest([pageview('v-c', 's-other', T0 + HOUR), identify('v-c', 's-other', T0 + HOUR, { phone: '+393330000003' })], []);
    store.ingest([identify('v-d', 's-other', T0 + HOUR + MIN, { phone: '+393330000004' })], []);
    expect(store.resolveVisitorGroup('v-d')).toEqual(['v-d']);
  });

  it('unmerge restores both profiles; automatic merges respect it, a manual merge re-links', () => {
    store.ingest([pageview('v-1', 's-1', T0), identify('v-1', 's-1', T0 + MIN, { email: 'p@example.com' })], []);
    store.ingest([pageview('v-2', 's-2', T0 + DAY), identify('v-2', 's-2', T0 + DAY + MIN, { email: 'p@example.com' })], []);
    store.recordTouch(touch({ id: 'hit_v2', visitor_id: 'v-2', session_id: 's-2', ts: T0 + DAY }));
    expect(store.resolveVisitorGroup('v-1')).toEqual(['v-1', 'v-2']);

    const un = store.unmergeVisitors('v-2');
    expect(un.ok && un.value.child.visitor_ids).toEqual(['v-2']);
    expect(un.ok && un.value.origin.visitor_ids).toEqual(['v-1']);
    expect(un.ok && un.value.child.merges).toEqual([expect.objectContaining({ active: false, mechanism: 'email' })]);
    // Individual data untouched.
    expect(store.visitorProfile('v-1')?.sessions).toHaveLength(1);
    expect(store.visitorProfile('v-2')?.sessions).toHaveLength(1);
    expect(store.listTouchesByVisitor(store.resolveVisitorGroup('v-1'))).toEqual([]);
    expect(store.listTouchesByVisitor(store.resolveVisitorGroup('v-2')).map((t) => t.id)).toEqual(['hit_v2']);
    expect(store.unmergeVisitors('v-2')).toMatchObject({ ok: false, error: { code: 'not_found' } });

    // The shared key shows up again: no automatic reconnection.
    store.ingest([identify('v-2', 's-2', T0 + 2 * DAY, { email: 'p@example.com' })], []);
    expect(store.resolveVisitorGroup('v-2')).toEqual(['v-2']);
    // A reprocess keeps the disconnection too.
    expect(store.reprocessVisitors({ from: 0, to: T0 + 10 * DAY })).toMatchObject({ ok: true, value: { merges: 0 } });

    const merged = store.mergeVisitors('v-1', 'v-2');
    expect(merged.ok && merged.value.visitor_ids).toEqual(['v-1', 'v-2']);
    expect(merged.ok && merged.value.merges).toEqual([
      expect.objectContaining({ child_visitor_id: 'v-2', origin_visitor_id: 'v-1', mechanism: 'manual', active: true }),
    ]);
    expect(store.mergeVisitors('v-1', 'v-2')).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(store.mergeVisitors('v-1', 'v-ghost')).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('resolves chains to the group origin (VISITOR_ORIGIN_CTE)', () => {
    store.ingest([pageview('v-a', 'sa', T0), pageview('v-b', 'sb', T0 + 1), pageview('v-c', 'sc', T0 + 2), pageview('v-z', 'sz', T0 + 3)], []);
    store.mergeVisitors('v-b', 'v-c');
    store.mergeVisitors('v-a', 'v-b');
    expect(store.resolveVisitorGroup('v-c')).toEqual(['v-a', 'v-b', 'v-c']);
    expect(visitorOrigins(db, ['v-a', 'v-b', 'v-c', 'v-z'])).toEqual(
      new Map([
        ['v-a', 'v-a'],
        ['v-b', 'v-a'],
        ['v-c', 'v-a'],
        ['v-z', 'v-z'],
      ]),
    );
    // Disconnecting the middle link takes its own child along.
    store.unmergeVisitors('v-b');
    expect(store.resolveVisitorGroup('v-c')).toEqual(['v-b', 'v-c']);
    expect(store.resolveVisitorGroup('v-a')).toEqual(['v-a']);
  });

  it('GDPR blacklist: future events with the keys of a deleted visitor are dropped', () => {
    store.ingest([pageview('v-gone', 's-g', T0), identify('v-gone', 's-g', T0 + MIN, { email: 'gone@example.com', phone: '+393339999999' })], []);
    expect(store.blacklistVisitorKeys('v-gone')).toBe(3);
    const hash = nodeSha('gone@example.com');
    const r = store.ingest(
      [
        identify('v-new', 's-n', T0 + DAY, { email: 'GONE@example.com' }),
        identify('v-new2', 's-n2', T0 + DAY, { phone: '+39 333 999 9999' }),
        payment('v-new3', 's-n3', T0 + DAY, 'tx-gone', 'gone@example.com'),
        pageview('v-new4', 's-n4', T0 + DAY, { url: `https://www.example.com/?he=${hash}` }),
        identify('v-ok', 's-ok', T0 + DAY, { email: 'ok@example.com' }),
      ],
      [],
    );
    expect(r).toMatchObject({ ingested: 1, skipped: 4 });
    expect(db.all(`SELECT 1 FROM payments WHERE transaction_id = 'tx-gone'`)).toEqual([]);
    expect(store.findVisitorsByKey('email', 'gone@example.com').map((k) => k.visitor_id)).toEqual(['v-gone']);

    store.removeFromBlacklist([{ key_type: 'email', key_value: 'gone@example.com' }, { key_type: 'email', key_value: hash }]);
    expect(store.ingest([identify('v-back', 's-b', T0 + 2 * DAY, { email: 'gone@example.com' })], []).ingested).toBe(1);
  });

  it('reprocess rebuilds merges after a gap (mechanism off, or keys written without resolution)', () => {
    store.updateIdentitySettings({ phone: false });
    store.ingest([pageview('v-1', 's-1', T0), identify('v-1', 's-1', T0 + MIN, { phone: '+393331112222' })], []);
    store.recordTouch(touch({ id: 'hit_gap', visitor_id: 'v-2', session_id: 's-2', ts: T0 + DAY - MIN }));
    store.ingest([pageview('v-2', 's-2', T0 + DAY), identify('v-2', 's-2', T0 + DAY + MIN, { phone: '+393331112222' })], []);
    expect(store.resolveVisitorGroup('v-2')).toEqual(['v-2']);
    // Keys imported raw (no resolution) for a third visitor.
    store.upsertIdentityKeys([{ key_type: 'phone', key_value: '+393331112222', visitor_id: 'v-3', first_seen: T0 + 2 * DAY }]);

    store.updateIdentitySettings({ phone: true });
    expect(store.reprocessVisitors({ from: T0 + 3 * DAY, to: T0 + 4 * DAY })).toEqual({
      ok: true,
      value: { keys: 0, merges: 0, visitors: 0 },
    });
    const r = store.reprocessVisitors({ from: T0, to: T0 + 3 * DAY });
    // The phone plus the session keys of both identifications.
    expect(r).toMatchObject({ ok: true, value: { keys: 3, merges: 2 } });
    expect(store.resolveVisitorGroup('v-3')).toEqual(['v-1', 'v-2', 'v-3']);
    expect(store.listTouchesByVisitor(store.resolveVisitorGroup('v-1')).map((t) => t.id)).toEqual(['hit_gap']);
    expect(store.reprocessVisitors({ from: T0, to: T0 + 3 * DAY })).toMatchObject({ ok: true, value: { merges: 0 } });
    expect(store.reprocessVisitors({ from: 5, to: 5 })).toMatchObject({ ok: false, error: { code: 'validation_failed' } });
  });

  it('extends the contact journey with funnel/ad touches and tags of the merge group', () => {
    store.ingest([pageview('v-click', 's-click', T0), identify('v-click', 's-click', T0 + MIN, { phone: '+393331234567' })], []);
    store.recordTouch(touch());
    store.applyVisitorTags('v-click', ['webinar']);
    store.ingest([pageview('v-crm', 's-crm', T0 + DAY), identify('v-crm', 's-crm', T0 + DAY, { phone: '+393331234567' })], []);
    store.applyCrmFacts([{ kind: 'link', id: 'l1', contactId: 'c1', visitorId: 'v-crm', source: 'form', ts: T0 + DAY }]);
    const activity = store.contactActivity('c1', 50);
    expect(activity?.visitor_ids).toEqual(['v-crm']);
    expect(activity?.merged_visitor_ids).toEqual(['v-click']);
    expect(activity?.tags).toEqual(['webinar']);
    expect(activity?.funnel_touches).toEqual([
      expect.objectContaining({
        id: 'hit_1',
        visitor_id: 'v-click',
        kind: 'entrance',
        funnel_id: 'fg_1',
        traffic_source_id: 'ts_paid',
        campaign: 'cmp_1',
        external_click_id: 'click-abc',
      }),
    ]);
  });
});

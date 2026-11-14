import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACKER_BUNDLES } from '@amable/tracker/bundles';
import { networkOf } from '../src/analytics/device-signals';
import { clearSiteConfigCache, localCounters } from '../src/analytics/pipeline';
import { proxyKeyFor } from '../src/analytics/proxy-key';
import { analyticsRoutes } from '../src/analytics/routes';
import type { EnrichedEvent } from '../src/analytics/types';
import { gunzipLines, redactForArchive } from '../src/analytics/wal';
import type { Env } from '../src/env';
import { edgeEnv, FakeAnalyticsNamespace, FakeR2, SITE_ID, siteInit, T0 } from './helpers';

const SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const INSTAGRAM =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0';

let ns: FakeAnalyticsNamespace;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  clearSiteConfigCache();
  localCounters.clear();
  ns = new FakeAnalyticsNamespace();
  ns.store(`site:${SITE_ID}`).initSite(siteInit());
});
afterEach(() => vi.useRealTimers());

const siteDb = () => ns.store(`site:${SITE_ID}`);
type Db = { all: <T>(q: string, ...p: unknown[]) => T[]; run: (q: string, ...p: unknown[]) => void };
const db = (): Db => (siteDb() as unknown as { db: Db }).db;
const rows = <T>(q: string): T[] => db().all<T>(q);

const vidOf = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const sidOf = (n: number) => `s${String(n).repeat(31)}a`;

const SIGNALS = { dpr: 3, cd: 24, hc: 6, tp: 5, plat: 'iPhone', gpu: 'Apple GPU', cv: 'a1b2c3d4' };

function base(n: number): Record<string, unknown> {
  return {
    site: SITE_ID,
    url: 'https://www.example.com/',
    sw: 393,
    sh: 852,
    tz: 'Europe/Rome',
    vid: vidOf(n),
    sid: sidOf(n),
    fs: T0,
    sn: 1,
  };
}

/** How the event reaches the edge: the tracking domain by default, or a proxy recipe. */
interface Via {
  url?: string;
  headers?: Record<string, string>;
  /** Headers the request does not carry at all. */
  without?: readonly string[];
}

async function send(
  env: Env,
  body: unknown,
  ip: string,
  ua = SAFARI,
  via: Via = {},
): Promise<Response> {
  const req = new Request(via.url ?? 'https://t.example.com/e', {
    method: 'POST',
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      'user-agent': ua,
      'cf-connecting-ip': ip,
      origin: 'https://www.example.com',
      // What a browser says of an event sent to the tracking domain of the page's site.
      'sec-fetch-site': 'same-site',
      ...via.headers,
    },
    body: JSON.stringify(body),
  });
  for (const name of via.without ?? []) req.headers.delete(name);
  Object.defineProperty(req, 'cf', { value: { country: 'IT' } });
  return analyticsRoutes.fetch(req, env);
}

/** A pageview then the device event of visitor `n`. */
async function visit(
  env: Env,
  n: number,
  ip: string,
  opts: { ua?: string; signals?: Record<string, unknown>; sw?: number; via?: Via } = {},
): Promise<void> {
  const ua = opts.ua ?? SAFARI;
  const b = { ...base(n), ...(opts.sw === undefined ? {} : { sw: opts.sw }) };
  await send(env, { ...b, type: 'pageview' }, ip, ua, opts.via);
  await send(env, { ...b, type: 'device', data: opts.signals ?? SIGNALS }, ip, ua, opts.via);
}

function enable(): void {
  siteDb().updateSite({ device_signals: true });
  clearSiteConfigCache();
}

const merges = () =>
  rows<{ child_visitor_id: string; origin_visitor_id: string; mechanism: string }>(
    `SELECT child_visitor_id, origin_visitor_id, mechanism FROM visitor_merges ORDER BY created_at, child_visitor_id`,
  );
const candidates = () =>
  rows<{ visitor_id: string; candidate: string | null }>(
    `SELECT visitor_id, candidate FROM device_signals ORDER BY visitor_id`,
  );
const sightings = () =>
  rows<{ visitor_id: string }>(`SELECT visitor_id FROM device_ip_seen ORDER BY visitor_id`);

describe('device signals module', () => {
  it('takes the network part of an IP', () => {
    expect(networkOf('203.0.113.7')).toBe('203.0.113.7');
    expect(networkOf('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2');
    expect(networkOf('2001:0db8:0001:0002:3:4:5:6')).toBe('2001:db8:1:2');
    expect(networkOf('fe80::1:2:3:4:5')).toBe('fe80:0:0:1');
    expect(networkOf('')).toBeNull();
  });

  it('serves the module and announces it in the handshake only when the site turns it on', async () => {
    const env = edgeEnv(ns);
    const mode = async () => (await analyticsRoutes.request(`/e?site=${SITE_ID}`, {}, env)).json();
    expect(await mode()).toEqual({ cookieless: false });
    enable();
    expect(await mode()).toEqual({ cookieless: false, device: true });
    for (const path of ['/s-d.js', '/k3x9ab2q/app-d.js']) {
      const res = await analyticsRoutes.fetch(new Request(`https://t.example.com${path}`), env);
      expect(await res.text()).toBe(TRACKER_BUNDLES.device);
    }
    siteDb().updateSite({ cookieless: true });
    clearSiteConfigCache();
    expect(await mode()).toEqual({ cookieless: true });
  });

  it('drops device events while the module is off and on cookieless visits', async () => {
    const env = edgeEnv(ns);
    await visit(env, 1, '198.51.100.1');
    enable();
    const { vid: _vid, sid: _sid, ...anonymous } = base(2);
    await send(env, { ...anonymous, type: 'device', data: SIGNALS }, '198.51.100.1');
    expect(rows(`SELECT * FROM device_signals`)).toEqual([]);
    await visit(env, 3, '198.51.100.1');
    expect(
      rows<{ visitor_id: string; browser: string }>(
        `SELECT visitor_id, browser FROM device_signals`,
      ),
    ).toEqual([{ visitor_id: vidOf(3), browser: 'Safari' }]);
    // Never shown in the live feed nor counted as a pageview.
    expect(rows<{ n: number }>(`SELECT COUNT(*) AS n FROM pageviews`)).toEqual([{ n: 2 }]);
  });

  it('measures the device_ip match while off and merges once it is on', async () => {
    const env = edgeEnv(ns);
    enable();
    // Safari, then the Instagram in-app browser on the same phone and network.
    await visit(env, 1, '198.51.100.1');
    await visit(env, 2, '198.51.100.1', { ua: INSTAGRAM });
    expect(
      rows<{ visitor_id: string; candidate: string | null }>(
        `SELECT visitor_id, candidate FROM device_signals ORDER BY visitor_id`,
      ),
    ).toEqual([
      { visitor_id: vidOf(1), candidate: null },
      { visitor_id: vidOf(2), candidate: vidOf(1) },
    ]);
    expect(merges()).toEqual([]);

    siteDb().updateIdentitySettings({ device_ip: true });
    // Same network, another device (screen): no match.
    await visit(env, 3, '198.51.100.9', { sw: 390 });
    await visit(env, 4, '198.51.100.9');
    expect(merges()).toEqual([]);
    // One device, one network: the visitors join up to three on the pair.
    await visit(env, 5, '198.51.100.20');
    await visit(env, 6, '198.51.100.20', {
      ua: INSTAGRAM,
      signals: { ...SIGNALS, cv: 'ffff0000' },
    });
    await visit(env, 7, '198.51.100.20');
    await visit(env, 8, '198.51.100.20');
    expect(merges()).toEqual([
      { child_visitor_id: vidOf(6), origin_visitor_id: vidOf(5), mechanism: 'device_ip' },
      { child_visitor_id: vidOf(7), origin_visitor_id: vidOf(5), mechanism: 'device_ip' },
    ]);
  });

  it('reports the measurements and disconnects the device_ip merges', async () => {
    const env = edgeEnv(ns);
    enable();
    siteDb().updateIdentitySettings({ device_ip: true });
    expect(siteDb().updateIdentitySettings({ session: false })).toMatchObject({
      value: { device_ip: true },
    });
    await visit(env, 1, '198.51.100.1');
    await visit(env, 2, '198.51.100.1', { ua: INSTAGRAM });
    await visit(env, 3, '198.51.100.30', { sw: 390 });
    vi.setSystemTime(T0 + 3_600_000);
    // Visitor 1 back in a new session, same device.
    await send(
      env,
      { ...base(1), sid: sidOf(9), type: 'device', id: 'dev-again', data: SIGNALS },
      '198.51.100.1',
    );
    for (const [n, id] of [
      [1, 'identify-1'],
      [2, 'identify-2'],
    ] as const) {
      await send(
        env,
        { ...base(n), type: 'identify', id, data: { email: 'ada@example.com' } },
        '198.51.100.1',
      );
    }
    const report = siteDb().deviceSignalsReport();
    expect(report).toMatchObject({
      collected: 3,
      devices: 2,
      would_merge: 1,
      merged: 1,
      precision: { checked: 1, correct: 1 },
      merges: [{ child_visitor_id: vidOf(2), origin_visitor_id: vidOf(1) }],
    });
    expect(report.groups.find((g) => g.browser === 'Safari')).toMatchObject({
      visitors: 2,
      unique_share: 0.5,
      returning: 1,
      stable_share: 1,
    });
    expect(siteDb().unmergeDeviceMerges(null)).toBe(1);
    expect(siteDb().deviceSignalsReport()).toMatchObject({ merged: 0, merges: [] });
    expect(siteDb().unmergeDeviceMerges([vidOf(2)])).toBe(0);
  });

  it('forgets the signals when the module is turned off', async () => {
    const env = edgeEnv(ns);
    enable();
    await visit(env, 1, '198.51.100.1');
    expect(rows(`SELECT visitor_id FROM device_ip_seen`)).toHaveLength(1);
    siteDb().updateSite({ device_signals: false });
    expect(rows(`SELECT * FROM device_signals`)).toEqual([]);
    expect(rows(`SELECT * FROM device_ip_seen`)).toEqual([]);
  });

  it('keeps nothing once the site turned the module off, even for events the edge still accepts', async () => {
    const env = edgeEnv(ns);
    enable();
    await visit(env, 1, '198.51.100.1');
    // The edge keeps the site config for a minute: it still takes device events.
    siteDb().updateSite({ device_signals: false });
    const late = base(2);
    await send(env, { ...late, type: 'pageview' }, '198.51.100.1');
    const accepted = await send(env, { ...late, type: 'device', data: SIGNALS }, '198.51.100.1');
    expect(accepted.status).toBe(202);
    expect(rows(`SELECT * FROM device_signals`)).toEqual([]);
    expect(rows(`SELECT * FROM device_ip_seen`)).toEqual([]);
  });

  it('erases the signals of a visitor and the matches pointing at it', async () => {
    const env = edgeEnv(ns);
    enable();
    await visit(env, 1, '198.51.100.1');
    await visit(env, 2, '198.51.100.1', { ua: INSTAGRAM });
    siteDb().suppressVisitors({ visitorIds: [vidOf(1)], keys: [], purge: true });
    expect(
      rows<{ visitor_id: string; candidate: string | null }>(
        `SELECT visitor_id, candidate FROM device_signals`,
      ),
    ).toEqual([{ visitor_id: vidOf(2), candidate: null }]);
    expect(rows<{ visitor_id: string }>(`SELECT visitor_id FROM device_ip_seen`)).toEqual([
      { visitor_id: vidOf(2) },
    ]);
  });

  it('forgets the signals of dormant visitors without archiving them', async () => {
    const env = edgeEnv(ns);
    enable();
    await visit(env, 1, '198.51.100.1');
    vi.setSystemTime(T0 + 400 * 86_400_000);
    const archived: string[] = [];
    const result = await siteDb().retention({
      put: (key, body) => {
        archived.push(key, body);
        return Promise.resolve();
      },
    });
    expect(result?.dormant_visitors).toBe(1);
    expect(rows(`SELECT * FROM device_signals`)).toEqual([]);
    expect(rows(`SELECT * FROM device_ip_seen`)).toEqual([]);
    expect(archived.join('\n')).toContain(vidOf(1));
    expect(archived.join('\n')).not.toContain('Apple GPU');
  });

  it('drops the match pointing at a visitor forgotten as dormant', async () => {
    const env = edgeEnv(ns);
    enable();
    await visit(env, 1, '198.51.100.1');
    await visit(env, 2, '198.51.100.1', { ua: INSTAGRAM });
    expect(candidates()[1]).toEqual({ visitor_id: vidOf(2), candidate: vidOf(1) });
    // Visitor 2 keeps coming back, visitor 1 goes idle for 13 months.
    vi.setSystemTime(T0 + 399 * 86_400_000);
    await send(env, { ...base(2), sid: sidOf(7), type: 'pageview' }, '198.51.100.1', INSTAGRAM);
    vi.setSystemTime(T0 + 400 * 86_400_000);
    await siteDb().retention(null);
    expect(candidates()).toEqual([{ visitor_id: vidOf(2), candidate: null }]);
  });

  it('never merges a new visitor into one that opted out', async () => {
    const env = edgeEnv(ns);
    enable();
    siteDb().updateIdentitySettings({ device_ip: true });
    await visit(env, 1, '198.51.100.1');
    siteDb().suppressVisitors({ visitorIds: [vidOf(1)], keys: [], purge: false });
    clearSiteConfigCache();
    await visit(env, 2, '198.51.100.1', { ua: INSTAGRAM });
    expect(merges()).toEqual([]);
    expect(candidates()).toEqual([
      { visitor_id: vidOf(1), candidate: null },
      { visitor_id: vidOf(2), candidate: null },
    ]);
  });

  it('never merges a new visitor into the group of one that opted out', async () => {
    const env = edgeEnv(ns);
    enable();
    siteDb().updateIdentitySettings({ device_ip: true });
    await visit(env, 1, '198.51.100.1');
    await visit(env, 2, '198.51.100.9');
    // Visitor 2 hangs on a tombstone through a guess no opt-out has cut (a link made after it,
    // or one older than the cut): the visitor sighted is not suppressed, its origin is.
    db().run(
      `INSERT INTO visitor_merges (child_visitor_id, origin_visitor_id, mechanism, active, created_at, updated_at)
       VALUES (?, ?, 'ip_ua', 1, ?, ?)`,
      vidOf(2),
      vidOf(1),
      T0,
      T0,
    );
    db().run(`INSERT INTO suppressed_visitors (vid, created_at) VALUES (?, ?)`, vidOf(1), T0);
    clearSiteConfigCache();
    await visit(env, 3, '198.51.100.9', { ua: INSTAGRAM });
    expect(candidates()[2]).toEqual({ visitor_id: vidOf(3), candidate: null });
    expect(merges().map((m) => m.child_visitor_id)).toEqual([vidOf(2)]);
  });

  it('cuts a device merge when one of the two visitors opts out', async () => {
    const env = edgeEnv(ns);
    enable();
    siteDb().updateIdentitySettings({ device_ip: true });
    await visit(env, 1, '198.51.100.1');
    await visit(env, 2, '198.51.100.1', { ua: INSTAGRAM });
    const links = () =>
      rows<{ child_visitor_id: string; origin_visitor_id: string; active: number }>(
        `SELECT child_visitor_id, origin_visitor_id, active FROM visitor_merges`,
      );
    expect(links()).toEqual([
      { child_visitor_id: vidOf(2), origin_visitor_id: vidOf(1), active: 1 },
    ]);
    const out = siteDb().suppressVisitors({ visitorIds: [vidOf(1)], keys: [], purge: false });
    // A guess: the opt-out stays with the visitor, and the other one goes on alone.
    expect(out.visitorIds).toEqual([vidOf(1)]);
    expect(links()).toEqual([
      { child_visitor_id: vidOf(2), origin_visitor_id: vidOf(1), active: 0 },
    ]);
    expect(siteDb().deviceSignalsReport()).toMatchObject({ merged: 0, merges: [] });
  });

  it('reaches every visitor of a device group that gave the same email or phone', async () => {
    const env = edgeEnv(ns);
    enable();
    siteDb().updateIdentitySettings({ device_ip: true });
    // One phone, three browsers: the first one never identified.
    await visit(env, 1, '198.51.100.1');
    await visit(env, 2, '198.51.100.1', { ua: INSTAGRAM });
    await visit(env, 3, '198.51.100.1', { ua: INSTAGRAM });
    // Another device and network: two browsers, later the same phone number.
    await visit(env, 5, '198.51.100.50', { sw: 390 });
    await visit(env, 6, '198.51.100.50', { sw: 390, ua: INSTAGRAM });
    expect(merges().map((m) => [m.child_visitor_id, m.origin_visitor_id, m.mechanism])).toEqual([
      [vidOf(2), vidOf(1), 'device_ip'],
      [vidOf(3), vidOf(1), 'device_ip'],
      [vidOf(6), vidOf(5), 'device_ip'],
    ]);
    const identify = (n: number, data: Record<string, string>, ip: string) =>
      send(env, { ...base(n), type: 'identify', id: `identify-${n}`, data }, ip);
    await identify(2, { email: 'ada@example.com' }, '198.51.100.1');
    await identify(3, { email: 'ada@example.com' }, '198.51.100.1');
    await identify(5, { phone: '+39 333 1234567' }, '198.51.100.50');
    await identify(6, { phone: '+39 333 1234567' }, '198.51.100.50');
    // An opt-out of the person behind visitor 3: also visitor 2, not the browser only guessed.
    const optOut = siteDb().suppressVisitors({ visitorIds: [vidOf(3)], keys: [], purge: false });
    expect([...optOut.visitorIds].sort()).toEqual([vidOf(2), vidOf(3)]);
    const erased = siteDb().suppressVisitors({ visitorIds: [vidOf(6)], keys: [], purge: true });
    expect([...erased.visitorIds].sort()).toEqual([vidOf(5), vidOf(6)]);
    expect(candidates().map((c) => c.visitor_id)).toEqual([vidOf(1), vidOf(2), vidOf(3)]);
  });

  it('keeps an erasure on the visitor when the emails differ or the site does not merge by email', async () => {
    const env = edgeEnv(ns);
    enable();
    siteDb().updateIdentitySettings({ device_ip: true });
    await visit(env, 1, '198.51.100.1');
    await visit(env, 2, '198.51.100.1', { ua: INSTAGRAM });
    await visit(env, 3, '198.51.100.40', { sw: 390 });
    await visit(env, 4, '198.51.100.40', { sw: 390, ua: INSTAGRAM });
    const identify = (n: number, email: string, ip: string) =>
      send(env, { ...base(n), type: 'identify', id: `identify-${n}`, data: { email } }, ip);
    await identify(1, 'ada@example.com', '198.51.100.1');
    await identify(2, 'bob@example.com', '198.51.100.1');
    const differ = siteDb().suppressVisitors({ visitorIds: [vidOf(1)], keys: [], purge: true });
    expect(differ.visitorIds).toEqual([vidOf(1)]);
    siteDb().updateIdentitySettings({ email: false });
    await identify(3, 'eve@example.com', '198.51.100.40');
    await identify(4, 'eve@example.com', '198.51.100.40');
    const off = siteDb().suppressVisitors({ visitorIds: [vidOf(3)], keys: [], purge: true });
    expect(off.visitorIds).toEqual([vidOf(3)]);
  });

  it('keeps an erasure on the visitor when the other one was unlinked, same email or not', async () => {
    const env = edgeEnv(ns);
    enable();
    siteDb().updateIdentitySettings({ device_ip: true });
    await visit(env, 1, '198.51.100.1');
    await visit(env, 2, '198.51.100.1', { ua: INSTAGRAM });
    // The owner said they are two people: the same email later does not join them again.
    expect(siteDb().unmergeDeviceMerges([vidOf(2)])).toBe(1);
    for (const n of [1, 2]) {
      await send(
        env,
        { ...base(n), type: 'identify', id: `identify-${n}`, data: { email: 'ada@example.com' } },
        '198.51.100.1',
      );
    }
    // Another pair keeps a device merge alive on the site.
    await visit(env, 5, '198.51.100.50', { sw: 390 });
    await visit(env, 6, '198.51.100.50', { sw: 390, ua: INSTAGRAM });
    const erased = siteDb().suppressVisitors({ visitorIds: [vidOf(1)], keys: [], purge: true });
    expect(erased.visitorIds).toEqual([vidOf(1)]);
  });

  it('suppresses a key held by many visitors in one go', async () => {
    const env = edgeEnv(ns);
    enable();
    siteDb().updateIdentitySettings({ device_ip: true });
    // A device merge on the site, so shared keys are looked at.
    await visit(env, 1, '198.51.100.1');
    await visit(env, 2, '198.51.100.1', { ua: INSTAGRAM });
    const many = Array.from({ length: 400 }, (_, i) => `many-${String(i).padStart(4, '0')}`);
    for (const [i, id] of many.entries()) {
      db().run(`INSERT INTO visitors (id, first_seen, last_seen) VALUES (?, ?, ?)`, id, T0, T0);
      db().run(
        `INSERT INTO identity_keys (key_type, key_value, visitor_id, first_seen) VALUES ('email', ?, ?, ?)`,
        'e'.repeat(64),
        id,
        T0,
      );
      if (i > 0)
        db().run(
          `INSERT INTO visitor_merges (child_visitor_id, origin_visitor_id, mechanism, active, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
          id,
          many[0],
          i % 2 === 0 ? 'email' : 'device_ip',
          T0,
          T0,
        );
    }
    const byKey = siteDb().suppressVisitors({
      visitorIds: [],
      keys: [{ type: 'email', hash: 'e'.repeat(64) }],
      purge: false,
    });
    expect(byKey.visitorIds).toHaveLength(400);
    expect(rows<{ n: number }>(`SELECT COUNT(*) AS n FROM suppressed_visitors`)).toEqual([{ n: 400 }]);
  });

  it('reaches the whole group from one visitor of a key held by many', async () => {
    const env = edgeEnv(ns);
    enable();
    const many = Array.from({ length: 300 }, (_, i) => `many-${String(i).padStart(4, '0')}`);
    for (const [i, id] of many.entries()) {
      db().run(`INSERT INTO visitors (id, first_seen, last_seen) VALUES (?, ?, ?)`, id, T0, T0);
      db().run(
        `INSERT INTO identity_keys (key_type, key_value, visitor_id, first_seen) VALUES ('email', ?, ?, ?)`,
        'e'.repeat(64),
        id,
        T0,
      );
      // Every browser hangs on the first one by a guess: only the shared email says one person.
      if (i > 0)
        db().run(
          `INSERT INTO visitor_merges (child_visitor_id, origin_visitor_id, mechanism, active, created_at, updated_at)
           VALUES (?, ?, 'device_ip', 1, ?, ?)`,
          id,
          many[0],
          T0,
          T0,
        );
    }
    void env;
    const byId = siteDb().suppressVisitors({ visitorIds: [many[7] as string], keys: [], purge: false });
    expect(byId.visitorIds).toHaveLength(300);
  });

  it('extends an erasure across a device merge only once both visitors gave the same email', async () => {
    const env = edgeEnv(ns);
    enable();
    siteDb().updateIdentitySettings({ device_ip: true });
    await visit(env, 1, '198.51.100.1');
    await visit(env, 2, '198.51.100.1', { ua: INSTAGRAM });
    await visit(env, 3, '198.51.100.40', { sw: 390 });
    await visit(env, 4, '198.51.100.40', { sw: 390, ua: INSTAGRAM });
    expect(merges().map((m) => [m.child_visitor_id, m.origin_visitor_id, m.mechanism])).toEqual([
      [vidOf(2), vidOf(1), 'device_ip'],
      [vidOf(4), vidOf(3), 'device_ip'],
    ]);
    for (const [n, id] of [
      [1, 'identify-1'],
      [2, 'identify-2'],
    ] as const) {
      await send(
        env,
        { ...base(n), type: 'identify', id, data: { email: 'ada@example.com' } },
        '198.51.100.1',
      );
    }
    // Still a guess: the erasure stops at the visitor.
    const guess = siteDb().suppressVisitors({ visitorIds: [vidOf(3)], keys: [], purge: true });
    expect(guess.visitorIds).toEqual([vidOf(3)]);
    // Confirmed by the same email on both sides: one person, erased together.
    const known = siteDb().suppressVisitors({ visitorIds: [vidOf(1)], keys: [], purge: true });
    expect([...known.visitorIds].sort()).toEqual([vidOf(1), vidOf(2)]);
    expect(candidates()).toEqual([{ visitor_id: vidOf(4), candidate: null }]);
  });

  it('lets the sightings expire with the daily retention and wipes everything with the site', async () => {
    const env = edgeEnv(ns);
    enable();
    await visit(env, 1, '198.51.100.1');
    vi.setSystemTime(T0 + 15 * 86_400_000);
    await siteDb().retention(null);
    expect(sightings()).toEqual([]);
    expect(candidates()).toEqual([{ visitor_id: vidOf(1), candidate: null }]);
    await visit(env, 2, '198.51.100.2');
    expect(sightings()).toEqual([{ visitor_id: vidOf(2) }]);
    siteDb().deleteSite();
    expect(candidates()).toEqual([]);
    expect(sightings()).toEqual([]);
    // The edge still knows the site for a minute: what it lets through leaves nothing.
    await visit(env, 3, '198.51.100.3');
    expect(candidates()).toEqual([]);
    expect(sightings()).toEqual([]);
  });

  it('takes a network only from events the browser delivered itself', async () => {
    const env = { ...edgeEnv(ns), EDGE_GATEWAY_SECRET: 'gateway-secret-for-tests' };
    const key = (await proxyKeyFor(env.EDGE_GATEWAY_SECRET, SITE_ID)) as string;
    enable();
    siteDb().updateIdentitySettings({ device_ip: true });
    const edge = 'https://edge.amable.net/k3x9ab2q/app';
    const fetchSite = (value: string, url = edge): Via => ({
      url,
      headers: { 'sec-fetch-site': value },
    });
    // Relayed by the page's own server (rewrite recipes): one address for every visitor.
    await visit(env, 1, '203.0.113.50', { via: fetchSite('same-origin') });
    await visit(env, 2, '203.0.113.50', { via: fetchSite('same-site') });
    // No word from the browser (before the header, or a plain-http relay).
    await visit(env, 3, '203.0.113.50', { via: { url: edge, without: ['sec-fetch-site'] } });
    // A proxy with the key that forwards no usable address.
    await visit(env, 4, '203.0.113.50', { via: { url: edge, headers: { 'x-amb-proxy-key': key } } });
    expect(candidates().map((c) => c.visitor_id)).toEqual([1, 2, 3, 4].map(vidOf));
    expect(sightings()).toEqual([]);
    expect(merges()).toEqual([]);

    // Sent by the browser to the shared host, or to the page's own host (landing pages).
    await visit(env, 5, '198.51.100.90', { via: fetchSite('cross-site') });
    await visit(env, 6, '198.51.100.91', {
      via: fetchSite('same-origin', 'https://www.example.com/e'),
    });
    expect(sightings().map((s) => s.visitor_id)).toEqual([vidOf(5), vidOf(6)]);

    // The proxy recipes with the key forward the visitor address: that is the network.
    const proxied = (ip: string): Via => ({
      url: edge,
      headers: { 'x-amb-proxy-key': key, 'x-amb-forwarded-for': ip },
    });
    await visit(env, 7, '203.0.113.50', { via: proxied('198.51.100.77') });
    await visit(env, 8, '203.0.113.50', { via: proxied('198.51.100.78') });
    await visit(env, 9, '203.0.113.50', { via: proxied('198.51.100.77'), ua: INSTAGRAM });
    expect(merges().map((m) => [m.child_visitor_id, m.origin_visitor_id])).toEqual([
      [vidOf(9), vidOf(7)],
    ]);
  });

  it('never archives the signals', async () => {
    const event = {
      type: 'device',
      data: { gpu: 'Apple GPU' },
      deviceSighting: { key: 'k', net: 'n', signals: '{}' },
      identity: null,
      payment: null,
    } as unknown as EnrichedEvent;
    const archived = await redactForArchive({ kind: 'event', event } as never);
    expect(archived).toMatchObject({ event: { data: null, deviceSighting: null } });
  });

  it('applies the signals to the site and writes none of them to the R2 archive', async () => {
    const r2 = new FakeR2();
    const env = { ...edgeEnv(ns), FILES: r2 as unknown as R2Bucket };
    enable();
    await visit(env, 1, '198.51.100.1');
    expect(rows<{ signals: string }>(`SELECT signals FROM device_signals`)[0]?.signals).toContain(
      'Apple GPU',
    );
    const archived = JSON.stringify(
      await Promise.all([...r2.objects.values()].map((o) => gunzipLines<unknown>(o.body))),
    );
    // The event is archived like the others, without its signals.
    expect(archived).toContain('"type":"device"');
    for (const signal of ['Apple GPU', 'a1b2c3d4']) expect(archived).not.toContain(signal);
  });
});

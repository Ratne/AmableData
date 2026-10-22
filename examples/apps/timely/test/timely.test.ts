import { d1InstallStore, generateAppKey, storedAppKeys, type PrivateJwk } from '@amable/app-sdk';
import { fakeCrm, routeFetch, signedCaller, testInstall } from '@amable/app-sdk/testing';
import { memoryD1 } from '@amable/app-sdk/testing/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { passed, runConformance } from '../../../../packages/app-cli/src/conformance';
import { parseAppManifest } from '../../../../packages/core/src/apps';
import manifest from '../manifest.json';
import { createWorker } from '../src/app';
import { deadlineFor } from '../src/deadlines';
import { linkSecrets } from '../src/keys';
import { renderTimerGif } from '../src/gif/render';
import { presetStyle, splitRemaining, widgetCss } from '../src/style';
import { contactToken, readContactToken } from '../src/token';
import { decodeGif } from './gif';

/** Where the CRM deployed this copy (`APP_BASE_URL`). */
const BASE = 'https://amable-app-timely.acme.workers.dev';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const VISITOR = '3f6c1d2e-8a4b-4c5d-9e0f-1a2b3c4d5e6f';

let ip = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-22T10:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const db = memoryD1();
  const install = testInstall({ scopes: manifest.scopes, expiresAt: Number.MAX_SAFE_INTEGER });
  await d1InstallStore(db).put(install);
  const crm = fakeCrm();
  crm.contacts.set('ct_ada', { id: 'ct_ada', given_name: 'Ada', family_name: 'Lovelace' });
  crm.contacts.set('ct_bob', { id: 'ct_bob', emails: [{ email: 'bob@example.com', is_primary: true }] });
  crm.on('GET', /^\/contacts$/, (call) => {
    const q = new URL(call.url).searchParams.get('q')?.toLowerCase() ?? '';
    const data = [...crm.contacts.values()].filter((c) => JSON.stringify(c).toLowerCase().includes(q));
    return Response.json({ data, next_cursor: null });
  });
  // Signatures and session tokens read the same (fake) clock as the app.
  const clock = {
    get now() {
      return Date.now();
    },
    set now(value: number) {
      vi.setSystemTime(value);
    },
  };
  const worker = createWorker({ fetch: routeFetch(crm.fetch) });
  // As deployed by the CRM: no keys in the environment, the app creates them in its database.
  const env = { DB: db, APP_BASE_URL: BASE };
  const linkSecret = async () => linkSecrets(await storedAppKeys(db, { kid: 'timely-1' }))[0]!;
  const fetch = (request: Request) => worker.fetch(request, env);
  const call = signedCaller({ fetch, baseUrl: BASE, install });
  const screen = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const token = await crm.sessionToken({ appId: manifest.id, audience: BASE, install });
    const response = await fetch(
      new Request(`${BASE}${path}`, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  /** A public request (mail client, browser), each from its own address unless `from` is given. */
  const pub = (path: string, from?: string) =>
    fetch(new Request(`${BASE}${path}`, { headers: { 'cf-connecting-ip': from ?? `10.0.${String((ip += 1) % 250)}.${String(ip % 250)}` } }));
  const campaign = async (body: Record<string, unknown> = {}) => {
    const created = await screen('/api/campaigns', {
      method: 'POST',
      body: {
        name: 'Black Friday',
        mode: 'evergreen',
        duration_minutes: 48 * 60,
        start_on: ['email_open', 'email_click', 'page_visit'],
        offer_url: 'https://shop.example.com/offer',
        expired_url: 'https://shop.example.com/too-late',
        ...body,
      },
    });
    expect(created.status).toBe(201);
    return created.body as { id: string; public_id: string; snippets: Record<string, string> };
  };
  const deadlines = async (id: string) =>
    ((await screen(`/api/deadlines?campaign=${id}`)).body['data'] as Array<{ id: string; contact_id: string | null; deadline_at: number; expired: boolean; contact_name: string | null }>);
  return { install, crm, db, clock, worker, env, fetch, call, screen, pub, campaign, deadlines, linkSecret };
}

describe('timely: manifest', () => {
  it('is a valid manifest whose page lives in the Marketing menu', () => {
    const parsed = parseAppManifest(manifest);
    expect(parsed.ok).toBe(true);
    const page = manifest.extensions.ui.find((u) => u.slot === 'app.page');
    expect(page).toMatchObject({ nav_group: 'marketing', path: '/ui/campaigns' });
  });
});

describe('timely: zero configuration', () => {
  const jwks = async (worker: ReturnType<typeof createWorker>, env: Parameters<ReturnType<typeof createWorker>['fetch']>[1]) =>
    ((await (await worker.fetch(new Request(`${BASE}/.well-known/jwks.json`), env)).json()) as { keys: Array<{ kid: string; x: string }> })
      .keys;

  it('creates its signing keys once, the same for every isolate, and keeps them across restarts', async () => {
    const db = memoryD1();
    const env = { DB: db, APP_BASE_URL: BASE };
    // Two isolates starting at the same time on an empty database.
    const [a, b] = await Promise.all([jwks(createWorker(), env), jwks(createWorker(), env)]);
    expect(a).toHaveLength(1);
    expect(b).toEqual(a);
    expect(await jwks(createWorker(), env)).toEqual(a);
    expect((db.sqlite.prepare('SELECT COUNT(*) AS n FROM amable_app_keys').get() as { n: number }).n).toBe(1);
  });

  it('uses APP_KEYS when the environment has them', async () => {
    const key = await generateAppKey('from-env');
    const keys = await jwks(createWorker(), { DB: memoryD1(), APP_KEYS: JSON.stringify([key]) });
    expect(keys.map((k) => k.kid)).toEqual(['from-env']);
  });

  it('keeps email links valid when a new signing key is added in front', async () => {
    const old = await generateAppKey('old');
    const token = await contactToken(linkSecrets([old])[0]!, 'pub1', 'ct_ada');
    const rotated: PrivateJwk[] = [await generateAppKey('new'), old];
    expect(await readContactToken(linkSecrets(rotated), 'pub1', token)).toBe('ct_ada');
    expect(await readContactToken(linkSecrets([rotated[0]!]), 'pub1', token)).toBeNull();
  });
});

describe('timely: timer maths and styles', () => {
  it('splits the remaining time, the largest unit taking the rest', () => {
    expect(splitRemaining(3 * 86_400 + 4 * 3_600 + 5 * 60 + 6, ['days', 'hours', 'minutes', 'seconds'])).toEqual({
      expired: false,
      values: { days: 3, hours: 4, minutes: 5, seconds: 6 },
    });
    expect(splitRemaining(50 * 3_600 + 30, ['hours', 'minutes', 'seconds']).values).toEqual({ hours: 50, minutes: 0, seconds: 30 });
    expect(splitRemaining(-5, ['minutes', 'seconds'])).toMatchObject({ expired: true, values: { minutes: 0, seconds: 0 } });
  });

  it('caps evergreen deadlines at the hard end date', () => {
    const base = { mode: 'evergreen' as const, durationMinutes: 60, fixedEndAt: null, hardEndAt: null };
    expect(deadlineFor(base, 1_000)).toBe(1_000 + HOUR);
    expect(deadlineFor({ ...base, hardEndAt: 1_000 + MINUTE }, 1_000)).toBe(1_000 + MINUTE);
    expect(deadlineFor({ mode: 'fixed', durationMinutes: null, fixedEndAt: 5_000, hardEndAt: null }, 1_000)).toBe(5_000);
  });

  it('scopes the widget CSS to the campaign and keeps the custom CSS last', () => {
    const css = widgetCss('abc', { ...presetStyle('neon'), custom_css: '.timely-value { letter-spacing: 2px }' });
    expect(css).toContain('.timely-abc');
    expect(css.trim().endsWith('.timely-value { letter-spacing: 2px }')).toBe(true);
  });

  it('signs contact tokens for one campaign only', async () => {
    const token = await contactToken('s', 'pub1', 'ct_ada');
    expect(await readContactToken('s', 'pub1', token)).toBe('ct_ada');
    expect(await readContactToken('s', 'pub2', token)).toBeNull();
    expect(await readContactToken('other', 'pub1', token)).toBeNull();
    expect(await readContactToken('s', 'pub1', token.replace('ct_ada', 'ct_bob'))).toBeNull();
  });
});

describe('timely: email GIF', () => {
  it('renders decodable frames for every preset, one second apart', () => {
    for (const preset of ['classic', 'minimal', 'bold', 'neon', 'soft'] as const) {
      const gif = decodeGif(renderTimerGif(presetStyle(preset), { remaining: 2 * 86_400 + 3_725 }));
      expect(gif.frames).toHaveLength(60);
      expect(gif.loops).toBe(false);
      expect(gif.frames.slice(1).every((f) => f.delay === 100)).toBe(true);
      expect(gif.frames[0]).toMatchObject({ left: 0, top: 0, width: gif.width, height: gif.height });
      // Later frames only repaint the digits that change: much smaller than the canvas.
      expect(gif.frames[1]!.width * gif.frames[1]!.height).toBeLessThan(gif.width * gif.height);
      const colors = gif.palette.length / 3;
      for (const frame of gif.frames) expect(Math.max(...frame.pixels)).toBeLessThan(colors);
    }
  });

  it('stops at zero and shows the expired text after the deadline', () => {
    const closing = decodeGif(renderTimerGif(presetStyle('classic'), { remaining: 5 }));
    expect(closing.frames.length).toBeLessThanOrEqual(7);
    const expired = decodeGif(renderTimerGif({ ...presetStyle('classic'), expired_text: 'Offerta scaduta' }, { remaining: 0 }));
    expect(expired.frames).toHaveLength(1);
    const still = decodeGif(renderTimerGif(presetStyle('bold'), { remaining: 3_600, still: true }));
    expect(still.frames).toHaveLength(1);
  });

  it('starts the deadline of a contact when the email is opened, and keeps it', async () => {
    const app = await setup();
    const c = await app.campaign();
    expect(c.snippets['email_image']).toBe(`${BASE}/i/${c.public_id}/c/{{ contact.id }}.gif`);
    const first = await app.pub(`/i/${c.public_id}/c/ct_ada.gif`);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/gif');
    expect(first.headers.get('cache-control')).toContain('no-store');
    expect(decodeGif(new Uint8Array(await first.arrayBuffer())).frames.length).toBe(60);
    const [started] = await app.deadlines(c.id);
    expect(started).toMatchObject({ contact_id: 'ct_ada', deadline_at: app.clock.now + 48 * HOUR, contact_name: 'Ada Lovelace' });

    // Opening it again a day later does not move the deadline.
    app.clock.now += 24 * HOUR;
    await app.pub(`/i/${c.public_id}/c/ct_ada.gif`);
    expect((await app.deadlines(c.id))[0]!.deadline_at).toBe(started!.deadline_at);

    // Two days later: expired, one frame.
    app.clock.now += 25 * HOUR;
    const late = decodeGif(new Uint8Array(await (await app.pub(`/i/${c.public_id}/c/ct_ada.gif`)).arrayBuffer()));
    expect(late.frames).toHaveLength(1);
  });

  it('does not start deadlines for unknown contacts or unmerged merge tags', async () => {
    const app = await setup();
    const c = await app.campaign();
    expect((await app.pub(`/i/${c.public_id}/c/ct_nobody.gif`)).status).toBe(200);
    expect((await app.pub(`/i/${c.public_id}/c/${encodeURIComponent('{{ contact.id }}')}.gif`)).status).toBe(200);
    expect(await app.deadlines(c.id)).toEqual([]);
    expect((await app.pub('/i/0000000000000000/c/ct_ada.gif')).status).toBe(404);
  });

  it('serves the shared GIF of a fixed deadline and the editor preview', async () => {
    const app = await setup();
    const c = await app.campaign({ mode: 'fixed', fixed_end_at: new Date(app.clock.now + 3 * HOUR).toISOString() });
    const shared = await app.pub(`/i/${c.public_id}.gif`);
    expect(shared.status).toBe(200);
    expect(decodeGif(new Uint8Array(await shared.arrayBuffer())).frames).toHaveLength(60);
    const style = Buffer.from(JSON.stringify(presetStyle('soft'))).toString('base64url');
    const preview = await app.pub(`/preview.gif?style=${style}&minutes=90&still=true`);
    expect(preview.status).toBe(200);
    expect(decodeGif(new Uint8Array(await preview.arrayBuffer())).frames).toHaveLength(1);
    expect((await app.pub('/preview.gif?style=%%%')).status).toBe(400);
  });
});

describe('timely: links and the page widget', () => {
  it('starts on click, opens the offer with the contact token, then the expired page', async () => {
    const app = await setup();
    const c = await app.campaign({ start_on: ['email_click'] });
    const click = await app.pub(`/r/${c.public_id}?c=ct_bob&utm_source=newsletter`);
    expect(click.status).toBe(302);
    const location = new URL(click.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://shop.example.com/offer');
    expect(location.searchParams.get('utm_source')).toBe('newsletter');
    expect(location.searchParams.get('c')).toBeNull();
    const token = location.searchParams.get('tly')!;
    expect(await readContactToken(await app.linkSecret(), c.public_id, token)).toBe('ct_bob');

    const state = await app.pub(`/w/${c.public_id}/state?t=${encodeURIComponent(token)}`);
    expect(state.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await state.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ contact: true, status: 'running', deadline_at: app.clock.now + 48 * HOUR, server_now: app.clock.now, expiry: 'zeros' });
    expect(String(body['css'])).toContain(`.timely-${c.public_id}`);

    app.clock.now += 49 * HOUR;
    const late = await app.pub(`/r/${c.public_id}?c=ct_bob`);
    expect(late.headers.get('location')).toMatch(/^https:\/\/shop\.example\.com\/too-late\?tly=/);
  });

  it('gives an anonymous visitor one deadline, adopted by the contact when they come from an email', async () => {
    const app = await setup();
    const c = await app.campaign({ start_on: ['page_visit'], expiry: 'redirect' });
    const visit = (await (await app.pub(`/w/${c.public_id}/state?v=${VISITOR}`)).json()) as Record<string, unknown>;
    expect(visit).toMatchObject({ status: 'running', redirect_url: 'https://shop.example.com/too-late' });
    const visitorDeadline = visit['deadline_at'];

    app.clock.now += 2 * HOUR;
    const token = await contactToken(await app.linkSecret(), c.public_id, 'ct_ada');
    const adopted = (await (await app.pub(`/w/${c.public_id}/state?v=${VISITOR}&t=${encodeURIComponent(token)}`)).json()) as Record<string, unknown>;
    expect(adopted['deadline_at']).toBe(visitorDeadline);
    const rows = await app.deadlines(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contact_id: 'ct_ada' });

    // A forged token reads as no contact at all.
    const forged = (await (await app.pub(`/w/${c.public_id}/state?t=ct_bob.AAAAAAAAAAAAAAAAAAAAAA`)).json()) as Record<string, unknown>;
    expect(forged).toMatchObject({ contact: false, status: 'not_started' });
  });

  it('answers CORS preflights and limits each address', async () => {
    const app = await setup();
    const c = await app.campaign();
    const preflight = await app.fetch(new Request(`${BASE}/w/${c.public_id}/state`, { method: 'OPTIONS' }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('GET');
    let last = 200;
    for (let i = 0; i < 125; i += 1) last = (await app.pub(`/w/${c.public_id}/state`, '192.0.2.77')).status;
    expect(last).toBe(429);
  });
});

describe('timely: managing deadlines', () => {
  it('resets, restarts, extends and sets deadlines from the campaign screen', async () => {
    const app = await setup();
    const c = await app.campaign({ duration_minutes: 60 });
    const started = await app.screen('/api/deadlines/start', { method: 'POST', body: { campaign: c.id, contact_id: 'ct_ada' } });
    expect(started.status).toBe(200);
    expect((await app.screen('/api/deadlines/start', { method: 'POST', body: { campaign: c.id, contact_id: 'ct_ghost' } })).status).toBe(422);
    const [row] = await app.deadlines(c.id);
    const change = (body: Record<string, unknown>) => app.screen('/api/deadlines', { method: 'POST', body: { campaign: c.id, ids: [row!.id], ...body } });

    expect((await change({ change: { kind: 'extend', minutes: 30 } })).body).toEqual({ changed: 1 });
    expect((await app.deadlines(c.id))[0]!.deadline_at).toBe(app.clock.now + 90 * MINUTE);

    const at = Date.parse('2026-12-01T09:00:00Z');
    await change({ change: { kind: 'set', deadline_at: new Date(at).toISOString() } });
    expect((await app.deadlines(c.id))[0]!.deadline_at).toBe(at);

    app.clock.now += 10 * MINUTE;
    await change({ change: { kind: 'restart' } });
    expect((await app.deadlines(c.id))[0]!.deadline_at).toBe(app.clock.now + 60 * MINUTE);

    expect((await change({ change: { kind: 'nope' } })).status).toBe(422);
    await app.screen('/api/deadlines', { method: 'POST', body: { campaign: c.id, all: true, change: { kind: 'reset' } } });
    expect(await app.deadlines(c.id)).toEqual([]);

    // After a reset the next open starts a fresh countdown.
    await app.pub(`/i/${c.public_id}/c/ct_ada.gif`);
    expect((await app.deadlines(c.id))[0]!.deadline_at).toBe(app.clock.now + 60 * MINUTE);
  });

  it('lists campaigns with their counters, searches contacts and deletes campaigns', async () => {
    const app = await setup();
    const c = await app.campaign({ duration_minutes: 60 });
    await app.pub(`/i/${c.public_id}/c/ct_ada.gif`);
    app.clock.now += 2 * HOUR;
    await app.pub(`/i/${c.public_id}/c/ct_bob.gif`);
    const list = (await app.screen('/api/campaigns')).body['data'] as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({ id: c.id, running: 1, expired: 1 });
    expect((await app.screen(`/api/deadlines?campaign=${c.id}&q=bob`)).body['data']).toMatchObject([{ contact_id: 'ct_bob', contact_name: 'bob@example.com' }]);
    expect((await app.screen('/api/contacts?q=ada')).body).toEqual({ data: [{ id: 'ct_ada', name: 'Ada Lovelace' }] });

    const invalid = await app.screen('/api/campaigns', { method: 'POST', body: { name: 'x', mode: 'evergreen' } });
    expect(invalid.status).toBe(422);
    const renamed = await app.screen('/api/campaigns', { method: 'POST', body: { id: c.id, name: 'Cyber Monday', mode: 'evergreen', duration_minutes: 30 } });
    expect(renamed.body).toMatchObject({ name: 'Cyber Monday', public_id: c.public_id });

    expect((await app.screen(`/api/campaigns?id=${c.id}`, { method: 'DELETE' })).body).toEqual({ ok: true });
    expect((await app.screen('/api/campaigns')).body['data']).toEqual([]);
    expect((await app.pub(`/i/${c.public_id}/c/ct_ada.gif`)).status).toBe(404);
  });

  it('stores the defaults in the settings screen', async () => {
    const app = await setup();
    expect((await app.screen('/api/settings')).body).toEqual({ label_locale: 'it', preset: 'classic', duration_hours: 72 });
    await app.screen('/api/settings', { method: 'POST', body: { label_locale: 'en', preset: 'neon', duration_hours: 24 } });
    expect((await app.screen('/api/settings')).body).toEqual({ label_locale: 'en', preset: 'neon', duration_hours: 24 });
  });
});

describe('timely: automations', () => {
  it('starts deadlines from a workflow step, once per idempotency key', async () => {
    const app = await setup();
    const c = await app.campaign({ start_on: [] });
    const options = await app.call('/options/campaigns', {});
    expect(options.body['options']).toMatchObject([{ value: c.id, label: 'Black Friday' }]);

    const step = (extra: Record<string, unknown> = {}) =>
      app.call('/actions/start-deadline', { contact_id: 'ct_ada', idempotency_key: 'run_1:step_1', input: { campaign: c.id }, ...extra });
    const first = await step();
    expect(first.body['output']).toMatchObject({
      deadline_at: new Date(app.clock.now + 48 * HOUR).toISOString(),
      campaign_name: 'Black Friday',
      timer_url: `${BASE}/i/${c.public_id}/c/ct_ada.gif`,
    });
    app.clock.now += HOUR;
    expect((await step()).body).toEqual(first.body);

    const restarted = await app.call('/actions/start-deadline', {
      contact_id: 'ct_ada',
      idempotency_key: 'run_2:step_1',
      input: { campaign: c.id, restart: true, duration_hours: 2 },
    });
    expect(restarted.body['output']).toMatchObject({ deadline_at: new Date(app.clock.now + 2 * HOUR).toISOString() });
    expect((await app.call('/actions/start-deadline', { contact_id: 'ct_ada', input: { campaign: 'missing' } })).status).toBe(422);
    expect((await app.call('/actions/start-deadline', { input: { campaign: c.id } })).status).toBe(422);
  });

  it('fires started and expired triggers once, and again after a restart', async () => {
    const app = await setup();
    const c = await app.campaign({ duration_minutes: 30 });
    await app.pub(`/i/${c.public_id}/c/ct_ada.gif`);
    await app.pub(`/w/${c.public_id}/state?v=${VISITOR}`);

    await app.worker.scheduled(app.env);
    expect(app.crm.events).toMatchObject([{ key: 'deadline_started', contact_id: 'ct_ada', data: { campaign_id: c.id, campaign_name: 'Black Friday' } }]);
    await app.worker.scheduled(app.env);
    expect(app.crm.events).toHaveLength(1);

    app.clock.now += 31 * MINUTE;
    await app.worker.scheduled(app.env);
    expect(app.crm.events.map((e) => e['key'])).toEqual(['deadline_started', 'deadline_expired']);
    await app.worker.scheduled(app.env);
    expect(app.crm.events).toHaveLength(2);

    const ada = (await app.deadlines(c.id)).find((d) => d.contact_id === 'ct_ada');
    await app.screen('/api/deadlines', { method: 'POST', body: { campaign: c.id, ids: [ada!.id], change: { kind: 'restart' } } });
    await app.worker.scheduled(app.env);
    expect(app.crm.events.map((e) => e['key'])).toEqual(['deadline_started', 'deadline_expired', 'deadline_started']);
    expect(new Set(app.crm.events.map((e) => e['event_id'])).size).toBe(3);
  });

  it('keeps events for the next run when the CRM is down', async () => {
    const app = await setup();
    const c = await app.campaign();
    await app.pub(`/i/${c.public_id}/c/ct_ada.gif`);
    let down = true;
    app.crm.on('POST', /^\/apps\/events$/, () => (down ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json({ event_id: 'ev', matched: 0 }, { status: 201 })));
    await app.worker.scheduled(app.env);
    down = false;
    expect(await app.worker.announce(app.env)).toEqual({ started: 1, expired: 0 });
  });
});

describe('timely: privacy and lifecycle', () => {
  it('exports and erases the deadlines of a contact', async () => {
    const app = await setup();
    const c = await app.campaign();
    await app.pub(`/i/${c.public_id}/c/ct_ada.gif`);
    const exported = await app.call('/privacy/data', { data: { contact_id: 'ct_ada' } });
    expect(exported.body['data']).toMatchObject({ deadlines: [{ campaign: 'Black Friday', started_by: 'email_open' }] });
    expect((await app.call('/privacy/erasure', { data: { contact_id: 'ct_ada' } })).body).toEqual({ ok: true });
    expect((await app.call('/privacy/data', { data: { contact_id: 'ct_ada' } })).body).toEqual({ data: null });
  });

  it('deletes everything of the install when the app is uninstalled', async () => {
    const app = await setup();
    const c = await app.campaign();
    await app.pub(`/i/${c.public_id}/c/ct_ada.gif`);
    const uninstalled = await app.call('/webhooks', { type: 'app.uninstalled', data: {} });
    expect(uninstalled.status).toBeLessThan(300);
    const count = (table: string) => (app.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count('campaigns')).toBe(0);
    expect(count('deadlines')).toBe(0);
  });

  it('serves the screens and passes the conformance suite', async () => {
    const app = await setup();
    for (const path of ['/ui/campaigns', '/ui/settings']) {
      const token = await app.crm.sessionToken({ appId: manifest.id, audience: BASE, install: app.install });
      const response = await app.fetch(new Request(`${BASE}${path}?session=${token}`));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`<base href="${BASE}/" />`);
    }
    const results = await runConformance({
      manifest,
      fetch: (input, init) => app.fetch(new Request(input, init)),
      secret: app.install.webhookSecrets[0]!,
      installationId: app.install.id,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(passed(results)).toBe(true);
  });
});

import { signContactToken } from '@amable/core';
import {
  newSiteId,
  newSiteSecret,
  siteStub,
  tenantSitesStub,
  type AnalyticsNamespace,
  type BotHit,
  type Channel,
  type EnrichedEvent,
} from '@amable/app-edge/analytics';
import { seeded } from './integrations';
import { contactTokenSecrets } from './runtime';
import { sha256Hex } from './service';
import type { Env } from '../env';

/**
 * Local development only (`/api/dev/analytics/traffic`, ENVIRONMENT=dev):
 * realistic fake web traffic for the demo tenant — sessions over N days with
 * channels, campaigns, geo, devices, goals, bots, identifies of seeded CRM
 * contacts before their real payments (so CRM revenue gets attributed), and
 * "live" visitors for the realtime view. Deterministic for a given seed.
 */

const DAY = 86_400_000;
const MIN = 60_000;

interface Place {
  country: string;
  region: string;
  city: string;
  lat: number;
  lon: number;
  w: number;
  lang: string;
}

const PLACES: Place[] = [
  { country: 'IT', region: 'Lombardy', city: 'Milan', lat: 45.46, lon: 9.19, w: 14, lang: 'it-IT' },
  { country: 'IT', region: 'Lazio', city: 'Rome', lat: 41.9, lon: 12.5, w: 9, lang: 'it-IT' },
  { country: 'IT', region: 'Piedmont', city: 'Turin', lat: 45.07, lon: 7.69, w: 4, lang: 'it-IT' },
  { country: 'US', region: 'New York', city: 'New York', lat: 40.71, lon: -74.0, w: 9, lang: 'en-US' },
  { country: 'US', region: 'California', city: 'San Francisco', lat: 37.77, lon: -122.42, w: 7, lang: 'en-US' },
  { country: 'US', region: 'Texas', city: 'Austin', lat: 30.27, lon: -97.74, w: 4, lang: 'en-US' },
  { country: 'DE', region: 'Berlin', city: 'Berlin', lat: 52.52, lon: 13.4, w: 6, lang: 'de-DE' },
  { country: 'DE', region: 'Bavaria', city: 'Munich', lat: 48.14, lon: 11.58, w: 3, lang: 'de-DE' },
  { country: 'GB', region: 'England', city: 'London', lat: 51.51, lon: -0.13, w: 7, lang: 'en-GB' },
  { country: 'FR', region: 'Île-de-France', city: 'Paris', lat: 48.86, lon: 2.35, w: 5, lang: 'fr-FR' },
  { country: 'ES', region: 'Madrid', city: 'Madrid', lat: 40.42, lon: -3.7, w: 4, lang: 'es-ES' },
  { country: 'NL', region: 'North Holland', city: 'Amsterdam', lat: 52.37, lon: 4.9, w: 3, lang: 'nl-NL' },
  { country: 'BR', region: 'São Paulo', city: 'São Paulo', lat: -23.55, lon: -46.63, w: 3, lang: 'pt-BR' },
  { country: 'IN', region: 'Karnataka', city: 'Bengaluru', lat: 12.97, lon: 77.59, w: 3, lang: 'en-IN' },
  { country: 'JP', region: 'Tokyo', city: 'Tokyo', lat: 35.68, lon: 139.69, w: 2, lang: 'ja-JP' },
  { country: 'CA', region: 'Ontario', city: 'Toronto', lat: 43.65, lon: -79.38, w: 3, lang: 'en-CA' },
  { country: 'AU', region: 'New South Wales', city: 'Sydney', lat: -33.87, lon: 151.21, w: 2, lang: 'en-AU' },
];

interface Source {
  channel: Channel;
  w: number;
  paid: boolean;
  referrer?: string;
  source?: string;
  utm?: { source: string; medium: string; campaign: string };
  clickId?: string;
  via?: string;
  entry: string[];
}

const SOURCES: Source[] = [
  { channel: 'Direct', w: 22, paid: false, entry: ['/', '/', '/pricing', '/login'] },
  { channel: 'Organic search', w: 24, paid: false, referrer: 'www.google.com', source: 'Google', entry: ['/blog/attribution-guide', '/blog/crm-vs-spreadsheet', '/', '/features'] },
  { channel: 'Organic search', w: 4, paid: false, referrer: 'www.bing.com', source: 'Bing', entry: ['/', '/features'] },
  { channel: 'Organic search', w: 3, paid: false, referrer: 'duckduckgo.com', source: 'DuckDuckGo', entry: ['/blog/email-automation'] },
  { channel: 'Paid search', w: 7, paid: true, referrer: 'www.google.com', source: 'Google', utm: { source: 'google', medium: 'cpc', campaign: 'brand_search' }, clickId: 'gclid', entry: ['/pricing', '/'] },
  { channel: 'Paid social', w: 5, paid: true, referrer: 'l.facebook.com', source: 'Facebook', utm: { source: 'facebook', medium: 'paid_social', campaign: 'spring_sale' }, entry: ['/pricing', '/features'] },
  { channel: 'Paid social', w: 4, paid: true, referrer: 'l.instagram.com', source: 'Instagram', utm: { source: 'instagram', medium: 'paid_social', campaign: 'retargeting' }, entry: ['/pricing'] },
  { channel: 'Paid social', w: 2, paid: true, referrer: 'www.linkedin.com', source: 'LinkedIn', utm: { source: 'linkedin', medium: 'paid_social', campaign: 'brand_awareness' }, entry: ['/', '/features'] },
  { channel: 'Organic social', w: 4, paid: false, referrer: 'x.com', source: 'X', entry: ['/blog/attribution-guide', '/'] },
  { channel: 'Organic social', w: 3, paid: false, referrer: 'www.reddit.com', source: 'Reddit', entry: ['/blog/crm-vs-spreadsheet'] },
  { channel: 'Organic social', w: 2, paid: false, referrer: 'www.linkedin.com', source: 'LinkedIn', entry: ['/'] },
  { channel: 'Email', w: 6, paid: false, source: 'newsletter', utm: { source: 'newsletter', medium: 'email', campaign: 'october_digest' }, entry: ['/blog/email-automation', '/pricing'] },
  { channel: 'Referral', w: 4, paid: false, referrer: 'www.producthunt.com', source: 'Product Hunt', entry: ['/'] },
  { channel: 'Referral', w: 3, paid: false, referrer: 'news.ycombinator.com', source: 'Hacker News', entry: ['/blog/attribution-guide'] },
  { channel: 'Referral', w: 2, paid: false, referrer: 'partnerblog.example.org', source: 'partnerblog.example.org', entry: ['/integrations'] },
  { channel: 'Affiliate', w: 2, paid: false, via: 'marco', source: 'marco', entry: ['/pricing'] },
];

const NEXT_PAGES = ['/features', '/pricing', '/integrations', '/blog/attribution-guide', '/blog/email-automation', '/docs/getting-started', '/about', '/contact', '/customers', '/signup', '/demo'];

const TECH: Array<{ device: 'desktop' | 'mobile' | 'tablet'; browser: string; os: string; w: number; sw: number }> = [
  { device: 'desktop', browser: 'Chrome', os: 'macOS', w: 18, sw: 1512 },
  { device: 'desktop', browser: 'Chrome', os: 'Windows', w: 16, sw: 1920 },
  { device: 'desktop', browser: 'Safari', os: 'macOS', w: 9, sw: 1440 },
  { device: 'desktop', browser: 'Edge', os: 'Windows', w: 6, sw: 1920 },
  { device: 'desktop', browser: 'Firefox', os: 'Linux', w: 4, sw: 1920 },
  { device: 'mobile', browser: 'Safari', os: 'iOS', w: 20, sw: 390 },
  { device: 'mobile', browser: 'Chrome', os: 'Android', w: 18, sw: 412 },
  { device: 'mobile', browser: 'Samsung Internet', os: 'Android', w: 3, sw: 360 },
  { device: 'tablet', browser: 'Safari', os: 'iPadOS', w: 4, sw: 820 },
];

const BOTS: Array<Omit<BotHit, 'site' | 'ts' | 'path'> & { w: number }> = [
  { name: 'Googlebot', provider: 'Google', category: 'indexing', w: 30, verification: 'verified' },
  { name: 'Bingbot', provider: 'Microsoft', category: 'indexing', w: 10, verification: 'verified' },
  { name: 'GPTBot', provider: 'OpenAI', category: 'training', w: 14, verification: 'verified' },
  { name: 'ClaudeBot', provider: 'Anthropic', category: 'training', w: 8, verification: 'unknown' },
  { name: 'CCBot', provider: 'Common Crawl', category: 'training', w: 5, verification: 'unknown' },
  { name: 'ChatGPT-User', provider: 'OpenAI', category: 'ai_answers', w: 9, verification: 'verified' },
  { name: 'PerplexityBot', provider: 'Perplexity', category: 'ai_answers', w: 6, verification: 'unknown' },
  { name: 'Claude-User', provider: 'Anthropic', category: 'ai_answers', w: 4, verification: 'unknown' },
  { name: 'Googlebot', provider: 'Google', category: 'indexing', w: 2, verification: 'spoofed' },
  { name: 'AhrefsBot', provider: 'Ahrefs', category: 'other', w: 4, verification: 'unknown' },
];

const HOST = 'www.example.com';

function pick<T extends { w: number }>(rnd: () => number, list: readonly T[]): T {
  const total = list.reduce((a, x) => a + x.w, 0);
  let r = rnd() * total;
  for (const x of list) {
    r -= x.w;
    if (r <= 0) return x;
  }
  return list[list.length - 1] as T;
}

const anyOf = <T,>(rnd: () => number, list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;

function uuid(rnd: () => number): string {
  const h = Array.from({ length: 32 }, () => Math.floor(rnd() * 16).toString(16)).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}

interface VisitorState {
  vid: string;
  firstSeen: number;
  sessions: number;
  place: Place;
  tech: (typeof TECH)[number];
}

function baseEvent(
  siteId: string,
  v: VisitorState,
  sid: string,
  ts: number,
  src: Source,
  path: string,
  first: boolean,
  rnd: () => number,
): EnrichedEvent {
  const qs = new URLSearchParams();
  if (first && src.utm !== undefined) {
    qs.set('utm_source', src.utm.source);
    qs.set('utm_medium', src.utm.medium);
    qs.set('utm_campaign', src.utm.campaign);
  }
  if (first && src.via !== undefined) qs.set('via', src.via);
  const clickIds = first && src.clickId !== undefined ? { [src.clickId]: uuid(rnd).slice(0, 18) } : null;
  if (clickIds !== null) for (const [k, val] of Object.entries(clickIds)) qs.set(k, val);
  const url = `https://${HOST}${path}${qs.size > 0 ? `?${qs}` : ''}`;
  return {
    eid: uuid(rnd),
    ts,
    site: siteId,
    type: 'pageview',
    server: false,
    vid: v.vid,
    sid,
    firstSeen: v.firstSeen,
    sessionNumber: v.sessions,
    cookieless: false,
    url,
    hostname: HOST,
    path,
    referrer: first && src.referrer !== undefined ? `https://${src.referrer}/` : null,
    referrerHost: first ? (src.referrer ?? null) : null,
    channel: src.channel,
    paid: src.paid,
    source: src.source ?? null,
    utm: {
      source: src.utm?.source ?? null,
      medium: src.utm?.medium ?? null,
      campaign: src.utm?.campaign ?? null,
      term: null,
      content: null,
    },
    clickIds,
    geo: {
      country: v.place.country,
      region: v.place.region,
      city: v.place.city,
      latitude: Math.round((v.place.lat + (rnd() - 0.5) * 0.4) * 100) / 100,
      longitude: Math.round((v.place.lon + (rnd() - 0.5) * 0.4) * 100) / 100,
    },
    device: v.tech.device,
    browser: v.tech.browser,
    os: v.tech.os,
    language: v.place.lang,
    screenWidth: v.tech.sw,
    name: null,
    data: null,
    payment: null,
    identity: null,
  };
}

interface SessionPlan {
  v: VisitorState;
  start: number;
  src?: Source;
  /** Force a path through pricing + signup (buyers). */
  convert?: boolean;
  identify?: { email: string; name: string | null } | null;
  contactToken?: string | null;
}

function sessionEvents(siteId: string, plan: SessionPlan, rnd: () => number): EnrichedEvent[] {
  const { v } = plan;
  v.sessions += 1;
  const src = plan.src ?? pick(rnd, SOURCES);
  const sid = `s${uuid(rnd).replace(/-/g, '')}`;
  const events: EnrichedEvent[] = [];
  let ts = plan.start;
  const bounce = !plan.convert && rnd() < 0.42;
  const pages: string[] = [anyOf(rnd, src.entry)];
  if (!bounce) {
    const extra = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < extra; i += 1) pages.push(anyOf(rnd, NEXT_PAGES));
  }
  if (plan.convert) pages.push('/pricing', '/signup');
  pages.forEach((path, i) => {
    const e = baseEvent(siteId, v, sid, ts, src, path, i === 0, rnd);
    if (i === 0 && plan.contactToken) e.contactToken = plan.contactToken;
    events.push(e);
    const goal = (name: string, data: Record<string, string> | null = null): void => {
      events.push({ ...baseEvent(siteId, v, sid, ts + 5_000, src, path, false, rnd), type: 'goal', name, data });
    };
    if (path === '/pricing' && rnd() < 0.35) goal('pricing_scrolled');
    if (path === '/signup' && (plan.convert || rnd() < 0.45)) goal('signup', { plan: anyOf(rnd, ['starter', 'pro', 'team']) });
    if (path === '/demo' && rnd() < 0.5) goal('demo_request');
    if (path.startsWith('/blog/') && rnd() < 0.08) goal('newsletter_signup');
    if (path === '/' && rnd() < 0.1) goal('cta_click', { position: 'hero' });
    if (rnd() < 0.03) {
      events.push({
        ...baseEvent(siteId, v, sid, ts + 8_000, src, path, false, rnd),
        type: 'external_link',
        data: { url: anyOf(rnd, ['https://github.com/amable', 'https://x.com/amable', 'https://docs.example.org/']), host: 'github.com' },
      });
    }
    ts += Math.floor(15_000 + rnd() * 150_000);
  });
  if (plan.identify) {
    events.push({
      ...baseEvent(siteId, v, sid, ts, src, '/signup', false, rnd),
      type: 'identify',
      identity: { userId: `user_${v.vid.slice(0, 8)}`, email: plan.identify.email, name: plan.identify.name, traits: { plan: 'pro' } },
    });
  }
  return events;
}

export interface TrafficReport {
  siteId: string;
  secret: string | null;
  sessions: number;
  events: number;
  bots: number;
  identified: number;
}

/** Creates the demo site if needed and fills it with `days` of traffic ending now. */
export async function generateTraffic(
  env: Env,
  ns: AnalyticsNamespace,
  tenantId: string,
  opts: { days: number; perDay: number; seed: string; now: number },
  crm: <T>(op: string, input: unknown) => Promise<T>,
): Promise<TrafficReport> {
  const tenant = tenantSitesStub(ns, tenantId);
  let siteId = (await tenant.indexList())[0];
  let secret: string | null = null;
  if (siteId === undefined) {
    siteId = newSiteId();
    secret = newSiteSecret(siteId);
    await siteStub(ns, siteId).initSite({
      siteId,
      tenantId,
      name: 'example.com',
      hostnames: ['example.com'],
      cookieless: false,
      allowLocalhost: true,
      timezone: 'Europe/Rome',
      currency: 'EUR',
      retentionDays: 395,
      attributionModel: 'last_non_direct',
      secretHash: await sha256Hex(secret),
    });
    await tenant.indexAdd(siteId);
  }
  const stub = siteStub(ns, siteId);
  const rnd = seeded(`${opts.seed}|${siteId}`);
  const start = opts.now - opts.days * DAY;
  const pool: VisitorState[] = [];
  const newVisitor = (at: number): VisitorState => {
    const v = { vid: uuid(rnd), firstSeen: at, sessions: 0, place: pick(rnd, PLACES), tech: pick(rnd, TECH) };
    pool.push(v);
    return v;
  };
  const events: EnrichedEvent[] = [];
  let sessions = 0;

  // Anonymous traffic: weekday seasonality, growth over the period, daytime peaks.
  for (let d = 0; d < opts.days; d += 1) {
    const dayStart = start + d * DAY;
    const dow = new Date(dayStart).getUTCDay();
    const weekday = dow === 0 || dow === 6 ? 0.65 : 1;
    const growth = 0.75 + (0.5 * d) / Math.max(1, opts.days);
    const n = Math.round(opts.perDay * weekday * growth * (0.85 + rnd() * 0.3));
    for (let i = 0; i < n; i += 1) {
      const hour = 6 + Math.floor(Math.pow(rnd(), 0.8) * 17);
      const at = dayStart + hour * 3_600_000 + Math.floor(rnd() * 3_600_000);
      if (at > opts.now) continue;
      const returning = pool.length > 50 && rnd() < 0.24;
      const v = returning ? anyOf(rnd, pool) : newVisitor(at);
      events.push(...sessionEvents(siteId, { v, start: at }, rnd));
      sessions += 1;
    }
  }

  // Buyers: the seeded CRM payments of the period get a web history before them.
  const payments = await crm<Array<{ contactId: string; email: string | null; ts: number; amountMinor: number }>>(
    'analytics.recentPayments',
    { since: start, limit: 400 },
  );
  const secrets = contactTokenSecrets(env);
  const seen = new Set<string>();
  let identified = 0;
  for (const p of payments) {
    if (p.email === null || seen.has(p.contactId) || p.ts > opts.now) continue;
    seen.add(p.contactId);
    const visits = 1 + Math.floor(rnd() * 4);
    const firstAt = Math.max(start, p.ts - (1 + rnd() * 12) * DAY);
    const v = newVisitor(firstAt);
    for (let k = 0; k < visits; k += 1) {
      const at = k === visits - 1 ? p.ts - (20 + rnd() * 120) * MIN : firstAt + ((p.ts - firstAt) * k) / visits;
      const last = k === visits - 1;
      // Half of the buyers come back through an email click (signed `_amb_c`).
      const viaEmail = last && rnd() < 0.5 && secrets[0] !== undefined;
      events.push(
        ...sessionEvents(
          siteId,
          {
            v,
            start: Math.max(firstAt, at),
            convert: last,
            ...(viaEmail ? { src: SOURCES.find((s) => s.channel === 'Email') as Source } : {}),
            identify: last && !viaEmail ? { email: p.email, name: null } : null,
            contactToken: viaEmail ? await signContactToken(secrets[0] ?? '', tenantId, p.contactId, at) : null,
          },
          rnd,
        ),
      );
      sessions += 1;
    }
    identified += 1;
  }

  // Bots and AI crawlers.
  const bots: BotHit[] = [];
  for (let d = 0; d < opts.days; d += 1) {
    const hits = 20 + Math.floor(rnd() * 40);
    for (let i = 0; i < hits; i += 1) {
      const b = pick(rnd, BOTS);
      bots.push({
        site: siteId,
        ts: start + d * DAY + Math.floor(rnd() * DAY),
        name: b.name,
        provider: b.provider,
        category: b.category,
        path: anyOf(rnd, ['/', '/pricing', '/blog/attribution-guide', '/docs/getting-started', '/robots.txt', '/sitemap.xml']),
        ...(b.verification === undefined ? {} : { verification: b.verification }),
      });
    }
  }

  events.sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < events.length; i += 400) await stub.ingest(events.slice(i, i + 400), []);
  for (let i = 0; i < bots.length; i += 400) await stub.ingest([], bots.slice(i, i + 400));
  return { siteId, secret, sessions, events: events.length, bots: bots.length, identified };
}

/** A few visitors active right now (realtime view, globe). */
export async function liveTraffic(ns: AnalyticsNamespace, tenantId: string, now: number, count: number): Promise<number> {
  const siteId = (await tenantSitesStub(ns, tenantId).indexList())[0];
  if (siteId === undefined) return 0;
  const rnd = seeded(`live|${now}`);
  const events: EnrichedEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    const v: VisitorState = { vid: uuid(rnd), firstSeen: now - 60_000, sessions: 0, place: pick(rnd, PLACES), tech: pick(rnd, TECH) };
    events.push(...sessionEvents(siteId, { v, start: now - Math.floor(rnd() * 4 * MIN) }, rnd).filter((e) => e.ts <= now));
  }
  await siteStub(ns, siteId).ingest(events, []);
  return events.length;
}

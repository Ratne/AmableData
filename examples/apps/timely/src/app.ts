import {
  AmableApiError,
  appBaseUrl,
  appKeysLoader,
  appPath,
  createAppHandler,
  d1InstallStore,
  type AppContext,
  type Fetch,
} from '@amable/app-sdk';
import manifest from '../manifest.json';
import { assets } from './assets';
import {
  campaignByPublicId,
  deleteCampaign,
  eraseInstall,
  getCampaign,
  listCampaigns,
  parseCampaignInput,
  saveCampaign,
  type Campaign,
} from './campaigns';
import { ensureSchema, type SqlDb } from './db';
import { linkSecrets } from './keys';
import {
  adoptVisitor,
  changeDeadlines,
  contactDeadlines,
  countDeadlines,
  eraseContact,
  findDeadline,
  getOrStart,
  listDeadlines,
  markAnnounced,
  previewDeadline,
  restart,
  unannounced,
  type Change,
  type Deadline,
  type PendingEvent,
} from './deadlines';
import { renderTimerGif } from './gif/render';
import { campaignsPage, settingsPage } from './pages';
import { normalizeStyle, widgetCss, type TimerStyle } from './style';
import { CONTACT_ID, contactToken, readContactToken, VISITOR_ID, type Subject } from './token';

/**
 * Timely for AmableData: countdown timers that tell the truth. Every contact
 * (or anonymous visitor) of a campaign has one deadline stored here; the email
 * GIF, the page widget and the email links all read it, and automations hear
 * when it starts and when it expires.
 *
 * Public URLs (no CRM signature: they are fetched by mail clients and
 * browsers) carry the campaign's random public id:
 *   GET /i/<public id>/c/<contact id>.gif   email timer of a contact
 *   GET /i/<public id>.gif                  email timer without a contact (fixed deadlines)
 *   GET /r/<public id>?c=<contact id>       email link: starts the countdown, opens the offer
 *   GET /w/<public id>/state                the page widget's deadline (CORS)
 *   GET /preview.gif?style=…&minutes=…      editor preview of an unsaved style
 *
 * It runs in the workspace's own Cloudflare account, deployed by the CRM: one
 * D1 database keeps the campaigns, the deadlines, the installs and the
 * signing keys (created on first use).
 */

export interface Env {
  DB: SqlDb;
  /** URL of this Worker, set by the CRM when it deploys the app. */
  APP_BASE_URL?: string;
  /** Signing keys, only for a copy hosted elsewhere; normally created in DB. */
  APP_KEYS?: string;
}

const keysOf = appKeysLoader({ kid: 'timely-1' });
const SETTINGS_KEY = 'timely_settings';
const ACTION_TTL_MS = 3 * 24 * 3_600_000;
const CONTACT_CACHE_MS = 10 * 60_000;
const PUBLIC_ID = '[0-9a-z]{16}';
const RATE_LIMIT = { requests: 120, windowMs: 60_000 };

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const failure = (status: number, error: string) => json({ error }, status);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};
const NO_STORE = { 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0', expires: '0', pragma: 'no-cache' };

/** Per-isolate caches: rendered GIFs (fixed deadlines share them) and contacts known to exist. */
const gifCache = new Map<string, Uint8Array>();
const knownContacts = new Map<string, { exists: boolean; until: number }>();
const hits = new Map<string, { count: number; until: number }>();

function limited(request: Request, now: number): boolean {
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  const entry = hits.get(ip);
  if (entry === undefined || entry.until <= now) {
    if (hits.size > 10_000) hits.clear();
    hits.set(ip, { count: 1, until: now + RATE_LIMIT.windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT.requests;
}

export const timerUrl = (base: string, campaign: Campaign, contact = '{{ contact.id }}') => `${base}/i/${campaign.publicId}/c/${contact}.gif`;
export const linkUrl = (base: string, campaign: Campaign, contact = '{{ contact.id }}') => `${base}/r/${campaign.publicId}?c=${contact}`;

/** What the editor shows next to a campaign: the code to paste in emails and pages. */
export function snippets(base: string, campaign: Campaign): Record<string, string> {
  const image = timerUrl(base, campaign);
  const link = linkUrl(base, campaign);
  return {
    email_image: image,
    email_link: link,
    email_html: `<a href="${link}"><img src="${image}" alt="Countdown" style="display:block;max-width:100%;height:auto;border:0" /></a>`,
    email_image_shared: `${base}/i/${campaign.publicId}.gif`,
    page_inline: `<div data-timely="${campaign.publicId}"></div>\n<script async src="${base}/widget.js"></script>`,
    page_bar: `<div data-timely="${campaign.publicId}" data-timely-mode="bar" data-timely-position="top"></div>\n<script async src="${base}/widget.js"></script>`,
  };
}

function campaignView(base: string, campaign: Campaign, counts?: { running: number; expired: number }) {
  return {
    id: campaign.id,
    public_id: campaign.publicId,
    name: campaign.name,
    mode: campaign.mode,
    duration_minutes: campaign.durationMinutes,
    fixed_end_at: campaign.fixedEndAt,
    hard_end_at: campaign.hardEndAt,
    start_on: campaign.startOn,
    expiry: campaign.expiry,
    style: campaign.style,
    offer_url: campaign.offerUrl,
    expired_url: campaign.expiredUrl,
    created_at: campaign.createdAt,
    updated_at: campaign.updatedAt,
    running: counts?.running ?? 0,
    expired: counts?.expired ?? 0,
    snippets: snippets(base, campaign),
  };
}

const deadlineView = (deadline: Deadline, now: number) => ({
  id: deadline.id,
  contact_id: deadline.contactId,
  visitor: deadline.contactId === null,
  started_at: deadline.startedAt,
  deadline_at: deadline.deadlineAt,
  source: deadline.source,
  expired: deadline.deadlineAt <= now,
});

function contactName(contact: Record<string, unknown>): string {
  const name = [contact['given_name'], contact['family_name']].filter((v) => typeof v === 'string' && v !== '').join(' ');
  if (name !== '') return name;
  const emails = Array.isArray(contact['emails']) ? (contact['emails'] as Array<{ email?: unknown; is_primary?: unknown }>) : [];
  const email = emails.find((e) => e.is_primary === true) ?? emails[0];
  if (typeof email?.email === 'string') return email.email;
  return typeof contact['primary_email'] === 'string' ? contact['primary_email'] : String(contact['id'] ?? '');
}

async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await map(items[index]!);
      }
    }),
  );
  return out;
}

function gifResponse(bytes: Uint8Array): Response {
  return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'image/gif', ...NO_STORE } });
}

function renderCached(campaign: Pick<Campaign, 'id' | 'styleVersion' | 'style'>, remaining: number, still: boolean): Uint8Array {
  const key = `${campaign.id}|${String(campaign.styleVersion)}|${String(Math.max(0, Math.floor(remaining)))}|${String(still)}`;
  let gif = gifCache.get(key);
  if (gif === undefined) {
    gif = renderTimerGif(campaign.style, { remaining, still });
    if (gifCache.size > 200) gifCache.delete(gifCache.keys().next().value!);
    gifCache.set(key, gif);
  }
  return gif;
}

function decodeStyle(param: string | null): TimerStyle | null {
  if (param === null || param.length > 40_000) return null;
  try {
    const binary = atob(param.replace(/-/g, '+').replace(/_/g, '/'));
    return normalizeStyle(JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))));
  } catch {
    return null;
  }
}

function withQuery(target: string, params: URLSearchParams): string {
  const url = new URL(target);
  for (const [key, value] of params) url.searchParams.set(key, value);
  return url.toString();
}

const page = (title: string, text: string, status: number) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;color:#333"><p>${text}</p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE } },
  );

export function createWorker(deps: { fetch?: Fetch; now?: () => number } = {}) {
  const outbound: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const handlers = new Map<string, ReturnType<typeof createAppHandler>>();
  const baseOf = (env: Env, request?: Request) => appBaseUrl(manifest.base_url, env.APP_BASE_URL, request);

  /** The link token secrets come from the signing keys: nothing else to configure. */
  async function tokenSecrets(env: Env): Promise<string[]> {
    return linkSecrets(await keysOf(env));
  }

  async function handlerFor(env: Env, baseUrl: string) {
    const keys = await keysOf(env);
    const cacheKey = JSON.stringify([baseUrl, keys.map((k) => [k.kid, k.x])]);
    let app = handlers.get(cacheKey);
    if (app !== undefined) return app;
    app = createAppHandler({
      appId: manifest.id,
      baseUrl,
      keys,
      store: d1InstallStore(env.DB),
      manifest,
      assets,
      fetch: outbound,
      now,
      async onEvent(event, ctx) {
        if (event['type'] === 'app.uninstalled') await eraseInstall(env.DB, ctx.install.id);
      },
      calls: {
        '/actions/start-deadline': async (body, ctx) => {
          if (body['test'] === true) return { ok: true, test: true };
          const input = (body['input'] ?? {}) as { campaign?: unknown; restart?: unknown; duration_hours?: unknown };
          const contactId = typeof body['contact_id'] === 'string' ? body['contact_id'] : '';
          if (!CONTACT_ID.test(contactId)) return failure(422, 'the step needs a contact');
          if (typeof input.campaign !== 'string' || input.campaign === '') return failure(422, 'choose a Timely campaign');
          const key = typeof body['idempotency_key'] === 'string' ? body['idempotency_key'].slice(0, 200) : null;
          if (key !== null) {
            const done = await env.DB.prepare('SELECT output FROM action_runs WHERE install_id = ? AND key = ?')
              .bind(ctx.install.id, key)
              .first<{ output: string }>();
            if (done !== null) return { output: JSON.parse(done.output) as Record<string, unknown> };
          }
          const campaign = await getCampaign(env.DB, ctx.install.id, input.campaign);
          if (campaign === null) return failure(422, 'this Timely campaign no longer exists: pick another one');
          const hours = typeof input.duration_hours === 'number' && input.duration_hours >= 1 ? Math.floor(input.duration_hours) : null;
          const subject: Subject = { kind: 'contact', id: contactId };
          const at = now();
          const deadline =
            input.restart === true
              ? await restart(env.DB, campaign, subject, 'automation', at, hours === null ? null : hours * 60)
              : (await getOrStart(env.DB, campaign, subject, 'automation', at, hours === null ? null : hours * 60)).deadline;
          const output = {
            deadline_at: new Date(deadline.deadlineAt).toISOString(),
            campaign_name: campaign.name,
            timer_url: timerUrl(baseUrl, campaign, contactId),
            link_url: linkUrl(baseUrl, campaign, contactId),
          };
          if (key !== null) {
            await env.DB.prepare('INSERT OR IGNORE INTO action_runs (install_id, key, output, created_at) VALUES (?, ?, ?, ?)')
              .bind(ctx.install.id, key, JSON.stringify(output), at)
              .run();
          }
          return { output };
        },
        '/options/campaigns': async (_body, ctx) => ({
          options: (await listCampaigns(env.DB, ctx.install.id)).slice(0, 500).map((c) => ({
            value: c.id,
            label: c.name.slice(0, 200),
            description: c.mode === 'fixed' ? `fixed: ${new Date(c.fixedEndAt ?? 0).toISOString()}` : `evergreen: ${String(c.durationMinutes)} min`,
          })),
        }),
        '/privacy/erasure': async (body, ctx) => {
          const contactId = privacyContact(body);
          if (contactId !== null) await eraseContact(env.DB, ctx.install.id, contactId);
          return { ok: true };
        },
        '/privacy/data': async (body, ctx) => {
          const contactId = privacyContact(body);
          const rows = contactId === null ? [] : await contactDeadlines(env.DB, ctx.install.id, contactId);
          return {
            data:
              rows.length === 0
                ? null
                : {
                    deadlines: rows.map((r) => ({
                      campaign: r.campaignName,
                      started_at: new Date(r.startedAt).toISOString(),
                      deadline_at: new Date(r.deadlineAt).toISOString(),
                      started_by: r.source,
                    })),
                  },
          };
        },
      },
      screens: {
        '/ui/campaigns': () => campaignsPage(baseUrl),
        '/ui/settings': () => settingsPage(baseUrl),
      },
      screenApi: {
        '/api/campaigns': async (req, _session, ctx) => {
          const at = now();
          if (req.method === 'GET') {
            const counts = await countDeadlines(env.DB, ctx.install.id, at);
            const campaigns = await listCampaigns(env.DB, ctx.install.id);
            return json({ data: campaigns.map((c) => campaignView(baseUrl, c, counts.get(c.id))), base_url: baseUrl });
          }
          if (req.method === 'DELETE') {
            const id = new URL(req.url).searchParams.get('id') ?? '';
            return (await deleteCampaign(env.DB, ctx.install.id, id, at)) ? json({ ok: true }) : failure(404, 'campaign not found');
          }
          if (req.method !== 'POST') return failure(405, 'GET, POST or DELETE');
          const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const parsed = parseCampaignInput(raw);
          if (!parsed.ok) return failure(422, parsed.error);
          const id = typeof raw['id'] === 'string' && raw['id'] !== '' ? raw['id'] : null;
          const saved = await saveCampaign(env.DB, ctx.install.id, id, parsed.input, at);
          return saved === null ? failure(404, 'campaign not found') : json(campaignView(baseUrl, saved), id === null ? 201 : 200);
        },
        '/api/deadlines': async (req, _session, ctx) => {
          const at = now();
          const url = new URL(req.url);
          const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
          const campaignId = String(body['campaign'] ?? url.searchParams.get('campaign') ?? '');
          const campaign = await getCampaign(env.DB, ctx.install.id, campaignId);
          if (campaign === null) return failure(404, 'campaign not found');
          if (req.method === 'POST') {
            const change = changeOf(body['change']);
            if (change === null) return failure(422, 'unknown change');
            const ids = body['all'] === true ? null : Array.isArray(body['ids']) ? body['ids'].filter((i): i is string => typeof i === 'string').slice(0, 500) : [];
            return json({ changed: await changeDeadlines(env.DB, campaign, ids, change, at) });
          }
          const q = (url.searchParams.get('q') ?? '').trim();
          let contactIds: string[] | undefined;
          if (q !== '') {
            const found = await ctx.api.contacts.list({ q: q.slice(0, 200), limit: '100' });
            contactIds = found.data.map((c) => String(c['id']));
          }
          const items = await listDeadlines(env.DB, ctx.install.id, campaign.id, {
            ...(contactIds === undefined ? {} : { contactIds }),
            contactsOnly: url.searchParams.get('contacts') === 'true',
            before: url.searchParams.get('before'),
            limit: 50,
            now: at,
          });
          const names = await mapLimited(items, 5, async (item) => {
            if (item.contactId === null) return null;
            try {
              return contactName(await ctx.api.contacts.get(item.contactId));
            } catch {
              return null;
            }
          });
          return json({
            data: items.map((item, i) => ({ ...deadlineView(item, at), contact_name: names[i] })),
            next_before: items.length === 50 ? items[items.length - 1]!.id : null,
            server_now: at,
          });
        },
        '/api/deadlines/start': async (req, _session, ctx) => {
          if (req.method !== 'POST') return failure(405, 'POST only');
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const campaign = await getCampaign(env.DB, ctx.install.id, String(body['campaign'] ?? ''));
          if (campaign === null) return failure(404, 'campaign not found');
          const contactId = String(body['contact_id'] ?? '');
          if (!CONTACT_ID.test(contactId) || !(await contactExists(ctx, contactId))) return failure(422, 'contact not found');
          const subject: Subject = { kind: 'contact', id: contactId };
          const at = now();
          const deadline = body['restart'] === true ? await restart(env.DB, campaign, subject, 'manual', at) : (await getOrStart(env.DB, campaign, subject, 'manual', at)).deadline;
          return json(deadlineView(deadline, at));
        },
        '/api/contacts': async (req, _session, ctx) => {
          const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
          if (q === '') return json({ data: [] });
          const found = await ctx.api.contacts.list({ q: q.slice(0, 200), limit: '10' });
          return json({ data: found.data.map((c) => ({ id: String(c['id']), name: contactName(c) })) });
        },
        '/api/settings': async (req, _session, ctx) => {
          if (req.method === 'POST') {
            const settings = settingsOf(await req.json().catch(() => ({})));
            await ctx.api.data.set(SETTINGS_KEY, settings);
            return json(settings);
          }
          try {
            return json(settingsOf((await ctx.api.data.get(SETTINGS_KEY))['value']));
          } catch (error) {
            if (error instanceof AmableApiError && error.status === 404) return json(settingsOf(null));
            throw error;
          }
        },
      },
    });
    handlers.set(cacheKey, app);
    return app;
  }

  /** Whether the id is a contact of the install (cached); unknown when the CRM does not answer: then yes. */
  async function contactExists(ctx: AppContext, contactId: string): Promise<boolean> {
    const key = `${ctx.install.id}:${contactId}`;
    const cached = knownContacts.get(key);
    if (cached !== undefined && cached.until > now()) return cached.exists;
    let exists: boolean;
    try {
      await ctx.api.contacts.get(contactId);
      exists = true;
    } catch (error) {
      if (!(error instanceof AmableApiError) || (error.status !== 404 && error.status !== 400)) return true;
      exists = false;
    }
    if (knownContacts.size > 20_000) knownContacts.clear();
    knownContacts.set(key, { exists, until: now() + CONTACT_CACHE_MS });
    return exists;
  }

  async function canStart(env: Env, campaign: Campaign, contactId: string): Promise<boolean> {
    const ctx = await (await handlerFor(env, baseOf(env))).contextFor(campaign.installId);
    return ctx !== null && (await contactExists(ctx, contactId));
  }

  /** The contact's deadline, started now when `trigger` is one of the campaign's start triggers. */
  async function contactDeadline(env: Env, campaign: Campaign, contactId: string, trigger: Campaign['startOn'][number], at: number): Promise<Deadline | null> {
    const subject: Subject = { kind: 'contact', id: contactId };
    const existing = await findDeadline(env.DB, campaign, subject);
    if (existing !== null || !campaign.startOn.includes(trigger)) return existing;
    if (!(await canStart(env, campaign, contactId))) return null;
    return (await getOrStart(env.DB, campaign, subject, trigger, at)).deadline;
  }

  async function emailTimer(env: Env, publicId: string, contactId: string | null): Promise<Response> {
    const campaign = await campaignByPublicId(env.DB, publicId);
    if (campaign === null) return new Response('not found', { status: 404, headers: NO_STORE });
    const at = now();
    let deadline: Deadline | null = null;
    if (contactId !== null && CONTACT_ID.test(contactId)) deadline = await contactDeadline(env, campaign, contactId, 'email_open', at);
    if (deadline !== null) return gifResponse(renderCached(campaign, (deadline.deadlineAt - at) / 1000, false));
    if (campaign.mode === 'fixed') return gifResponse(renderCached(campaign, ((campaign.fixedEndAt ?? at) - at) / 1000, false));
    // Not started (a preview, a test send, or a campaign started only by automations): the full window, still.
    return gifResponse(renderCached(campaign, (previewDeadline(campaign, at) - at) / 1000, true));
  }

  async function emailLink(env: Env, url: URL, publicId: string): Promise<Response> {
    const campaign = await campaignByPublicId(env.DB, publicId);
    if (campaign === null) return page('Timely', 'This offer is no longer available.', 404);
    const at = now();
    const contactId = url.searchParams.get('c');
    const known = contactId !== null && CONTACT_ID.test(contactId) ? contactId : null;
    const deadline = known === null ? null : await contactDeadline(env, campaign, known, 'email_click', at);
    const deadlineAt = deadline?.deadlineAt ?? (campaign.mode === 'fixed' ? campaign.fixedEndAt : null);
    const expired = deadlineAt !== null && deadlineAt <= at;
    const target = expired && campaign.expiredUrl !== null ? campaign.expiredUrl : (campaign.offerUrl ?? campaign.expiredUrl);
    if (target === null) return page('Timely', 'This campaign has no page yet.', 404);
    const params = new URLSearchParams(url.searchParams);
    params.delete('c');
    if (known !== null) params.set('tly', await contactToken((await tokenSecrets(env))[0]!, campaign.publicId, known));
    return new Response(null, { status: 302, headers: { location: withQuery(target, params), ...NO_STORE } });
  }

  async function widgetState(env: Env, url: URL, publicId: string): Promise<Response> {
    const campaign = await campaignByPublicId(env.DB, publicId);
    if (campaign === null) return json({ error: 'not_found' }, 404, { ...CORS, ...NO_STORE });
    const at = now();
    const contactId = await readContactToken(await tokenSecrets(env), campaign.publicId, url.searchParams.get('t'));
    const visitorParam = url.searchParams.get('v');
    const visitorId = visitorParam !== null && VISITOR_ID.test(visitorParam) ? visitorParam : null;
    if (contactId !== null && visitorId !== null) await adoptVisitor(env.DB, campaign, visitorId, contactId, at);
    let deadline: Deadline | null = null;
    if (contactId !== null) deadline = await contactDeadline(env, campaign, contactId, 'page_visit', at);
    else if (visitorId !== null) {
      const subject: Subject = { kind: 'visitor', id: visitorId };
      deadline = campaign.startOn.includes('page_visit')
        ? (await getOrStart(env.DB, campaign, subject, 'page_visit', at)).deadline
        : await findDeadline(env.DB, campaign, subject);
    }
    const deadlineAt = deadline?.deadlineAt ?? (campaign.mode === 'fixed' ? campaign.fixedEndAt : null);
    const status = deadlineAt === null ? 'not_started' : deadlineAt <= at ? 'expired' : 'running';
    return json(
      {
        campaign: campaign.publicId,
        contact: contactId !== null,
        status,
        deadline_at: deadlineAt ?? previewDeadline(campaign, at),
        server_now: at,
        expiry: campaign.expiry,
        redirect_url: campaign.expiry === 'redirect' ? campaign.expiredUrl : null,
        style: campaign.style,
        css: widgetCss(campaign.publicId, campaign.style),
      },
      200,
      { ...CORS, ...NO_STORE },
    );
  }

  /** Announces started and expired deadlines of contacts to the CRM, as automation triggers. */
  async function announce(env: Env): Promise<{ started: number; expired: number }> {
    await ensureSchema(env.DB);
    const at = now();
    const { started, expired } = await unannounced(env.DB, at, 200);
    const app = await handlerFor(env, baseOf(env));
    const contexts = new Map<string, Promise<AppContext | null>>();
    const sent = { started: 0, expired: 0 };
    const fire = async (kind: 'started' | 'expired', event: PendingEvent) => {
      let ctx = contexts.get(event.installId);
      if (ctx === undefined) {
        ctx = app.contextFor(event.installId);
        contexts.set(event.installId, ctx);
      }
      const context = await ctx;
      if (context !== null) {
        try {
          await context.api.events.fire({
            key: kind === 'started' ? 'deadline_started' : 'deadline_expired',
            contact_id: event.contactId,
            event_id: kind === 'started' ? `start:${event.id}:${String(event.startedAt)}` : `exp:${event.id}:${String(event.deadlineAt)}`,
            data: { campaign_id: event.campaignId, campaign_name: event.campaignName, deadline_at: new Date(event.deadlineAt).toISOString() },
          });
          sent[kind] += 1;
        } catch (error) {
          // Transient: try again at the next run. Refused (contact erased, app paused): drop it.
          if (!(error instanceof AmableApiError) || error.status >= 500 || error.status === 429) {
            console.warn('[timely] event deferred', kind, event.id, error instanceof Error ? error.message : error);
            return;
          }
        }
      }
      await markAnnounced(env.DB, kind, event);
    };
    await mapLimited(started, 5, (event) => fire('started', event));
    await mapLimited(expired, 5, (event) => fire('expired', event));
    await env.DB.prepare('DELETE FROM action_runs WHERE created_at < ?').bind(at - ACTION_TTL_MS).run();
    return sent;
  }

  return {
    announce,
    async scheduled(env: Env): Promise<void> {
      await announce(env);
    },
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const baseUrl = baseOf(env, request);
      const path = appPath(url, baseUrl) ?? '';
      const isPublic = /^\/(i|r|w)\//.test(path) || path === '/preview.gif';
      if (!isPublic) {
        await ensureSchema(env.DB);
        return (await handlerFor(env, baseUrl)).fetch(request);
      }
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405, 'GET only');
      if (limited(request, now())) return json({ error: 'rate_limited' }, 429, { ...CORS, 'retry-after': '60' });
      try {
        await ensureSchema(env.DB);
        let m: RegExpMatchArray | null;
        if ((m = path.match(new RegExp(`^/i/(${PUBLIC_ID})/c/([^/]{1,200})\\.gif$`))) !== null) {
          return await emailTimer(env, m[1]!, decodeURIComponent(m[2]!));
        }
        if ((m = path.match(new RegExp(`^/i/(${PUBLIC_ID})\\.gif$`))) !== null) return await emailTimer(env, m[1]!, null);
        if ((m = path.match(new RegExp(`^/r/(${PUBLIC_ID})$`))) !== null) return await emailLink(env, url, m[1]!);
        if ((m = path.match(new RegExp(`^/w/(${PUBLIC_ID})/state$`))) !== null) return await widgetState(env, url, m[1]!);
        if (path === '/preview.gif') {
          const style = decodeStyle(url.searchParams.get('style'));
          if (style === null) return failure(400, 'invalid style');
          const minutes = Math.min(525_600, Math.max(0, Number(url.searchParams.get('minutes') ?? 0) || 0));
          const still = url.searchParams.get('still') === 'true';
          return gifResponse(renderTimerGif(style, { remaining: minutes * 60, still }));
        }
        return failure(404, 'not_found');
      } catch (error) {
        console.error('[timely]', error);
        return failure(500, 'internal_error');
      }
    },
  };
}

function privacyContact(body: Record<string, unknown>): string | null {
  const data = (body['data'] ?? {}) as { contact_id?: unknown };
  const id = typeof data.contact_id === 'string' ? data.contact_id : typeof body['contact_id'] === 'string' ? body['contact_id'] : null;
  return id !== null && CONTACT_ID.test(id) ? id : null;
}

function changeOf(value: unknown): Change | null {
  const raw = (value ?? {}) as { kind?: unknown; minutes?: unknown; deadline_at?: unknown };
  switch (raw.kind) {
    case 'reset':
    case 'restart':
      return { kind: raw.kind };
    case 'extend':
      return typeof raw.minutes === 'number' && Number.isInteger(raw.minutes) && Math.abs(raw.minutes) <= 525_600 && raw.minutes !== 0
        ? { kind: 'extend', minutes: raw.minutes }
        : null;
    case 'set': {
      const at = typeof raw.deadline_at === 'number' ? raw.deadline_at : typeof raw.deadline_at === 'string' ? Date.parse(raw.deadline_at) : Number.NaN;
      return Number.isFinite(at) ? { kind: 'set', deadlineAt: at } : null;
    }
    default:
      return null;
  }
}

export interface Settings {
  readonly label_locale: 'it' | 'en';
  readonly preset: TimerStyle['preset'];
  readonly duration_hours: number;
}

function settingsOf(value: unknown): Settings {
  const raw = (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const style = normalizeStyle({ preset: raw['preset'], label_locale: raw['label_locale'] });
  const hours = typeof raw['duration_hours'] === 'number' && Number.isInteger(raw['duration_hours']) ? raw['duration_hours'] : 72;
  return { label_locale: style.label_locale, preset: style.preset, duration_hours: Math.min(8760, Math.max(1, hours)) };
}

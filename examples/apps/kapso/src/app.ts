import {
  AmableApiError,
  appBaseUrl,
  appKeysLoader,
  appPath,
  createAppHandler,
  d1InstallStore,
  d1KeyValue,
  type AppContext,
  type ExpiringKeyValue,
  type SqlDatabase,
} from '@amable/app-sdk';
import manifest from '../manifest.json';
import { assets } from './assets';
import {
  kapsoClient,
  KapsoError,
  waNumber,
  type Fetch,
  type KapsoClient,
  type MetaTemplate,
  type PhoneNumber,
} from './kapso';
import { resultPage, settingsPage, templatesPage } from './pages';
import {
  createRequest,
  parseParams,
  sendable,
  templateMessage,
  toCrmTemplate,
  type TemplateDraft,
} from './templates';
import { contactNameOf, eventsOf, messageOf, sentAt, verifyKapsoSignature } from './webhook';

/**
 * Kapso for AmableData: a WhatsApp number of the workspace, connected through
 * Kapso, becomes the `whatsapp` channel of the shared inbox. Messages come in
 * through a signed Kapso webhook; replies, approved templates (to reopen the
 * 24-hour window) and the "Send WhatsApp template" automation block go out
 * through Kapso's WhatsApp API. The templates page submits new templates to
 * Meta for review.
 *
 * The Kapso API key and the webhook secret live encrypted in the app data of
 * the installation; this Worker keeps only short-lived setup and idempotency
 * records and, for each contact it talked to, the contact's WhatsApp number
 * (exported and erased with the contact).
 *
 * It runs in the workspace's own Cloudflare account, deployed by the CRM: its
 * D1 database keeps the installs, those records and the signing keys.
 */

export type Store = ExpiringKeyValue;

export interface Env {
  DB: SqlDatabase;
  /** URL of this Worker, set by the CRM when it deploys the app. */
  APP_BASE_URL?: string;
  /** Signing keys, only for a copy hosted elsewhere; normally created in DB. */
  APP_KEYS?: string;
}

const keysOf = appKeysLoader({ kid: 'kapso-1' });

const CHANNEL = 'whatsapp';
const API_KEY = 'kapso_api_key';
const WEBHOOK_SECRET = 'kapso_webhook_secret';
const NUMBER = 'kapso_number';
const CONFIG_TTL_MS = 60_000;
const TEMPLATES_TTL_MS = 60_000;
const SETUP_TTL_S = 24 * 3600;
const IDEMPOTENCY_TTL_S = 3 * 24 * 3600;

interface ConnectedNumber extends PhoneNumber {
  readonly webhook_id: string | null;
}

interface Config {
  readonly apiKey: string | null;
  readonly secret: string | null;
  readonly number: ConnectedNumber | null;
}

/** Per-isolate caches, so a webhook burst does not read the CRM each time. */
const configCache = new Map<string, { config: Config; until: number }>();
const templateCache = new Map<string, { templates: MetaTemplate[]; until: number }>();

const json = (value: unknown, status = 200) => Response.json(value, { status });
const failure = (status: number, error: string) => json({ error }, status);

async function readData(ctx: AppContext, key: string): Promise<unknown> {
  try {
    return (await ctx.api.data.get(key))['value'] ?? null;
  } catch (error) {
    if (error instanceof AmableApiError && error.status === 404) return null;
    throw error;
  }
}

async function configOf(ctx: AppContext): Promise<Config> {
  const cached = configCache.get(ctx.install.id);
  if (cached !== undefined && cached.until > Date.now()) return cached.config;
  const [apiKey, secret, number] = await Promise.all([
    readData(ctx, API_KEY),
    readData(ctx, WEBHOOK_SECRET),
    readData(ctx, NUMBER),
  ]);
  const config: Config = {
    apiKey: typeof apiKey === 'string' ? apiKey : null,
    secret: typeof secret === 'string' ? secret : null,
    number: number !== null && typeof number === 'object' ? (number as ConnectedNumber) : null,
  };
  configCache.set(ctx.install.id, { config, until: Date.now() + CONFIG_TTL_MS });
  return config;
}

function forget(installId: string): void {
  configCache.delete(installId);
  templateCache.delete(installId);
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const contactKey = (installId: string, contactId: string) => `wa:${installId}:c:${contactId}`;
const phoneKey = (installId: string, digits: string) => `wa:${installId}:p:${digits}`;

async function remember(
  store: Store,
  installId: string,
  contactId: string | null,
  digits: string,
): Promise<void> {
  if (contactId === null) return;
  await store.put(contactKey(installId, contactId), digits);
  await store.put(phoneKey(installId, digits), contactId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : 'unexpected error';
}

/** CRM failures worth a retry from Kapso (the webhook answers 500). */
function retryable(error: unknown): boolean {
  return !(error instanceof AmableApiError) || error.status >= 500 || error.status === 429;
}

export function createWorker(deps: { fetch?: Fetch } = {}) {
  const outbound: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));

  async function templatesOf(
    ctx: AppContext,
    client: KapsoClient,
    number: ConnectedNumber,
    fresh = false,
  ): Promise<MetaTemplate[]> {
    if (number.kind === 'sandbox' || number.business_account_id === null) return [];
    const cached = templateCache.get(ctx.install.id);
    if (!fresh && cached !== undefined && cached.until > Date.now()) return cached.templates;
    const templates = await client.templates(number.business_account_id);
    templateCache.set(ctx.install.id, { templates, until: Date.now() + TEMPLATES_TTL_MS });
    return templates;
  }

  async function templateById(
    ctx: AppContext,
    client: KapsoClient,
    number: ConnectedNumber,
    id: string,
  ): Promise<MetaTemplate | null> {
    const listed = (await templatesOf(ctx, client, number)).find((t) => t.id === id);
    if (listed !== undefined || number.business_account_id === null) return listed ?? null;
    try {
      return await client.template(number.business_account_id, id);
    } catch (error) {
      if (error instanceof KapsoError && error.status === 404) return null;
      throw error;
    }
  }

  /** Points a Kapso webhook with a fresh secret at this install, replacing the previous number's. */
  async function connectNumber(
    ctx: AppContext,
    client: KapsoClient,
    number: PhoneNumber,
    baseUrl: string,
  ): Promise<ConnectedNumber> {
    const previous = (await configOf(ctx)).number;
    if (previous?.webhook_id != null)
      await client
        .deleteWebhook(previous.phone_number_id, previous.webhook_id)
        .catch(() => undefined);
    const secret = randomHex(32);
    const webhookId = await client.createWebhook(
      number.phone_number_id,
      `${baseUrl}/inbound/${ctx.install.id}`,
      secret,
    );
    const connected: ConnectedNumber = { ...number, webhook_id: webhookId };
    await ctx.api.data.set(WEBHOOK_SECRET, secret, { secret: true });
    await ctx.api.data.set(NUMBER, connected);
    forget(ctx.install.id);
    return connected;
  }

  async function disconnect(ctx: AppContext, config: Config): Promise<void> {
    if (config.apiKey !== null && config.number?.webhook_id != null) {
      await kapsoClient(config.apiKey, outbound)
        .deleteWebhook(config.number.phone_number_id, config.number.webhook_id)
        .catch(() => undefined);
    }
    await ctx.api.data.delete(NUMBER).catch(() => null);
    await ctx.api.data.delete(WEBHOOK_SECRET).catch(() => null);
    forget(ctx.install.id);
  }

  async function settingsState(ctx: AppContext): Promise<Record<string, unknown>> {
    const config = await configOf(ctx);
    if (config.apiKey === null) return { configured: false, number: null };
    let numbers: PhoneNumber[] | null = null;
    let error: string | null = null;
    try {
      numbers = await kapsoClient(config.apiKey, outbound).phoneNumbers();
    } catch (e) {
      error = errorMessage(e);
    }
    return {
      configured: true,
      last4: config.apiKey.slice(-4),
      number: config.number,
      numbers,
      error,
    };
  }

  /** Sends one approved template to a WhatsApp number. */
  async function sendTemplate(
    ctx: AppContext,
    templateId: string,
    params: Record<string, string>,
    to: string,
  ): Promise<
    | { ok: true; id: string; text: string; template: MetaTemplate }
    | { ok: false; status: number; error: string }
  > {
    const config = await configOf(ctx);
    if (config.apiKey === null || config.number === null)
      return {
        ok: false,
        status: 422,
        error: 'WhatsApp is not connected: open the Kapso app settings',
      };
    const client = kapsoClient(config.apiKey, outbound);
    const template = await templateById(ctx, client, config.number, templateId);
    if (template === null || !sendable(template))
      return {
        ok: false,
        status: 422,
        error: 'this template is not approved (or no longer exists)',
      };
    const built = templateMessage(template, params);
    if (!built.ok)
      return {
        ok: false,
        status: 422,
        error: `missing template parameters: ${built.missing.join(', ')}`,
      };
    const sent = await client.send(config.number.phone_number_id, {
      to,
      type: 'template',
      template: built.template,
    });
    return { ok: true, id: sent.id, text: built.text, template };
  }

  async function handleWebhook(
    request: Request,
    store: Store,
    installId: string,
    contextFor: (id: string) => Promise<AppContext | null>,
  ): Promise<Response> {
    const raw = await request.text();
    const ctx = await contextFor(installId);
    if (ctx === null) return failure(404, 'unknown installation');
    const config = await configOf(ctx);
    if (
      config.secret === null ||
      !(await verifyKapsoSignature(config.secret, raw, request.headers.get('x-webhook-signature')))
    ) {
      return failure(401, 'invalid signature');
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return failure(400, 'invalid JSON');
    }
    for (const { event, payload } of eventsOf(request.headers.get('x-webhook-event'), body)) {
      if (
        config.number !== null &&
        payload['phone_number_id'] !== undefined &&
        String(payload['phone_number_id']) !== config.number.phone_number_id
      )
        continue;
      try {
        await handleEvent(ctx, store, event, payload);
      } catch (error) {
        if (retryable(error)) {
          console.error('[kapso] webhook', event, error);
          return failure(500, 'try again');
        }
        console.warn('[kapso] webhook skipped', event, errorMessage(error));
      }
    }
    return json({ ok: true });
  }

  async function handleEvent(
    ctx: AppContext,
    store: Store,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (event === 'whatsapp.contact.marketing_preference_changed') {
      const contact = (payload['contact'] ?? {}) as Record<string, unknown>;
      const preference = (payload['marketing_preference'] ?? {}) as Record<string, unknown>;
      const digits = typeof contact['wa_id'] === 'string' ? waNumber(contact['wa_id']) : null;
      const contactId = digits === null ? null : await store.get(phoneKey(ctx.install.id, digits));
      const key =
        preference['status'] === 'stopped'
          ? 'marketing_opted_out'
          : preference['status'] === 'resumed'
            ? 'marketing_opted_in'
            : null;
      if (contactId === null || key === null) return;
      await ctx.api.events.fire({
        key,
        contact_id: contactId,
        event_id: `pref:${String(preference['sequence'] ?? preference['occurred_at'] ?? Date.now())}:${digits!}`,
        data: { detail: typeof preference['detail'] === 'string' ? preference['detail'] : null },
      });
      return;
    }
    const message = messageOf(payload);
    if (message === null) return;
    if (event === 'whatsapp.message.received') {
      const digits = message.from === null ? null : waNumber(message.from);
      if (digits === null) return;
      const result = await ctx.api.messages.inbound({
        channel: CHANNEL,
        external_id: message.id,
        from: `+${digits}`,
        text: message.text,
        contact: contactNameOf(payload),
        ...(sentAt(message.timestamp) === undefined ? {} : { sent_at: sentAt(message.timestamp)! }),
      });
      await remember(store, ctx.install.id, result.contact_id, digits);
      if (!result.duplicate && result.contact_id !== null) {
        await ctx.api.events.fire({
          key: 'message_received',
          contact_id: result.contact_id,
          event_id: message.id,
          data: { text: message.text.slice(0, 500), type: message.type },
        });
      }
      return;
    }
    const status = event.replace('whatsapp.message.', '');
    if (!['sent', 'delivered', 'read', 'failed'].includes(status)) return;
    const delivery = status as 'sent' | 'delivered' | 'read' | 'failed';
    const digits = message.to === null ? null : waNumber(message.to);
    // Sent from the WhatsApp Business app on the team's phone (coexistence): show it in the thread.
    if (message.origin === 'business_app' && message.direction === 'outbound' && digits !== null) {
      const recorded = await ctx.api.messages.outbound({
        channel: CHANNEL,
        external_id: message.id,
        to: `+${digits}`,
        text: message.text,
        status: delivery,
        ...(sentAt(message.timestamp) === undefined ? {} : { sent_at: sentAt(message.timestamp)! }),
      });
      await remember(store, ctx.install.id, recorded.contact_id, digits);
      if (!recorded.duplicate) return;
    }
    try {
      await ctx.api.messages.status({
        channel: CHANNEL,
        external_id: message.id,
        status: delivery,
        ...(delivery === 'failed' && message.error !== null ? { error: message.error } : {}),
      });
    } catch (error) {
      // Messages sent outside the CRM (Kapso's own inbox, workflows) are not in its threads.
      if (!(error instanceof AmableApiError && error.status === 404)) throw error;
    }
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const baseUrl = appBaseUrl(manifest.base_url, env.APP_BASE_URL, request);
      const store = d1KeyValue(env.DB);
      const app = createAppHandler({
        appId: manifest.id,
        baseUrl,
        keys: await keysOf(env),
        store: d1InstallStore(env.DB),
        manifest,
        assets,
        fetch: outbound,
        async onEvent(event, ctx) {
          if (event['type'] !== 'app.uninstalled') return;
          const cached = configCache.get(ctx.install.id)?.config;
          if (cached !== undefined && cached.apiKey !== null && cached.number?.webhook_id != null) {
            await kapsoClient(cached.apiKey, outbound)
              .deleteWebhook(cached.number.phone_number_id, cached.number.webhook_id)
              .catch(() => undefined);
          }
          forget(ctx.install.id);
        },
        calls: {
          '/channels/send': async (body, ctx) => {
            if (body['test'] === true) return { ok: true, test: true };
            const message = (body['message'] ?? {}) as {
              text?: unknown;
              template?: { id?: unknown; params?: unknown };
            };
            const to = typeof body['to'] === 'string' ? waNumber(body['to']) : null;
            if (to === null) return failure(422, 'this contact has no valid WhatsApp number');
            try {
              if (message.template !== undefined && typeof message.template.id === 'string') {
                const sent = await sendTemplate(
                  ctx,
                  message.template.id,
                  parseParams(message.template.params),
                  to,
                );
                if (!sent.ok) return failure(sent.status, sent.error);
                return { external_id: sent.id, status: 'sent', text: sent.text };
              }
              const config = await configOf(ctx);
              if (config.apiKey === null || config.number === null)
                return failure(422, 'WhatsApp is not connected: open the Kapso app settings');
              const text = typeof message.text === 'string' ? message.text : '';
              if (text.trim() === '') return failure(422, 'empty message');
              const sent = await kapsoClient(config.apiKey, outbound).send(
                config.number.phone_number_id,
                { to, type: 'text', text: { body: text, preview_url: false } },
              );
              return { external_id: sent.id, status: 'sent' };
            } catch (error) {
              if (error instanceof KapsoError)
                return failure(error.transient ? 502 : 422, error.message);
              throw error;
            }
          },
          '/channels/templates': async (_body, ctx) => {
            const config = await configOf(ctx);
            if (config.apiKey === null || config.number === null) return { templates: [] };
            try {
              const templates = await templatesOf(
                ctx,
                kapsoClient(config.apiKey, outbound),
                config.number,
              );
              return { templates: templates.filter(sendable).map(toCrmTemplate).slice(0, 500) };
            } catch (error) {
              if (error instanceof KapsoError) return failure(502, error.message);
              throw error;
            }
          },
          '/options/templates': async (_body, ctx) => {
            const config = await configOf(ctx);
            if (config.apiKey === null || config.number === null) return { options: [] };
            try {
              const templates = await templatesOf(
                ctx,
                kapsoClient(config.apiKey, outbound),
                config.number,
              );
              return {
                options: templates
                  .filter(sendable)
                  .map(toCrmTemplate)
                  .map((t) => ({
                    value: t.id,
                    label: `${t.name} (${t.language ?? '?'})`.slice(0, 200),
                    description: [
                      t.category?.toLowerCase(),
                      t.params.length === 0
                        ? null
                        : `params: ${t.params.map((p) => p.key).join(', ')}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                      .slice(0, 500),
                  })),
              };
            } catch (error) {
              if (error instanceof KapsoError) return failure(502, error.message);
              throw error;
            }
          },
          '/actions/send-template': async (body, ctx) => {
            if (body['test'] === true) return { ok: true, test: true };
            const input = (body['input'] ?? {}) as { template?: unknown; params?: unknown };
            const contact = (body['contact'] ?? null) as { phone?: unknown } | null;
            const contactId = typeof body['contact_id'] === 'string' ? body['contact_id'] : null;
            const to = typeof contact?.phone === 'string' ? waNumber(contact.phone) : null;
            if (typeof input.template !== 'string' || input.template === '')
              return failure(422, 'choose a template');
            if (to === null) return failure(422, 'the contact has no valid phone number');
            const idempotency =
              typeof body['idempotency_key'] === 'string'
                ? `act:${ctx.install.id}:${body['idempotency_key']}`
                : null;
            const done = idempotency === null ? null : await store.get(idempotency);
            if (done !== null) return { output: JSON.parse(done) as Record<string, unknown> };
            const params = parseParams(input.params);
            let sent: Awaited<ReturnType<typeof sendTemplate>>;
            try {
              sent = await sendTemplate(ctx, input.template, params, to);
            } catch (error) {
              if (error instanceof KapsoError)
                return failure(error.transient ? 502 : 422, error.message);
              throw error;
            }
            if (!sent.ok) return failure(sent.status, sent.error);
            const output = {
              message_id: sent.id,
              template: sent.template.name,
              language: sent.template.language,
            };
            if (idempotency !== null)
              await store.put(idempotency, JSON.stringify(output), {
                expirationTtl: IDEMPOTENCY_TTL_S,
              });
            const recorded = await ctx.api.messages
              .outbound({
                channel: CHANNEL,
                external_id: sent.id,
                to: `+${to}`,
                text: sent.text,
                template: { id: sent.template.id, params },
              })
              .catch((error: unknown) => {
                console.warn('[kapso] sent but not recorded in the thread', errorMessage(error));
                return null;
              });
            await remember(store, ctx.install.id, recorded?.contact_id ?? contactId, to);
            return { output };
          },
          '/privacy/erasure': async (body, ctx) => {
            const contactId = String(
              (body['data'] as { contact_id?: unknown } | undefined)?.contact_id ?? '',
            );
            const digits =
              contactId === ''
                ? null
                : await store.get(contactKey(ctx.install.id, contactId));
            if (digits === null) return { ok: true };
            const config = await configOf(ctx).catch(() => null);
            if (config?.apiKey != null)
              await kapsoClient(config.apiKey, outbound).eraseContact(`+${digits}`);
            await store.delete(contactKey(ctx.install.id, contactId));
            await store.delete(phoneKey(ctx.install.id, digits));
            return { ok: true };
          },
          '/privacy/data': async (body, ctx) => {
            const contactId = String(
              (body['data'] as { contact_id?: unknown } | undefined)?.contact_id ?? '',
            );
            const digits =
              contactId === ''
                ? null
                : await store.get(contactKey(ctx.install.id, contactId));
            return { data: digits === null ? null : { whatsapp_number: `+${digits}` } };
          },
        },
        screens: {
          '/ui/settings': () => settingsPage(baseUrl),
          '/ui/templates': () => templatesPage(baseUrl),
        },
        screenApi: {
          '/api/settings': async (req, _session, ctx) => {
            if (req.method !== 'POST') return json(await settingsState(ctx));
            const input = (await req.json().catch(() => ({}))) as { api_key?: unknown };
            const apiKey = typeof input.api_key === 'string' ? input.api_key.trim() : '';
            const config = await configOf(ctx);
            if (apiKey === '') {
              await disconnect(ctx, config);
              await ctx.api.data.delete(API_KEY).catch(() => null);
              forget(ctx.install.id);
              return json(await settingsState(ctx));
            }
            try {
              await kapsoClient(apiKey, outbound).phoneNumbers();
            } catch (error) {
              return failure(
                error instanceof KapsoError && error.status === 401 ? 422 : 502,
                errorMessage(error),
              );
            }
            await ctx.api.data.set(API_KEY, apiKey, { secret: true });
            forget(ctx.install.id);
            return json(await settingsState(ctx));
          },
          '/api/number': async (req, _session, ctx) => {
            if (req.method !== 'POST') return failure(405, 'POST only');
            const input = (await req.json().catch(() => ({}))) as { phone_number_id?: unknown };
            const config = await configOf(ctx);
            if (config.apiKey === null) return failure(422, 'save the Kapso API key first');
            if (input.phone_number_id === null) {
              await disconnect(ctx, config);
              return json(await settingsState(ctx));
            }
            if (typeof input.phone_number_id !== 'string')
              return failure(422, 'phone_number_id is required');
            const client = kapsoClient(config.apiKey, outbound);
            try {
              const number = await client.phoneNumber(input.phone_number_id);
              if (number === null) return failure(404, 'this number is not in the Kapso project');
              await connectNumber(ctx, client, number, baseUrl);
            } catch (error) {
              return failure(
                error instanceof KapsoError && !error.transient ? 422 : 502,
                errorMessage(error),
              );
            }
            return json(await settingsState(ctx));
          },
          '/api/connect': async (req, _session, ctx) => {
            if (req.method !== 'POST') return failure(405, 'POST only');
            const config = await configOf(ctx);
            if (config.apiKey === null) return failure(422, 'save the Kapso API key first');
            const client = kapsoClient(config.apiKey, outbound);
            const nonce = randomHex(16);
            try {
              const customerId = await client.customerFor(
                `amable-${ctx.install.tenant.id}`,
                `AmableData ${ctx.install.tenant.slug}`,
              );
              const link = await client.createSetupLink(customerId, {
                success: `${baseUrl}/setup/connected/${nonce}`,
                failure: `${baseUrl}/setup/failed/${nonce}`,
              });
              await store.put(`setup:${nonce}`, ctx.install.id, {
                expirationTtl: SETUP_TTL_S,
              });
              return json({ url: link.url });
            } catch (error) {
              return failure(
                error instanceof KapsoError && !error.transient ? 422 : 502,
                errorMessage(error),
              );
            }
          },
          '/api/templates': async (req, _session, ctx) => {
            const config = await configOf(ctx);
            if (config.apiKey === null || config.number === null)
              return json({ number: null, templates: [] });
            const client = kapsoClient(config.apiKey, outbound);
            const waba = config.number.business_account_id;
            const sandbox = config.number.kind === 'sandbox' || waba === null;
            try {
              if (req.method === 'POST') {
                if (sandbox)
                  return failure(
                    422,
                    'sandbox numbers cannot have templates: connect a production number',
                  );
                const built = createRequest((await req.json().catch(() => ({}))) as TemplateDraft);
                if (!built.ok) return failure(422, built.error);
                const created = await client.createTemplate(waba, built.request);
                templateCache.delete(ctx.install.id);
                return json(
                  { id: created.id, status: created.status, category: created.category },
                  201,
                );
              }
              if (req.method === 'DELETE') {
                const name = new URL(req.url).searchParams.get('name') ?? '';
                if (sandbox || !/^[a-z0-9_]{1,512}$/.test(name))
                  return failure(422, 'name is required');
                await client.deleteTemplate(waba, name);
                templateCache.delete(ctx.install.id);
                return json({ ok: true });
              }
              const templates = sandbox ? [] : await templatesOf(ctx, client, config.number, true);
              return json({
                number: config.number,
                sandbox,
                templates: templates.map((t) => ({
                  id: t.id,
                  name: t.name,
                  language: t.language,
                  category: t.category,
                  status: t.status,
                  rejected_reason: t.rejected_reason ?? null,
                  sendable: sendable(t),
                  text: toCrmTemplate(t).text,
                })),
              });
            } catch (error) {
              return failure(
                error instanceof KapsoError && !error.transient ? 422 : 502,
                errorMessage(error),
              );
            }
          },
        },
      });

      const url = new URL(request.url);
      const path = appPath(url, baseUrl) ?? '';
      const webhook = path.match(/^\/inbound\/([A-Za-z0-9_-]{1,64})$/);
      if (webhook !== null && request.method === 'POST')
        return handleWebhook(request, store, webhook[1]!, (id) => app.contextFor(id));
      const setup = path.match(/^\/setup\/(connected|failed)\/([0-9a-f]{32})$/);
      if (setup !== null && request.method === 'GET') {
        const [, outcome, nonce] = setup;
        const installId = await store.get(`setup:${nonce!}`);
        if (installId === null) return resultPage('expired');
        if (outcome === 'failed') return resultPage('failed', url.searchParams.get('error_code'));
        const ctx = await app.contextFor(installId);
        const config = ctx === null ? null : await configOf(ctx);
        const phoneNumberId = url.searchParams.get('phone_number_id');
        if (ctx === null || config?.apiKey == null || phoneNumberId === null)
          return resultPage('failed', 'missing_number');
        const client = kapsoClient(config.apiKey, outbound);
        try {
          const number = await client.phoneNumber(phoneNumberId);
          if (number === null) return resultPage('failed', 'unknown_number');
          const connected = await connectNumber(ctx, client, number, baseUrl);
          await store.delete(`setup:${nonce!}`);
          return resultPage(
            'connected',
            connected.display_phone_number ?? url.searchParams.get('display_phone_number'),
          );
        } catch (error) {
          console.error('[kapso] setup', error);
          return resultPage('failed', 'kapso_unavailable');
        }
      }
      return app.fetch(request);
    },
  };
}

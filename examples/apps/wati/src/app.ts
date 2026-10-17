import { AmableApiError, createAppHandler, kvInstallStore, type AppContext, type KeyValue, type PrivateJwk } from '@amable/app-sdk';
import manifest from '../manifest.json';
import { settingsPage } from './page';
import {
  checkConfig,
  normalizeEndpoint,
  parseParameters,
  parseWebhook,
  sendSessionMessage,
  sendTemplateMessage,
  WatiError,
  type Fetch,
  type WatiConfig,
} from './wati';

/**
 * WATI for AmableData: WhatsApp as a channel of the shared inbox (incoming
 * messages, replies, delivery updates), a "send WhatsApp template" automation
 * step and a "WhatsApp received" trigger. The workspace's WATI credentials
 * live encrypted in the installation's app data; WATI calls this Worker on a
 * per-install webhook URL with a random token.
 */

export interface Env {
  APP_KEYS: string;
  INSTALLS: KeyValue;
}

const CONFIG_KEY = 'wati';
const CHANNEL = 'whatsapp';
const TRIGGER = 'message_received';
const CONFIG_TTL_MS = 5 * 60_000;
const WEBHOOK_RE = /^\/wati\/webhook\/(ai_[A-Za-z0-9_-]{1,64})\/([a-f0-9]{64})$/;

const configCache = new Map<string, { config: WatiConfig | null; until: number }>();

async function configOf(ctx: AppContext): Promise<WatiConfig | null> {
  const cached = configCache.get(ctx.install.id);
  if (cached !== undefined && cached.until > Date.now()) return cached.config;
  const entry = await ctx.api.data.get(CONFIG_KEY).catch(() => null);
  const value = (entry?.['value'] ?? null) as { endpoint?: unknown; token?: unknown } | null;
  const config =
    value !== null && typeof value.endpoint === 'string' && typeof value.token === 'string' ? { endpoint: value.endpoint, token: value.token } : null;
  configCache.set(ctx.install.id, { config, until: Date.now() + CONFIG_TTL_MS });
  return config;
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  const left = new Uint8Array(x!);
  const right = new Uint8Array(y!);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

async function webhookToken(kv: KeyValue, installId: string): Promise<string> {
  const existing = await kv.get(`hook:${installId}`);
  if (existing !== null) return existing;
  const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  await kv.put(`hook:${installId}`, token);
  return token;
}

const failure = (error: string, status = 422) => Response.json({ error }, { status });

function watiFailure(error: unknown): Response {
  if (error instanceof WatiError) return failure(error.message, error.status >= 500 ? 502 : 422);
  return failure('WATI did not answer', 504);
}

export function createWorker(deps: { fetch?: Fetch } = {}) {
  const outbound = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const app = createAppHandler({
        appId: manifest.id,
        baseUrl: manifest.base_url,
        keys: JSON.parse(env.APP_KEYS) as PrivateJwk[],
        store: kvInstallStore(env.INSTALLS),
        manifest,
        fetch: outbound,
        async onEvent(event, ctx) {
          if (event['type'] === 'app.uninstalled') {
            configCache.delete(ctx.install.id);
            await env.INSTALLS.delete(`hook:${ctx.install.id}`);
          }
        },
        calls: {
          '/channels/send': async (body, ctx) => {
            if (body['test'] === true) return { ok: true };
            const config = await configOf(ctx);
            if (config === null) return failure('WATI is not configured: open the app settings');
            const message = (body['message'] ?? {}) as { text?: unknown };
            try {
              const id = await sendSessionMessage(config, String(body['to'] ?? ''), String(message.text ?? ''), outbound);
              return { external_id: id, status: 'sent' };
            } catch (error) {
              return watiFailure(error);
            }
          },
          '/actions/send-template': async (body, ctx) => {
            if (body['test'] === true) return { ok: true };
            const config = await configOf(ctx);
            if (config === null) return failure('WATI is not configured: open the app settings');
            const contact = (body['contact'] ?? null) as { phone?: unknown } | null;
            const phone = typeof contact?.phone === 'string' ? contact.phone : '';
            if (phone.replace(/\D/g, '').length < 6) return failure('the contact has no phone number');
            const input = (body['input'] ?? {}) as { template_name?: unknown; broadcast_name?: unknown; parameters?: unknown };
            const template = String(input.template_name ?? '').trim();
            if (template === '') return failure('template_name is required');
            try {
              const id = await sendTemplateMessage(
                config,
                phone,
                {
                  template,
                  broadcast: String(input.broadcast_name ?? '').trim() || `amable_${template}`,
                  parameters: parseParameters(String(input.parameters ?? '')),
                },
                outbound,
              );
              return { message_id: id };
            } catch (error) {
              return watiFailure(error);
            }
          },
          // Messages live in the CRM inbox and at WATI, not here: nothing to erase or export.
          '/privacy/erasure': async () => ({ ok: true }),
          '/privacy/data': async () => ({ data: null }),
        },
        screens: {
          '/ui/settings': () => settingsPage(),
        },
        screenApi: {
          '/api/settings': async (req, _session, ctx) => {
            const webhookUrl = `${manifest.base_url}/wati/webhook/${ctx.install.id}/${await webhookToken(env.INSTALLS, ctx.install.id)}`;
            if (req.method === 'POST') {
              const input = (await req.json().catch(() => ({}))) as { endpoint?: unknown; token?: unknown; remove?: unknown };
              if (input.remove === true) {
                await ctx.api.data.delete(CONFIG_KEY).catch(() => null);
                configCache.delete(ctx.install.id);
                return Response.json({ configured: false, webhook_url: webhookUrl });
              }
              const endpoint = normalizeEndpoint(String(input.endpoint ?? ''));
              const token = String(input.token ?? '').trim();
              if (endpoint === null) return Response.json({ error: 'invalid_endpoint' }, { status: 422 });
              if (token === '' || !(await checkConfig({ endpoint, token }, outbound))) return Response.json({ error: 'invalid_token' }, { status: 422 });
              await ctx.api.data.set(CONFIG_KEY, { endpoint, token }, { secret: true });
              configCache.set(ctx.install.id, { config: { endpoint, token }, until: Date.now() + CONFIG_TTL_MS });
              return Response.json({ configured: true, endpoint, webhook_url: webhookUrl });
            }
            const config = await configOf(ctx);
            return Response.json({ configured: config !== null, endpoint: config?.endpoint ?? null, webhook_url: webhookUrl });
          },
        },
      });

      const hook = request.method === 'POST' ? WEBHOOK_RE.exec(new URL(request.url).pathname) : null;
      if (hook !== null) return receiveWebhook(request, env, hook[1]!, hook[2]!, (id) => app.contextFor(id));
      return app.fetch(request);
    },
  };
}

/** WATI → inbox. 2xx tells WATI the event is handled; a 5xx makes it retry. */
async function receiveWebhook(
  request: Request,
  env: Env,
  installId: string,
  token: string,
  contextFor: (id: string) => Promise<AppContext | null>,
): Promise<Response> {
  const expected = await env.INSTALLS.get(`hook:${installId}`);
  if (expected === null || !(await sameSecret(expected, token))) return new Response('not found', { status: 404 });
  const ctx = await contextFor(installId);
  if (ctx === null) return new Response('not found', { status: 404 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body === null) return new Response('bad request', { status: 400 });
  const event = parseWebhook(body);
  try {
    if (event.kind === 'message') {
      const result = await ctx.api.messages.inbound({
        channel: CHANNEL,
        external_id: event.externalId,
        from: event.from,
        text: event.text,
        ...(event.senderName === null ? {} : { contact: { given_name: event.senderName } }),
        ...(event.sentAt === null ? {} : { sent_at: event.sentAt }),
      });
      if (!result.duplicate && result.contact_id !== null && ctx.install.scopes.includes('automations:trigger')) {
        await ctx.api.events.fire({ key: TRIGGER, contact_id: result.contact_id, event_id: event.externalId, data: { text: event.text.slice(0, 2000) } });
      }
    } else if (event.kind === 'status') {
      await ctx.api.messages
        .status({ channel: CHANNEL, external_id: event.externalId, status: event.status, ...(event.error === null ? {} : { error: event.error }) })
        .catch((error: unknown) => {
          // Template messages sent by automations are not in the inbox.
          if (!(error instanceof AmableApiError && error.status === 404)) throw error;
        });
    }
  } catch (error) {
    console.error('[wati] webhook', error);
    return new Response('retry', { status: 503 });
  }
  return Response.json({ ok: true });
}

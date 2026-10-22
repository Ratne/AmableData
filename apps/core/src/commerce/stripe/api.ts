import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  stripeCheckResultSchema,
  stripeSettingsSchema,
  updateStripeSettingsSchema,
  type StripeSettings,
} from '@amable/api-types';
import type { Context } from 'hono';
import { callCrm, crmRoute, json, jsonBody } from '../../crm/api/core';
import { CrmError } from '../../crm/errors';
import { audit, getTenant, type AppEnv } from '../../middleware';
import { stripeAccountAd, type StoredStripeAccount } from './account';
import { STRIPE_WEBHOOK_EVENTS, StripeApiError, StripeClient } from './client';
import { commerceRuntime, openStripe, secretHint, type CommerceRuntime } from './runtime';

type Ctx = Context<AppEnv>;

const tags = ['Commerce settings'];

function webhookUrl(c: Ctx): string {
  const edge = (c.env.EDGE_ORIGIN ?? 'http://localhost:8788').replace(/\/+$/, '');
  return `${edge}/c/${getTenant(c).tenant.slug}/stripe/webhook`;
}

function withUrl(c: Ctx, settings: Omit<StripeSettings, 'webhook_url'>): StripeSettings {
  return { ...settings, webhook_url: settings.configured ? webhookUrl(c) : null };
}

function reachableByStripe(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  return protocol === 'https:' && hostname !== 'localhost' && !hostname.endsWith('.localhost') && hostname !== '127.0.0.1';
}

/**
 * Creates the webhook endpoint in the Stripe account, replacing any endpoint
 * already pointing at the same URL: the signing secret is only returned on
 * creation, so an existing endpoint cannot be adopted.
 */
async function createWebhook(client: StripeClient, url: string, slug: string): Promise<{ id: string; secret: string; replaced: string[] }> {
  const replaced: string[] = [];
  for (const endpoint of await client.webhookEndpoints()) {
    if (endpoint.url !== url) continue;
    await client.deleteWebhookEndpoint(endpoint.id);
    replaced.push(endpoint.id);
  }
  const created = await client.createWebhookEndpoint({
    url,
    events: STRIPE_WEBHOOK_EVENTS,
    description: `Amable checkout (${slug})`,
  });
  if (created.secret === undefined) throw new Error('Stripe did not return the webhook signing secret');
  return { id: created.id, secret: created.secret, replaced };
}

/** Best effort: a key that was revoked or an endpoint removed by hand must not block the change. */
async function deleteManagedWebhook(runtime: CommerceRuntime, account: StoredStripeAccount): Promise<void> {
  if (account.webhook_endpoint_id === null) return;
  try {
    const stripe = await openStripe(runtime, account);
    await stripe.client.deleteWebhookEndpoint(account.webhook_endpoint_id);
  } catch {
    // The endpoint stays in the Stripe dashboard, where it can be removed by hand.
  }
}

/** Stripe account routes, relative to `/api/v2/t/{slug}`. Secrets never leave the worker in clear. */
export function registerStripeRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    crmRoute('settings:manage', {
      method: 'get',
      path: '/commerce/stripe',
      tags,
      summary: 'Stripe account of the workspace (key hints, webhook endpoint)',
      responses: { 200: json(stripeSettingsSchema, 'Stripe settings') },
    }),
    async (c) => c.json(withUrl(c, await callCrm(c, 'stripe.settings', {})), 200),
  );
  app.openapi(
    crmRoute(
      'settings:manage',
      {
        method: 'put',
        path: '/commerce/stripe',
        tags,
        summary: 'Connect Stripe with the workspace API keys (the secret key is checked against Stripe)',
        request: { body: jsonBody(updateStripeSettingsSchema) },
        responses: { 200: json(stripeSettingsSchema, 'Stripe settings') },
      },
      { stepUp: true },
    ),
    async (c) => {
      const body = c.req.valid('json');
      const tenantId = getTenant(c).tenant.id;
      const runtime = await commerceRuntime(c.env);
      const publicMode = body.publishable_key.includes('_live_') ? 'live' : 'test';
      let accountId: string | null = null;
      if (body.secret_key !== undefined) {
        const secretMode = body.secret_key.includes('_live_') ? 'live' : 'test';
        if (secretMode !== publicMode) {
          throw new CrmError('validation_failed', 'publishable and secret keys belong to different modes (test/live)', [
            { path: 'secret_key', message: 'test/live mismatch' },
          ]);
        }
        try {
          const client = new StripeClient(body.secret_key, runtime.fetch);
          await client.verify();
          accountId = await client.accountId();
        } catch (error) {
          const message = error instanceof StripeApiError ? error.message : 'Stripe is unreachable';
          throw new CrmError('validation_failed', message, [{ path: 'secret_key', message }]);
        }
      }
      const box = runtime.secretBox;
      const current = await callCrm(c, 'stripe.account', {});
      let webhook: { enc: string; hint: string; endpointId?: string | null } | null =
        body.webhook_secret === undefined
          ? null
          : {
              enc: await box.encrypt(body.webhook_secret, stripeAccountAd(tenantId, 'webhook')),
              hint: secretHint(body.webhook_secret),
              endpointId: null,
            };
      let webhookSetupError: string | null = null;
      const storedKeyFits = current !== null && current.publishable_key.includes('_live_') === (publicMode === 'live');
      const client =
        body.secret_key !== undefined
          ? new StripeClient(body.secret_key, runtime.fetch)
          : current !== null && storedKeyFits && current.webhook_enc === null
            ? (await openStripe(runtime, current)).client
            : null;
      if (webhook === null && client !== null) {
        const url = webhookUrl(c);
        if (!reachableByStripe(url)) {
          webhookSetupError = `Stripe cannot reach ${url}`;
        } else {
          try {
            const created = await createWebhook(client, url, getTenant(c).tenant.slug);
            webhook = {
              enc: await box.encrypt(created.secret, stripeAccountAd(tenantId, 'webhook')),
              hint: secretHint(created.secret),
              endpointId: created.id,
            };
            if (current !== null && current.webhook_endpoint_id !== null && !created.replaced.includes(current.webhook_endpoint_id)) {
              await deleteManagedWebhook(runtime, current);
            }
          } catch (error) {
            webhookSetupError = error instanceof Error ? error.message : 'webhook setup failed';
          }
        }
      }
      const settings = await callCrm(c, 'stripe.saveAccount', {
        tenantId,
        publishableKey: body.publishable_key,
        accountId,
        secret:
          body.secret_key === undefined
            ? null
            : { enc: await box.encrypt(body.secret_key, stripeAccountAd(tenantId, 'secret')), hint: secretHint(body.secret_key) },
        webhook,
      });
      await audit(c, 'commerce.stripe_connected', {
        details: {
          mode: publicMode,
          account_changed: settings.account_changed === true,
          webhook_managed: settings.webhook_managed,
        },
      });
      return c.json({ ...withUrl(c, settings), webhook_setup_error: webhookSetupError }, 200);
    },
  );
  app.openapi(
    crmRoute('settings:manage', {
      method: 'post',
      path: '/commerce/stripe/check',
      tags,
      summary: 'Check that the stored secret key is still accepted by Stripe',
      responses: { 200: json(stripeCheckResultSchema, 'Result') },
    }),
    async (c) => {
      const account = await callCrm(c, 'stripe.account', {});
      if (account === null) return c.json({ ok: false, message: 'Stripe is not connected' }, 200);
      try {
        const stripe = await openStripe(await commerceRuntime(c.env), account);
        await stripe.client.verify();
        return c.json({ ok: true, message: null }, 200);
      } catch (error) {
        return c.json({ ok: false, message: error instanceof Error ? error.message : 'Stripe check failed' }, 200);
      }
    },
  );
  app.openapi(
    crmRoute(
      'settings:manage',
      {
        method: 'delete',
        path: '/commerce/stripe',
        tags,
        summary: 'Disconnect Stripe (checkouts stop taking payments)',
        responses: { 200: json(stripeSettingsSchema, 'Stripe settings') },
      },
      { stepUp: true },
    ),
    async (c) => {
      const account = await callCrm(c, 'stripe.account', {});
      if (account !== null) await deleteManagedWebhook(await commerceRuntime(c.env), account);
      await callCrm(c, 'stripe.clearAccount', {});
      await audit(c, 'commerce.stripe_disconnected', {});
      return c.json(withUrl(c, await callCrm(c, 'stripe.settings', {})), 200);
    },
  );
}

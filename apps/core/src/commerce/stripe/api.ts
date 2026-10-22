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
import { stripeAccountAd } from './account';
import { StripeApiError, StripeClient } from './client';
import { commerceRuntime, openStripe, secretHint } from './runtime';

type Ctx = Context<AppEnv>;

const tags = ['Commerce settings'];

function webhookUrl(c: Ctx): string {
  const edge = (c.env.EDGE_ORIGIN ?? 'http://localhost:8788').replace(/\/+$/, '');
  return `${edge}/c/${getTenant(c).tenant.slug}/stripe/webhook`;
}

function withUrl(c: Ctx, settings: Omit<StripeSettings, 'webhook_url'>): StripeSettings {
  return { ...settings, webhook_url: settings.configured ? webhookUrl(c) : null };
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
      const settings = await callCrm(c, 'stripe.saveAccount', {
        tenantId,
        publishableKey: body.publishable_key,
        accountId,
        secret:
          body.secret_key === undefined
            ? null
            : { enc: await box.encrypt(body.secret_key, stripeAccountAd(tenantId, 'secret')), hint: secretHint(body.secret_key) },
        webhook:
          body.webhook_secret === undefined
            ? null
            : {
                enc: await box.encrypt(body.webhook_secret, stripeAccountAd(tenantId, 'webhook')),
                hint: secretHint(body.webhook_secret),
              },
      });
      await audit(c, 'commerce.stripe_connected', {
        details: { mode: publicMode, account_changed: settings.account_changed === true },
      });
      return c.json(withUrl(c, settings), 200);
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
      await callCrm(c, 'stripe.clearAccount', {});
      await audit(c, 'commerce.stripe_disconnected', {});
      return c.json(withUrl(c, await callCrm(c, 'stripe.settings', {})), 200);
    },
  );
}

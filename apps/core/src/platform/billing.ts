import type { OpenAPIHono } from '@hono/zod-openapi';
import { billingOverviewSchema, type BillingOverview } from '@amable/api-types';
import type { Context } from 'hono';
import { createCrmRouter, crmRoute, json } from '../crm/api/core';
import type { AppEnv } from '../middleware';
import { DEFAULT_CONTROL_PLANE_URL, platformLink } from './license';
import { loadQuotaSnapshot, localUsage, overageCost } from './quota';

export const MANAGED_PRICE_MONTHLY = 99;
const CURRENCY = 'USD';
const MICROS = 1_000_000;

function portalUrls(c: Context<AppEnv>): BillingOverview['portal'] {
  const link = platformLink(c.env);
  const url =
    link.mode === 'licensed'
      ? link.controlPlaneUrl
      : (c.env.CONTROL_PLANE_URL ?? DEFAULT_CONTROL_PLANE_URL).replace(/\/$/, '');
  return {
    url,
    billing_url: `${url}/billing`,
    wallet_url: `${url}/wallet`,
    connect_url: `${url}/signup`,
  };
}

async function billingOverview(c: Context<AppEnv>, nowMs: number): Promise<BillingOverview> {
  const portal = portalUrls(c);
  if (platformLink(c.env).mode !== 'licensed') {
    return {
      mode: 'open_source',
      linked: false,
      service_state: null,
      plan: null,
      email: null,
      wallet: null,
      snapshot: { status: 'missing', stale: false, issued_at: null },
      portal,
    };
  }
  const { snapshot, source } = await loadQuotaSnapshot(c.env, nowMs);
  if (snapshot === null) {
    return {
      mode: 'managed',
      linked: true,
      service_state: null,
      plan: { code: 'managed', price_monthly: MANAGED_PRICE_MONTHLY, currency: CURRENCY },
      email: null,
      wallet: null,
      snapshot: { status: 'missing', stale: true, issued_at: null },
      portal,
    };
  }
  const managed = snapshot.serviceState !== 'self_hosted';
  const usage = await localUsage(c.env.DB, snapshot, nowMs);
  const pendingOverage = overageCost(
    usage.unreported - snapshot.includedRemaining,
    snapshot.overagePer1000Micros,
  );
  const balanceMicros = snapshot.balanceMicros - pendingOverage;
  const stale = source === 'stale';
  return {
    mode: managed ? 'managed' : 'open_source',
    linked: true,
    service_state: snapshot.serviceState,
    plan: managed
      ? { code: 'managed', price_monthly: MANAGED_PRICE_MONTHLY, currency: CURRENCY }
      : null,
    email: managed
      ? {
          included_monthly: snapshot.includedMonthly,
          used_this_period: snapshot.usedThisPeriod + usage.unreported,
          remaining: Math.max(snapshot.includedRemaining - usage.unreported, 0),
          period_start: snapshot.periodStart,
          period_end: snapshot.periodEnd,
          overage_per_1000: snapshot.overagePer1000Micros / MICROS,
          currency: CURRENCY,
          caps: snapshot.caps,
        }
      : null,
    wallet: { balance: balanceMicros / MICROS, balance_micros: balanceMicros, currency: CURRENCY },
    snapshot: { status: stale ? 'stale' : 'fresh', stale, issued_at: snapshot.issuedAt },
    portal,
  };
}

function registerBillingRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    crmRoute('tenant:billing', {
      method: 'get',
      path: '/billing',
      tags: ['Billing'],
      summary: 'Plan, email quota and wallet',
      description:
        'Read-only view of the installation plan, included email quota and prepaid wallet, from the last quota snapshot of the platform (`snapshot.stale` when the platform is unreachable and the data may be out of date). Open source installations without a license answer `mode: open_source` with no quota. Payments, top-ups and invoices are managed in the portal (`portal.*`).',
      responses: { 200: json(billingOverviewSchema, 'Billing overview') },
    }),
    async (c) => c.json(await billingOverview(c, c.get('services').now()), 200),
  );
}

/** Settings > Billing & wallet, relative to `/api/v2/t/{slug}`. */
export const billingApi = createCrmRouter();
registerBillingRoutes(billingApi);

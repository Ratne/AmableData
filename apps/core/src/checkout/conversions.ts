import {
  facebookCapiConfigSchema,
  tiktokEventsConfigSchema,
  type ConnectionTestResult,
  type FacebookCapiConfig,
  type TiktokEventsConfig,
} from '@amable/api-types';
import { SYSTEM_ACTOR } from '../crm/context';
import { parseJson } from '../crm/util';
import type { Env } from '../env';
import {
  sendAdConversion,
  verifyAdCredentials,
  type ConversionPlatform,
  type ConversionTarget,
} from '../forms/connectors/ad-conversion';
import type { ConnectorResult } from '../forms/connectors/types';
import { decryptSecret } from '../forms/crypto';
import { MAX_DELIVERY_ATTEMPTS } from '../forms/process';
import { formsRuntime, tenantOp, type FormsRuntime } from '../forms/runtime';
import type { CheckoutConnectionRow, PaidCheckoutOrder } from './connections';

/**
 * Server-side Purchase conversions of paid checkout orders. `order.paid`
 * events of the outbox (every payment path: card, recorded bank transfer,
 * post-purchase offers) are queued here; each enabled connection of the
 * checkout gets the order once, `event_id` = order id.
 */

export interface CheckoutConversionMessage {
  readonly kind: 'checkout.conversions';
  readonly tenantId: string;
  readonly orderId: string;
}

export function isCheckoutConversionMessage(body: unknown): body is CheckoutConversionMessage {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return b['kind'] === 'checkout.conversions' && typeof b['tenantId'] === 'string' && typeof b['orderId'] === 'string';
}

const PLATFORM: Readonly<Record<CheckoutConnectionRow['type'], ConversionPlatform>> = {
  facebook_capi: 'meta',
  tiktok_events: 'tiktok',
};

type Resolved = { ok: true; target: ConversionTarget } | { ok: false; result: ConnectorResult };

const fail = (response: string): Resolved => ({
  ok: false,
  result: { status: 'failed', retryable: false, statusCode: null, request: null, response },
});

async function targetOf(runtime: FormsRuntime, tenantId: string, row: CheckoutConnectionRow): Promise<Resolved> {
  const platform = PLATFORM[row.type] as ConversionPlatform | undefined;
  if (platform === undefined) return fail(`unknown connection type ${row.type}`);
  const raw = parseJson<unknown>(row.config, {});
  const parsed = platform === 'meta' ? facebookCapiConfigSchema.safeParse(raw) : tiktokEventsConfigSchema.safeParse(raw);
  if (!parsed.success) return fail(`invalid configuration: ${parsed.error.issues[0]?.message ?? ''}`.trim());
  if (row.secret_ciphertext === null) return fail('access token missing');
  let token: string;
  try {
    token = await decryptSecret(runtime.secretBox, tenantId, row.id, row.secret_ciphertext);
  } catch {
    return fail('secret could not be decrypted');
  }
  return {
    ok: true,
    target: {
      platform,
      token,
      config: parsed.data as FacebookCapiConfig | TiktokEventsConfig,
      fetch: (input, init) => runtime.fetch(input, init),
      now: () => runtime.now(),
    },
  };
}

function sendOrder(target: ConversionTarget, paid: PaidCheckoutOrder): Promise<ConnectorResult> {
  const meta = paid.adMeta;
  return sendAdConversion(target, {
    platform: target.platform,
    eventId: paid.order.id,
    eventName: target.config.event_name,
    eventTime: paid.order.paidAt,
    email: paid.email,
    phone: paid.phone,
    clickIds: { ...paid.tracking, fbp: meta?.fbp ?? '', fbc: meta?.fbc ?? '', ttp: meta?.ttp ?? '' },
    ip: meta?.ip ? meta.ip : null,
    userAgent: meta?.user_agent ? meta.user_agent : null,
    pageUrl: paid.pageUrl,
    externalId: paid.order.id,
    valueMinor: paid.order.totalMinor,
    currency: paid.order.currency,
    orderId: paid.order.number,
  });
}

export async function processCheckoutConversions(
  env: Env,
  tenantId: string,
  orderId: string,
  options: { attempt: number; final: boolean; runtime?: FormsRuntime },
): Promise<{ retry: boolean }> {
  const paid = await tenantOp(env, tenantId, SYSTEM_ACTOR, 'checkoutConnections.paidOrder', { orderId });
  if (paid === null) return { retry: false };
  const runtime = options.runtime ?? (await formsRuntime(env));
  let retry = false;
  for (const connection of paid.pending) {
    const attempt = (paid.attempts[connection.id] ?? 0) + 1;
    const resolved = await targetOf(runtime, tenantId, connection);
    let result: ConnectorResult;
    try {
      result = resolved.ok ? await sendOrder(resolved.target, paid) : resolved.result;
    } catch (error) {
      result = { status: 'failed', retryable: true, statusCode: null, request: null, response: `connector error: ${error instanceof Error ? error.message : String(error)}` };
    }
    const willRetry = result.status === 'failed' && result.retryable && !options.final && attempt < MAX_DELIVERY_ATTEMPTS;
    if (willRetry) retry = true;
    await tenantOp(env, tenantId, SYSTEM_ACTOR, 'checkoutConnections.recordDelivery', {
      orderId,
      connectionId: connection.id,
      status: willRetry ? 'retrying' : result.status,
      statusCode: result.statusCode,
      request: result.request,
      response: result.response,
    });
  }
  return { retry };
}

/**
 * "Test" of a checkout connection: with a test events code a sample Purchase
 * goes to the platform's Test Events tool; without it only the token and pixel
 * are checked (a real Purchase would be recorded otherwise).
 */
export async function testCheckoutConnection(input: {
  runtime: FormsRuntime;
  tenantId: string;
  connection: CheckoutConnectionRow;
}): Promise<ConnectionTestResult> {
  const resolved = await targetOf(input.runtime, input.tenantId, input.connection);
  let result: ConnectorResult;
  if (!resolved.ok) result = resolved.result;
  else if (resolved.target.config.test_event_code === '') result = await verifyAdCredentials(resolved.target);
  else {
    const now = input.runtime.now();
    result = await sendOrder(resolved.target, {
      order: { id: `test_${String(now)}`, number: 'TEST', totalMinor: 1000, currency: 'EUR', paidAt: now },
      email: 'test@example.com',
      phone: '+393330000000',
      tracking: {},
      adMeta: { fbp: '', fbc: '', ttp: '', ip: '203.0.113.1', user_agent: 'Mozilla/5.0 (test)' },
      pageUrl: 'https://example.com/checkout',
      pending: [],
      attempts: {},
    });
  }
  return { status: result.status, status_code: result.statusCode, request: result.request, response: result.response };
}

/**
 * Queues the conversions of newly paid orders (outbox fan-out). Without the
 * queue binding they are sent right away, single attempt.
 */
export async function enqueueCheckoutConversions(env: Env, tenantId: string, orderIds: readonly string[]): Promise<void> {
  if (orderIds.length === 0) return;
  const messages = orderIds.map((orderId): CheckoutConversionMessage => ({ kind: 'checkout.conversions', tenantId, orderId }));
  if (env.FORM_SUBMISSIONS !== undefined) {
    await env.FORM_SUBMISSIONS.sendBatch(messages.map((body) => ({ body })));
    return;
  }
  for (const message of messages) {
    await processCheckoutConversions(env, tenantId, message.orderId, { attempt: 1, final: true }).catch((error: unknown) =>
      console.error('[checkout] conversions failed', message.orderId, error),
    );
  }
}

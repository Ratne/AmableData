import { monotonicFactory } from 'ulid';
import { pauseInstall } from '../apps/lifecycle';
import { installById } from '../apps/store';
import { getAuthServices } from '../auth/services';
import type { Env } from '../env';
import { WebhookService, type WebhookDeps, type WebhookMessage } from './service';

export const WEBHOOKS_QUEUE = 'webhooks-out';

const nextId = monotonicFactory();

type Override = (base: WebhookDeps, env: Env) => WebhookDeps;
let override: Override | null = null;

/** Test hook (pass `null` to restore). */
export function overrideWebhookDeps(next: Override | null): void {
  override = next;
}

export function webhookDeps(env: Env): WebhookDeps {
  const base: WebhookDeps = {
    db: env.DB,
    box: async () => (await getAuthServices(env)).secretBox,
    enqueue: async (message, delaySeconds) => {
      await env.WEBHOOKS_OUT.send(
        message,
        delaySeconds === undefined ? undefined : { delaySeconds },
      );
    },
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    newId: () => nextId(),
    allowLoopback: env.ENVIRONMENT === 'dev' && env.WEBHOOKS_ALLOW_LOOPBACK === 'true',
    // An app that keeps failing its deliveries is paused and the admins are told.
    onAppEndpointDisabled: async (installId) => {
      const install = await installById(env.DB, installId);
      if (install !== null) await pauseInstall(env, install, 'webhook_endpoint_disabled', Date.now());
    },
  };
  return override === null ? base : override(base, env);
}

export function webhookService(env: Env): WebhookService {
  return new WebhookService(webhookDeps(env));
}

function isMessage(body: unknown): body is WebhookMessage {
  if (typeof body !== 'object' || body === null) return false;
  const kind = (body as { kind?: unknown }).kind;
  return kind === 'webhooks.fanout' || kind === 'webhooks.deliver';
}

/** Consumer of `webhooks-out`: fan-out of tenant events and single delivery attempts. */
export async function consumeWebhooks(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const service = webhookService(env);
  for (const message of batch.messages) {
    const body = message.body;
    if (!isMessage(body)) {
      message.ack();
      continue;
    }
    try {
      if (body.kind === 'webhooks.fanout') await service.fanout(body.tenantId, body.events);
      else await service.attempt(body.deliveryId);
      message.ack();
    } catch (error) {
      console.error('[webhooks] message failed', error);
      message.retry({ delaySeconds: 30 });
    }
  }
}

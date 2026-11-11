import { ulid } from 'ulid';
import type { RegistryMessage } from '@amable/app-edge/analytics';
import { registerTenant } from '../analytics/registry';
import { syncPorts } from '../analytics/runtime';
import type { Env } from '../env';

/**
 * Registry messages that exhausted their retries. The `registry-dlq` consumer
 * parks them in R2 (a queue keeps them 14 days only); a workspace admin
 * replays them from the operations page once the cause is fixed.
 */

const prefixOf = (tenantId: string) => `dlq/registry/${tenantId}/`;
/** Parked messages that cannot be read: kept aside for a look, never replayed. */
const poisonPrefixOf = (tenantId: string) => `dlq/registry-poison/${tenantId}/`;
const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Messages replayed per request (one registry pass of the workspace). */
const REPLAY_MAX = 500;

export async function parkRegistryDeadLetters(
  batch: MessageBatch<RegistryMessage>,
  env: Pick<Env, 'FILES'>,
): Promise<void> {
  for (const m of batch.messages) {
    if (
      m.body?.v !== 1 ||
      typeof m.body.tenantId !== 'string' ||
      !TENANT_ID_RE.test(m.body.tenantId)
    ) {
      m.ack();
      continue;
    }
    try {
      await env.FILES.put(`${prefixOf(m.body.tenantId)}${ulid()}.json`, JSON.stringify(m.body));
      m.ack();
    } catch {
      // R2 unavailable: the message stays in the dead letter queue.
      m.retry({ delaySeconds: 60 });
    }
  }
}

export async function parkedRegistry(
  env: Pick<Env, 'FILES'>,
  tenantId: string,
): Promise<{ parked: number; truncated: boolean; oldest_at: number | null }> {
  const page = await env.FILES.list({ prefix: prefixOf(tenantId), limit: 1000 });
  return {
    parked: page.objects.length,
    truncated: page.truncated,
    // Keys are ULIDs: the first one listed is the oldest.
    oldest_at: page.objects[0]?.uploaded.getTime() ?? null,
  };
}

export async function replayParkedRegistry(
  env: Env,
  tenantId: string,
): Promise<{ replayed: number; failed: number; remaining: boolean }> {
  const ns = env.ANALYTICS;
  if (ns === undefined) throw new Error('registry replay: no ANALYTICS binding');
  const page = await env.FILES.list({ prefix: prefixOf(tenantId), limit: REPLAY_MAX });
  const parked: { key: string; body: RegistryMessage }[] = [];
  for (const o of page.objects) {
    const object = await env.FILES.get(o.key);
    if (object === null) continue;
    const text = await object.text();
    let body: RegistryMessage | null = null;
    try {
      body = JSON.parse(text) as RegistryMessage;
    } catch {
      body = null;
    }
    if (body === null || body.v !== 1 || body.tenantId !== tenantId) {
      await env.FILES.put(poisonPrefixOf(tenantId) + o.key.slice(prefixOf(tenantId).length), text);
      await env.FILES.delete(o.key);
      continue;
    }
    parked.push({ key: o.key, body });
  }
  const ports = syncPorts(env, ns, tenantId);
  const done: string[] = [];
  let failed = 0;
  try {
    if (parked.length > 0)
      await registerTenant(
        ports,
        tenantId,
        parked.map((p) => p.body),
      );
    done.push(...parked.map((p) => p.key));
  } catch {
    // One by one: a message that still fails stays parked, the others go through.
    for (const p of parked) {
      try {
        await registerTenant(ports, tenantId, [p.body]);
        done.push(p.key);
      } catch (error) {
        failed += 1;
        console.error('registry replay failed', p.key, error);
      }
    }
  }
  if (done.length > 0) await env.FILES.delete(done);
  return { replayed: done.length, failed, remaining: page.truncated };
}

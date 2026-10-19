import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }));

const { default: worker } = await import('../src/index');

function batchOf(queue: string) {
  const acked: string[] = [];
  let ackedAll = false;
  const batch = {
    queue,
    messages: [{ id: 'm1', timestamp: new Date(), attempts: 1, body: { not: 'a job' }, ack: () => acked.push('m1'), retry: () => undefined }],
    ackAll: () => {
      ackedAll = true;
    },
    retryAll: () => undefined,
  } as unknown as MessageBatch<unknown>;
  return { batch, acked, ackedAll: () => ackedAll };
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

describe('queue dispatch', () => {
  it.each(['esign-seal', 'amable-esign-seal'])('routes %s to its consumer', async (name) => {
    const { batch, acked, ackedAll } = batchOf(name);
    await worker.queue(batch, {} as Env, ctx);
    expect(acked).toEqual(['m1']);
    expect(ackedAll()).toBe(false);
  });

  it('acknowledges queues it does not know', async () => {
    const { batch, acked, ackedAll } = batchOf('amable-unknown');
    await worker.queue(batch, {} as Env, ctx);
    expect(acked).toEqual([]);
    expect(ackedAll()).toBe(true);
  });
});

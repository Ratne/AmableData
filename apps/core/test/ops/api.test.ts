import { beforeAll, describe, expect, it } from 'vitest';
import type { RegistryMessage } from '@amable/app-edge/analytics';
import { FakeAnalyticsNamespace } from '../../../edge/test/helpers';
import type { Env } from '../../src/env';
import { parkRegistryDeadLetters } from '../../src/ops/registry-dlq';
import { FakeR2 } from '../backup/helpers';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
} from '../helpers/harness';

let h: Harness;
let r2: FakeR2;
let owner: TestClient;
let viewer: TestClient;
let tenantId: string;
const ops = '/api/v2/t/acme/ops';

/** A queue batch as the runtime hands it to the consumer. */
function batchOf(bodies: unknown[]) {
  const acked: number[] = [];
  const retried: number[] = [];
  const messages = bodies.map((body, i) => ({
    body,
    ack: () => acked.push(i),
    retry: () => retried.push(i),
  }));
  return {
    batch: { queue: 'registry-dlq', messages } as unknown as MessageBatch<RegistryMessage>,
    acked,
    retried,
  };
}

beforeAll(async () => {
  h = await createHarness();
  h.env.ANALYTICS = new FakeAnalyticsNamespace(() => h.clock.now) as unknown as Env['ANALYTICS'];
  h.env.EDGE_ORIGIN = 'https://t.acme.test';
  r2 = new FakeR2();
  h.env.FILES = r2.asBucket();
  const tenant = await seedTenant(h, 'acme');
  tenantId = tenant.id;
  const o = await seedUser(h, { email: 'owner@acme.test' });
  await addMember(h, o.id, tenant.id, 'owner');
  owner = await login(h, o.email);
  const v = await seedUser(h, { email: 'viewer@acme.test' });
  await addMember(h, v.id, tenant.id, 'viewer');
  viewer = await login(h, v.email);
});

describe('operations page', () => {
  it('parks registry dead letters in R2 and replays them on request', async () => {
    const message: RegistryMessage = {
      v: 1,
      eid: 'ev-1',
      tenantId,
      siteId: '',
      visitorId: null,
      ts: h.clock.now,
      source: 'lead',
      email: 'ada@example.com',
      phone: null,
      userId: null,
      profile: {},
    };
    const { batch, acked } = batchOf([message, { v: 0 }]);
    await parkRegistryDeadLetters(batch, h.env);
    expect(acked).toEqual([0, 1]);
    expect(
      [...r2.objects.keys()].filter((k) => k.startsWith(`dlq/registry/${tenantId}/`)),
    ).toHaveLength(1);

    // An unreadable parked object is set aside, it does not block the others.
    await r2.asBucket().put(`dlq/registry/${tenantId}/00-broken.json`, '{not json');

    expect((await viewer.get(`${ops}/status`)).status).toBe(403);
    const status = await owner.get(`${ops}/status`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      registry: { parked: 2, truncated: false },
      sites: [],
      backups: { count: 0, last_at: null },
    });

    const replay = await owner.post(`${ops}/registry/replay`);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ replayed: 1, failed: 0, remaining: false });
    expect([...r2.objects.keys()]).toContain(`dlq/registry-poison/${tenantId}/00-broken.json`);
    expect((await owner.get(`${ops}/status`)).body).toMatchObject({ registry: { parked: 0 } });
    // The replayed lead reached the contact registry.
    const contacts = await owner.get('/api/v2/t/acme/contacts?q=ada');
    expect(JSON.stringify(contacts.body)).toContain('ada@example.com');
  });
});

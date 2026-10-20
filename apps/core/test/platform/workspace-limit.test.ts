import { afterEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  stepUp,
  type Harness,
  type TestClient,
} from '../helpers/harness';
import { fakeControlPlane, license, type FakeControlPlane } from './link/helpers';

let cp: FakeControlPlane | null = null;
afterEach(() => {
  cp?.restore();
  cp = null;
});

async function setup(): Promise<{ h: Harness; owner: TestClient }> {
  const h = await createHarness();
  const tenant = await seedTenant(h, 'acme');
  const o = await seedUser(h, { email: 'owner@acme.test' });
  await addMember(h, o.id, tenant.id, 'owner');
  const owner = await login(h, o.email);
  await stepUp(h, owner);
  return { h, owner };
}

/** Licensed installation whose first quota snapshot has been received (billing page load). */
async function licensed(h: Harness, owner: TestClient, serviceState: FakeControlPlane['serviceState']) {
  license(h.env);
  cp = fakeControlPlane(() => h.clock.now);
  cp.serviceState = serviceState;
  expect((await owner.get('/api/v2/t/acme/billing')).status).toBe(200);
}

describe('workspace creation by offering', () => {
  it('open source: owners can create more workspaces', async () => {
    const { owner } = await setup();
    expect((await owner.get('/api/me')).body).toMatchObject({ canCreateTenant: true });
    expect((await owner.post('/api/tenants', { name: 'Beta', slug: 'beta' })).status).toBe(201);
  });

  it('cloud: no switcher entry and the API refuses a second workspace', async () => {
    const { h, owner } = await setup();
    await licensed(h, owner, 'active');
    const calls = cp?.calls.length;
    expect((await owner.get('/api/me')).body).toMatchObject({ canCreateTenant: false });
    expect(cp?.calls.length).toBe(calls);
    const res = await owner.post('/api/tenants', { name: 'Beta', slug: 'beta' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'managed_workspace_limit' });
  });

  it('licensed before the first snapshot: treated as cloud', async () => {
    const { h, owner } = await setup();
    license(h.env);
    expect((await owner.get('/api/me')).body).toMatchObject({ canCreateTenant: false });
    expect((await owner.post('/api/tenants', { name: 'Beta', slug: 'beta' })).status).toBe(403);
  });

  it('self-hosted linked to the platform for credits: creation stays open', async () => {
    const { h, owner } = await setup();
    await licensed(h, owner, 'self_hosted');
    expect((await owner.get('/api/me')).body).toMatchObject({ canCreateTenant: true });
    expect((await owner.post('/api/tenants', { name: 'Beta', slug: 'beta' })).status).toBe(201);
  });
});

import { PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Permission, type Role } from '@amable/core';
import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { overrideAuthServices } from '../src/auth/services';
import { getTenant, requirePermission, type AppEnv } from '../src/middleware';
import {
  addMember,
  createHarness,
  login,
  seedTenant,
  seedUser,
  stepUp,
  type Harness,
  type TestClient,
} from './helpers/harness';

/**
 * Authorization matrix: every role × every permission-guarded route, plus
 * unauthenticated callers and members of a foreign tenant.
 */

// Probe router: one route per permission, exercising the exact middleware chain
// every module uses (app-level requireAuth + requireTenant, then requirePermission).
const probe = new Hono<AppEnv>();
for (const permission of PERMISSIONS) {
  probe.get(`/${permission}`, requirePermission(permission), (c) =>
    c.json({ ok: true, tenant: getTenant(c).tenant.slug }),
  );
}
beforeAll(() => {
  app.route('/t/:slug/__probe', probe);
});
afterEach(() => overrideAuthServices(null));

/** Real routes of the auth layer with their required permission. */
const ADMIN_ROUTES: ReadonlyArray<{ path: string; permission: Permission }> = [
  { path: '/members', permission: 'users:manage' },
  { path: '/invites', permission: 'users:manage' },
  { path: '/api-keys', permission: 'api_keys:manage' },
  { path: '/audit', permission: 'audit:read' },
];

interface World {
  h: Harness;
  clients: Record<Role, TestClient>;
  outsider: TestClient;
  users: Record<Role, string>;
}

async function world(): Promise<World> {
  const h = await createHarness();
  const acme = await seedTenant(h, 'acme');
  const other = await seedTenant(h, 'other');
  const clients = {} as Record<Role, TestClient>;
  const users = {} as Record<Role, string>;
  for (const role of ROLES) {
    const user = await seedUser(h, { email: `${role}@acme.test` });
    await addMember(h, user.id, acme.id, role);
    users[role] = user.id;
    clients[role] = await login(h, user.email);
  }
  const stranger = await seedUser(h, { email: 'owner@other.test' });
  await addMember(h, stranger.id, other.id, 'owner');
  return { h, clients, users, outsider: await login(h, stranger.email) };
}

describe('role matrix', () => {
  it('matches the plan on the critical rules', () => {
    const owners = ROLES.filter((r) => ROLE_PERMISSIONS[r].includes('tenant:billing'));
    expect(owners).toEqual(['owner']);
    expect(ROLE_PERMISSIONS.admin).not.toContain('tenant:delete');
    expect(ROLE_PERMISSIONS.admin).toContain('users:manage');
    for (const role of ['marketer', 'sales', 'analyst', 'viewer'] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain('users:manage');
      expect(ROLE_PERMISSIONS[role]).not.toContain('api_keys:manage');
      expect(ROLE_PERMISSIONS[role]).not.toContain('settings:manage');
      expect(ROLE_PERMISSIONS[role]).not.toContain('domains:manage');
    }
    expect(ROLE_PERMISSIONS.viewer).not.toContain('contacts:export');
    expect(ROLE_PERMISSIONS.viewer).not.toContain('reports:create');
    expect(ROLE_PERMISSIONS.sales).not.toContain('contacts:export');
    // Analysts never modify data (saving their own searches/reports is not data).
    const analystWrites = ROLE_PERMISSIONS.analyst.filter(
      (p) => p.endsWith(':write') && p !== 'saved_searches:write',
    );
    expect(analystWrites).toEqual([]);
    expect(ROLE_PERMISSIONS.marketer).toContain('broadcasts:send');
    expect(ROLE_PERMISSIONS.sales).not.toContain('broadcasts:send');
  });

  it('enforces every permission for every role through the central middleware', async () => {
    const { clients } = await world();
    for (const role of ROLES) {
      for (const permission of PERMISSIONS) {
        const res = await clients[role].get(`/api/t/acme/__probe/${permission}`);
        const expected = ROLE_PERMISSIONS[role].includes(permission) ? 200 : 403;
        expect({ role, permission, status: res.status }).toEqual({ role, permission, status: expected });
      }
    }
  });

  it('applies the matrix to the real admin routes', async () => {
    const { clients } = await world();
    for (const role of ROLES) {
      for (const route of ADMIN_ROUTES) {
        const res = await clients[role].get(`/api/t/acme${route.path}`);
        const expected = ROLE_PERMISSIONS[role].includes(route.permission) ? 200 : 403;
        expect({ role, path: route.path, status: res.status }).toEqual({
          role,
          path: route.path,
          status: expected,
        });
      }
    }
  });

  it('hides foreign and unknown tenants (404) and rejects anonymous callers (401)', async () => {
    const { h, outsider, clients } = await world();
    for (const path of ['/me', '/members', '/__probe/contacts:read']) {
      expect((await outsider.get(`/api/t/acme${path}`)).status).toBe(404);
      expect((await clients.owner.get(`/api/t/other${path}`)).status).toBe(404);
      expect((await clients.owner.get(`/api/t/does-not-exist${path}`)).status).toBe(404);
      expect((await h.client().get(`/api/t/acme${path}`)).status).toBe(401);
    }
  });

  it('exposes role and permissions of the caller for the UI', async () => {
    const { clients } = await world();
    const res = await clients.sales.get('/api/t/acme/me');
    expect(res.body.role).toBe('sales');
    expect(new Set(res.body.permissions as string[])).toEqual(new Set(ROLE_PERMISSIONS.sales));
  });
});

describe('membership management', () => {
  it('admins cannot touch owners or grant ownership; the last owner stays', async () => {
    const { h, clients, users } = await world();
    await stepUp(h, clients.admin);
    const demoteOwner = await clients.admin.patch(`/api/t/acme/members/${users.owner}`, { role: 'viewer' });
    expect(demoteOwner.status).toBe(403);
    const promote = await clients.admin.patch(`/api/t/acme/members/${users.viewer}`, { role: 'owner' });
    expect(promote.status).toBe(403);
    const inviteOwner = await clients.admin.post('/api/t/acme/invites', { email: 'x@acme.test', role: 'owner' });
    expect(inviteOwner.status).toBe(403);
    const ok = await clients.admin.patch(`/api/t/acme/members/${users.viewer}`, { role: 'analyst' });
    expect(ok.status).toBe(200);

    await stepUp(h, clients.owner);
    const lastOwner = await clients.owner.patch(`/api/t/acme/members/${users.owner}`, { role: 'admin' });
    expect(lastOwner.status).toBe(409);
    expect((await clients.owner.post('/api/t/acme/leave')).status).toBe(409);
  });

  it('member changes require a step-up', async () => {
    const { clients, users } = await world();
    const res = await clients.admin.patch(`/api/t/acme/members/${users.viewer}`, { role: 'sales' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('step_up_required');
  });

  it('removing a member cuts their access immediately', async () => {
    const { h, clients, users } = await world();
    expect((await clients.sales.get('/api/t/acme/me')).status).toBe(200);
    await stepUp(h, clients.admin);
    expect((await clients.admin.delete(`/api/t/acme/members/${users.sales}`)).status).toBe(200);
    expect((await clients.sales.get('/api/t/acme/me')).status).toBe(404);
  });

  it('role changes take effect on the next request', async () => {
    const { h, clients, users } = await world();
    expect((await clients.viewer.get('/api/t/acme/__probe/contacts:write')).status).toBe(403);
    await stepUp(h, clients.admin);
    await clients.admin.patch(`/api/t/acme/members/${users.viewer}`, { role: 'sales' });
    expect((await clients.viewer.get('/api/t/acme/__probe/contacts:write')).status).toBe(200);
  });
});

describe('tenant switcher', () => {
  it('lists memberships, switches and remembers the last tenant across sessions', async () => {
    const h = await createHarness();
    const a = await seedTenant(h, 'alpha');
    const b = await seedTenant(h, 'beta');
    const user = await seedUser(h, { email: 'multi@example.com' });
    await addMember(h, user.id, a.id, 'owner');
    await addMember(h, user.id, b.id, 'viewer');
    const client = await login(h, user.email);
    const list = await client.get('/api/me/tenants');
    expect((list.body.tenants as Array<{ slug: string }>).map((t) => t.slug).sort()).toEqual(['alpha', 'beta']);
    expect((await client.post('/api/me/tenants/switch', { slug: 'beta' })).body).toEqual({
      slug: 'beta',
      path: '/t/beta',
    });
    expect((await client.post('/api/me/tenants/switch', { slug: 'gamma' })).status).toBe(404);
    const next = await login(h, user.email);
    expect((await next.get('/api/me')).body.lastTenantSlug).toBe('beta');
  });
});

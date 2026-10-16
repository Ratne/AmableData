import {
  formatLicenseKey,
  generateSigningKeyPair,
  importSigningKey,
  signAssistToken,
  type AssistTokenPayload,
} from '@amable/core/platform';
import { ulid } from 'ulid';
import { app } from '../../../src/app';
import { overrideControlPlaneFetch } from '../../../src/platform/client';
import {
  addMember,
  createHarness,
  login,
  ORIGIN,
  seedTenant,
  seedUser,
  type Harness,
  type TestClient,
  type TestResponse,
} from '../../helpers/harness';

export const CP_URL = 'https://cp.test';
export const INSTALLATION_ID = ulid();
export const LICENSE_KEY = formatLicenseKey(INSTALLATION_ID, 'b'.repeat(40));

export interface CpCall {
  method: string;
  path: string;
  search: string;
  auth: string | null;
  json: unknown;
  form: FormData | null;
}

export interface FakeCp {
  down: boolean;
  readonly calls: CpCall[];
  routes: Record<string, (call: CpCall) => Response | Promise<Response>>;
  restore(): void;
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** In-memory control plane: records every call, answers from `routes` (`'POST /v1/…'`), 404 otherwise. */
export function fakeCp(): FakeCp {
  const cp: FakeCp = {
    down: false,
    calls: [],
    routes: {},
    restore: () => overrideControlPlaneFetch(null),
  };
  overrideControlPlaneFetch(async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const body = init?.body;
    const call: CpCall = {
      method,
      path: url.pathname,
      search: url.search,
      auth: new Headers(init?.headers).get('authorization'),
      json: typeof body === 'string' ? (JSON.parse(body) as unknown) : null,
      form: body instanceof FormData ? body : null,
    };
    cp.calls.push(call);
    if (cp.down) throw new TypeError('fetch failed');
    if (call.auth !== `Bearer ${LICENSE_KEY}`) return json({ error: 'invalid_license' }, 401);
    const route = cp.routes[`${method} ${url.pathname}`];
    return route === undefined ? json({ error: 'not_found' }, 404) : route(call);
  });
  return cp;
}

export interface World {
  h: Harness;
  cp: FakeCp;
  keys: { privateKey: string; publicKey: string };
  acme: { id: string; slug: string };
  other: { id: string; slug: string };
  owner: TestClient;
  ownerId: string;
  admin: TestClient;
  viewer: TestClient;
}

/** Licensed installation with tenants `acme` (owner, admin, viewer) and `other`, plus a fake control plane. */
export async function world(options: { licensed?: boolean } = {}): Promise<World> {
  const h = await createHarness();
  const keys = await generateSigningKeyPair();
  if (options.licensed !== false) {
    Object.assign(h.env, { LICENSE_KEY, CONTROL_PLANE_URL: CP_URL, CONTROL_PLANE_PUBLIC_KEY: keys.publicKey });
  }
  const cp = fakeCp();
  const acme = await seedTenant(h, 'acme');
  const other = await seedTenant(h, 'other');
  const ownerUser = await seedUser(h, { email: 'owner@acme.test', name: 'Olga Owner' });
  const adminUser = await seedUser(h, { email: 'admin@acme.test', name: 'Adam Admin' });
  const viewerUser = await seedUser(h, { email: 'viewer@acme.test', name: 'Vera Viewer' });
  await addMember(h, ownerUser.id, acme.id, 'owner');
  await addMember(h, adminUser.id, acme.id, 'admin');
  await addMember(h, viewerUser.id, acme.id, 'viewer');
  return {
    h,
    cp,
    keys,
    acme,
    other,
    owner: await login(h, ownerUser.email),
    ownerId: ownerUser.id,
    admin: await login(h, adminUser.email),
    viewer: await login(h, viewerUser.email),
  };
}

export async function assistToken(
  w: World,
  overrides: Partial<AssistTokenPayload> & { gid: string },
  privateKey = w.keys.privateKey,
): Promise<string> {
  const iat = Math.floor(w.h.clock.now / 1000);
  const payload: AssistTokenPayload = {
    v: 1,
    typ: 'assist',
    iid: INSTALLATION_ID,
    tid: w.acme.id,
    sid: 'staff_01',
    sname: 'Sam Staff',
    iat,
    exp: iat + 2 * 3600,
    jti: ulid(),
    ...overrides,
  };
  return signAssistToken(await importSigningKey(privateKey), payload);
}

/** Multipart request with the client's cookies (TestClient only sends JSON). */
export async function multipart(h: Harness, client: TestClient, path: string, form: FormData): Promise<TestResponse> {
  const res = await app.request(
    `${ORIGIN}${path}`,
    {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'x-amable-csrf': '1',
        cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: form,
    },
    h.env,
  );
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { text };
  }
  return { status: res.status, body, headers: res.headers };
}

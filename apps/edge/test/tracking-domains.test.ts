import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTrackingHostCache,
  resolveTrackingHost,
  TRACKING_HOST_OP,
} from '../src/analytics/tracking-domains';
import type { Env } from '../src/env';
import { T0 } from './helpers';

const TENANT = { id: 't_1', slug: 'acme', name: 'Acme' };

/** Fake core gateway: answers the tracking host op from a hostname → site map. */
function fakeCore(active: Record<string, string>) {
  const seen: Array<{ op: string; host: unknown }> = [];
  let down = false;
  const env = {
    ENVIRONMENT: 'dev',
    CORE: {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (down) throw new Error('Network connection lost');
        const envelope = JSON.parse(String(init?.body)) as {
          op: string;
          tenant: { host?: string };
        };
        seen.push({ op: envelope.op, host: envelope.tenant.host });
        const siteId =
          envelope.tenant.host === undefined ? undefined : active[envelope.tenant.host];
        const body =
          siteId === undefined
            ? {
                ok: false,
                error: { code: 'not_found', status: 404, message: 'tracking domain not found' },
              }
            : { ok: true, tenant: TENANT, value: { site_id: siteId } };
        return new Response(JSON.stringify(body), { status: siteId === undefined ? 404 : 200 });
      },
    } as unknown as Fetcher,
  } as unknown as Env;
  return { env, seen, setDown: (value: boolean) => (down = value) };
}

beforeEach(() => clearTrackingHostCache());

describe('resolveTrackingHost', () => {
  it('resolves an active custom hostname through the gateway', async () => {
    const core = fakeCore({ 'track.acme.test': 'st_aaaaaaaaaaaaaaaaaaaa' });
    expect(await resolveTrackingHost(core.env, 'Track.Acme.test:443', T0)).toEqual({
      tenant: TENANT,
      siteId: 'st_aaaaaaaaaaaaaaaaaaaa',
    });
    expect(core.seen).toEqual([{ op: TRACKING_HOST_OP, host: 'track.acme.test' }]);
  });

  it('answers null for unknown or not yet active hostnames', async () => {
    const core = fakeCore({});
    expect(await resolveTrackingHost(core.env, 'pending.acme.test', T0)).toBeNull();
  });

  it('caches hits and misses, then refreshes after the TTL', async () => {
    const core = fakeCore({ 'track.acme.test': 'st_aaaaaaaaaaaaaaaaaaaa' });
    await resolveTrackingHost(core.env, 'track.acme.test', T0);
    await resolveTrackingHost(core.env, 'track.acme.test', T0 + 60_000);
    await resolveTrackingHost(core.env, 'nope.acme.test', T0);
    await resolveTrackingHost(core.env, 'nope.acme.test', T0 + 30_000);
    expect(core.seen).toHaveLength(2);
    await resolveTrackingHost(core.env, 'track.acme.test', T0 + 10 * 60_000);
    await resolveTrackingHost(core.env, 'nope.acme.test', T0 + 2 * 60_000);
    expect(core.seen).toHaveLength(4);
  });

  it('does not cache gateway outages', async () => {
    const core = fakeCore({ 'track.acme.test': 'st_aaaaaaaaaaaaaaaaaaaa' });
    core.setDown(true);
    expect(await resolveTrackingHost(core.env, 'track.acme.test', T0)).toBeNull();
    core.setDown(false);
    expect((await resolveTrackingHost(core.env, 'track.acme.test', T0))?.siteId).toBe(
      'st_aaaaaaaaaaaaaaaaaaaa',
    );
  });
});

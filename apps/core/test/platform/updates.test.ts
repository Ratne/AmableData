import { describe, expect, it } from 'vitest';
import {
  isNewer,
  parseVersion,
  RELEASES_API_URL,
  runUpdateCheck,
  UPDATE_CHECK_INTERVAL_MS,
  updateNotice,
} from '../../src/platform/updates';
import { addMember, createHarness, login, seedTenant, seedUser, START, type Harness } from '../helpers/harness';

function githubAnswering(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetcher };
}

const RELEASE = { tag_name: '2026.11.2', html_url: 'https://github.com/Ratne/AmableData/releases/tag/2026.11.2' };

async function selfHosted(version = '2026.10.1'): Promise<Harness> {
  const h = await createHarness();
  Object.assign(h.env, { APP_VERSION: version });
  return h;
}

describe('versions', () => {
  it('parses release tags and git describe output', () => {
    expect(parseVersion('2026.10.1')).toEqual([2026, 10, 1]);
    expect(parseVersion('v2026.10.1')).toEqual([2026, 10, 1]);
    expect(parseVersion('2026.10.1-3-gabc1234')).toEqual([2026, 10, 1]);
    expect(parseVersion('dev')).toBeNull();
    expect(parseVersion('2026.10')).toBeNull();
  });

  it('compares numerically', () => {
    expect(isNewer('2026.10.10', '2026.10.9')).toBe(true);
    expect(isNewer('2026.11.1', '2026.10.9')).toBe(true);
    expect(isNewer('2026.10.1', '2026.10.1-4-gabc1234')).toBe(false);
    expect(isNewer('2026.10.1', '2026.10.2')).toBe(false);
    expect(isNewer('2026.10.2', 'dev')).toBe(false);
  });
});

describe('update check', () => {
  it('asks GitHub at most once a day and exposes a newer release', async () => {
    const h = await selfHosted();
    const github = githubAnswering(RELEASE);
    await runUpdateCheck(h.env, START, github.fetcher);
    await runUpdateCheck(h.env, START + UPDATE_CHECK_INTERVAL_MS - 1, github.fetcher);
    expect(github.calls).toEqual([RELEASES_API_URL]);
    expect(await updateNotice(h.env)).toEqual({ current: '2026.10.1', latest: '2026.11.2', url: RELEASE.html_url });
    await runUpdateCheck(h.env, START + UPDATE_CHECK_INTERVAL_MS, github.fetcher);
    expect(github.calls).toHaveLength(2);
  });

  it('shows nothing when up to date, without a version or when disabled', async () => {
    const upToDate = await selfHosted('2026.11.2');
    await runUpdateCheck(upToDate.env, START, githubAnswering(RELEASE).fetcher);
    expect(await updateNotice(upToDate.env)).toBeNull();

    for (const vars of [{ APP_VERSION: 'dev' }, { APP_VERSION: '2026.10.1', UPDATE_CHECK: 'off' }]) {
      const h = await createHarness();
      Object.assign(h.env, vars);
      const github = githubAnswering(RELEASE);
      await runUpdateCheck(h.env, START, github.fetcher);
      expect(github.calls).toEqual([]);
      expect(await updateNotice(h.env)).toBeNull();
    }
  });

  it('keeps the previous answer when GitHub fails and never links outside the releases page', async () => {
    const h = await selfHosted();
    await runUpdateCheck(h.env, START, githubAnswering({ ...RELEASE, html_url: 'https://evil.example/x' }).fetcher);
    expect((await updateNotice(h.env))?.url).toBe('https://github.com/Ratne/AmableData/releases/tag/2026.11.2');
    await runUpdateCheck(h.env, START + UPDATE_CHECK_INTERVAL_MS, githubAnswering({ message: 'rate limited' }, 403).fetcher);
    expect((await updateNotice(h.env))?.latest).toBe('2026.11.2');
  });

  it('is visible to workspace owners only', async () => {
    const h = await selfHosted();
    await runUpdateCheck(h.env, START, githubAnswering(RELEASE).fetcher);
    const tenant = await seedTenant(h, 'acme');
    const owner = await seedUser(h, { email: 'owner@example.com' });
    const member = await seedUser(h, { email: 'member@example.com' });
    await addMember(h, owner.id, tenant.id, 'owner');
    await addMember(h, member.id, tenant.id, 'admin');

    const asOwner = await login(h, 'owner@example.com');
    expect((await asOwner.get('/api/me/update')).body).toEqual({
      update: { current: '2026.10.1', latest: '2026.11.2', url: RELEASE.html_url },
    });
    const asMember = await login(h, 'member@example.com');
    expect((await asMember.get('/api/me/update')).body).toEqual({ update: null });
    expect((await h.client().get('/api/me/update')).status).toBe(401);
  });
});

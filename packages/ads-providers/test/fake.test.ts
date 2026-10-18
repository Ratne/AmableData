import { adEntitySchema, adSpendDaySchema } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { createFakeProvider, createProvider, ProviderError } from '../src';
import { config, job, queueFetch } from './helpers';

const RANGE = {
  from: '2026-10-13',
  to: '2026-10-15',
  granularity: 'day',
  level: 'campaign',
} as const;

describe('createFakeProvider', () => {
  it('is deterministic for the same platform and seed', async () => {
    const a = createFakeProvider('meta', 7);
    const b = createFakeProvider('meta', 7);
    const [account] = await a.listAccounts('t');
    expect(await a.listEntities('t', account!.account_id)).toEqual(
      await b.listEntities('t', account!.account_id),
    );
    expect(await a.fetchSpend('t', account!.account_id, RANGE)).toEqual(
      await b.fetchSpend('t', account!.account_id, RANGE),
    );
    const other = createFakeProvider('meta', 8);
    const [otherAccount] = await other.listAccounts('t');
    expect(await other.fetchSpend('t', otherAccount!.account_id, RANGE)).not.toEqual(
      await a.fetchSpend('t', account!.account_id, RANGE),
    );
  });

  it('produces contract-valid entities and spend, one row per entity and day', async () => {
    const fake = createFakeProvider('google', 'dev');
    const entities = await fake.listEntities('t', 'acc');
    expect(entities).toHaveLength(2 + 4 + 8);
    for (const e of entities) expect(adEntitySchema.parse(e)).toEqual(e);
    const ids = new Set(entities.map((e) => e.external_id));
    for (const e of entities)
      if (e.parent_external_id) expect(ids.has(e.parent_external_id)).toBe(true);

    const spend = await fake.fetchSpend('t', 'acc', { ...RANGE, level: 'adset' });
    expect(spend).toHaveLength(4 * 3);
    for (const row of spend) {
      expect(adSpendDaySchema.parse(row)).toEqual(row);
      expect(row.platform).toBe('google');
    }
    const hourly = await fake.fetchSpend('t', 'acc', {
      from: '2026-10-15',
      to: '2026-10-15',
      granularity: 'hour',
      level: 'campaign',
    });
    expect(hourly).toHaveLength(2 * 24);
    expect(hourly.map((r) => r.hour)).toEqual([...Array(24).keys(), ...Array(24).keys()]);
  });

  it('oauth round-trip: authorize redirects back with a code, refresh needs the issued token', async () => {
    const fake = createFakeProvider('tiktok', 1);
    const url = new URL(fake.authorizeUrl({ redirectUri: 'https://app.test/cb?x=1', state: 'st' }));
    expect(url.origin + url.pathname).toBe('https://app.test/cb');
    expect(url.searchParams.get('state')).toBe('st');
    const tokens = await fake.exchangeCode({
      code: url.searchParams.get('code')!,
      redirectUri: 'https://app.test/cb',
    });
    const refreshed = await fake.refreshToken(tokens.refreshToken!);
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);
    await expect(fake.refreshToken('bogus')).rejects.toMatchObject({ kind: 'auth_expired' });
  });

  it('records conversions in memory and replays scripted failures', async () => {
    const fake = createFakeProvider('meta', 'x');
    fake.failNext(new ProviderError('retryable', 'boom'), new ProviderError('permanent', 'nope'));
    await expect(fake.sendConversion('t', job(), { pixelId: 'p' })).rejects.toMatchObject({
      kind: 'retryable',
    });
    await expect(fake.sendConversion('t', job(), { pixelId: 'p' })).rejects.toMatchObject({
      kind: 'permanent',
    });
    expect(await fake.sendConversion('t', job(), { pixelId: 'p' })).toEqual({
      ok: true,
      platformResponseId: 'fake-meta-x-1',
    });
    expect(fake.sent).toEqual([{ accessToken: 't', job: job(), options: { pixelId: 'p' } }]);
  });
});

describe('createProvider', () => {
  it('returns the client for each platform', () => {
    const { fetch } = queueFetch([]);
    expect(createProvider('meta', config(fetch)).platform).toBe('meta');
    expect(createProvider('google', config(fetch)).platform).toBe('google');
    expect(createProvider('tiktok', config(fetch)).platform).toBe('tiktok');
  });
});

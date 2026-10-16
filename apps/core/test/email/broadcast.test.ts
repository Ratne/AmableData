import type { QuotaGuard } from '@amable/core';
import { describe, expect, it } from 'vitest';
import { bucketize, scheduleRecipients, zonedLocalToUtc } from '../../src/broadcast/tz';
import { configureSender, createMailWorld, sampleDoc } from './helpers';

type World = ReturnType<typeof createMailWorld>;

async function draft(world: World, overrides: Record<string, unknown> = {}) {
  const tag = world.crm.op('tags.list', { limit: 200 }).data.find((t) => t.name === 'News');
  return world.op('broadcasts.create', {
    name: 'October news',
    subject: 'News for {{ contact.first_name }}',
    body: sampleDoc() as never,
    segment: { type: 'tags', match: 'any', tag_ids: [tag?.id ?? 'missing'] },
    createdBy: 'user_owner',
    ...overrides,
  });
}

describe('timezone scheduling', () => {
  it('converts local wall-clock times across DST-aware zones', () => {
    expect(new Date(zonedLocalToUtc('2026-10-16', '09:00', 'Europe/Rome')).toISOString()).toBe('2026-10-16T07:00:00.000Z');
    expect(new Date(zonedLocalToUtc('2026-12-16', '09:00', 'Europe/Rome')).toISOString()).toBe('2026-12-16T08:00:00.000Z');
    expect(new Date(zonedLocalToUtc('2026-10-16', '09:00', 'America/New_York')).toISOString()).toBe('2026-10-16T13:00:00.000Z');
    expect(new Date(zonedLocalToUtc('2026-10-16', '09:00', 'Asia/Kolkata')).toISOString()).toBe('2026-10-16T03:30:00.000Z');
  });

  it('buckets recipients by contact timezone, falling back to the tenant timezone, never in the past', () => {
    const now = Date.UTC(2026, 9, 16, 5, 0);
    const scheduled = scheduleRecipients(
      [
        { id: 'rome1', time_zone: 'Europe/Rome' },
        { id: 'rome2', time_zone: 'Europe/Rome' },
        { id: 'ny', time_zone: 'America/New_York' },
        { id: 'none', time_zone: null },
        { id: 'bogus', time_zone: 'Mars/Olympus' },
        { id: 'tokyo', time_zone: 'Asia/Tokyo' },
      ],
      { mode: 'contact_tz', local_date: '2026-10-16', local_time: '09:00' },
      'Europe/London',
      now,
    );
    expect(bucketize(scheduled)).toEqual([
      // Tokyo 09:00 = 00:00Z, already past → sends now.
      { time_zone: 'Asia/Tokyo', send_at: '2026-10-16T05:00:00.000Z', count: 1 },
      { time_zone: 'Europe/Rome', send_at: '2026-10-16T07:00:00.000Z', count: 2 },
      { time_zone: 'Europe/London', send_at: '2026-10-16T08:00:00.000Z', count: 2 },
      { time_zone: 'America/New_York', send_at: '2026-10-16T13:00:00.000Z', count: 1 },
    ]);
  });
});

describe('broadcasts', () => {
  it('estimates recipients and blocks scheduling when the QuotaGuard denies', async () => {
    const world = createMailWorld();
    await configureSender(world);
    world.contact({ email: 'a@x.test', tags: ['News'] });
    world.contact({ email: 'b@x.test', tags: ['News'] });
    world.contact({ email: null, tags: ['News'] });
    world.contact({ email: 'gone@x.test', tags: ['News'] });
    await world.op('suppressions.add', { email: 'gone@x.test', reason: 'manual' });
    const b = await draft(world);
    const deny: QuotaGuard = {
      check: (input) => Promise.resolve({ action: 'deny', reason: `balance too low for ${String(input.count)} emails` }),
    };
    world.quota.current = deny;
    const estimate = await world.op('broadcasts.estimate', { id: b.id });
    expect(estimate).toMatchObject({
      segment_size: 4,
      eligible: 2,
      excluded: { no_email: 1, suppressed: 1, unmarketable: 0 },
      quota: { action: 'deny', reason: 'balance too low for 2 emails' },
      can_send: false,
      block_reason: 'quota_denied',
    });
    const error = await world.fail('broadcasts.schedule', { id: b.id, schedule: { mode: 'now' } });
    expect(error).toMatchObject({ code: 'quota_denied', status: 402 });
    expect(error.message).toContain('balance too low for 2 emails');
    expect((await world.op('broadcasts.get', { id: b.id })).status).toBe('draft');
    expect(world.deps.db.all(`SELECT 1 FROM mail_broadcast_recipients`)).toHaveLength(0);
  });

  it('refuses to schedule before the sending domain is verified or without a physical address', async () => {
    const world = createMailWorld({ verified: false });
    await configureSender(world);
    world.contact({ email: 'a@x.test', tags: ['News'] });
    const b = await draft(world);
    expect(await world.fail('broadcasts.schedule', { id: b.id, schedule: { mode: 'now' } })).toMatchObject({
      code: 'domain_not_verified',
      status: 409,
    });
    world.sending.current = { ...world.sending.current, state: 'dev_override' };
    await world.op('settings.update', { physical_address: null });
    expect(await world.fail('broadcasts.schedule', { id: b.id, schedule: { mode: 'now' } })).toMatchObject({
      code: 'missing_physical_address',
    });
  });

  it('sends to the segment, tracks progress and aggregates per-link stats', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const ids = ['a', 'b', 'c'].map((n) => world.contact({ email: `${n}@x.test`, given: n.toUpperCase(), tags: ['News'] }));
    world.contact({ email: 'other@x.test', tags: [] });
    const b = await draft(world);
    const scheduled = await world.op('broadcasts.schedule', { id: b.id, schedule: { mode: 'now' } });
    expect(scheduled.broadcast).toMatchObject({ status: 'scheduled', progress: { recipients: 3, pending: 3 } });
    expect(world.alarms).toEqual([world.clock.now]);

    const tick = await world.op('broadcasts.tick', {});
    expect(tick.enqueued).toBe(3);
    expect(world.queue.map((r) => r.id).sort()).toEqual(ids.map((id) => `bc:${b.id}:${id}`).sort());
    expect((await world.op('broadcasts.get', { id: b.id })).status).toBe('sent');
    await world.drain();
    expect(world.provider.sent.map((m) => m.to).sort()).toEqual(['a@x.test', 'b@x.test', 'c@x.test']);
    expect(world.provider.sent.find((m) => m.to === 'b@x.test')?.subject).toBe('News for B');

    // Clicks: two recipients click the news link, one clicks it twice and the shop link once.
    const tokensFor = (to: string) =>
      [...(world.provider.sent.find((m) => m.to === to)?.html ?? '').matchAll(/\/r\/([^"]+)"/g)].map((m) => m[1] ?? '');
    const [aNews = ''] = tokensFor('a@x.test');
    const [bNews = '', bShop = ''] = tokensFor('b@x.test');
    await world.op('track.click', { token: aNews });
    await world.op('track.click', { token: bNews });
    await world.op('track.click', { token: bNews });
    await world.op('track.click', { token: bShop });

    const stats = await world.op('broadcasts.stats', { id: b.id });
    expect(stats.totals).toMatchObject({ recipients: 3, sent: 3, opened: 2, clicked: 2, bounced: 0 });
    expect(stats.rates.click).toBeCloseTo(0.6667, 3);
    expect(stats.links).toEqual([
      { url: 'https://example.com/news?a=1&b=2', position: 0, clicks: 3, unique_clicks: 2 },
      { url: 'https://shop.example.com/', position: 1, clicks: 1, unique_clicks: 1 },
    ]);
    const list = await world.op('broadcasts.list', { limit: 10 });
    expect(list.data[0]?.stats).toEqual({ sent: 3, opened: 2, clicked: 2 });
  });

  it('handles segments larger than the 100-parameter SQL limit', async () => {
    const world = createMailWorld();
    await configureSender(world);
    await world.op('settings.update', { rate_per_minute: 1000 });
    world.deps.db.run(`INSERT INTO mail_meta (key, value) VALUES ('warmup_started_at', '1')`);
    for (let i = 0; i < 150; i += 1) world.contact({ email: `bulk${String(i)}@x.test`, tags: ['News'] });
    const b = await draft(world);
    expect((await world.op('broadcasts.estimate', { id: b.id })).eligible).toBe(150);
    await world.op('broadcasts.schedule', { id: b.id, schedule: { mode: 'now' } });
    expect((await world.op('broadcasts.tick', {})).enqueued).toBe(150);
    await world.drain();
    expect(world.provider.sent).toHaveLength(150);
    expect((await world.op('broadcasts.stats', { id: b.id })).totals.sent).toBe(150);
    const events = await world.op('events.pending', { limit: 500 });
    expect((await world.op('events.ack', { ids: events.map((e) => e.id) })).acked).toBe(150);
    expect((await world.op('broadcasts.list', { limit: 200 })).data).toHaveLength(1);
  });

  it('throttles per tick, pauses, resumes and cancels', async () => {
    const world = createMailWorld();
    await configureSender(world);
    for (let i = 0; i < 5; i += 1) world.contact({ email: `p${String(i)}@x.test`, tags: ['News'] });
    const b = await draft(world, { throttle_per_hour: 120 });
    await world.op('broadcasts.schedule', { id: b.id, schedule: { mode: 'now' } });
    expect((await world.op('broadcasts.tick', {})).enqueued).toBe(2);
    const running = await world.op('broadcasts.get', { id: b.id });
    expect(running).toMatchObject({ status: 'sending', progress: { enqueued: 2, pending: 3 } });
    expect(running.next_send_at).toBe(new Date(world.clock.now + 60_000).toISOString());
    // Not due yet: nothing more.
    expect((await world.op('broadcasts.tick', {})).enqueued).toBe(0);

    await world.op('broadcasts.pause', { id: b.id });
    world.clock.now += 60_000;
    expect((await world.op('broadcasts.tick', {})).enqueued).toBe(0);
    // Queued messages of a paused broadcast are deferred, not sent.
    const paused = await world.op('send.process', { batch: world.queue.map((request) => ({ request, queueAttempts: 1 })) });
    expect(paused.every((o) => o.action === 'retry')).toBe(true);

    await world.op('broadcasts.resume', { id: b.id });
    expect((await world.op('broadcasts.tick', {})).enqueued).toBe(2);
    const cancelled = await world.op('broadcasts.cancel', { id: b.id });
    expect(cancelled).toMatchObject({ status: 'cancelled', progress: { enqueued: 4, cancelled: 1, pending: 0 } });
    await world.drain();
    expect(world.provider.sent).toHaveLength(0);
    expect(
      world.deps.db.all<{ status_reason: string }>(`SELECT status_reason FROM mail_messages`).every((r) => r.status_reason === 'cancelled'),
    ).toBe(true);
  });

  it('test sends go to tenant members only, with sample or real contact data', async () => {
    const world = createMailWorld({ verified: false });
    await configureSender(world);
    const contactId = world.contact({ email: 'ada@x.test', given: 'Ada', tags: ['News'] });
    const b = await draft(world);
    const sent = await world.op('broadcasts.testSend', { id: b.id, data: { contact_id: contactId }, callerId: 'user_owner' });
    expect(sent.sent).toMatchObject([{ email: 'owner@acme.test' }]);
    const email = world.provider.sent[0];
    expect(email?.to).toBe('owner@acme.test');
    expect(email?.subject).toBe('[Test] News for Ada');
    const stranger = await world.fail('broadcasts.testSend', {
      id: b.id,
      data: { user_ids: ['user_owner', 'someone_else'] },
      callerId: 'user_owner',
    });
    expect(stranger).toMatchObject({ code: 'not_tenant_member', status: 403 });
    // Test sends never count in broadcast stats.
    expect((await world.op('broadcasts.stats', { id: b.id })).totals.sent).toBe(0);
  });
});

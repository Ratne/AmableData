import { EmailProviderError, verifyEmailToken } from '@amable/core';
import { describe, expect, it } from 'vitest';
import { consumeEmailMessages, type QueueMessageLike } from '../../src/email/consumer';
import { backoffSeconds, MAX_SEND_ATTEMPTS, type SendOutcome } from '../../src/email/pipeline';
import { setSetting, WARMUP_CAPS } from '../../src/email/settings';
import { configureSender, createMailWorld, SECRET, sendRequest, TENANT_ID } from './helpers';

async function process(world: ReturnType<typeof createMailWorld>, ids: string[], contactId: string) {
  return world.op('send.process', {
    batch: ids.map((id) => ({ request: sendRequest(contactId, { id }), queueAttempts: 1 })),
  });
}

function messageRow(world: ReturnType<typeof createMailWorld>, requestId: string) {
  return world.deps.db.all<{ id: string; status: string; status_reason: string | null; attempts: number }>(
    `SELECT id, status, status_reason, attempts FROM mail_messages WHERE request_id = ?`,
    requestId,
  )[0];
}

describe('send pipeline', () => {
  it('renders per recipient, rewrites links, adds the open pixel and List-Unsubscribe headers', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const contactId = world.contact({ email: 'Ada@Example.com', given: 'Ada' });
    const [outcome] = await process(world, ['r1'], contactId);
    expect(outcome).toEqual({ id: 'r1', action: 'ack', status: 'sent' });
    const [email] = world.provider.sent;
    expect(email?.to).toBe('ada@example.com');
    expect(email?.subject).toBe('Hello Ada');
    expect(email?.from).toBe('"Acme" <news@acme.test>');
    expect(email?.providerTenantId).toBe('ps_acme');
    expect(email?.html).toContain('Hi Ada');
    expect(email?.html).not.toContain('https://example.com/news');
    expect(email?.html).toMatch(/https:\/\/t\.acme\.test\/o\/[\w-]+\.[\w-]+/);
    expect(email?.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/t\.acme\.test\/unsub\/[\w-]+\.[\w-]+>$/);
    expect(email?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // Unsubscribe link in the footer is not rewritten for click tracking.
    const unsubUrl = email?.headers?.['List-Unsubscribe']?.slice(1, -1) ?? '';
    expect(email?.html).toContain(unsubUrl);

    const tracked = [...(email?.html ?? '').matchAll(/href="https:\/\/t\.acme\.test\/r\/([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(tracked).toHaveLength(2);
    const first = await verifyEmailToken([SECRET], tracked[0] ?? '', 'click');
    expect(first).toMatchObject({ t: TENANT_ID, c: contactId, l: 0, u: 'https://example.com/news?a=1&b=2' });
    const second = await verifyEmailToken([SECRET], tracked[1] ?? '', 'click');
    expect(second?.u).toBe('https://shop.example.com/');
    // Outbox: email.sent.
    const events = await world.op('events.pending', {});
    expect(events.map((e) => e.type)).toEqual(['email.sent']);
  });

  it('is idempotent per request id (message × recipient)', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const contactId = world.contact({});
    await process(world, ['dup'], contactId);
    const again = await process(world, ['dup', 'dup'], contactId);
    expect(again.map((o) => (o.action === 'ack' ? o.status : o.action))).toEqual(['duplicate', 'duplicate']);
    expect(world.provider.sent).toHaveLength(1);
    expect(world.deps.db.all(`SELECT id FROM mail_messages`)).toHaveLength(1);
  });

  it('retries retryable provider errors with exponential backoff, then succeeds', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const contactId = world.contact({});
    world.provider.failNext(2);
    const first = await process(world, ['retry'], contactId);
    expect(first[0]).toMatchObject({ action: 'retry', delaySeconds: backoffSeconds(1) });
    const second = await process(world, ['retry'], contactId);
    expect(second[0]).toMatchObject({ action: 'retry', delaySeconds: backoffSeconds(2) });
    expect(backoffSeconds(2)).toBe(60);
    const third = await process(world, ['retry'], contactId);
    expect(third[0]).toMatchObject({ action: 'ack', status: 'sent' });
    expect(messageRow(world, 'retry')).toMatchObject({ status: 'sent', attempts: 3 });
    // Failed attempts gave their warm-up/rate slots back.
    expect(world.deps.db.all<{ count: number }>(`SELECT count FROM mail_counters WHERE bucket LIKE 'day:%'`)[0]?.count).toBe(1);
  });

  it('fails after MAX_SEND_ATTEMPTS and on non-retryable errors', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const contactId = world.contact({});
    world.provider.failNext(MAX_SEND_ATTEMPTS);
    let outcome: SendOutcome | undefined;
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i += 1) [outcome] = await process(world, ['exhaust'], contactId);
    expect(outcome).toMatchObject({ action: 'ack', status: 'failed' });
    expect(messageRow(world, 'exhaust')?.attempts).toBe(MAX_SEND_ATTEMPTS);

    world.provider.failNext(1, new EmailProviderError('invalid recipient', false, 422));
    const [rejected] = await process(world, ['permanent'], contactId);
    expect(rejected).toMatchObject({ action: 'ack', status: 'failed' });
    expect(messageRow(world, 'permanent')?.status_reason).toBe('invalid recipient');
  });

  it('skips suppressed, unmarketable and email-less contacts', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const suppressed = world.contact({ email: 'gone@example.com' });
    await world.op('suppressions.add', { email: 'GONE@example.com', reason: 'manual' });
    const noEmail = world.contact({ email: null });
    const unmarketable = world.contact({ email: 'no@example.com' });
    world.crm.op('contacts.update', { id: unmarketable, data: { marketable_status: 'unsubscribed' } });
    await process(world, ['s'], suppressed);
    await process(world, ['n'], noEmail);
    await process(world, ['u'], unmarketable);
    expect(messageRow(world, 's')).toMatchObject({ status: 'skipped', status_reason: 'suppressed' });
    expect(messageRow(world, 'n')).toMatchObject({ status: 'skipped', status_reason: 'no_email' });
    expect(messageRow(world, 'u')?.status_reason).toBe('unmarketable: unsubscribed');
    expect(world.provider.sent).toHaveLength(0);
  });

  it('blocks real sends while the sending domain is not verified (test sends still allowed)', async () => {
    const world = createMailWorld({ verified: false });
    await configureSender(world);
    const contactId = world.contact({});
    const [outcome] = await process(world, ['blocked'], contactId);
    expect(outcome).toMatchObject({ action: 'ack', status: 'blocked' });
    expect(messageRow(world, 'blocked')?.status_reason).toBe('domain_not_verified');
    expect(world.provider.sent).toHaveLength(0);
    const settings = await world.op('settings.get', {});
    expect(settings.sending).toMatchObject({ state: 'unverified', can_send: false, block_reason: 'domain_not_verified' });

    // Dev override behaves like a verified domain.
    world.sending.current = { ...world.sending.current, state: 'dev_override' };
    const [ok] = await process(world, ['override'], contactId);
    expect(ok).toMatchObject({ status: 'sent' });
  });

  it('defers sends beyond the warm-up daily cap without consuming attempts', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const contactId = world.contact({});
    setSetting(world.deps, 'warmup_started_at', String(world.clock.now));
    const cap = WARMUP_CAPS[0] ?? 0;
    const day = new Date(world.clock.now).toISOString().slice(0, 10);
    world.deps.db.run(`INSERT INTO mail_counters (bucket, count) VALUES (?, ?)`, `day:${day}`, cap);
    const [outcome] = await process(world, ['capped'], contactId);
    expect(outcome?.action).toBe('retry');
    if (outcome?.action !== 'retry') throw new Error('expected retry');
    expect(outcome.reason).toBe('warmup_cap');
    // Retry lands after midnight UTC (12:00 → +12 h).
    expect(outcome.delaySeconds).toBeGreaterThanOrEqual(12 * 3600);
    expect(messageRow(world, 'capped')).toMatchObject({ status: 'queued', attempts: 0 });

    // Next day the cap of day 1 applies and the message goes out.
    world.clock.now += 13 * 3600 * 1000;
    const [later] = await process(world, ['capped'], contactId);
    expect(later).toMatchObject({ status: 'sent' });
    const settings = await world.op('settings.get', {});
    expect(settings.warmup).toMatchObject({ day: 1, daily_cap: WARMUP_CAPS[1], sent_today: 1 });
  });

  it('applies the per-tenant rate limit per minute', async () => {
    const world = createMailWorld();
    await configureSender(world);
    await world.op('settings.update', { rate_per_minute: 2 });
    const ids = [world.contact({ email: 'a@x.test' }), world.contact({ email: 'b@x.test' }), world.contact({ email: 'c@x.test' })];
    const outcomes = await world.op('send.process', {
      batch: ids.map((id, i) => ({ request: sendRequest(id, { id: `rl${String(i)}` }), queueAttempts: 1 })),
    });
    expect(outcomes.map((o) => o.action)).toEqual(['ack', 'ack', 'retry']);
    expect(outcomes[2]).toMatchObject({ reason: 'rate_limit' });
  });

  it('uses the plan rate when the managed offering sets one, and refuses to change it', async () => {
    const world = createMailWorld();
    await configureSender(world);
    world.quota.current = { check: () => Promise.resolve({ action: 'allow' }), ratePerMinute: () => Promise.resolve(1) };
    expect(await world.op('settings.get', {})).toMatchObject({ rate_per_minute: 1, rate_managed: true, rate_dedicated: false });
    await expect(world.op('settings.update', { rate_per_minute: 5000 })).rejects.toThrow(/^rate_managed/);
    world.quota.current = { ...world.quota.current, dedicatedCapacity: () => Promise.resolve(true) };
    expect(await world.op('settings.get', {})).toMatchObject({ rate_managed: true, rate_dedicated: true });
    const ids = [world.contact({ email: 'a@x.test' }), world.contact({ email: 'b@x.test' })];
    const outcomes = await world.op('send.process', {
      batch: ids.map((id, i) => ({ request: sendRequest(id, { id: `pr${String(i)}` }), queueAttempts: 1 })),
    });
    expect(outcomes.map((o) => o.action)).toEqual(['ack', 'retry']);
    expect(outcomes[1]).toMatchObject({ reason: 'rate_limit' });
  });

  it('formats dates in the tenant timezone, in the body, subject and snippets; explicit zones still win', async () => {
    const world = createMailWorld();
    await configureSender(world);
    await world.op('snippets.create', { key: 'when', name: 'When', body: '{{ "2026-10-16T07:00:00Z" | date: "%H:%M" }}' });
    const at = '{{ "2026-10-16T07:00:00Z" | date: "%H:%M" }}';
    const subject = `${at} {{ "2026-12-01" | date: "%d/%m" }} {{ "2026-10-16T07:00:00Z" | date: "%H:%M", "Asia/Tokyo" }} {{ "2026-10-16T07:00:00Z" | date: "%H:%M", contact.time_zone }} {{ snippets.when }}`;
    const contactId = world.contact({});
    const send = async (id: string) => {
      await world.op('send.process', {
        batch: [{ request: sendRequest(contactId, { id, content: { ...sendRequest(contactId).content, subject } }), queueAttempts: 1 }],
      });
      return world.provider.sent.at(-1)?.subject;
    };

    expect(await send('tz-utc')).toBe('07:00 01/12 16:00 07:00 07:00');
    await world.op('settings.update', { timezone: 'America/New_York' });
    // Same content: the cached renderer must not keep the previous zone. Calendar dates never shift.
    expect(await send('tz-ny')).toBe('03:00 01/12 16:00 03:00 03:00');
    await world.op('settings.update', { timezone: 'Europe/Rome' });
    expect(await send('tz-rome')).toBe('09:00 01/12 16:00 09:00 09:00');

    const tokyoContact = world.contact({ email: 'kenji@example.com', given: 'Kenji', tz: 'Asia/Tokyo' });
    await world.op('send.process', {
      batch: [{ request: sendRequest(tokyoContact, { id: 'tz-contact', content: { ...sendRequest(tokyoContact).content, subject } }), queueAttempts: 1 }],
    });
    expect(world.provider.sent.at(-1)?.subject).toBe('09:00 01/12 16:00 16:00 09:00');
  });
});

describe('email-send queue consumer', () => {
  function message(body: unknown) {
    const state = { acked: false, retryDelay: null as number | null };
    const msg: QueueMessageLike = {
      body,
      attempts: 1,
      ack: () => {
        state.acked = true;
      },
      retry: (options) => {
        state.retryDelay = options?.delaySeconds ?? 0;
      },
    };
    return { msg, state };
  }

  it('groups by tenant, acks done messages, retries with the pipeline delay and drops malformed ones', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const contactId = world.contact({});
    world.provider.failNext(1);
    const good = message(sendRequest(contactId, { id: 'c1' }));
    const failing = message(sendRequest(contactId, { id: 'c0' }));
    const malformed = message({ kind: 'email.send', version: 1, id: 'x' });
    const calls: string[] = [];
    const stats = await consumeEmailMessages([failing.msg, good.msg, malformed.msg], async (tenantId, batch) => {
      calls.push(tenantId);
      return world.op('send.process', { batch });
    });
    expect(calls).toEqual([TENANT_ID]);
    expect(stats).toEqual({ acked: 1, retried: 1, dropped: 1 });
    expect(failing.state.retryDelay).toBe(backoffSeconds(1));
    expect(good.state.acked).toBe(true);
    expect(malformed.state.acked).toBe(true);
  });

  it('retries the whole group when the tenant DO call fails', async () => {
    const m = message(sendRequest('c', { id: 'boom' }));
    const stats = await consumeEmailMessages([m.msg], () => Promise.reject(new Error('DO unavailable')));
    expect(stats.retried).toBe(1);
    expect(m.state.retryDelay).toBe(60);
  });
});

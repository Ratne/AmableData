import { hmacSha256Hex, signWebhook } from '@amable/auth';
import { EmailProviderError } from '@amable/core';
import { describe, expect, it } from 'vitest';
import { capsuleSignature } from '../../src/email/public';
import { HEALTH_POLICY } from '../../src/email/settings';
import { parseProviderEvents } from '../../src/email/webhooks';
import { configureSender, createMailWorld, sendRequest } from './helpers';

const WEBHOOK_SECRET = 'whsec_test';

type World = ReturnType<typeof createMailWorld>;

/** Signs like PostShiba (`X-Capsule-*` headers) and normalizes like the route. */
async function deliver(world: World, events: unknown[], secret = WEBHOOK_SECRET) {
  const rawBody = JSON.stringify(events);
  const timestamp = String(Math.floor(world.clock.now / 1000));
  const hex = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return { rawBody, signature: capsuleSignature(timestamp, `sha256=${hex}`) };
}

async function sentMessage(world: World, email: string, id: string) {
  const contactId = world.contact({ email });
  await world.op('send.process', { batch: [{ request: sendRequest(contactId, { id }), queueAttempts: 1 }] });
  const row = world.deps.db.all<{ id: string; provider_message_id: string }>(
    `SELECT id, provider_message_id FROM mail_messages WHERE request_id = ?`,
    id,
  )[0];
  if (row === undefined) throw new Error('no message');
  return { contactId, ...row };
}

/** A PostShiba event in SendGrid Event Webhook format, carrying our unique args. */
function psEvent(
  id: string,
  event: string,
  message: { id: string; provider_message_id: string } | null,
  extra: Record<string, unknown> = {},
) {
  return {
    event,
    email: 'x@example.com',
    timestamp: 1_790_000_000,
    sg_event_id: `capsule-${id}`,
    ...(message === null
      ? {}
      : {
          sg_message_id: message.provider_message_id,
          amb_message_id: message.id,
          unique_args: { account: 'tenant_1', amb_message_id: message.id },
        }),
    tenant_id: 'ps-tenant-slug',
    ...extra,
  };
}

const statusOf = (world: World, id: string) =>
  world.deps.db.all<{ status: string; status_reason: string | null }>(
    `SELECT status, status_reason FROM mail_messages WHERE id = ?`,
    id,
  )[0];

describe('PostShiba signature headers', () => {
  it('normalizes X-Capsule-Timestamp + X-Capsule-Signature into the verifier format', () => {
    const hex = 'a'.repeat(64);
    expect(capsuleSignature('1790000000', `sha256=${hex}`)).toBe(`t=1790000000,v1=${hex}`);
    expect(capsuleSignature('1790000000', `SHA256=${hex.toUpperCase()}`)).toBe(`t=1790000000,v1=${hex}`);
    expect(capsuleSignature(undefined, `sha256=${hex}`)).toBeNull();
    expect(capsuleSignature('abc', `sha256=${hex}`)).toBe('malformed');
    expect(capsuleSignature('1790000000', 'sha256=zz')).toBe('malformed');
  });
});

describe('provider delivery webhooks', () => {
  it('verifies the HMAC signature and rejects replays, forgeries and stale timestamps', async () => {
    const world = createMailWorld();
    const req = await deliver(world, []);
    expect(await world.op('webhooks.provider', { ...req, secrets: [WEBHOOK_SECRET] })).toMatchObject({ processed: 0 });
    const replay = await world.fail('webhooks.provider', { ...req, secrets: [WEBHOOK_SECRET] });
    expect(replay).toMatchObject({ code: 'invalid_signature', status: 401, message: 'replayed' });
    const forged = await deliver(world, [], 'wrong');
    expect(await world.fail('webhooks.provider', { ...forged, secrets: [WEBHOOK_SECRET] })).toMatchObject({
      message: 'bad_signature',
    });
    const stale = await deliver(world, []);
    world.clock.now += 10 * 60 * 1000;
    expect(await world.fail('webhooks.provider', { ...stale, secrets: [WEBHOOK_SECRET] })).toMatchObject({
      message: 'timestamp_out_of_tolerance',
    });
    expect(await world.fail('webhooks.provider', { ...req, signature: null, secrets: [WEBHOOK_SECRET] })).toMatchObject({
      message: 'malformed_header',
    });
    expect(await world.fail('webhooks.provider', { ...req, signature: 'malformed', secrets: [WEBHOOK_SECRET] })).toMatchObject({
      message: 'malformed_header',
    });
    expect(await world.fail('webhooks.provider', { ...req, secrets: [] })).toMatchObject({ status: 503 });
  });

  it('still accepts our own Amable-Signature format (rotation of old secrets)', async () => {
    const world = createMailWorld();
    const rawBody = JSON.stringify([]);
    const signature = await signWebhook(WEBHOOK_SECRET, rawBody, world.clock.now);
    expect(await world.op('webhooks.provider', { rawBody, signature, secrets: ['new', WEBHOOK_SECRET] })).toMatchObject({
      processed: 0,
    });
  });

  it('parses the SendGrid-format fields PostShiba sends', () => {
    const [event] = parseProviderEvents(
      JSON.stringify([
        {
          event: 'bounce',
          type: 'blocked',
          email: 'a@example.com',
          sg_event_id: 'capsule-9',
          sg_message_id: 'abc@capsule',
          status: '5.7.1',
          reason: 'blocked by policy',
          bounce_classification: 'Reputation',
          unique_args: { amb_message_id: 'msg_1' },
        },
      ]),
    );
    expect(event).toEqual({
      id: 'capsule-9',
      type: 'bounced',
      providerMessageId: 'abc@capsule',
      messageId: 'msg_1',
      recipient: 'a@example.com',
      bounceType: 'soft',
      classification: 'Reputation',
      reason: '5.7.1 blocked by policy',
    });
    expect(parseProviderEvents(JSON.stringify([{ event: 'delivered', sg_event_id: 'capsule-1', test: true }]))).toEqual([]);
    expect(parseProviderEvents(JSON.stringify([{ event: 'open', sg_event_id: 'capsule-2' }]))).toEqual([]);
  });

  it('maps processed/delivered/deferred/bounce/dropped; hard bounces suppress and mark the contact', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const a = await sentMessage(world, 'a@example.com', 'ra');
    const b = await sentMessage(world, 'b@example.com', 'rb');
    const c = await sentMessage(world, 'c@example.com', 'rc');
    const req = await deliver(world, [
      psEvent('0', 'processed', a),
      psEvent('1', 'delivered', a),
      psEvent('2', 'deferred', b, { reason: 'greylisted', bounce_classification: 'Technical' }),
      psEvent('3', 'bounce', b, { type: 'bounce', status: '5.1.1', reason: '550 5.1.1 no such user', bounce_classification: 'Invalid Address' }),
      psEvent('4', 'dropped', { id: c.id, provider_message_id: 'unknown' }, { reason: 'Unclassified: firewall' }),
      psEvent('1', 'delivered', a),
      psEvent('5', 'open', a),
    ]);
    const result = await world.op('webhooks.provider', { ...req, secrets: [WEBHOOK_SECRET] });
    expect(result).toMatchObject({ processed: 5, ignored: 1 });
    expect(statusOf(world, a.id)?.status).toBe('delivered');
    expect(statusOf(world, b.id)).toMatchObject({ status: 'bounced', status_reason: 'Invalid Address: 550 5.1.1 no such user' });
    expect(statusOf(world, c.id)?.status).toBe('dropped');
    const suppressions = await world.op('suppressions.list', { limit: 50 });
    expect(suppressions.data).toMatchObject([{ email: 'b@example.com', reason: 'bounce', contact_id: b.contactId }]);
    expect(world.crm.op('contacts.get', { id: b.contactId }).marketable_status).toBe('bounced');
    const types = (await world.op('events.pending', { limit: 100 })).map((e) => e.type);
    expect(types.filter((t) => t !== 'email.sent')).toEqual(['email.delivered', 'email.bounced']);
  });

  it('treats blocked bounces as refused (no suppression) and matches without the provider id', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const m = await sentMessage(world, 'blocked@example.com', 'rblk');
    const req = await deliver(world, [
      psEvent('b1', 'bounce', { id: m.id, provider_message_id: 'other' }, { type: 'blocked', reason: 'spam content', bounce_classification: 'Content' }),
    ]);
    expect(await world.op('webhooks.provider', { ...req, secrets: [WEBHOOK_SECRET] })).toMatchObject({ processed: 1 });
    expect(statusOf(world, m.id)).toMatchObject({ status: 'dropped', status_reason: 'Content: spam content' });
    expect((await world.op('suppressions.list', { limit: 10 })).data).toEqual([]);
    expect(world.crm.op('contacts.get', { id: m.contactId }).marketable_status).not.toBe('bounced');
    const pending = await world.op('events.pending', { limit: 100 });
    expect(pending.find((e) => e.type === 'email.bounced')?.payload).toMatchObject({ bounceType: 'soft' });
  });

  it('suppresses locally when the provider dropped the message for its suppression list', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const m = await sentMessage(world, 'gone@example.com', 'rdrop');
    const req = await deliver(world, [
      psEvent('d1', 'dropped', m, { reason: 'address is suppressed', bounce_classification: 'Invalid Address' }),
    ]);
    await world.op('webhooks.provider', { ...req, secrets: [WEBHOOK_SECRET] });
    expect((await world.op('suppressions.list', { limit: 10 })).data).toMatchObject([
      { email: 'gone@example.com', reason: 'manual', source: 'provider' },
    ]);
  });

  it('handles provider one-click unsubscribes once: suppression, contact unsubscribed, event', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const m = await sentMessage(world, 'bye@example.com', 'runsub');
    const first = await deliver(world, [psEvent('u1', 'unsubscribe', m)]);
    expect(await world.op('webhooks.provider', { ...first, secrets: [WEBHOOK_SECRET] })).toMatchObject({ processed: 1 });
    world.clock.now += 1000;
    const again = await deliver(world, [psEvent('u2', 'unsubscribe', m)]);
    await world.op('webhooks.provider', { ...again, secrets: [WEBHOOK_SECRET] });
    expect((await world.op('suppressions.list', { limit: 10 })).data).toMatchObject([
      { email: 'bye@example.com', reason: 'unsubscribe', source: 'provider' },
    ]);
    expect(world.crm.op('contacts.get', { id: m.contactId }).marketable_status).toBe('unsubscribed');
    const unsubs = (await world.op('events.pending', { limit: 100 })).filter((e) => e.type === 'email.unsubscribed');
    expect(unsubs).toHaveLength(1);
    expect(unsubs[0]?.payload).toMatchObject({ via: 'provider', email: 'bye@example.com' });
    const row = world.deps.db.all<{ unsubscribed_at: number | null }>(
      `SELECT unsubscribed_at FROM mail_messages WHERE id = ?`,
      m.id,
    )[0];
    expect(row?.unsubscribed_at).not.toBeNull();
  });

  it('turns spam reports into suppressions and auto-suspends sending past the bounce threshold', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const complainer = await sentMessage(world, 'spam@example.com', 'complaint');
    const complaint = await deliver(world, [psEvent('c1', 'spamreport', complainer, { attribution: 'verified' })]);
    await world.op('webhooks.provider', { ...complaint, secrets: [WEBHOOK_SECRET] });
    expect((await world.op('suppressions.list', { limit: 10 })).data[0]).toMatchObject({ reason: 'complaint' });
    expect(world.crm.op('contacts.get', { id: complainer.contactId }).marketable_status).toBe('complained');

    // Fill the window with sends, then bounce more than the threshold.
    const now = world.clock.now;
    for (let i = 0; i < HEALTH_POLICY.minSent; i += 1) {
      world.deps.db.run(
        `INSERT INTO mail_messages (id, request_id, contact_id, status, source_type, sent_at, provider_message_id, created_at, updated_at)
         VALUES (?, ?, 'c', 'sent', 'broadcast', ?, ?, ?, ?)`,
        `bulk${String(i)}`,
        `bulkreq${String(i)}`,
        now,
        `pm${String(i)}`,
        now,
        now,
      );
    }
    const bounces = Array.from({ length: 7 }, (_, i) =>
      psEvent(`b${String(i)}`, 'bounce', { id: `bulk${String(i)}`, provider_message_id: `pm${String(i)}` }, { type: 'bounce' }),
    );
    world.clock.now += 1000;
    const req = await deliver(world, bounces);
    const result = await world.op('webhooks.provider', { ...req, secrets: [WEBHOOK_SECRET] });
    expect(result.suspended).toBe('bounce_rate');
    expect(world.provider.suspended.has('ps_acme')).toBe(true);
    const settings = await world.op('settings.get', {});
    expect(settings.suspension).toMatchObject({ suspended: true, reason: 'bounce_rate' });
    expect(settings.sending.block_reason).toBe('sending_suspended');

    // Suspended tenants send nothing until an admin resumes.
    const other = world.contact({ email: 'next@example.com' });
    await world.op('send.process', { batch: [{ request: sendRequest(other, { id: 'after' }), queueAttempts: 1 }] });
    expect(world.deps.db.all<{ status: string }>(`SELECT status FROM mail_messages WHERE request_id = 'after'`)[0]?.status).toBe('blocked');
    const resumed = await world.op('settings.resume', {});
    expect(resumed.suspension.suspended).toBe(false);
    expect(world.provider.suspended.has('ps_acme')).toBe(false);
  });
});

describe('send outcomes reported by the provider', () => {
  it('skips and suppresses a recipient the provider has on its suppression list', async () => {
    const world = createMailWorld();
    await configureSender(world);
    world.provider.failNext(1, new EmailProviderError('suppressed', false, 403, null, 'suppressed'));
    const contactId = world.contact({ email: 'blocked@example.com' });
    await world.op('send.process', { batch: [{ request: sendRequest(contactId, { id: 'rs' }), queueAttempts: 1 }] });
    expect(
      world.deps.db.all<{ status: string; status_reason: string }>(`SELECT status, status_reason FROM mail_messages WHERE request_id = 'rs'`)[0],
    ).toMatchObject({ status: 'skipped', status_reason: 'suppressed_by_provider' });
    expect((await world.op('suppressions.list', { limit: 10 })).data).toMatchObject([
      { email: 'blocked@example.com', reason: 'manual', source: 'provider' },
    ]);
  });

  it('never resends when the outcome is unknown, and still matches later webhooks', async () => {
    const world = createMailWorld();
    await configureSender(world);
    world.provider.failNext(1, new EmailProviderError('timeout', false, 502, null, 'outcome_unknown'));
    const contactId = world.contact({ email: 'maybe@example.com' });
    const out = await world.op('send.process', { batch: [{ request: sendRequest(contactId, { id: 'ru' }), queueAttempts: 1 }] });
    expect(out).toMatchObject([{ action: 'ack', status: 'sent' }]);
    const row = world.deps.db.all<{ id: string; status: string; status_reason: string; provider_message_id: string | null }>(
      `SELECT id, status, status_reason, provider_message_id FROM mail_messages WHERE request_id = 'ru'`,
    )[0];
    expect(row).toMatchObject({ status: 'sent', status_reason: 'provider_outcome_unknown', provider_message_id: null });
    const req = await deliver(world, [psEvent('ok', 'delivered', { id: row?.id ?? '', provider_message_id: 'late' })]);
    await world.op('webhooks.provider', { ...req, secrets: [WEBHOOK_SECRET] });
    expect(statusOf(world, row?.id ?? '')?.status).toBe('delivered');
  });

  it('sends our message id as a unique arg that does not collide with provider fields', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const m = await sentMessage(world, 'args@example.com', 'rargs');
    expect(world.provider.sent.at(-1)?.metadata).toEqual({ account: expect.any(String), amb_message_id: m.id });
  });
});

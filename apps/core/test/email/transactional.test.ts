import type { EmailSendRequest, QuotaCheck } from '@amable/core';
import { describe, expect, it } from 'vitest';
import { emailRequest } from '../../src/booking/messages';
import { parseEmailSendRequest } from '../../src/email/consumer';
import { setSetting, WARMUP_CAPS } from '../../src/email/settings';
import { configureSender, createMailWorld, sendRequest } from './helpers';

type World = ReturnType<typeof createMailWorld>;

const TRANSACTIONAL: EmailSendRequest['source'] = {
  type: 'transactional',
  purpose: 'booking',
  referenceId: 'bkg_1',
  userId: 'user_owner',
};

const BOOKING_DOC = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hi ' },
        { type: 'liquidVariable', attrs: { path: 'contact.first_name', label: null, fallback: null, filter: null } },
        { type: 'text', text: ', your booking is confirmed.' },
      ],
    },
  ],
};

async function send(world: World, id: string, contactId: string, source: EmailSendRequest['source'] = TRANSACTIONAL) {
  const base = sendRequest(contactId, { id, source });
  const request = { ...base, content: { ...base.content, subject: 'Confirmed', body: BOOKING_DOC } };
  const [outcome] = await world.op('send.process', { batch: [{ request, queueAttempts: 1 }] });
  return outcome;
}

function row(world: World, requestId: string) {
  return world.deps.db.all<{ status: string; status_reason: string | null; source_type: string }>(
    `SELECT status, status_reason, source_type FROM mail_messages WHERE request_id = ?`,
    requestId,
  )[0];
}

describe('transactional sends', () => {
  it('reach contacts who unsubscribed from marketing, without unsubscribe footer or headers', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const contactId = world.contact({ email: 'ada@example.com', given: 'Ada' });
    world.crm.op('contacts.update', { id: contactId, data: { marketable_status: 'unsubscribed' } });
    await world.op('suppressions.add', { email: 'ada@example.com', reason: 'unsubscribe' });

    expect(await send(world, 'marketing', contactId, { type: 'single', userId: 'user_owner' })).toMatchObject({ status: 'skipped' });
    expect(await send(world, 'tx', contactId)).toEqual({ id: 'tx', action: 'ack', status: 'sent' });
    expect(row(world, 'tx')).toMatchObject({ status: 'sent', source_type: 'transactional' });
    const [email] = world.provider.sent;
    expect(email?.to).toBe('ada@example.com');
    expect(email?.headers?.['List-Unsubscribe']).toBeUndefined();
    expect(email?.html).toContain('Hi Ada, your booking is confirmed.');
    expect(email?.html).not.toMatch(/\/unsub\//);
    const events = await world.op('events.pending', {});
    expect(events.find((e) => e.type === 'email.sent')?.payload).toMatchObject({ source: TRANSACTIONAL });
  });

  it('still skip hard-bounced, complaining and manually suppressed addresses', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const bounced = world.contact({ email: 'b@example.com' });
    world.crm.op('contacts.update', { id: bounced, data: { marketable_status: 'bounced' } });
    const complained = world.contact({ email: 'c@example.com' });
    world.crm.op('contacts.update', { id: complained, data: { marketable_status: 'complained' } });
    const manual = world.contact({ email: 'm@example.com' });
    await world.op('suppressions.add', { email: 'm@example.com', reason: 'manual' });
    await send(world, 'b', bounced);
    await send(world, 'c', complained);
    await send(world, 'm', manual);
    expect(row(world, 'b')?.status_reason).toBe('unmarketable: bounced');
    expect(row(world, 'c')?.status_reason).toBe('unmarketable: complained');
    expect(row(world, 'm')).toMatchObject({ status: 'skipped', status_reason: 'suppressed' });
    expect(world.provider.sent).toHaveLength(0);
  });

  it('are blocked on an unverified sending domain', async () => {
    const world = createMailWorld({ verified: false });
    await configureSender(world);
    const contactId = world.contact({});
    expect(await send(world, 'tx', contactId)).toMatchObject({ action: 'ack', status: 'blocked' });
    expect(row(world, 'tx')?.status_reason).toBe('domain_not_verified');
  });

  it('skip the quota guard and the warm-up cap but respect the rate limit', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const checks: QuotaCheck[] = [];
    world.quota.current = {
      check: (input) => {
        checks.push(input);
        return Promise.resolve({ action: 'deny', reason: 'no_balance' });
      },
    };
    const contactId = world.contact({});
    expect(await send(world, 'single', contactId, { type: 'single', userId: 'user_owner' })).toMatchObject({ status: 'skipped' });
    expect(checks).toHaveLength(1);

    setSetting(world.deps, 'warmup_started_at', String(world.clock.now));
    const day = new Date(world.clock.now).toISOString().slice(0, 10);
    world.deps.db.run(`UPDATE mail_counters SET count = ? WHERE bucket = ?`, WARMUP_CAPS[0] ?? 0, `day:${day}`);
    world.deps.db.run(
      `INSERT OR IGNORE INTO mail_counters (bucket, count) VALUES (?, ?)`,
      `day:${day}`,
      WARMUP_CAPS[0] ?? 0,
    );
    expect(await send(world, 'tx', contactId)).toMatchObject({ status: 'sent' });
    expect(checks).toHaveLength(1);

    await world.op('settings.update', { rate_per_minute: 1 });
    const other = world.contact({ email: 'z@example.com' });
    expect(await send(world, 'tx2', other)).toMatchObject({ action: 'retry', reason: 'rate_limit' });
  });

  it('booking emails render contact Liquid and reach unsubscribed invitees', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const contactId = world.contact({ email: 'ada@example.com', given: 'Ada' });
    world.crm.op('contacts.update', { id: contactId, data: { marketable_status: 'unsubscribed' } });
    const request = emailRequest({
      id: 'booking:bkg_1:confirmation:0',
      tenantId: sendRequest(contactId).tenantId,
      contactId,
      bookingId: 'bkg_1',
      hostUserId: 'user_owner',
      kind: 'confirmation',
      messages: { confirmation_subject: '', confirmation_body: '', reminder_subject: '', reminder_body: '' },
      vars: {
        eventTitle: 'Intro call',
        startsAt: Date.UTC(2026, 9, 20, 8),
        endsAt: Date.UTC(2026, 9, 20, 8, 30),
        timeZone: 'Europe/Rome',
        locale: 'en',
        hostName: 'Owner',
        location: '',
        manageUrl: 'https://t.acme.test/b/acme/manage/tok',
        inviteeName: 'Ada',
      },
      now: world.clock.now,
      notAfter: null,
    });
    expect(request.source).toEqual({ type: 'transactional', purpose: 'booking', referenceId: 'bkg_1', userId: 'user_owner' });
    const [outcome] = await world.op('send.process', { batch: [{ request, queueAttempts: 1 }] });
    expect(outcome).toMatchObject({ status: 'sent' });
    const [email] = world.provider.sent;
    expect(email?.html).toContain('Hi Ada,');
    expect(email?.text).toContain('Hi Ada,');
    expect(email?.html).not.toContain('{{');
  });

  it('are validated by the queue consumer', () => {
    const contactId = 'con_1';
    expect(parseEmailSendRequest(sendRequest(contactId, { source: TRANSACTIONAL }))).not.toBeNull();
    expect(parseEmailSendRequest(sendRequest(contactId, { source: { ...TRANSACTIONAL, userId: null } }))).not.toBeNull();
    const bad = { ...sendRequest(contactId), source: { type: 'transactional', purpose: 'newsletter', referenceId: 'x', userId: null } };
    expect(parseEmailSendRequest(bad)).toBeNull();
  });
});

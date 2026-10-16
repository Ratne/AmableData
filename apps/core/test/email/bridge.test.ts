import type { EmailSendSource } from '@amable/core';
import { describe, expect, it } from 'vitest';
import type { BridgedEmailEvent } from '../../src/crm/email-events';
import { bridgeEmailEvents, hasPendingEmailEvents } from '../../src/email/bridge';
import { emitEmailEvent } from '../../src/email/outbox';
import { configureSender, createMailWorld, sendRequest, type MailWorld } from './helpers';

const SOURCE: EmailSendSource = { type: 'single', userId: 'user_owner' };

function crmEmailOutbox(world: MailWorld): Array<{ id: string; type: string; payload: Record<string, unknown> }> {
  return world.crm.db
    .all<{ id: string; type: string; payload: string }>(
      `SELECT id, type, payload FROM crm_outbox WHERE type LIKE 'email.%' ORDER BY id`,
    )
    .map((r) => ({ id: r.id, type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}

function timeline(world: MailWorld, contactId: string): Array<{ type: string; data: Record<string, unknown> }> {
  return world.crm
    .op('timeline', { subject: 'contact', id: contactId, limit: 100 })
    .data.filter((a) => a.type.startsWith('email.'))
    .reverse()
    .map((a) => ({ type: a.type, data: a.data }));
}

async function sentMessageId(world: MailWorld, contactId: string): Promise<string> {
  await world.op('send.process', { batch: [{ request: sendRequest(contactId, { id: 'm1' }), queueAttempts: 1 }] });
  const row = world.deps.db.all<{ id: string }>(`SELECT id FROM mail_messages`)[0];
  if (row === undefined) throw new Error('no message');
  return row.id;
}

describe('email events bridge (MailDb outbox → CRM outbox + timeline)', () => {
  it('forwards every email event type to the CRM bus and the contact timeline', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const contactId = world.contact({});
    const messageId = await sentMessageId(world, contactId);
    const refs = { messageId, contactId, source: SOURCE };
    world.deps.db.transaction(() => {
      emitEmailEvent(world.deps, 'email.delivered', refs);
      emitEmailEvent(world.deps, 'email.opened', { ...refs, unique: true });
      emitEmailEvent(world.deps, 'email.link_clicked', { ...refs, url: 'https://shop.example.com/', linkIndex: 0, unique: true });
      emitEmailEvent(world.deps, 'email.bounced', { ...refs, bounceType: 'soft', reason: 'mailbox full' });
      emitEmailEvent(world.deps, 'email.complained', refs);
      emitEmailEvent(world.deps, 'email.unsubscribed', { ...refs, email: 'ada@example.com', via: 'link' });
    });
    expect(await bridgeEmailEvents(world.deps)).toEqual({ bridged: 7, skipped: 0 });
    expect(hasPendingEmailEvents(world.deps)).toBe(false);
    expect(world.kicks.count).toBe(1);

    const types = [
      'email.sent',
      'email.delivered',
      'email.opened',
      'email.link_clicked',
      'email.bounced',
      'email.complained',
      'email.unsubscribed',
    ];
    const bus = crmEmailOutbox(world);
    expect(bus.map((e) => e.type)).toEqual(types);
    // The ids are the MailDb ones; the payload keeps `emailId` for automations and webhooks.
    const mailIds = world.deps.db.all<{ id: string }>(`SELECT id FROM mail_outbox ORDER BY id`).map((r) => r.id);
    expect(bus.map((e) => e.id)).toEqual(mailIds);
    expect(bus[3]?.payload).toMatchObject({ contactId, emailId: messageId, messageId, url: 'https://shop.example.com/', source: SOURCE });
    // Picked up by the engine drain like any other CRM event.
    expect(world.crm.op('events.pending', { limit: 100 }).filter((e) => e.type.startsWith('email.'))).toHaveLength(7);

    const activities = timeline(world, contactId);
    expect(activities.map((a) => a.type)).toEqual(types);
    expect(activities[0]?.data).toMatchObject({ subject: 'Hello Ada', emailId: messageId });
  });

  it('is idempotent across redeliveries and skips test sends and repeat opens', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const contactId = world.contact({});
    const messageId = await sentMessageId(world, contactId);
    const refs = { messageId, contactId, source: SOURCE };
    world.deps.db.transaction(() => {
      emitEmailEvent(world.deps, 'email.opened', { ...refs, unique: true });
      emitEmailEvent(world.deps, 'email.opened', { ...refs, unique: false });
      emitEmailEvent(world.deps, 'email.sent', { ...refs, source: null, providerMessageId: null });
    });
    const pending = await world.op('events.pending', { limit: 100 });
    expect(await bridgeEmailEvents(world.deps)).toEqual({ bridged: 2, skipped: 2 });

    // Same batch again (e.g. the ack was lost): nothing new on the bus nor in the timeline.
    const replay: BridgedEmailEvent[] = pending
      .filter((e) => e.payload.source !== null && !(e.type === 'email.opened' && !e.payload.unique))
      .map((e) => ({
        id: e.id,
        type: e.type,
        occurredAt: Date.parse(e.occurredAt),
        contactId,
        payload: { ...e.payload },
      }));
    expect(replay).toHaveLength(2);
    expect(world.crm.op('mail.recordEvents', { events: replay })).toEqual({ recorded: 0, duplicates: 2 });
    expect(crmEmailOutbox(world).map((e) => e.type)).toEqual(['email.sent', 'email.opened']);
    expect(timeline(world, contactId)).toHaveLength(2);
    // Nothing left: a second run neither writes nor kicks the engine.
    expect(await bridgeEmailEvents(world.deps)).toEqual({ bridged: 0, skipped: 0 });
    expect(world.kicks.count).toBe(1);
  });

  it('pages large backlogs, chunks SQL parameters and keeps deleted contacts off the timeline', async () => {
    const world = createMailWorld();
    const live = world.contact({ email: 'live@example.com' });
    const gone = world.contact({ email: 'gone@example.com', given: 'Gone' });
    world.crm.op('contacts.delete', { id: gone });
    world.deps.db.transaction(() => {
      for (let i = 0; i < 450; i += 1) {
        const contactId = i === 0 ? live : i === 1 ? gone : `ct_missing_${String(i)}`;
        emitEmailEvent(world.deps, 'email.delivered', { messageId: `msg_${String(i)}`, contactId, source: SOURCE });
      }
    });
    // The helpers reject statements with more than 100 parameters on both databases.
    expect(await bridgeEmailEvents(world.deps)).toEqual({ bridged: 450, skipped: 0 });
    expect(crmEmailOutbox(world)).toHaveLength(450);
    expect(timeline(world, live)).toHaveLength(1);
    const orphans = world.crm.db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM crm_activities WHERE type LIKE 'email.%' AND contact_id <> ?`,
      live,
    )[0];
    expect(orphans?.n).toBe(0);
  });

  it('acks nothing when the CRM write fails', async () => {
    const world = createMailWorld();
    const contactId = world.contact({});
    emitEmailEvent(world.deps, 'email.delivered', { messageId: 'msg_1', contactId, source: SOURCE });
    const failing = {
      ...world.deps,
      crm: { ...world.deps.crm, recordEvents: () => Promise.reject(new Error('tenant db down')) },
    };
    await expect(bridgeEmailEvents(failing)).rejects.toThrow('tenant db down');
    expect(hasPendingEmailEvents(world.deps)).toBe(true);
    expect(await bridgeEmailEvents(world.deps)).toEqual({ bridged: 1, skipped: 0 });
  });

  it('rejects oversized batches and non-email events', () => {
    const world = createMailWorld();
    const event = (i: number): BridgedEmailEvent => ({
      id: `01J${String(i).padStart(23, '0')}`,
      type: 'email.sent',
      occurredAt: world.clock.now,
      contactId: 'ct',
      payload: {},
    });
    expect(() =>
      world.crm.op('mail.recordEvents', { events: Array.from({ length: 201 }, (_, i) => event(i)) }),
    ).toThrow(/at most 200/);
    expect(() =>
      world.crm.op('mail.recordEvents', { events: [{ ...event(1), type: 'contact.created' as never }] }),
    ).toThrow(/not an email event/);
  });
});

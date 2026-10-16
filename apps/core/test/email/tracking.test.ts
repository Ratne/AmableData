import { CONTACT_TOKEN_PARAM, signEmailToken, verifyContactToken, verifyEmailToken } from '@amable/core';
import { describe, expect, it } from 'vitest';
import { bridgeEmailEvents } from '../../src/email/bridge';
import { rewriteLinks } from '../../src/email/render';
import { configureSender, createMailWorld, ORIGIN, SECRET, sendRequest, TENANT_ID } from './helpers';

async function sendOne(world: ReturnType<typeof createMailWorld>, contactId: string) {
  await world.op('send.process', { batch: [{ request: sendRequest(contactId, { id: 'm1' }), queueAttempts: 1 }] });
  const html = world.provider.sent.at(-1)?.html ?? '';
  const clicks = [...html.matchAll(/\/r\/([^"]+)"/g)].map((m) => m[1] ?? '');
  const open = /\/o\/([^"]+)"/.exec(html)?.[1] ?? '';
  const unsub = /\/unsub\/([^>"]+)/.exec(world.provider.sent.at(-1)?.headers?.['List-Unsubscribe'] ?? '')?.[1] ?? '';
  return { clicks, open, unsub };
}

describe('link rewriting and signed tokens', () => {
  it('rewrites only external http(s) links and keeps the tracking origin untouched', async () => {
    const html =
      '<a href="https://a.test/x?y=1&amp;z=2">A</a><a href="mailto:x@y.z">M</a>' +
      `<a href="${ORIGIN}/unsub/abc">U</a><a href="http://b.test/">B</a>`;
    const out = await rewriteLinks(html, {
      origin: ORIGIN,
      secret: SECRET,
      tenantId: TENANT_ID,
      messageId: 'msg',
      contactId: 'ct',
    });
    expect(out.links).toEqual([
      { position: 0, url: 'https://a.test/x?y=1&z=2' },
      { position: 1, url: 'http://b.test/' },
    ]);
    expect(out.html).toContain('href="mailto:x@y.z"');
    expect(out.html).toContain(`href="${ORIGIN}/unsub/abc"`);
    expect(out.html).not.toContain('a.test');
  });

  it('rejects forged, tampered and wrong-kind tokens', async () => {
    const token = await signEmailToken(SECRET, { k: 'open', t: TENANT_ID, m: 'm', c: 'c' });
    expect(await verifyEmailToken([SECRET], token, 'open')).toMatchObject({ m: 'm' });
    expect(await verifyEmailToken(['other-secret'], token, 'open')).toBeNull();
    expect(await verifyEmailToken([SECRET], token, 'click')).toBeNull();
    const [body = '', mac = ''] = token.split('.');
    const tampered = `${body.slice(0, -2)}AA.${mac}`;
    expect(await verifyEmailToken([SECRET], tampered, 'open')).toBeNull();
    // Rotation: an old secret still verifies when listed.
    expect(await verifyEmailToken(['new-secret', SECRET], token, 'open')).not.toBeNull();
    // A click token must carry an http(s) destination.
    const bad = await signEmailToken(SECRET, { k: 'click', t: 't', m: 'm', c: 'c', l: 0, u: 'javascript:alert(1)' });
    expect(await verifyEmailToken([SECRET], bad, 'click')).toBeNull();
  });

  it('records clicks, appends the signed contact token and bridges goals to the CRM event bus', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const contactId = world.contact({});
    const { clicks, open } = await sendOne(world, contactId);
    const result = await world.op('track.click', { token: clicks[1] ?? '' });
    const url = new URL(result?.url ?? 'x:');
    expect(`${url.origin}${url.pathname}`).toBe('https://shop.example.com/');
    const identity = await verifyContactToken([SECRET], url.searchParams.get(CONTACT_TOKEN_PARAM) ?? '', {
      nowMs: world.clock.now,
    });
    expect(identity).toMatchObject({ t: TENANT_ID, c: contactId });
    await world.op('track.click', { token: clicks[1] ?? '' });
    await world.op('track.open', { token: open });
    await world.op('track.open', { token: open });
    const row = world.deps.db.all<{ click_count: number; open_count: number; opened_at: number | null }>(
      `SELECT click_count, open_count, opened_at FROM mail_messages`,
    )[0];
    expect(row).toMatchObject({ click_count: 2, open_count: 2 });
    expect(row?.opened_at).not.toBeNull();
    const events = (await world.op('events.pending', {})).map((e) => e.type);
    // The first click implies the open (images blocked); later pixel loads are repeat opens.
    expect(events).toEqual([
      'email.sent',
      'email.opened',
      'email.link_clicked',
      'email.link_clicked',
      'email.opened',
      'email.opened',
    ]);
    // The CRM bus receives the send, the first open and every click; repeat opens stay in the MailDb.
    expect(await bridgeEmailEvents(world.deps)).toEqual({ bridged: 4, skipped: 2 });
    expect(world.kicks.count).toBe(1);
    expect(await world.op('track.click', { token: 'garbage.token' })).toBeNull();
  });
});

describe('unsubscribe flow', () => {
  it('shows a masked address, suppresses, marks the contact and emits one event', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const contactId = world.contact({ email: 'ada@example.com' });
    const { unsub } = await sendOne(world, contactId);
    const info = await world.op('unsubscribe.info', { token: unsub });
    expect(info).toEqual({ valid: true, email: 'ad•@example.com', alreadyUnsubscribed: false });

    expect(await world.op('unsubscribe.confirm', { token: unsub, via: 'one_click' })).toEqual({ ok: true });
    expect(await world.op('unsubscribe.confirm', { token: unsub, via: 'link' })).toEqual({ ok: true });
    expect((await world.op('unsubscribe.info', { token: unsub })).alreadyUnsubscribed).toBe(true);
    const suppressions = await world.op('suppressions.list', { limit: 50 });
    expect(suppressions.data).toMatchObject([{ email: 'ada@example.com', reason: 'unsubscribe', source: 'one_click' }]);
    expect(world.crm.op('contacts.get', { id: contactId }).marketable_status).toBe('unsubscribed');
    const events = (await world.op('events.pending', {})).filter((e) => e.type === 'email.unsubscribed');
    expect(events).toHaveLength(1);

    // Future sends are skipped.
    await world.op('send.process', { batch: [{ request: sendRequest(contactId, { id: 'm2' }), queueAttempts: 1 }] });
    expect(world.provider.sent).toHaveLength(1);
    expect(await world.op('unsubscribe.info', { token: 'nope.nope' })).toMatchObject({ valid: false });
  });
});

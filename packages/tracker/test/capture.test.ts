import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conversionOf,
  fieldKind,
  normalizeEmail,
  normalizePhone,
  readDirectLink,
  readLinkAttribution,
} from '../src/capture';
import { cookieMap, openPage, type Page } from './helpers';

const T0 = Date.UTC(2026, 9, 15, 10, 0, 0);
const HASH = 'A'.repeat(8) + 'b'.repeat(56);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function input(page: Page, id: string): HTMLInputElement {
  const el = page.win.document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el as HTMLInputElement;
}

function type(page: Page, id: string, value: string, event: 'blur' | 'change' = 'blur'): void {
  const el = input(page, id);
  el.value = value;
  el.dispatchEvent(new page.dom.window.Event(event));
}

const identifies = (page: Page) => page.sent.filter((e) => e.type === 'identify');

const tick = (): Promise<void> => new Promise((r) => queueMicrotask(r));

describe('normalization', () => {
  it('emails: trimmed, lower-cased, shape-checked', () => {
    expect(normalizeEmail('  Mario.Rossi@Example.COM ')).toBe('mario.rossi@example.com');
    expect(normalizeEmail('not-an-email')).toBeUndefined();
    expect(normalizeEmail('a@b')).toBeUndefined();
  });

  it('phones: separators dropped, 00 becomes +, unprefixed digits kept', () => {
    expect(normalizePhone('+39 (333) 123-4567')).toBe('+393331234567');
    expect(normalizePhone('0039 333.123.4567')).toBe('+393331234567');
    expect(normalizePhone('333 1234567')).toBe('3331234567');
    expect(normalizePhone('call me')).toBeUndefined();
    expect(normalizePhone('12')).toBeUndefined();
  });

  it('classifies fields by type, autocomplete, name and id; never passwords, hidden or cards', () => {
    const page = openPage({
      body: `
        <input id="a" type="email">
        <input id="b" type="tel">
        <input id="c" type="text" name="user_email">
        <input id="d" type="text" name="cellulare">
        <input id="e" type="text" name="Telefono_casa">
        <input id="mobile" type="text">
        <input id="f" type="text" autocomplete="tel-national">
        <input id="g" type="password" name="email">
        <input id="h" type="hidden" name="email">
        <input id="i" type="text" name="cc-number" autocomplete="cc-number">
        <input id="j" type="text" name="hotel_name">
        <input id="k" type="text" name="first_name">
        <input id="l" type="email" data-amb-ignore>
        <input id="m" type="text" name="mobile_phone">
        <input id="n" type="tel" name="card_phone_pin">`,
    });
    const kinds = Object.fromEntries(
      'abcdefghijklmn'.split('').map((id) => [id, fieldKind(input(page, id)) ?? null]),
    );
    expect(kinds).toEqual({
      a: 'email',
      b: 'phone',
      c: 'email',
      d: 'phone',
      e: 'phone',
      f: 'phone',
      g: null,
      h: null,
      i: null,
      j: null,
      k: null,
      l: null,
      m: 'phone',
      n: null,
    });
    expect(fieldKind(input(page, 'mobile'))).toBe('phone');
  });
});

describe('form capture', () => {
  const FORM = `
    <form id="form" action="/subscribe">
      <input id="name" name="first_name" type="text">
      <input id="email" name="email" type="email">
      <input id="phone" name="telefono" type="text">
      <input id="pwd" name="password" type="password">
      <input id="secret" name="email_token" type="hidden" value="hidden@example.com">
      <textarea id="notes" name="notes"></textarea>
      <button id="go" type="submit">go</button>
    </form>`;

  it('identifies on blur before any submit, with normalized values only', () => {
    const page = openPage({ body: FORM });
    type(page, 'name', 'Mario');
    type(page, 'pwd', 'hunter2@example.com');
    expect(identifies(page)).toHaveLength(0);
    type(page, 'email', ' Mario@Example.com ');
    expect(identifies(page)).toHaveLength(1);
    expect(identifies(page)[0]?.data).toEqual({ email: 'mario@example.com' });
    type(page, 'phone', '0039 333-123 4567', 'change');
    expect(identifies(page).at(-1)?.data).toEqual({
      email: 'mario@example.com',
      phone: '+393331234567',
    });
    const body = JSON.stringify(page.sent);
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('Mario"');
    expect(body).not.toContain('hidden@example.com');
  });

  it('dedupes by value across blur, change and submit', () => {
    const page = openPage({ body: FORM });
    type(page, 'email', 'a@example.com');
    type(page, 'email', 'A@example.com', 'change');
    const form = page.win.document.getElementById('form') as HTMLFormElement;
    form.addEventListener('submit', (e) => e.preventDefault());
    form.dispatchEvent(new page.dom.window.Event('submit', { cancelable: true }));
    expect(identifies(page)).toHaveLength(1);
    type(page, 'email', 'b@example.com');
    expect(identifies(page).map((e) => e.data)).toEqual([
      { email: 'a@example.com' },
      { email: 'b@example.com' },
    ]);
  });

  it('submit reads the whole form when fields were filled programmatically', () => {
    const page = openPage({ body: FORM });
    input(page, 'email').value = 'auto@example.com';
    input(page, 'phone').value = '+1 (555) 010-9999';
    input(page, 'pwd').value = 'secret';
    const form = page.win.document.getElementById('form') as HTMLFormElement;
    form.addEventListener('submit', (e) => e.preventDefault());
    form.dispatchEvent(new page.dom.window.Event('submit', { cancelable: true }));
    expect(identifies(page)).toEqual([
      expect.objectContaining({
        type: 'identify',
        data: { email: 'auto@example.com', phone: '+15550109999' },
      }),
    ]);
  });

  it('ignores invalid values and honours data-no-forms', () => {
    const page = openPage({ body: FORM });
    type(page, 'email', 'half@typed');
    expect(identifies(page)).toHaveLength(0);
    const off = openPage({ body: FORM, attrs: { 'data-no-forms': '' } });
    type(off, 'email', 'a@example.com');
    expect(identifies(off)).toHaveLength(0);
  });
});

describe('he / sl / el', () => {
  it('parses plain or hashed emails and source labels', () => {
    expect(readLinkAttribution(new URLSearchParams('he=Mario%40Example.com&el=email&sl=fb_group'))).toEqual({
      he: 'mario@example.com',
      el: 'email',
      sl: 'fb_group',
    });
    expect(readLinkAttribution(new URLSearchParams(`he=${HASH}`))).toEqual({ he: HASH.toLowerCase() });
    // Unencoded alias: `+` decodes to a space.
    expect(readLinkAttribution(new URLSearchParams('he=a+tag@example.com'))?.he).toBe('a+tag@example.com');
    expect(readLinkAttribution(new URLSearchParams('he=garbage&el=<b>'))).toEqual({ el: 'b' });
    expect(readLinkAttribution(new URLSearchParams('utm_source=x'))).toBeUndefined();
  });

  it('sends them with the landing pageview only, next to click ids, and strips he from the URL', () => {
    const page = openPage({
      url: 'https://www.example.com/offer?gclid=G1&utm_source=nl&he=Mario%40Example.com&el=launch&sl=partner',
    });
    expect(page.win.location.href).toBe('https://www.example.com/offer?gclid=G1&utm_source=nl&el=launch&sl=partner');
    const pv = page.sent[0];
    expect(pv).toMatchObject({
      type: 'pageview',
      url: 'https://www.example.com/offer?gclid=G1&utm_source=nl&el=launch&sl=partner',
      clk: { gclid: 'G1' },
      src: { utm_source: 'nl' },
      la: { he: 'mario@example.com', el: 'launch', sl: 'partner' },
    });
    // A plain email also identifies through the v1 identify event.
    expect(page.sent[1]).toMatchObject({ type: 'identify', data: { email: 'mario@example.com' } });
    page.win.history.pushState({}, '', '/next');
    expect(page.sent.at(-1)?.la).toBeUndefined();
    expect(JSON.stringify(page.sent.slice(2))).not.toContain('mario@');
  });

  it('a hashed he never produces an identify event', () => {
    const page = openPage({ url: `https://www.example.com/?he=${HASH}` });
    expect(page.sent.map((e) => e.type)).toEqual(['pageview']);
    expect(page.sent[0]?.la).toEqual({ he: HASH.toLowerCase() });
  });
});

describe('direct-link context', () => {
  it('reads f/ts/n/p only when a funnel id or funnel vid is present', () => {
    expect(readDirectLink(new URLSearchParams('p=123&n=4'), {})).toEqual({});
    expect(readDirectLink(new URLSearchParams('f=fun1&ts=src2&n=nd3&p=pg4'), { f: 'old', n: 'x' })).toEqual({
      f: 'fun1',
      ts: 'src2',
      n: 'nd3',
      p: 'pg4',
    });
    expect(
      readDirectLink(new URLSearchParams('vid=v1234567890&n=nd9'), { f: 'fun1', ts: 'src2', n: 'nd3' }),
    ).toEqual({ f: 'fun1', ts: 'src2', n: 'nd9', vid: 'v1234567890' });
    expect(readDirectLink(new URLSearchParams('f=bad%20id'), { f: 'keep' })).toEqual({ f: 'keep' });
  });

  it('is sent with every event and kept across page loads of the session', () => {
    const page = openPage({ url: 'https://www.example.com/lander?f=fun1&ts=src2&n=nd3&p=pg4&campaign=x' });
    const dl = { f: 'fun1', ts: 'src2', n: 'nd3', p: 'pg4' };
    expect(page.sent[0]).toMatchObject({ type: 'pageview', dl });
    page.handle.command('goal', 'clicked');
    expect(page.sent.at(-1)).toMatchObject({ type: 'goal', dl });
    const stored = page.win.sessionStorage.getItem('amb_dl');
    const next = openPage({
      url: 'https://www.example.com/offer',
      before: (win) => win.sessionStorage.setItem('amb_dl', stored ?? ''),
    });
    expect(next.sent[0]?.dl).toEqual(dl);
  });

  it('cookieless build keeps the context in memory only', () => {
    const page = openPage({
      url: 'https://www.example.com/lander?f=fun1&n=nd3',
      options: { cookieless: true },
    });
    expect(page.sent[0]).toMatchObject({ cl: 1, dl: { f: 'fun1', n: 'nd3' } });
    expect(page.win.sessionStorage.getItem('amb_dl')).toBeNull();
    expect(page.win.document.cookie).toBe('');
  });

  it("amable('context') updates the node used by action links", () => {
    const page = openPage({ body: '<a id="a" href="https://trk.example.com/a/1">go</a>' });
    page.handle.command('context', { n: 'nd7', junk: { x: 1 } });
    const a = page.win.document.getElementById('a') as HTMLAnchorElement;
    expect(new URL(a.href).searchParams.get('rn')).toBe('nd7');
    page.handle.command('pageview');
    vi.setSystemTime(T0 + 61_000);
    page.handle.command('pageview');
    expect(page.sent.at(-1)?.dl).toEqual({ n: 'nd7' });
  });
});

describe('action links', () => {
  const LINKS = `
    <a id="a1" href="https://trk.example.com/a/1">a1</a>
    <a id="a2" href="/go/fun1/nd3/a/2?x=1">a2</a>
    <a id="a3" href="https://shop.example.org/buy" data-amb-action>a3</a>
    <a id="plain" href="https://other.org/a/b">plain</a>
    <a id="pre" href="https://trk.example.com/a/3?vid=keep1234&rn=keep">pre</a>`;

  it('appends vid (funnel vid first, cookie otherwise) and rn, without double append', async () => {
    const page = openPage({ url: 'https://www.example.com/lander?f=fun1&n=nd3', body: LINKS });
    const vid = cookieMap(page.win)['amb_vid'];
    const href = (id: string): string =>
      (page.win.document.getElementById(id) as HTMLAnchorElement).href;
    expect(href('a1')).toBe(`https://trk.example.com/a/1?vid=${vid}&rn=nd3`);
    expect(href('a2')).toBe(`https://www.example.com/go/fun1/nd3/a/2?x=1&vid=${vid}&rn=nd3`);
    expect(href('a3')).toBe(`https://shop.example.org/buy?vid=${vid}&rn=nd3`);
    expect(href('plain')).toBe('https://other.org/a/b');
    expect(href('pre')).toBe('https://trk.example.com/a/3?vid=keep1234&rn=keep');

    // Click decoration and the observer are idempotent.
    page.win.document.addEventListener('click', (e) => e.preventDefault());
    (page.win.document.getElementById('a1') as HTMLAnchorElement).click();
    await tick();
    expect(href('a1')).toBe(`https://trk.example.com/a/1?vid=${vid}&rn=nd3`);
    // Action clicks are funnel actions, not external links.
    expect(page.sent.some((e) => e.type === 'external_link')).toBe(false);

    const funnelVid = openPage({
      url: 'https://www.example.com/lander?vid=FUNNELVID01&n=nd5',
      body: '<a id="x" href="https://trk.example.com/a/2">x</a>',
    });
    expect((funnelVid.win.document.getElementById('x') as HTMLAnchorElement).href).toBe(
      'https://trk.example.com/a/2?vid=FUNNELVID01&rn=nd5',
    );
  });

  it('decorates links added later by an SPA (MutationObserver) once', async () => {
    const page = openPage({ url: 'https://www.example.com/lander?f=fun1&n=nd3' });
    const vid = cookieMap(page.win)['amb_vid'];
    const doc = page.win.document;
    const a = doc.createElement('a');
    a.id = 'late';
    a.href = 'https://trk.example.com/a/4';
    doc.body.appendChild(a);
    await tick();
    await tick();
    expect(a.href).toBe(`https://trk.example.com/a/4?vid=${vid}&rn=nd3`);
    a.setAttribute('href', 'https://trk.example.com/a/5');
    await tick();
    await tick();
    expect(a.href).toBe(`https://trk.example.com/a/5?vid=${vid}&rn=nd3`);
    expect(a.href.match(/vid=/g)).toHaveLength(1);
  });

  it('cookieless without context leaves action links untouched', () => {
    const page = openPage({ options: { cookieless: true }, body: LINKS });
    expect((page.win.document.getElementById('a1') as HTMLAnchorElement).href).toBe(
      'https://trk.example.com/a/1',
    );
  });
});

describe('conversion', () => {
  it('validates value, currency and tx', () => {
    expect(conversionOf({ value: '12.99', currency: 'eur', tx: ' T-1 ' })).toEqual({
      value: 12.99,
      currency: 'EUR',
      tx: 'T-1',
    });
    expect(conversionOf(undefined)).toEqual({});
    expect(conversionOf({ value: -1 })).toBeUndefined();
    expect(conversionOf({ value: 'abc' })).toBeUndefined();
    expect(conversionOf({ currency: 'euro' })).toBeUndefined();
  });

  it("serializes amable('conversion') as a v1 goal with the session context", () => {
    const page = openPage({ url: 'https://www.example.com/thanks?f=fun1&ts=src2&n=nd8' });
    page.handle.command('conversion', { value: 49, currency: 'usd', tx: 'ord_1', email: 'x@y.z' });
    page.handle.command('conversion', { value: 'nope' });
    const conversions = page.sent.filter((e) => e.type === 'goal');
    expect(conversions).toHaveLength(1);
    expect(conversions[0]).toMatchObject({
      type: 'goal',
      name: 'conversion',
      data: { value: 49, currency: 'USD', tx: 'ord_1' },
      dl: { f: 'fun1', ts: 'src2', n: 'nd8' },
    });
    expect(conversions[0]?.data).not.toHaveProperty('email');
  });
});

describe('emitted params snapshot', () => {
  it('landing pageview, identify and conversion of a direct-link funnel page', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: 'Europe/Rome',
    } as Intl.ResolvedDateTimeFormatOptions);
    const page = openPage({
      url: 'https://www.example.com/lander?f=fun1&ts=src2&n=nd3&p=pg4&fbclid=FB&he=lead%40example.com&el=newsletter&sl=partner',
      body: '<input id="tel" type="tel">',
    });
    type(page, 'tel', '+39 333 000 1111');
    page.handle.command('conversion', { value: 10, currency: 'EUR', tx: 'tx1' });
    const strip = ({ vid: _v, sid: _s, ...rest }: Record<string, unknown>) => rest;
    expect(page.sent.map((e) => strip(e as unknown as Record<string, unknown>))).toMatchInlineSnapshot(`
      [
        {
          "clk": {
            "fbclid": "FB",
          },
          "dl": {
            "f": "fun1",
            "n": "nd3",
            "p": "pg4",
            "ts": "src2",
          },
          "fs": 1792058400000,
          "la": {
            "el": "newsletter",
            "he": "lead@example.com",
            "sl": "partner",
          },
          "lang": "en-US",
          "ref": "https://www.google.com/",
          "sh": 0,
          "site": "site_test",
          "sn": 1,
          "sw": 0,
          "type": "pageview",
          "tz": "Europe/Rome",
          "url": "https://www.example.com/lander?f=fun1&ts=src2&n=nd3&p=pg4&fbclid=FB&el=newsletter&sl=partner",
          "vh": 768,
          "vw": 1024,
        },
        {
          "clk": {
            "fbclid": "FB",
          },
          "data": {
            "email": "lead@example.com",
          },
          "dl": {
            "f": "fun1",
            "n": "nd3",
            "p": "pg4",
            "ts": "src2",
          },
          "fs": 1792058400000,
          "lang": "en-US",
          "ref": "https://www.google.com/",
          "sh": 0,
          "site": "site_test",
          "sn": 1,
          "sw": 0,
          "type": "identify",
          "tz": "Europe/Rome",
          "url": "https://www.example.com/lander?f=fun1&ts=src2&n=nd3&p=pg4&fbclid=FB&el=newsletter&sl=partner",
          "vh": 768,
          "vw": 1024,
        },
        {
          "clk": {
            "fbclid": "FB",
          },
          "data": {
            "email": "lead@example.com",
            "phone": "+393330001111",
          },
          "dl": {
            "f": "fun1",
            "n": "nd3",
            "p": "pg4",
            "ts": "src2",
          },
          "fs": 1792058400000,
          "lang": "en-US",
          "ref": "https://www.google.com/",
          "sh": 0,
          "site": "site_test",
          "sn": 1,
          "sw": 0,
          "type": "identify",
          "tz": "Europe/Rome",
          "url": "https://www.example.com/lander?f=fun1&ts=src2&n=nd3&p=pg4&fbclid=FB&el=newsletter&sl=partner",
          "vh": 768,
          "vw": 1024,
        },
        {
          "clk": {
            "fbclid": "FB",
          },
          "data": {
            "currency": "EUR",
            "tx": "tx1",
            "value": 10,
          },
          "dl": {
            "f": "fun1",
            "n": "nd3",
            "p": "pg4",
            "ts": "src2",
          },
          "fs": 1792058400000,
          "lang": "en-US",
          "name": "conversion",
          "ref": "https://www.google.com/",
          "sh": 0,
          "site": "site_test",
          "sn": 1,
          "sw": 0,
          "type": "goal",
          "tz": "Europe/Rome",
          "url": "https://www.example.com/lander?f=fun1&ts=src2&n=nd3&p=pg4&fbclid=FB&el=newsletter&sl=partner",
          "vh": 768,
          "vw": 1024,
        },
      ]
    `);
  });
});

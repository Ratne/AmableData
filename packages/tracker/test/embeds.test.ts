import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { embedSignal } from '../src/embeds';
import { openPage, type Page } from './helpers';

const T0 = Date.UTC(2026, 9, 15, 10, 0, 0);
const PAGE = 'https://www.example.com';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const identifies = (page: Page) =>
  page.sent.filter((e) => e.type === 'identify').map((e) => e.data);
const goals = (page: Page) =>
  page.sent.filter((e) => e.type === 'goal').map((e) => [e.name, e.data]);

function message(page: Page, origin: string, data: unknown, source: unknown = null): void {
  const event = new page.dom.window.MessageEvent('message', { data, origin });
  if (source !== null) Object.defineProperty(event, 'source', { value: source });
  page.win.dispatchEvent(event);
}

describe('provider messages', () => {
  it('maps schedulers and form builders, only from their own origins', () => {
    expect(
      embedSignal('https://calendly.com', PAGE, { event: 'calendly.event_scheduled' }),
    ).toEqual({
      goal: 'booking_scheduled',
      form: 'calendly',
    });
    expect(
      embedSignal('https://evil.test', PAGE, { event: 'calendly.event_scheduled' }),
    ).toBeUndefined();
    expect(
      embedSignal('https://app.cal.com', PAGE, { originator: 'CAL', type: 'bookingSuccessfulV2' }),
    ).toEqual({
      goal: 'booking_scheduled',
      form: 'cal',
    });
    expect(
      embedSignal('https://form.typeform.com', PAGE, { type: 'form-submit', embedId: 'e1' }),
    ).toEqual({
      goal: 'form_submit',
      form: 'typeform:e1',
    });
    expect(
      embedSignal(
        'https://tally.so',
        PAGE,
        JSON.stringify({
          event: 'Tally.FormSubmitted',
          payload: {
            formId: 'w1',
            fields: [
              { label: 'Your email', value: 'Ada@Example.com' },
              { label: 'Password', value: 'x@y.zz' },
              { label: 'Nome', value: 'Ada' },
            ],
          },
        }),
      ),
    ).toEqual({
      goal: 'form_submit',
      form: 'tally:w1',
      contact: { email: 'ada@example.com', given_name: 'Ada' },
    });
  });

  it('a HubSpot submission identifies with its values and sends the goal', () => {
    const page = openPage({});
    message(page, PAGE, {
      type: 'hsFormCallback',
      eventName: 'onFormSubmitted',
      id: 'f-9',
      data: {
        submissionValues: {
          email: 'hs@example.com',
          phone: '+39 333 000 1111',
          firstname: 'Hu',
          company: 'X',
        },
      },
    });
    expect(identifies(page)).toEqual([
      { email: 'hs@example.com', phone: '+393330001111', given_name: 'Hu' },
    ]);
    expect(goals(page)).toEqual([
      ['form_submit', { form: 'hubspot:f-9', fields: 'email,given_name,phone' }],
    ]);
  });
});

describe('shadow DOM and iframes', () => {
  it('captures forms inside an open shadow root from the first focus', () => {
    const page = openPage({ body: '<div id="host"></div>' });
    const doc = page.win.document;
    const root = (doc.getElementById('host') as HTMLElement).attachShadow({ mode: 'open' });
    root.innerHTML = '<form id="sf"><input id="se" type="email"></form>';
    const el = root.getElementById('se') as HTMLInputElement;
    el.dispatchEvent(new page.dom.window.FocusEvent('focusin', { bubbles: true, composed: true }));
    el.value = 'shadow@example.com';
    el.dispatchEvent(new page.dom.window.Event('change'));
    expect(identifies(page)).toEqual([{ email: 'shadow@example.com' }]);
    const form = root.getElementById('sf') as HTMLFormElement;
    form.addEventListener('submit', (e) => e.preventDefault());
    form.dispatchEvent(new page.dom.window.Event('submit', { cancelable: true }));
    expect(goals(page)).toEqual([['form_submit', { form: 'sf', fields: 'email' }]]);
  });

  it('data-iframe-forms watches forms of same-origin iframes', () => {
    const page = openPage({
      attrs: { 'data-iframe-forms': '' },
      body: '<iframe id="fr"></iframe>',
    });
    const frame = page.win.document.getElementById('fr') as HTMLIFrameElement;
    const inner = frame.contentDocument as Document;
    inner.body.innerHTML = '<form><input id="ie" name="email"></form>';
    const el = inner.getElementById('ie') as HTMLInputElement;
    el.value = 'frame@example.com';
    el.dispatchEvent(new page.dom.window.Event('blur'));
    expect(identifies(page)).toEqual([{ email: 'frame@example.com' }]);
  });
});

describe('parent / iframe handshake', () => {
  it('the page lends its ids to a trusted child only', () => {
    const page = openPage({ attrs: { 'data-cross-domain': 'booking.partner.test' } });
    const replies: Array<[unknown, string]> = [];
    const child = { postMessage: (data: unknown, origin: string) => replies.push([data, origin]) };
    message(page, 'https://booking.partner.test', { __sa: 'hello' }, child);
    message(page, 'https://evil.test', { __sa: 'hello' }, child);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.[1]).toBe('https://booking.partner.test');
    expect(replies[0]?.[0]).toMatchObject({ __sa: 'ids', vid: page.sent[0]?.vid });
  });

  it('a child adopts the parent ids before its first pageview', () => {
    const PARENT_VID = '66666666-6666-4666-8666-666666666666';
    let child: Page | undefined;
    const parent = {
      postMessage: (data: { __sa?: string }) => {
        if (data.__sa !== 'hello') return;
        queueMicrotask(() =>
          message(
            child as Page,
            PAGE,
            { __sa: 'ids', vid: PARENT_VID, sid: 's-parent', fs: T0 - 5, sn: 2 },
            parent,
          ),
        );
      },
    };
    child = openPage({
      url: 'https://www.example.com/embed',
      attrs: { 'data-allow-iframe': '' },
      before: (win) => {
        // jsdom keeps `top` fixed: a different `self` makes the page an iframe.
        Object.defineProperty(win, 'parent', { value: parent });
        Object.defineProperty(win, 'self', { value: {} });
      },
    });
    expect(child.sent).toHaveLength(0);
    return Promise.resolve().then(() => {
      expect(child?.sent[0]).toMatchObject({ type: 'pageview', vid: PARENT_VID, sid: 's-parent' });
    });
  });
});

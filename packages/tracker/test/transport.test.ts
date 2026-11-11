import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { defaultTransport } from '../src/tracker';

function page(): { win: Window; calls: string[]; status: { value: number | 'down' } } {
  const dom = new JSDOM('<!doctype html><html></html>', {
    url: 'https://www.example.com/',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window;
  const calls: string[] = [];
  const status: { value: number | 'down' } = { value: 202 };
  (win as unknown as { fetch: unknown }).fetch = vi.fn((_url: string, init: { body: string }) => {
    calls.push(init.body);
    return status.value === 'down'
      ? Promise.reject(new TypeError('offline'))
      : Promise.resolve({ status: status.value } as Response);
  });
  return { win, calls, status };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('tracker transport', () => {
  it('buffers failed sends and resends them after the next success', async () => {
    const { win, calls, status } = page();
    const send = defaultTransport(win, false);
    status.value = 'down';
    send('https://t.example.com/e', '{"id":"a"}');
    await settle();
    status.value = 503;
    send('https://t.example.com/e', '{"id":"b"}');
    await settle();
    expect(JSON.parse(win.localStorage.getItem('amb_buf') ?? '[]')).toHaveLength(2);
    status.value = 202;
    send('https://t.example.com/e', '{"id":"c"}');
    await settle();
    await settle();
    expect(calls).toEqual(['{"id":"a"}', '{"id":"b"}', '{"id":"c"}', '{"id":"a"}', '{"id":"b"}']);
    expect(win.localStorage.getItem('amb_buf')).toBeNull();
  });

  it('drops final refusals (4xx) and keeps the buffer out of storage when cookieless', async () => {
    const { win, calls, status } = page();
    const send = defaultTransport(win, true);
    status.value = 400;
    send('https://t.example.com/e', '{"id":"x"}');
    status.value = 'down';
    send('https://t.example.com/e', '{"id":"y"}');
    await settle();
    expect(win.localStorage.getItem('amb_buf')).toBeNull();
    status.value = 202;
    send('https://t.example.com/e', '{"id":"z"}');
    await settle();
    await settle();
    expect(calls).toEqual(['{"id":"x"}', '{"id":"y"}', '{"id":"z"}', '{"id":"y"}']);
  });

  it('after clear() a send already in flight that fails is not buffered nor beaconed', async () => {
    const { win, calls, status } = page();
    const beacons: string[] = [];
    Object.assign(win.navigator, { sendBeacon: (_u: string, b: string) => beacons.push(b) > 0 });
    const send = defaultTransport(win, false);
    status.value = 'down';
    send('https://t.example.com/e', '{"id":"late"}');
    send.clear?.();
    await settle();
    expect(win.localStorage.getItem('amb_buf')).toBeNull();
    win.dispatchEvent(new (win as unknown as typeof globalThis).Event('pagehide'));
    expect(beacons).toEqual([]);
    expect(calls).toEqual(['{"id":"late"}']);
  });

  it('retries the stored buffer at the next page load', async () => {
    const first = page();
    first.status.value = 'down';
    defaultTransport(first.win, false)('https://t.example.com/e', '{"id":"a"}');
    await settle();
    const stored = first.win.localStorage.getItem('amb_buf');
    const second = page();
    second.win.localStorage.setItem('amb_buf', stored ?? '');
    defaultTransport(second.win, false)('https://t.example.com/e', '{"id":"b"}');
    await settle();
    await settle();
    expect(second.calls.sort()).toEqual(['{"id":"a"}', '{"id":"b"}']);
  });

  it('never persists identify events (they carry an email) and gives up after 5 tries', async () => {
    const { win, calls, status } = page();
    const send = defaultTransport(win, false);
    status.value = 'down';
    send('https://t.example.com/e', '{"type":"identify","email":"a@example.com"}');
    await settle();
    expect(win.localStorage.getItem('amb_buf')).toBeNull();
    send('https://t.example.com/e', '{"id":"p"}');
    await settle();
    expect(JSON.parse(win.localStorage.getItem('amb_buf') ?? '[]')).toHaveLength(1);
    for (let i = 0; i < 10; i += 1) {
      win.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event('online'));
      await settle();
      await settle();
    }
    expect(win.localStorage.getItem('amb_buf')).toBeNull();
    expect(calls.filter((c) => c === '{"id":"p"}')).toHaveLength(5);
  });
});

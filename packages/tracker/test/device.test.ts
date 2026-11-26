import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { collectDevice, UNSTABLE } from '../src/device';

function windowWith(opts: {
  screen?: Record<string, number>;
  canvas?: () => string;
  fullscreen?: boolean;
}): Window {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://www.example.com/' });
  const win = dom.window as unknown as Window;
  Object.defineProperty(win, 'screen', {
    value: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      availTop: 0,
      availLeft: 0,
      colorDepth: 24,
      ...opts.screen,
    },
  });
  if (opts.fullscreen === true)
    Object.defineProperty(win.document, 'fullscreenElement', { value: win.document.body });
  if (opts.canvas !== undefined) {
    const read = opts.canvas;
    const ctx = new Proxy(
      {},
      {
        get: (_t, key) =>
          key === 'createLinearGradient'
            ? () => ({ addColorStop: () => undefined })
            : () => undefined,
        set: () => true,
      },
    );
    const proto = dom.window.HTMLCanvasElement.prototype;
    proto.getContext = (() => ctx) as never;
    proto.toDataURL = read;
  }
  return win;
}

describe('device signals', () => {
  it('reads the math results and the screen frame, rounded', async () => {
    const signals = await collectDevice(
      windowWith({ screen: { availHeight: 1033, availTop: 25, height: 1080 } }),
    );
    expect(signals['math']).toMatch(/^[0-9a-f]{8}$/);
    // Menu bar 25px on top, dock 22px at the bottom: rounded to 10px.
    expect(signals['sf']).toBe('30,0,20,0');
  });

  it('leaves the screen frame out in fullscreen', async () => {
    const signals = await collectDevice(windowWith({ fullscreen: true }));
    expect(signals['sf']).toBeUndefined();
  });

  it('marks a canvas the browser noises at every read', async () => {
    let n = 0;
    const noised = await collectDevice(
      windowWith({ canvas: () => `data:image/png;base64,${String((n += 1))}` }),
    );
    expect(noised['cv']).toBe(UNSTABLE);
    const steady = await collectDevice(windowWith({ canvas: () => 'data:image/png;base64,AAAA' }));
    expect(steady['cv']).toMatch(/^[0-9a-f]{8}$/);
  });
});

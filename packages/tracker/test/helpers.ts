import { CookieJar, JSDOM } from 'jsdom';

export { CookieJar };
import { createTracker, type BuildOptions, type TrackerHandle } from '../src/tracker';
import type { EventPayload } from '../src/protocol';

export interface Page {
  dom: JSDOM;
  win: Window;
  sent: EventPayload[];
  endpoints: string[];
  handle: TrackerHandle;
}

export interface PageOptions {
  url?: string;
  attrs?: Record<string, string>;
  body?: string;
  options?: Partial<BuildOptions>;
  cookies?: string[];
  before?: (win: Window) => void;
  /** Share a cookie jar between page loads. */
  jar?: CookieJar;
}

export function openPage(opts: PageOptions = {}): Page {
  const url = opts.url ?? 'https://www.example.com/pricing?utm_source=news&gclid=abc';
  const attrs = { 'data-site': 'site_test', src: 'https://t.example.com/s.js', ...opts.attrs };
  const attrText = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  const html = `<!doctype html><html><head><script ${attrText}></script></head><body>${opts.body ?? ''}</body></html>`;
  const dom = new JSDOM(html, {
    url,
    referrer: 'https://www.google.com/',
    pretendToBeVisual: true,
    ...(opts.jar === undefined ? {} : { cookieJar: opts.jar }),
  });
  const win = dom.window as unknown as Window;
  for (const c of opts.cookies ?? []) win.document.cookie = c;
  opts.before?.(win);
  const sent: EventPayload[] = [];
  const endpoints: string[] = [];
  const handle = createTracker(
    win,
    { cookieless: false, hashRouting: false, ...opts.options },
    (endpoint, body) => {
      endpoints.push(endpoint);
      sent.push(JSON.parse(body) as EventPayload);
    },
  );
  return { dom, win, sent, endpoints, handle };
}

export function cookieMap(win: Window): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of win.document.cookie.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

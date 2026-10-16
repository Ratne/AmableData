import { isInIframe, isLikelyBot, isLocalHost, isOptedOut, setOptOut } from './env-checks';
import {
  cookieJar,
  decorateLink,
  readHandoff,
  rootDomain,
  stripHandoff,
  touchIds,
  writeIds,
  type Ids,
} from './identity';
import {
  CLICK_ID_PARAMS,
  CONTACT_TOKEN_PARAM,
  SOURCE_PARAMS,
  type EventPayload,
  type EventType,
  type ExtraValue,
} from './protocol';
import { goalOf, sanitizeName, sanitizeParams, sanitizeValue } from './sanitize';

export interface BuildOptions {
  /** No cookies at all: the server derives a daily visitor hash. */
  cookieless: boolean;
  /** Track `#/route` changes as pageviews and keep the hash in URLs. */
  hashRouting: boolean;
}

export type Transport = (endpoint: string, body: string) => void;

export interface TrackerHandle {
  enabled: boolean;
  /** Why tracking is off (bot, iframe, localhost, opted_out, no_site). */
  reason?: string;
  /** The public command function installed as `window.amable`. */
  command: (name: string, ...args: unknown[]) => void;
}

/** Same URL pageviews within this window are dropped (SPA routers often fire twice). */
export const PAGEVIEW_DEDUPE_MS = 60_000;

type Queued = { q?: ArrayLike<ArrayLike<unknown>> };

function defaultTransport(win: Window): Transport {
  return (endpoint, body) => {
    const nav = win.navigator;
    try {
      if (typeof nav.sendBeacon === 'function' && nav.sendBeacon(endpoint, body)) return;
    } catch {
      // fall through to fetch
    }
    if (typeof win.fetch === 'function') {
      win
        .fetch(endpoint, {
          method: 'POST',
          body,
          keepalive: true,
          credentials: 'omit',
          headers: { 'content-type': 'text/plain' },
        })
        .catch(() => undefined);
    }
  };
}

function pick(
  params: URLSearchParams,
  names: readonly string[],
): Record<string, string> | undefined {
  let out: Record<string, string> | undefined;
  for (const name of names) {
    const value = params.get(name);
    if (value !== null && value !== '') (out ??= {})[name] = sanitizeValue(value);
  }
  return out;
}

function currentScript(doc: Document): HTMLScriptElement | null {
  const cur = doc.currentScript;
  if (cur !== null && cur.tagName === 'SCRIPT' && cur.hasAttribute('data-site')) {
    return cur as HTMLScriptElement;
  }
  return doc.querySelector<HTMLScriptElement>('script[data-site]');
}

/**
 * Boots the tracker on a page. Reads its configuration from the script tag:
 * `data-site` (required), `data-api` (endpoint, default `<script origin>/e`),
 * `data-domain` (cookie domain), `data-allow-localhost`, `data-allow-iframe`,
 * `data-cross-domain` (comma separated hostnames), `data-no-external-links`.
 */
export function createTracker(
  win: Window,
  options: BuildOptions,
  transport: Transport = defaultTransport(win),
): TrackerHandle {
  const doc = win.document;
  const loc = win.location;
  const script = currentScript(doc);
  const attr = (name: string): string | null => script?.getAttribute(name) ?? null;
  const has = (name: string): boolean => script?.hasAttribute(name) === true;
  const site = attr('data-site') ?? '';
  const now = (): number => Date.now();

  const disabled = (reason: string): TrackerHandle => {
    const command = (name: string): void => {
      if (name === 'optin') setOptOut(win, false);
    };
    return { enabled: false, reason, command };
  };

  // Previously queued calls on the stub stay queued only when tracking is on.
  const stub = (win as unknown as { amable?: Queued }).amable;
  const queued = stub?.q === undefined ? [] : Array.from(stub.q, (args) => Array.from(args));

  if (site === '') return disabled('no_site');
  if (isOptedOut(win)) return disabled('opted_out');
  if (isLikelyBot(win)) return disabled('bot');
  if (isInIframe(win) && !has('data-allow-iframe')) return disabled('iframe');
  if (isLocalHost(loc) && !has('data-allow-localhost')) return disabled('localhost');

  let endpoint = attr('data-api');
  if (endpoint === null) {
    endpoint = script !== null && script.src !== '' ? new URL('/e', script.src).toString() : '/e';
  }
  const crossDomains = (attr('data-cross-domain') ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== '');

  const jar = options.cookieless
    ? undefined
    : cookieJar(
        doc,
        attr('data-domain') ?? rootDomain(doc, loc.hostname),
        loc.protocol === 'https:',
      );

  // Cross-domain handoff: adopt the ids carried by the link, then clean the URL.
  // An email click also carries `_amb_c` (signed contact identity): it is sent
  // once with the first pageview (the server verifies it) and removed too.
  const landing = new URL(loc.href);
  const handoff = readHandoff(landing, now());
  let cleaned = stripHandoff(landing);
  const rawToken = landing.searchParams.get(CONTACT_TOKEN_PARAM);
  let contactToken =
    rawToken !== null && rawToken.length <= 4096 && /^[\w-]+\.[\w-]+$/.test(rawToken) ? rawToken : undefined;
  if (rawToken !== null) {
    landing.searchParams.delete(CONTACT_TOKEN_PARAM);
    cleaned = landing.toString();
  }
  if (cleaned !== undefined) {
    try {
      win.history.replaceState(win.history.state, '', cleaned);
    } catch {
      // sandboxed documents may refuse replaceState
    }
  }
  if (jar !== undefined && handoff !== undefined) writeIds(jar, handoff);

  const ids = (): Ids | undefined =>
    jar === undefined ? undefined : touchIds(jar, win.crypto, now());

  const pageUrl = (): string => {
    const u = new URL(loc.href);
    if (!options.hashRouting) u.hash = '';
    return u.toString();
  };

  const attribution = (): { clk?: Record<string, string>; src?: Record<string, string> } => {
    const u = new URL(loc.href);
    const params = new URLSearchParams(u.search);
    if (options.hashRouting) {
      const q = u.hash.indexOf('?');
      if (q >= 0) new URLSearchParams(u.hash.slice(q + 1)).forEach((v, k) => params.set(k, v));
    }
    const clk = pick(params, CLICK_ID_PARAMS);
    const src = pick(params, SOURCE_PARAMS);
    return { ...(clk === undefined ? {} : { clk }), ...(src === undefined ? {} : { src }) };
  };

  const send = (
    type: EventType,
    extra: { name?: string; data?: Record<string, ExtraValue> } = {},
  ): void => {
    const payload: EventPayload = {
      type,
      site,
      url: pageUrl(),
      vw: win.innerWidth,
      vh: win.innerHeight,
      sw: win.screen.width,
      sh: win.screen.height,
      ...attribution(),
      ...extra,
    };
    if (doc.referrer !== '') payload.ref = doc.referrer;
    const lang = win.navigator.language;
    if (lang !== '') payload.lang = lang;
    try {
      payload.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      // very old engines
    }
    const current = ids();
    if (current === undefined) payload.cl = 1;
    else Object.assign(payload, current);
    if (type === 'pageview' && contactToken !== undefined) {
      payload.ct = contactToken;
      contactToken = undefined;
    }
    transport(endpoint, JSON.stringify(payload));
  };

  let lastPageview: { url: string; at: number } | undefined;
  const pageview = (): void => {
    const url = pageUrl();
    const at = now();
    if (
      lastPageview !== undefined &&
      lastPageview.url === url &&
      at - lastPageview.at < PAGEVIEW_DEDUPE_MS
    ) {
      return;
    }
    lastPageview = { url, at };
    send('pageview');
    scanScrollGoals();
  };

  const goal = (rawName: unknown, rawParams?: unknown): void => {
    const name = sanitizeName(rawName);
    if (name === '') return;
    const params = sanitizeParams(rawParams);
    send('goal', params === undefined ? { name } : { name, data: params });
  };

  // --- Scroll goals: data-amable-scroll="name" [+ -threshold (0..1), -delay (ms)]
  const observed = new WeakSet<Element>();
  const scanScrollGoals = (): void => {
    const IO = (win as unknown as { IntersectionObserver?: typeof IntersectionObserver })
      .IntersectionObserver;
    if (IO === undefined) return;
    for (const el of Array.from(doc.querySelectorAll('[data-amable-scroll]'))) {
      if (observed.has(el)) continue;
      observed.add(el);
      const spec = goalOf(el, 'data-amable-scroll');
      if (spec === undefined) continue;
      const t = Number(el.getAttribute('data-amable-scroll-threshold') ?? '0.5');
      const threshold = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.5;
      const d = Number(el.getAttribute('data-amable-scroll-delay') ?? '0');
      const delay = Number.isFinite(d) && d > 0 ? d : 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const io = new IO(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.intersectionRatio >= threshold) {
              if (timer !== undefined) continue;
              timer = setTimeout(() => {
                io.disconnect();
                goal(spec.name, spec.params);
              }, delay);
            } else if (timer !== undefined) {
              clearTimeout(timer);
              timer = undefined;
            }
          }
        },
        { threshold },
      );
      io.observe(el);
    }
  };

  // --- Clicks: goal attributes, cross-domain decoration, external links
  doc.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element | null;
      if (target === null || typeof target.closest !== 'function') return;
      const goalEl = target.closest('[data-amable-goal]');
      if (goalEl !== null) {
        const spec = goalOf(goalEl);
        if (spec !== undefined) goal(spec.name, spec.params);
      }
      const link = target.closest<HTMLAnchorElement>('a[href]');
      if (link === null) return;
      let url: URL;
      try {
        url = new URL(link.href, loc.href);
      } catch {
        return;
      }
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === loc.hostname)
        return;
      const host = url.hostname.toLowerCase();
      if (crossDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
        const current = ids();
        if (current !== undefined) link.href = decorateLink(url.toString(), current, now());
        return;
      }
      if (!has('data-no-external-links'))
        send('external_link', { data: { url: sanitizeValue(url.toString()) } });
    },
    true,
  );

  // --- SPA navigation
  const history = win.history;
  const originalPush = history.pushState.bind(history);
  history.pushState = (data: unknown, unused: string, url?: string | URL | null): void => {
    originalPush(data, unused, url);
    pageview();
  };
  win.addEventListener('popstate', pageview);
  if (options.hashRouting) win.addEventListener('hashchange', pageview);

  const command = (name: string, ...args: unknown[]): void => {
    switch (name) {
      case 'pageview':
        pageview();
        break;
      case 'goal':
        goal(args[0], args[1]);
        break;
      case 'identify':
      case 'payment': {
        const data = sanitizeParams(args[0]);
        if (data !== undefined) send(name, { data });
        break;
      }
      case 'optout':
        setOptOut(win, true);
        break;
      case 'optin':
        setOptOut(win, false);
        break;
      default:
        break;
    }
  };

  pageview();
  for (const args of queued) {
    const [name, ...rest] = args;
    if (typeof name === 'string') command(name, ...rest);
  }
  return { enabled: true, command };
}

/** Installs `window.amable` and drains the pre-load queue. */
export function boot(win: Window, options: BuildOptions): void {
  const handle = createTracker(win, options);
  (win as unknown as { amable: TrackerHandle['command'] }).amable = handle.command;
}

import {
  contactSink,
  conversionOf,
  decorateAction,
  isEmpty,
  parseDirectLink,
  readDirectLink,
  readLinkAttribution,
  watchForms,
} from './capture';
import { isInIframe, isLikelyBot, isLocalHost, isOptedOut, setOptOut } from './env-checks';
import {
  clearIds,
  COOKIE_VISITOR,
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
  CONVERSION_GOAL,
  SOURCE_PARAMS,
  type DirectLink,
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

/** Query params of a URL; the hash-routing build also reads the `#/route?…` part. */
function queryOf(href: string, hashRouting: boolean): URLSearchParams {
  const u = new URL(href);
  const params = new URLSearchParams(u.search);
  if (hashRouting) {
    const q = u.hash.indexOf('?');
    if (q >= 0) new URLSearchParams(u.hash.slice(q + 1)).forEach((v, k) => params.set(k, v));
  }
  return params;
}

const CONTEXT_KEY = 'amb_dl';

/**
 * Boots the tracker on a page. Reads its configuration from the script tag:
 * `data-site` (required), `data-api` (endpoint, default `<script origin>/e`),
 * `data-domain` (cookie domain), `data-allow-localhost`, `data-allow-iframe`,
 * `data-cross-domain` (comma separated hostnames), `data-no-external-links`,
 * `data-no-forms` (no email/phone capture from form fields).
 */
export function createTracker(
  win: Window,
  options: BuildOptions,
  transport: Transport = defaultTransport(win),
  script: HTMLScriptElement | null = currentScript(win.document),
): TrackerHandle {
  const doc = win.document;
  const loc = win.location;
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

  const endpoint = endpointOf(script);
  const crossDomains = (attr('data-cross-domain') ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== '');

  const jar = options.cookieless ? undefined : jarOf(win, script);

  // Cross-domain handoff: adopt the ids carried by the link, then clean the URL.
  // An email click also carries `_amb_c` (signed contact identity): it is sent
  // once with the first pageview (the server verifies it) and removed too.
  const landing = new URL(loc.href);
  const landingParams = queryOf(loc.href, options.hashRouting);
  let linkAttribution = readLinkAttribution(landingParams);
  const handoff = readHandoff(landing, now());
  let cleaned = stripHandoff(landing);
  const rawToken = landing.searchParams.get(CONTACT_TOKEN_PARAM);
  let contactToken =
    rawToken !== null && rawToken.length <= 4096 && /^[\w-]+\.[\w-]+$/.test(rawToken) ? rawToken : undefined;
  // `he` may be a plain email: it must not stay in the address bar nor in pageview URLs.
  for (const name of [CONTACT_TOKEN_PARAM, 'he']) {
    if (landing.searchParams.has(name)) {
      landing.searchParams.delete(name);
      cleaned = landing.toString();
    }
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

  // Direct-link context survives page loads through sessionStorage (cookie builds only).
  const session = (value?: string): string | null => {
    try {
      if (options.cookieless) return null;
      if (value !== undefined) win.sessionStorage.setItem(CONTEXT_KEY, value);
      return win.sessionStorage.getItem(CONTEXT_KEY);
    } catch {
      // privacy mode or quota
      return null;
    }
  };
  let context: DirectLink = {};
  const setContext = (next: DirectLink): void => {
    context = next;
    if (!isEmpty(next)) session(JSON.stringify(next));
  };
  setContext(readDirectLink(landingParams, parseDirectLink(session())));

  const attribution = (): { clk?: Record<string, string>; src?: Record<string, string> } => {
    const params = queryOf(loc.href, options.hashRouting);
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
    if (!isEmpty(context)) payload.dl = context;
    if (type === 'pageview' && linkAttribution !== undefined) {
      payload.la = linkAttribution;
      linkAttribution = undefined;
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

  // --- Email/phone: form fields (before submit too) and plain `he` emails share one dedupe.
  const offerContact = contactSink((contact) => send('identify', { data: { ...contact } }));
  if (!has('data-no-forms')) watchForms(doc, offerContact);

  // --- Action links: `vid` + `rn` so the edge resolves the origin without cookies.
  // Reads the cookie without sliding the session: DOM mutations are not activity.
  const decorate = (a: HTMLAnchorElement): boolean =>
    decorateAction(a, loc.href, context.vid ?? jar?.get(COOKIE_VISITOR), context.n);
  const decorateActions = (): void => {
    for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'))) decorate(a);
  };
  const MO = (win as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (MO !== undefined) {
    new MO(decorateActions).observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'data-amb-action'],
    });
  }

  // --- Clicks: goal attributes, action links, cross-domain decoration, external links
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
      if (link === null || decorate(link)) return;
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
      case 'conversion': {
        const data = conversionOf(args[0]);
        if (data !== undefined) send('goal', { name: CONVERSION_GOAL, data: { ...data } });
        break;
      }
      case 'context': {
        setContext({ ...context, ...parseDirectLink(JSON.stringify(args[0])) });
        decorateActions();
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

  const landingEmail = linkAttribution?.he;
  pageview();
  if (landingEmail?.includes('@') === true) offerContact({ email: landingEmail });
  decorateActions();
  for (const args of queued) {
    const [name, ...rest] = args;
    if (typeof name === 'string') command(name, ...rest);
  }
  return { enabled: true, command };
}

/** Ingest endpoint: `data-api`, else `/e` on the script's origin. */
function endpointOf(script: HTMLScriptElement | null): string {
  const api = script?.getAttribute('data-api') ?? null;
  if (api !== null) return api;
  return script !== null && script.src !== '' ? new URL('/e', script.src).toString() : '/e';
}

function jarOf(win: Window, script: HTMLScriptElement | null) {
  const doc = win.document;
  const loc = win.location;
  return cookieJar(
    doc,
    script?.getAttribute('data-domain') ?? rootDomain(doc, loc.hostname),
    loc.protocol === 'https:',
  );
}

type Command = TrackerHandle['command'];

/**
 * Installs `window.amable` and drains the pre-load queue. A cookie build first
 * asks the edge for the site mode (`GET <endpoint>?site=`): on a site set to
 * cookieless it runs without cookies and expires the ones written before.
 * When the edge cannot tell within 3 s, the build keeps its cookies.
 */
export function boot(win: Window, options: BuildOptions, transport?: Transport): Promise<void> {
  const script = currentScript(win.document);
  const w = win as unknown as { amable?: Command & Queued; amb?: Command };
  const install = (cookieless: boolean): void => {
    const handle = createTracker(win, { ...options, cookieless }, transport, script);
    w.amable = handle.command;
    w.amb ??= handle.command;
  };
  const site = script?.getAttribute('data-site');
  if (options.cookieless || !site || typeof win.fetch !== 'function' || isOptedOut(win) || isLikelyBot(win)) {
    install(options.cookieless);
    return Promise.resolve();
  }
  // Calls made meanwhile queue up like on the pre-load stub.
  const q = Array.from(w.amable?.q ?? [], (args) => Array.from(args));
  w.amable = Object.assign((...args: unknown[]) => void q.push(args), { q });
  const url = new URL(endpointOf(script), win.location.href);
  url.searchParams.set('site', site);
  return Promise.race([
    win
      .fetch(url.href, { credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null) as Promise<{ cookieless?: unknown } | null>)
      .then(
        (body) => body?.cookieless === true,
        () => false,
      ),
    new Promise<boolean>((resolve) => setTimeout(resolve, 3000, false)),
  ]).then((cookieless) => {
    if (cookieless) clearIds(jarOf(win, script));
    install(cookieless);
  });
}

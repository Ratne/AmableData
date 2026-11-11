import {
  contactSink,
  formSubmitData,
  conversionOf,
  decorateAction,
  isEmpty,
  parseDirectLink,
  readDirectLink,
  readLinkAttribution,
  readUrlPhone,
  watchForms,
  withoutContactParams,
  type Contact,
} from './capture';
import { embedSignal } from './embeds';
import { isInIframe, isLikelyBot, isLocalHost, isOptedOut, setOptOut } from './env-checks';
import {
  clearIds,
  COOKIE_SESSION,
  COOKIE_VISITOR,
  cookieJar,
  decorateLink,
  mirrorIds,
  PLATFORM_COOKIES,
  readHandoff,
  restoreIds,
  rootDomain,
  stripHandoff,
  touchIds,
  uuid,
  VISITOR_MAX_AGE_S,
  writeIds,
  type Ids,
} from './identity';
import {
  CLICK_ID_PARAMS,
  CONTACT_TOKEN_PARAM,
  CONVERSION_GOAL,
  FORM_SUBMIT_GOAL,
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

export type Transport = ((endpoint: string, body: string) => void) & {
  /** Drops what is buffered and stops retrying (opt-out). */
  clear?: () => void;
};

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

/** Undelivered events kept for a later retry (the client id makes a resend harmless). */
const BUFFER_KEY = 'amb_buf';
const BUFFER_MAX = 50;
const BUFFER_TTL_MS = 86_400_000;
const BUFFER_TRIES = 5;
/** `tries` is missing on items buffered by older tracker versions. */
type Buffered = [at: number, endpoint: string, body: string, tries?: number];

/**
 * `fetch` with an ack check; failed sends (network, 5xx, 429) go to a small
 * buffer retried one at a time after the next delivery, on `online` and at
 * page load, at most {@link BUFFER_TRIES} times. `sendBeacon` only while the
 * page is hidden/unloading. The buffer persists in localStorage except on
 * cookieless sites and for `identify` events (they carry an email): those
 * stay in memory.
 */
export function defaultTransport(win: Window, cookieless: boolean): Transport {
  const nav = win.navigator;
  let store: Storage | null = null;
  let buf: Buffered[] = [];
  const save = (items: Buffered[]): void => {
    // After an opt-out an in-flight send that fails is dropped, never buffered again.
    if (cleared) return;
    buf = items
      .filter((i) => Date.now() - i[0] < BUFFER_TTL_MS && (i[3] ?? 0) < BUFFER_TRIES)
      .slice(-BUFFER_MAX);
    try {
      const kept = buf.filter((i) => !i[2].includes('"type":"identify"'));
      if (kept.length > 0) store?.setItem(BUFFER_KEY, JSON.stringify(kept));
      else store?.removeItem(BUFFER_KEY);
    } catch {
      // storage full or blocked: the page still retries from memory
    }
  };
  const hidden = (): boolean => win.document.visibilityState === 'hidden';
  const beacon = (endpoint: string, body: string): boolean => {
    try {
      return !!nav.sendBeacon?.(endpoint, body);
    } catch {
      return false;
    }
  };
  // 4xx other than 429 is a final refusal: retrying cannot help.
  const post = (endpoint: string, body: string): Promise<boolean> =>
    typeof win.fetch != 'function'
      ? Promise.resolve(beacon(endpoint, body))
      : win
          .fetch(endpoint, {
            method: 'POST',
            body,
            keepalive: hidden(),
            credentials: 'omit',
            headers: { 'content-type': 'text/plain' },
          })
          .then(
            (r) => r.status < 500 && r.status !== 429,
            () => false,
          );
  let flushing = false;
  // One at a time, each removed only once acked; stops at the first failure.
  const flush = async (): Promise<void> => {
    if (flushing) return;
    flushing = true;
    for (const item of [...buf]) {
      if (cleared) break;
      const ok = await post(item[1], item[2]);
      const rest = buf.filter((other) => other !== item);
      save(ok ? rest : [...rest, [item[0], item[1], item[2], (item[3] ?? 0) + 1]]);
      if (!ok) break;
    }
    flushing = false;
  };
  let started = false;
  let cleared = false;
  const send: Transport = (endpoint, body) => {
    if (cleared) return;
    if (!started) {
      started = true;
      try {
        if (!cookieless) store = win.localStorage;
        buf = JSON.parse(store?.getItem(BUFFER_KEY) ?? '[]') as Buffered[];
      } catch {
        // no storage: memory only
      }
      win.addEventListener('online', () => void flush());
      win.addEventListener('pagehide', () => {
        if (!cleared) save(buf.filter((i) => !beacon(i[1], i[2])));
      });
      void flush();
    }
    if (hidden() && beacon(endpoint, body)) return;
    void post(endpoint, body).then((ok) => {
      if (ok) void flush();
      else save([...buf, [Date.now(), endpoint, body, 1]]);
    });
  };
  send.clear = () => {
    cleared = true;
    buf = [];
    try {
      win.localStorage.removeItem(BUFFER_KEY);
    } catch {
      // storage disabled
    }
  };
  return send;
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
  if (cur !== null && cur.tagName === 'SCRIPT') {
    const el = cur as HTMLScriptElement;
    // GTM recreates the tag and drops data-site, but the executing script
    // still carries our src (the event endpoint comes from it). An inline
    // copy without src defers to a tagged script elsewhere in the page.
    if (el.hasAttribute('data-site') || el.src !== '') return el;
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
 * `data-no-forms` (no form capture), `data-capture-typing` (capture while
 * typing, debounced), `data-form-payload` (other form answers in
 * `form_submit`; per form: `data-amb-payload`), `data-iframe-forms` (forms
 * in same-origin iframes).
 */
export function createTracker(
  win: Window,
  options: BuildOptions,
  transport: Transport = defaultTransport(win, options.cookieless),
  script: HTMLScriptElement | null = currentScript(win.document),
): TrackerHandle {
  const doc = win.document;
  const loc = win.location;
  const attr = (name: string): string | null => script?.getAttribute(name) ?? null;
  const has = (name: string): boolean => script?.hasAttribute(name) === true;
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

  // Tag managers (GTM) recreate the script tag and drop data-site: the snippet
  // also queues amable('site', id), so the id survives whatever injected the tag.
  const queuedSite = queued.find((a) => a[0] === 'site' && typeof a[1] === 'string')?.[1];
  const attrSite = attr('data-site') ?? '';
  const site = attrSite !== '' ? attrSite : typeof queuedSite === 'string' ? queuedSite : '';

  if (site === '') return disabled('no_site');
  if (isOptedOut(win)) return disabled('opted_out');
  if (isLikelyBot(win)) return disabled('bot');
  if (isInIframe(win) && !has('data-allow-iframe')) return disabled('iframe');
  if (isLocalHost(loc) && !has('data-allow-localhost')) return disabled('localhost');

  // `optout` stops everything on this page right away (listeners, observers, sends).
  let stopped = false;
  const AC = (win as unknown as { AbortController?: typeof AbortController }).AbortController;
  const abort = AC === undefined ? undefined : new AC();
  const listen = { capture: true, ...(abort === undefined ? {} : { signal: abort.signal }) };
  const observers: Array<{ disconnect(): void }> = [];

  const endpoint = endpointOf(script);
  const crossDomains = (attr('data-cross-domain') ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d !== '');

  const siteRoot = options.cookieless
    ? undefined
    : (attr('data-domain') ?? rootDomain(doc, loc.hostname));
  const jar = options.cookieless ? undefined : jarOf(win, script, siteRoot);

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
    rawToken !== null && rawToken.length <= 4096 && /^[\w-]+\.[\w-]+$/.test(rawToken)
      ? rawToken
      : undefined;
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
  const store = options.cookieless ? undefined : storageOf(win);
  if (jar !== undefined && handoff !== undefined) writeIds(jar, handoff);
  else if (jar !== undefined) restoreIds(jar, store);

  const ids = (): Ids | undefined => {
    if (jar === undefined) return undefined;
    const current = touchIds(jar, win.crypto, now());
    mirrorIds(store, current);
    return current;
  };

  const pageUrl = (): string => {
    const u = new URL(loc.href);
    if (!options.hashRouting) u.hash = '';
    return withoutContactParams(u.toString());
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
    let clk = pick(params, CLICK_ID_PARAMS);
    for (const [cookie, key] of PLATFORM_COOKIES) {
      const v = jar?.get(cookie);
      if (v !== undefined && v !== '' && v.length <= 255) clk = { ...clk, [key]: v };
    }
    const src = pick(params, SOURCE_PARAMS);
    return { ...(clk === undefined ? {} : { clk }), ...(src === undefined ? {} : { src }) };
  };

  const send = (
    type: EventType,
    extra: { name?: string; data?: Record<string, ExtraValue> } = {},
  ): void => {
    if (stopped) return;
    const payload: EventPayload = {
      type,
      id: uuid(win.crypto),
      at: now(),
      site,
      url: pageUrl(),
      vw: win.innerWidth,
      vh: win.innerHeight,
      sw: win.screen.width,
      sh: win.screen.height,
      ...attribution(),
      ...extra,
    };
    if (doc.referrer !== '') payload.ref = withoutContactParams(doc.referrer);
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
      observers.push(io);
    }
  };

  // --- Hidden fields `data-amb-fill="vid|sid|<click id>|<utm>"`: filled at boot and on submit.
  const ATT_KEY = 'amb_att';
  const landed = attribution();
  try {
    if (!options.cookieless && !isEmpty(landed))
      win.sessionStorage.setItem(ATT_KEY, JSON.stringify(landed));
  } catch {
    // storage disabled
  }
  const fillHidden = (root: ParentNode): void => {
    let stored: ReturnType<typeof attribution> = {};
    try {
      stored = JSON.parse(win.sessionStorage.getItem(ATT_KEY) ?? '{}') as typeof stored;
    } catch {
      // storage disabled or corrupt
    }
    const current = attribution();
    const clk = { ...stored.clk, ...current.clk };
    const values: Record<string, string | undefined> = {
      ...stored.src,
      ...current.src,
      ...clk,
      click_id: Object.values(clk)[0],
      vid: context.vid ?? jar?.get(COOKIE_VISITOR),
      sid: jar?.get(COOKIE_SESSION),
    };
    for (const el of Array.from(root.querySelectorAll<HTMLInputElement>('input[data-amb-fill]'))) {
      const v = values[el.getAttribute('data-amb-fill') ?? ''];
      if (v !== undefined && el.value === '') el.value = v;
    }
  };

  // --- Forms: values grouped per form (before submit too), then `form_submit` on submit.
  const offerContact = contactSink((contact) => send('identify', { data: { ...contact } }));
  const formOptions = {
    listen,
    typing: has('data-capture-typing'),
    onSubmit: (form: HTMLFormElement, values: Contact) => {
      fillHidden(form);
      send('goal', {
        name: FORM_SUBMIT_GOAL,
        data: formSubmitData(form, values, has('data-form-payload')),
      });
    },
  };
  const watchedRoots = new WeakSet<object>();
  const forms = !has('data-no-forms');
  if (forms) watchForms(doc, offerContact, formOptions, watchedRoots);
  // `data-iframe-forms`: forms inside same-origin iframes (other origins are unreadable).
  const watchFrame = (frame: HTMLIFrameElement): void => {
    try {
      const d = frame.contentDocument;
      if (d !== null) watchForms(d, offerContact, formOptions, watchedRoots);
    } catch {
      // cross-origin
    }
  };
  if (forms && has('data-iframe-forms')) {
    for (const f of Array.from(doc.querySelectorAll('iframe'))) watchFrame(f);
    doc.addEventListener(
      'load',
      (event) => {
        if ((event.target as Element | null)?.tagName === 'IFRAME')
          watchFrame(event.target as HTMLIFrameElement);
      },
      listen,
    );
  }

  // --- Embeds: provider messages (schedulers, form builders) and our tracker in child iframes.
  const trusted = (origin: string): boolean => {
    let host: string;
    try {
      host = new URL(origin).hostname.toLowerCase();
    } catch {
      return false;
    }
    const root = jar === undefined ? undefined : siteRoot;
    return (
      host === loc.hostname ||
      (root !== undefined && (host === root || host.endsWith(`.${root}`))) ||
      crossDomains.some((d) => host === d || host.endsWith(`.${d}`))
    );
  };
  win.addEventListener(
    'message',
    (event: MessageEvent) => {
      const data = event.data as { __sa?: unknown } | null;
      if (data?.__sa === 'hello' && event.source !== null && trusted(event.origin)) {
        const current = ids();
        if (current !== undefined)
          (event.source as Window).postMessage({ __sa: 'ids', ...current }, event.origin);
        return;
      }
      if (!forms) return;
      const signal = embedSignal(event.origin, loc.origin, event.data);
      if (signal === undefined) return;
      if (signal.contact !== undefined) offerContact({}, signal.contact);
      send('goal', {
        name: signal.goal,
        data: {
          form: signal.form,
          fields: Object.keys(signal.contact ?? {})
            .sort()
            .join(','),
        },
      });
    },
    listen,
  );

  // --- Action links: `vid` + `rn` so the edge resolves the origin without cookies.
  // Reads the cookie without sliding the session: DOM mutations are not activity.
  const decorate = (a: HTMLAnchorElement): boolean =>
    !stopped && decorateAction(a, loc.href, context.vid ?? jar?.get(COOKIE_VISITOR), context.n);
  const decorateActions = (): void => {
    for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'))) decorate(a);
  };
  // Only the mutated subtrees: a full rescan on every DOM change is costly on busy SPAs.
  const decorateMutations = (records: MutationRecord[]): void => {
    for (const record of records) {
      if (record.type === 'attributes') {
        const el = record.target as Element;
        if (el.tagName === 'A' && el.hasAttribute('href')) decorate(el as HTMLAnchorElement);
        continue;
      }
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        if (el.tagName === 'A' && el.hasAttribute('href')) decorate(el as HTMLAnchorElement);
        for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>('a[href]'))) decorate(a);
      }
    }
  };
  const MO = (win as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (MO !== undefined) {
    const mo = new MO(decorateMutations);
    observers.push(mo);
    mo.observe(doc.documentElement, {
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
    listen,
  );

  // --- SPA navigation
  const history = win.history;
  const originalPush = history.pushState.bind(history);
  // Stays installed after an opt-out (others may wrap it too): `send` is off by then.
  history.pushState = (data: unknown, unused: string, url?: string | URL | null): void => {
    originalPush(data, unused, url);
    pageview();
  };
  win.addEventListener('popstate', pageview, listen);
  if (options.hashRouting) win.addEventListener('hashchange', pageview, listen);

  const stop = (): void => {
    stopped = true;
    // Links already carrying the ids (action links, cross-domain handoff) forget them.
    const vid = context.vid ?? jar?.get(COOKIE_VISITOR);
    for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      try {
        const u = new URL(a.href, loc.href);
        const p = u.searchParams;
        const own = (vid !== undefined && p.get('vid') === vid) || p.has('_amb_vid');
        if (!own) continue;
        if (p.get('vid') === vid) p.delete('vid');
        if (context.n !== undefined && p.get('rn') === context.n) p.delete('rn');
        stripHandoff(u);
        a.href = u.toString();
      } catch {
        // unparsable href
      }
    }
    abort?.abort();
    for (const o of observers) o.disconnect();
    transport.clear?.();
    if (jar !== undefined) clearIds(jar, store);
    try {
      win.sessionStorage.removeItem(CONTEXT_KEY);
    } catch {
      // storage disabled
    }
  };

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
        stop();
        break;
      case 'optin':
        setOptOut(win, false);
        break;
      case 'site':
        // Read at boot (the GTM fallback): nothing to do once running.
        break;
      default:
        break;
    }
  };

  const start = (): void => {
    const landingEmail = linkAttribution?.he;
    const landingPhone = readUrlPhone(landingParams);
    pageview();
    fillHidden(doc);
    const fromUrl: Contact = {};
    if (landingEmail?.includes('@') === true) fromUrl.email = landingEmail;
    if (landingPhone !== undefined) fromUrl.phone = landingPhone;
    if (!isEmpty(fromUrl)) offerContact(landing, fromUrl);
    decorateActions();
    for (const args of queued) {
      const [name, ...rest] = args;
      if (typeof name === 'string') command(name, ...rest);
    }
  };
  // In an iframe (`data-allow-iframe`) the parent page's tracker lends its ids, so
  // the embed and the page are one visitor; without an answer the iframe keeps its own.
  if (isInIframe(win) && jar !== undefined) {
    let started = false;
    const go = (): void => {
      if (!started) {
        started = true;
        start();
      }
    };
    win.addEventListener(
      'message',
      (event: MessageEvent) => {
        const d = event.data as Partial<Ids> & { __sa?: unknown };
        if (d?.__sa !== 'ids' || event.source !== win.parent || !trusted(event.origin)) return;
        if (typeof d.vid === 'string' && typeof d.sid === 'string')
          writeIds(jar, {
            vid: d.vid,
            sid: d.sid,
            fs: Number(d.fs) || now(),
            sn: Number(d.sn) || 1,
          });
        go();
      },
      listen,
    );
    try {
      win.parent.postMessage({ __sa: 'hello' }, '*');
    } catch {
      // detached
    }
    setTimeout(go, IFRAME_HANDSHAKE_MS);
  } else {
    start();
  }
  return { enabled: true, command };
}

const IFRAME_HANDSHAKE_MS = 400;

/**
 * Ingest endpoint: `data-api`, else on the script's origin `/<dir>/<name>` for
 * a neutral script path (`/<dir>/<name>.js`), `/e` for the classic ones.
 */
function endpointOf(script: HTMLScriptElement | null): string {
  const api = script?.getAttribute('data-api') ?? null;
  if (api !== null) return api;
  if (script === null || script.src === '') return '/e';
  const src = new URL(script.src);
  // Neutral directories always hold a digit (SCRIPT_PATH_RE): `/static/sa.js` stays classic.
  const neutral = /^\/((?=[a-z]*\d)[a-z0-9]{6,16}\/[a-z0-9]{2,16})(?:-[lh])?\.js$/.exec(
    src.pathname,
  );
  return new URL(neutral === null ? '/e' : `/${neutral[1]}`, src).toString();
}

function jarOf(win: Window, script: HTMLScriptElement | null, root?: string) {
  const doc = win.document;
  const loc = win.location;
  return cookieJar(
    doc,
    root ?? script?.getAttribute('data-domain') ?? rootDomain(doc, loc.hostname),
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
  // GTM drops data-site from the tag: the snippet also queues amable('site', id).
  const queuedSite = Array.from(w.amable?.q ?? [], (args) => Array.from(args)).find(
    (a) => a[0] === 'site' && typeof a[1] === 'string',
  )?.[1] as string | undefined;
  const site = script?.getAttribute('data-site') ?? queuedSite;
  if (
    options.cookieless ||
    !site ||
    typeof win.fetch !== 'function' ||
    isOptedOut(win) ||
    isLikelyBot(win)
  ) {
    install(options.cookieless);
    return Promise.resolve();
  }
  // Calls made meanwhile queue up like on the pre-load stub.
  const q = Array.from(w.amable?.q ?? [], (args) => Array.from(args));
  w.amable = Object.assign((...args: unknown[]) => void q.push(args), { q });
  const url = new URL(endpointOf(script), win.location.href);
  url.searchParams.set('site', site);
  // A tracking domain of the site (`t.example.com` for `www.example.com`) also
  // keeps the visitor id in a cookie it sets itself (Set-Cookie), which some
  // browsers keep longer than one written by a script; it restores the id.
  const jar = jarOf(win, script);
  const root =
    script?.getAttribute('data-domain') ?? rootDomain(win.document, win.location.hostname);
  const sameSite =
    root !== undefined && (url.hostname === root || url.hostname.endsWith(`.${root}`));
  const known = jar.get(COOKIE_VISITOR);
  if (sameSite && known !== undefined) url.searchParams.set('vid', known);
  return Promise.race([
    win
      .fetch(url.href, { credentials: sameSite ? 'include' : 'omit' })
      .then(
        (r) => (r.ok ? r.json() : null) as Promise<{ cookieless?: unknown; vid?: unknown } | null>,
      )
      .then(
        (body) => {
          if (
            sameSite &&
            known === undefined &&
            typeof body?.vid === 'string' &&
            /^[a-zA-Z0-9-]{8,64}$/.test(body.vid)
          )
            jar.set(COOKIE_VISITOR, body.vid, VISITOR_MAX_AGE_S);
          return body?.cookieless === true;
        },
        () => false,
      ),
    new Promise<boolean>((resolve) => setTimeout(resolve, 3000, false)),
  ]).then((cookieless) => {
    if (cookieless) clearIds(jar, storageOf(win));
    install(cookieless);
  });
}

function storageOf(win: Window): Storage | undefined {
  try {
    return win.localStorage;
  } catch {
    return undefined;
  }
}

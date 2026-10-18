/** Cookie names (first-party, set on the site's root domain). */
export const COOKIE_VISITOR = 'amb_vid';
export const COOKIE_SESSION = 'amb_sid';
export const COOKIE_FIRST_SEEN = 'amb_fs';
export const COOKIE_SESSION_COUNT = 'amb_sn';

export const VISITOR_MAX_AGE_S = 365 * 24 * 3600;
export const SESSION_MAX_AGE_S = 30 * 60;

/** Cross-domain handoff params, removed from the URL right after being read. */
export const HANDOFF_PARAMS = ['_amb_vid', '_amb_sid', '_amb_fs', '_amb_sn', '_amb_ts'] as const;
/** A handoff link older than this is ignored (copied/shared links must not merge visitors). */
export const HANDOFF_MAX_AGE_MS = 10 * 60 * 1000;

export interface Ids {
  vid: string;
  sid: string;
  /** First-seen timestamp of the visitor (ms). */
  fs: number;
  /** Session number of the visitor (1 = first session). */
  sn: number;
}

export function uuid(crypto: Crypto | undefined): string {
  if (crypto !== undefined && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  if (crypto !== undefined) crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;

export function readCookie(doc: Document, name: string): string | undefined {
  for (const part of doc.cookie.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export interface CookieJar {
  get(name: string): string | undefined;
  set(name: string, value: string, maxAgeS: number): void;
}

/**
 * Finds the registrable root domain by writing a probe cookie from the shortest
 * candidate upwards (`example.co.uk` is refused by the browser for `co.uk`).
 */
export function rootDomain(doc: Document, hostname: string): string | undefined {
  if (!hostname.includes('.') || /^[\d.]+$/.test(hostname) || hostname.includes(':'))
    return undefined;
  const labels = hostname.split('.');
  for (let i = labels.length - 2; i >= 0; i--) {
    const domain = labels.slice(i).join('.');
    doc.cookie = `amb_probe=1; path=/; domain=${domain}`;
    if (readCookie(doc, 'amb_probe') === '1') {
      doc.cookie = `amb_probe=; path=/; domain=${domain}; max-age=0`;
      return domain;
    }
  }
  return undefined;
}

export function cookieJar(doc: Document, domain: string | undefined, secure: boolean): CookieJar {
  const suffix = `; path=/; SameSite=Lax${domain === undefined ? '' : `; domain=${domain}`}${secure ? '; Secure' : ''}`;
  return {
    get: (name) => readCookie(doc, name),
    set(name, value, maxAgeS) {
      doc.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAgeS}${suffix}`;
    },
  };
}

/**
 * Returns the visitor/session ids, creating them when missing, and slides the
 * 30-minute session cookie. A missing session cookie means the previous session
 * expired: a new session id is issued and the session counter is incremented.
 */
export function touchIds(jar: CookieJar, crypto: Crypto | undefined, now: number): Ids {
  let vid = jar.get(COOKIE_VISITOR);
  let fs = Number(jar.get(COOKIE_FIRST_SEEN));
  let sn = Number(jar.get(COOKIE_SESSION_COUNT));
  let sid = jar.get(COOKIE_SESSION);
  if (vid === undefined || !ID_RE.test(vid)) {
    vid = uuid(crypto);
    fs = now;
    sn = 0;
    sid = undefined;
  }
  if (!Number.isFinite(fs) || fs <= 0) fs = now;
  if (!Number.isInteger(sn) || sn < 0) sn = 0;
  if (sid === undefined || !ID_RE.test(sid)) {
    sid = `s${uuid(crypto).replace(/-/g, '')}`;
    sn += 1;
  }
  if (sn < 1) sn = 1;
  return writeIds(jar, { vid, sid, fs, sn });
}

export function writeIds(jar: CookieJar, ids: Ids): Ids {
  jar.set(COOKIE_VISITOR, ids.vid, VISITOR_MAX_AGE_S);
  jar.set(COOKIE_FIRST_SEEN, String(ids.fs), VISITOR_MAX_AGE_S);
  jar.set(COOKIE_SESSION_COUNT, String(ids.sn), VISITOR_MAX_AGE_S);
  jar.set(COOKIE_SESSION, ids.sid, SESSION_MAX_AGE_S);
  return ids;
}

/** Parses handoff params from a URL; undefined when absent, stale or malformed. */
/** Expires the ids written by a cookie build (the site switched to cookieless). */
export function clearIds(jar: CookieJar): void {
  for (const name of [COOKIE_VISITOR, COOKIE_FIRST_SEEN, COOKIE_SESSION_COUNT, COOKIE_SESSION]) {
    jar.set(name, '', 0);
  }
}

export function readHandoff(url: URL, now: number): Ids | undefined {
  const p = url.searchParams;
  const vid = p.get('_amb_vid');
  const sid = p.get('_amb_sid');
  const fs = Number(p.get('_amb_fs'));
  const sn = Number(p.get('_amb_sn'));
  const ts = Number(p.get('_amb_ts'));
  if (vid === null || sid === null || !ID_RE.test(vid) || !ID_RE.test(sid)) return undefined;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > HANDOFF_MAX_AGE_MS) return undefined;
  return {
    vid,
    sid,
    fs: Number.isFinite(fs) && fs > 0 ? fs : now,
    sn: Number.isInteger(sn) && sn > 0 ? sn : 1,
  };
}

/** URL without the handoff params, or undefined when there were none. */
export function stripHandoff(url: URL): string | undefined {
  let found = false;
  for (const name of HANDOFF_PARAMS) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      found = true;
    }
  }
  return found ? url.toString() : undefined;
}

/** Adds the handoff params to a link pointing to another of the site's domains. */
export function decorateLink(href: string, ids: Ids, now: number): string {
  const url = new URL(href);
  url.searchParams.set('_amb_vid', ids.vid);
  url.searchParams.set('_amb_sid', ids.sid);
  url.searchParams.set('_amb_fs', String(ids.fs));
  url.searchParams.set('_amb_sn', String(ids.sn));
  url.searchParams.set('_amb_ts', String(now));
  return url.toString();
}

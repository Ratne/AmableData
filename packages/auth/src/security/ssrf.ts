/**
 * SSRF-safe outbound HTTP for user-configured URLs (automation HTTP steps,
 * outgoing webhooks, form connectors).
 *
 * - only http/https, no credentials in the URL, only ports 80/443 (+ allowlist);
 * - IP literals in private, loopback, link-local (cloud metadata), CGNAT,
 *   multicast, reserved and IPv4-mapped IPv6 ranges are refused, as are
 *   internal-looking hostnames (localhost, *.local, *.internal…);
 * - optional DNS resolver hook (e.g. DNS-over-HTTPS) to refuse hostnames that
 *   resolve to those ranges;
 * - redirects are followed manually, re-validating every hop (default 3,
 *   never more than 5); credentials headers are dropped on cross-origin hops;
 * - timeout (whole exchange, body included) and maximum response size.
 *
 * Workers cannot resolve DNS before connecting, so without a `resolver` a
 * public hostname pointing at a private address (DNS rebinding) is only
 * stopped by the platform itself: Cloudflare's fetch does not route to
 * private networks. IP literals in every encoding are refused here.
 */

export class SsrfBlockedError extends Error {
  override readonly name = 'SsrfBlockedError';
}

export class ResponseTooLargeError extends Error {
  override readonly name = 'ResponseTooLargeError';
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? bytes : null;
}

function isBlockedIpv4([a = 0, b = 0]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 + 192.0.2.0/24 (approximation: whole /16)
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224 // multicast + reserved + broadcast
  );
}

function expandIpv6(host: string): number[] | null {
  let value = host.toLowerCase();
  if (value.includes('%')) return null; // zone ids
  // IPv4-mapped / embedded IPv4 tail.
  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (v4Tail?.[1] !== undefined) {
    const v4 = parseIpv4(v4Tail[1]);
    if (v4 === null) return null;
    const hex = `${((v4[0] ?? 0) * 256 + (v4[1] ?? 0)).toString(16)}:${((v4[2] ?? 0) * 256 + (v4[3] ?? 0)).toString(16)}`;
    value = value.slice(0, -v4Tail[1].length) + hex;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : (halves[0]?.split(':') ?? []);
  const tail = halves.length === 2 && halves[1] !== '' ? (halves[1]?.split(':') ?? []) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const numbers = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  return numbers.length === 8 && numbers.every((n) => !Number.isNaN(n)) ? numbers : null;
}

const IPV6_CANDIDATE = /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{0,4})(?:%[\w.-]+)?(?![\w:])/gi;
const IPV4_ADDRESS = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

/**
 * Masks IPv6 (full, compressed, IPv4-mapped, with zone id) and IPv4 addresses
 * in free text, for log and error scrubbers. Candidates are validated, so
 * clock times (`12:30:45`) and other colon runs that are not addresses stay.
 */
export function redactIpAddresses(text: string, replacement = '[ip]'): string {
  return text
    .replace(IPV6_CANDIDATE, (match) => {
      const address = match.replace(/%.*$/, '');
      return address.includes('::') || address.split(':').length >= 7 ? (expandIpv6(address) === null ? match : replacement) : match;
    })
    .replace(IPV4_ADDRESS, replacement);
}

function isBlockedIpv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const allZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (allZeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  if (allZeroPrefix && (g5 === 0xffff || g5 === 0)) {
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible.
    return isBlockedIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if (g0 === 0x64 && g1 === 0xff9b) return true; // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48)
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard-only 100::/64
  if (g0 === 0x2002) return isBlockedIpv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]); // 6to4 embeds an IPv4
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo: the client IPv4 is obfuscated, refuse the range
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  return false;
}

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.lan',
  '.home',
  '.home.arpa',
  '.intranet',
  '.corp',
  '.private',
];
const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

/** Headers that must not follow a redirect to another origin. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
const MAX_REDIRECTS_CAP = 5;

/** True when an IP literal (v4 or v6, brackets optional) is not publicly routable. */
export function isPrivateAddress(address: string): boolean {
  const host = address.replace(/^\[|\]$/g, '');
  const v4 = parseIpv4(host);
  if (v4 !== null) return isBlockedIpv4(v4);
  if (host.includes(':')) {
    const v6 = expandIpv6(host);
    return v6 === null ? true : isBlockedIpv6(v6);
  }
  return false;
}

export interface SafeUrlOptions {
  /** Extra allowed ports besides 80/443. */
  readonly allowedPorts?: readonly number[];
}

/** Validates a user-supplied URL; throws SsrfBlockedError with a reason. */
export function assertSafeUrl(input: string | URL, options: SafeUrlOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SsrfBlockedError('invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SsrfBlockedError(`scheme ${url.protocol} not allowed`);
  }
  if (url.username !== '' || url.password !== '') throw new SsrfBlockedError('credentials in URL');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (port !== 80 && port !== 443 && !(options.allowedPorts ?? []).includes(port)) {
    throw new SsrfBlockedError(`port ${port} not allowed`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new SsrfBlockedError('internal hostname');
  }
  // WHATWG URL already normalizes decimal/hex/octal/short IPv4 forms (0x7f.1, 2130706433,
  // 0177.0.0.1) to dotted quads; anything numeric-looking that is still not one is refused.
  if (/^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$/i.test(host) && parseIpv4(host) === null) {
    throw new SsrfBlockedError('odd IPv4 form');
  }
  if (isPrivateAddress(host)) throw new SsrfBlockedError('private address');
  if (!host.includes('.') && !host.includes(':')) throw new SsrfBlockedError('single-label host');
  return url;
}

/** Resolves a hostname to IP addresses (e.g. via DNS-over-HTTPS). */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface SafeFetchOptions extends SafeUrlOptions {
  readonly fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
  readonly resolver?: HostResolver;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
}

export interface SafeFetchResult {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly url: string;
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new ResponseTooLargeError(`declared ${declared} bytes`);
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(`more than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function safeFetch(
  input: string,
  init: Omit<RequestInit, 'redirect' | 'signal'>,
  options: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const maxRedirects = Math.min(Math.max(options.maxRedirects ?? 3, 0), MAX_REDIRECTS_CAP);
  const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  let current = input;
  let method = init.method ?? 'GET';
  let body = init.body;
  let headers = new Headers(init.headers);
  let origin: string | null = null;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = assertSafeUrl(current, options);
    if (origin !== null && url.origin !== origin) {
      headers = new Headers(headers);
      for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    }
    origin = url.origin;
    if (options.resolver !== undefined) {
      const addresses = await options.resolver(url.hostname);
      if (addresses.length === 0) throw new SsrfBlockedError('host does not resolve');
      if (addresses.some(isPrivateAddress)) throw new SsrfBlockedError('resolves to private address');
    }
    const response = await options.fetchFn(url.toString(), {
      ...init,
      headers,
      method,
      body,
      redirect: 'manual',
      signal,
    });
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      current = new URL(response.headers.get('location') ?? '', url).toString();
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      await response.body?.cancel();
      continue;
    }
    return {
      status: response.status,
      headers: response.headers,
      body: await readLimited(response, options.maxBytes ?? 1_048_576),
      url: url.toString(),
    };
  }
  throw new SsrfBlockedError('too many redirects');
}

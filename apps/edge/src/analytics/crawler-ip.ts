/**
 * IP verification of declared crawlers: a request whose user agent claims to
 * be a known bot is checked against the IP ranges its operator publishes.
 *
 * The ranges below are a bundled baseline snapshot (no network at runtime);
 * the central services of the managed offering will distribute refreshed
 * lists, versioned like the crawler list. Operators without a published list
 * yield `unknown`, never `spoofed`.
 */

export const CRAWLER_RANGES_VERSION = '2026-10-15';

export type Verification = 'verified' | 'spoofed' | 'unknown';

/** Published ranges by operator. */
const RANGES: Readonly<Record<string, readonly string[]>> = {
  google: [
    '66.249.64.0/19',
    '64.233.160.0/19',
    '72.14.199.0/24',
    '74.125.0.0/16',
    '192.178.4.0/22',
    '2001:4860:4801::/48',
  ],
  bing: [
    '157.55.39.0/24',
    '207.46.13.0/24',
    '40.77.167.0/24',
    '13.66.139.0/24',
    '13.66.144.0/24',
    '52.167.144.0/24',
    '40.77.188.0/22',
    '65.55.210.0/24',
    '199.30.24.0/23',
    '40.77.202.0/24',
    '40.77.139.0/25',
    '40.77.177.0/24',
    '40.77.178.0/23',
    '20.15.133.160/27',
  ],
  openai_gptbot: [
    '52.230.152.0/24',
    '20.171.206.0/24',
    '20.171.207.0/24',
    '4.227.36.0/25',
    '20.125.66.80/28',
    '172.182.204.0/24',
    '172.182.214.0/24',
    '172.182.215.0/24',
  ],
  openai_user: [
    '23.98.142.176/28',
    '40.84.180.224/28',
    '13.65.240.240/28',
    '20.97.189.96/28',
    '20.161.75.208/28',
    '52.225.75.208/28',
    '52.156.77.144/28',
    '40.84.221.208/28',
    '40.84.180.64/28',
    '40.84.221.224/28',
  ],
  openai_search: [
    '20.42.10.176/28',
    '172.203.190.128/28',
    '104.210.140.128/28',
    '51.8.102.0/24',
    '135.234.64.0/24',
  ],
  anthropic: ['160.79.104.0/23', '2607:6bc0::/48'],
  apple: ['17.0.0.0/8'],
  duckduckgo: [
    '20.191.45.212/32',
    '40.88.21.235/32',
    '40.76.173.151/32',
    '40.76.163.7/32',
    '20.185.79.47/32',
    '52.142.26.175/32',
    '20.185.79.15/32',
    '52.142.24.149/32',
    '40.76.162.208/32',
    '40.76.163.23/32',
    '40.76.162.191/32',
    '40.76.162.247/32',
  ],
};

/** Bot name (as reported by `detectBot`) → operator range list. */
const BOT_OPERATOR: Readonly<Record<string, keyof typeof RANGES>> = {
  Googlebot: 'google',
  'Google-Agent': 'google',
  'Google-CloudVertexBot': 'google',
  Bingbot: 'bing',
  GPTBot: 'openai_gptbot',
  'ChatGPT-User': 'openai_user',
  'OAI-SearchBot': 'openai_search',
  ClaudeBot: 'anthropic',
  'Claude-User': 'anthropic',
  'Claude-SearchBot': 'anthropic',
  Applebot: 'apple',
  'Applebot-Extended': 'apple',
  DuckDuckBot: 'duckduckgo',
  DuckAssistBot: 'duckduckgo',
};

type Parsed = { v: 4 | 6; value: bigint };

function parseIpv4(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIpv6(input: string): bigint | null {
  let text = (input.toLowerCase().split('%')[0] ?? '').trim();
  let v4: bigint | null = null;
  if (text.includes('.')) {
    const idx = text.lastIndexOf(':');
    v4 = parseIpv4(text.slice(idx + 1));
    if (v4 === null) return null;
    text = `${text.slice(0, idx + 1)}x`;
  }
  const parts = text.split('::');
  if (parts.length > 2) return null;
  const expand = (s: string | undefined): string[] =>
    s === undefined || s === '' ? [] : s.split(':').flatMap((g) => (g === 'x' ? ['v4hi', 'v4lo'] : [g]));
  const left = expand(parts[0]);
  const right = parts.length === 2 ? expand(parts[1]) : [];
  let groups = left;
  if (parts.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null;
    groups = [...left, ...new Array<string>(fill).fill('0'), ...right];
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    let n: bigint;
    if (g === 'v4hi' && v4 !== null) n = (v4 >> 16n) & 0xffffn;
    else if (g === 'v4lo' && v4 !== null) n = v4 & 0xffffn;
    else if (/^[0-9a-f]{1,4}$/.test(g)) n = BigInt(parseInt(g, 16));
    else return null;
    value = (value << 16n) | n;
  }
  return value;
}

export function parseIp(ip: string): Parsed | null {
  const trimmed = ip.trim();
  if (trimmed.includes(':')) {
    const v6 = parseIpv6(trimmed);
    if (v6 === null) return null;
    // IPv4-mapped IPv6 behaves as IPv4.
    if (v6 >> 32n === 0xffffn) return { v: 4, value: v6 & 0xffffffffn };
    return { v: 6, value: v6 };
  }
  const v4 = parseIpv4(trimmed);
  return v4 === null ? null : { v: 4, value: v4 };
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const addr = parseIp(ip);
  const net = base === undefined ? null : parseIp(base);
  if (addr === null || net === null || addr.v !== net.v) return false;
  const width = addr.v === 4 ? 32 : 128;
  const bits = bitsText === undefined ? width : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  const shift = BigInt(width - bits);
  return addr.value >> shift === net.value >> shift;
}

/** Checks a claimed bot against its operator's published ranges. */
export function verifyCrawlerIp(botName: string, ip: string | null | undefined): Verification {
  const operator = BOT_OPERATOR[botName];
  if (operator === undefined || ip === null || ip === undefined || ip === '' || ip === '0.0.0.0') return 'unknown';
  if (parseIp(ip) === null) return 'unknown';
  return (RANGES[operator] ?? []).some((cidr) => inCidr(ip, cidr)) ? 'verified' : 'spoofed';
}

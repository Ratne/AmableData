import { sha256Hex } from '@amable/auth';
import type { ExtraValue } from './types';
import { parseUserAgent } from './ua';

/**
 * Signals shared by the browsers of one device (in-app browser → Safari or
 * Chrome on the same phone). Canvas, audio, fonts, device memory, preferences,
 * languages and the UA client hints differ between engines or apps, so they
 * stay out of the key and only feed the measurements.
 */
const KEY_SIGNALS = ['dpr', 'cd', 'hc', 'tp', 'plat', 'gpu'] as const;

/**
 * Signals of one browser install, for the `fp` key: the engine's readings
 * (canvas, audio, fonts, math) on top of the device ones. The color scheme
 * (it follows the time of day) and the system version (it changes with every
 * update) stay out.
 */
const FP_SIGNALS = [
  'cv',
  'au',
  'fonts',
  'math',
  'gpu',
  'dpr',
  'cd',
  'hc',
  'dm',
  'tp',
  'plat',
  'langs',
  'sf',
  'os',
  'mdl',
  'arch',
] as const;

/** A reading the browser noises at random (the tracker read two different values). */
export const UNSTABLE = 'unstable';
/** A reading dropped because the browser is known to noise or spoof it in some of its modes. */
export const SKIPPED = 'skipped';

const usable = (v: string | number | undefined): boolean =>
  v !== undefined && v !== UNSTABLE && v !== SKIPPED;

/**
 * Readings a browser noises or spoofs in some of its modes (private browsing,
 * strict tracking protection), so a value is no evidence. After FingerprintJS
 * (https://github.com/fingerprintjs/fingerprintjs, MIT): Safari 17+ noises
 * canvas and audio and zeroes the screen frame, Firefox 120+ randomizes the
 * canvas (143+ also spoofs the screen frame), Samsung Internet 26+ noises audio.
 */
export function noisyReadings(userAgent: string): ReadonlySet<'cv' | 'au' | 'sf'> {
  const ua = parseUserAgent(userAgent);
  const version = Number(ua.browserVersion ?? 0);
  // Firefox on iOS and iPadOS is WebKit underneath.
  const gecko = ua.browser === 'Firefox' && ua.os !== 'iOS' && ua.os !== 'iPadOS';
  if (ua.browser === 'Safari' && version >= 17) return new Set(['cv', 'au', 'sf']);
  if (gecko && version >= 143) return new Set(['cv', 'sf']);
  if (gecko && version >= 120) return new Set(['cv']);
  if (ua.browser === 'Samsung Internet' && version >= 26) return new Set(['au']);
  return new Set();
}

export interface DeviceSighting {
  /** Hash of the stable signals (plus screen size and time zone). */
  key: string;
  /** Keyed hash of the network (IPv4 address, IPv6 /64); null when the IP is unknown. */
  net: string | null;
  /**
   * Hash of the browser install signals (plus screen size and time zone), for
   * the `fp` rule; null when neither canvas nor audio gave a usable reading
   * (nothing tells two browsers of the same model apart then).
   */
  fp: string | null;
  /** Every signal received, JSON (measurements only). */
  signals: string;
}

/** The network part of an IP: the IPv4 address, or the IPv6 /64 (privacy addresses rotate inside it). */
export function networkOf(ip: string): string | null {
  if (ip === '' || ip === '0.0.0.0') return null;
  if (!ip.includes(':')) return ip;
  const [head = '', tail] = ip.split('::');
  const left = head.split(':').filter(Boolean);
  const right = tail === undefined ? [] : tail.split(':').filter(Boolean);
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':');
}

export async function deviceSighting(
  data: Record<string, ExtraValue> | null | undefined,
  input: {
    siteId: string;
    key: string;
    ip: string;
    userAgent?: string;
    sw?: number;
    sh?: number;
    tz?: string;
  },
): Promise<DeviceSighting | null> {
  if (data == null) return null;
  const noisy = noisyReadings(input.userAgent ?? '');
  const signals: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(data)) {
    if (noisy.has(k as 'cv')) signals[k] = SKIPPED;
    else if (typeof v === 'string') signals[k] = v.slice(0, 256);
    else if (typeof v === 'number' && Number.isFinite(v)) signals[k] = v;
  }
  if (Object.keys(signals).length === 0) return null;
  const screen =
    input.sw === undefined || input.sh === undefined
      ? ''
      : `${Math.max(input.sw, input.sh)}x${Math.min(input.sw, input.sh)}`;
  const stable = [
    screen,
    input.tz ?? '',
    ...KEY_SIGNALS.map((k) => String(signals[k] ?? '').toLowerCase()),
  ].join('\n');
  const net = networkOf(input.ip);
  const browserSpecific = usable(signals['cv']) || usable(signals['au']);
  const fp = browserSpecific
    ? [
        screen,
        input.tz ?? '',
        ...FP_SIGNALS.map((k) => (usable(signals[k]) ? String(signals[k]).toLowerCase() : '')),
      ].join('\n')
    : null;
  return {
    key: (await sha256Hex(`device\n${input.siteId}\n${stable}`)).slice(0, 32),
    net:
      net === null
        ? null
        : (await sha256Hex(`device_ip\n${input.key}\n${input.siteId}\n${net}`)).slice(0, 32),
    fp: fp === null ? null : (await sha256Hex(`fp\n${input.siteId}\n${fp}`)).slice(0, 32),
    signals: JSON.stringify(signals),
  };
}

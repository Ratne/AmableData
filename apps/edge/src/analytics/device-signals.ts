import { sha256Hex } from '@amable/auth';
import type { ExtraValue } from './types';

/**
 * Signals shared by the browsers of one device (in-app browser → Safari or
 * Chrome on the same phone). Canvas, audio, fonts, device memory, preferences,
 * languages and the UA client hints differ between engines or apps, so they
 * stay out of the key and only feed the measurements.
 */
const KEY_SIGNALS = ['dpr', 'cd', 'hc', 'tp', 'plat', 'gpu'] as const;

export interface DeviceSighting {
  /** Hash of the stable signals (plus screen size and time zone). */
  key: string;
  /** Keyed hash of the network (IPv4 address, IPv6 /64); null when the IP is unknown. */
  net: string | null;
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
  input: { siteId: string; key: string; ip: string; sw?: number; sh?: number; tz?: string },
): Promise<DeviceSighting | null> {
  if (data == null) return null;
  const signals: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') signals[k] = v.slice(0, 256);
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
  return {
    key: (await sha256Hex(`device\n${input.siteId}\n${stable}`)).slice(0, 32),
    net:
      net === null
        ? null
        : (await sha256Hex(`device_ip\n${input.key}\n${input.siteId}\n${net}`)).slice(0, 32),
    signals: JSON.stringify(signals),
  };
}

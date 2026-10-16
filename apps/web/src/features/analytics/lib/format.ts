import type { Locale } from '@amable/i18n';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';

/** Fraction digits of an ISO currency (EUR 2, JPY 0, …); 2 when unknown. */
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export function minorToMajor(minor: number, currency: string): number {
  return minor / 10 ** currencyDigits(currency);
}

function safeCurrency(currency: string): string {
  return /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : 'EUR';
}

export interface Formatters {
  readonly locale: Locale;
  readonly number: (value: number, digits?: number) => string;
  readonly compact: (value: number) => string;
  /** `ratio` is 0..1. */
  readonly percent: (ratio: number, digits?: number) => string;
  readonly money: (minor: number, currency: string) => string;
  readonly moneyCompact: (minor: number, currency: string) => string;
  readonly duration: (ms: number) => string;
  readonly date: (iso: string, timeZone?: string) => string;
  readonly dateTime: (iso: string, timeZone?: string) => string;
  readonly time: (iso: string, timeZone?: string) => string;
  readonly relative: (iso: string, now: number) => string;
}

export function createFormatters(locale: Locale): Formatters {
  const numberCache = new Map<string, Intl.NumberFormat>();
  const nf = (key: string, options: Intl.NumberFormatOptions) => {
    let format = numberCache.get(key);
    if (!format) {
      format = new Intl.NumberFormat(locale, options);
      numberCache.set(key, format);
    }
    return format;
  };
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const validDate = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const dateFormat = (options: Intl.DateTimeFormatOptions, timeZone?: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { ...options, timeZone });
    } catch {
      return new Intl.DateTimeFormat(locale, options);
    }
  };

  return {
    locale,
    number: (value, digits = 0) =>
      nf(`n${digits}`, { maximumFractionDigits: digits }).format(
        Number.isFinite(value) ? value : 0,
      ),
    compact: (value) =>
      Math.abs(value) < 10_000
        ? nf('n0', { maximumFractionDigits: 0 }).format(value)
        : nf('c', { notation: 'compact', maximumFractionDigits: 1 }).format(value),
    percent: (ratio, digits = 1) =>
      nf(`p${digits}`, { style: 'percent', maximumFractionDigits: digits }).format(
        Number.isFinite(ratio) ? ratio : 0,
      ),
    money: (minor, currency) => {
      const code = safeCurrency(currency);
      return nf(`m${code}`, { style: 'currency', currency: code }).format(
        minorToMajor(minor, code),
      );
    },
    moneyCompact: (minor, currency) => {
      const code = safeCurrency(currency);
      const major = minorToMajor(minor, code);
      if (Math.abs(major) < 10_000)
        return nf(`mc0${code}`, {
          style: 'currency',
          currency: code,
          maximumFractionDigits: Math.abs(major) < 100 ? currencyDigits(code) : 0,
        }).format(major);
      return nf(`mcc${code}`, {
        style: 'currency',
        currency: code,
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(major);
    },
    duration: (ms) => {
      const total = Math.max(0, Math.round(ms / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    },
    date: (iso, timeZone) => {
      const date = validDate(iso);
      return date ? dateFormat({ dateStyle: 'medium' }, timeZone).format(date) : iso;
    },
    dateTime: (iso, timeZone) => {
      const date = validDate(iso);
      return date
        ? dateFormat({ dateStyle: 'medium', timeStyle: 'short' }, timeZone).format(date)
        : iso;
    },
    time: (iso, timeZone) => {
      const date = validDate(iso);
      return date ? dateFormat({ hour: '2-digit', minute: '2-digit' }, timeZone).format(date) : iso;
    },
    relative: (iso, now) => {
      const date = validDate(iso);
      if (!date) return iso;
      const seconds = Math.round((date.getTime() - now) / 1000);
      const abs = Math.abs(seconds);
      if (abs < 45) return rtf.format(Math.min(0, seconds), 'second');
      if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
      if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
      if (abs < 86_400 * 30) return rtf.format(Math.round(seconds / 86_400), 'day');
      if (abs < 86_400 * 365) return rtf.format(Math.round(seconds / (86_400 * 30)), 'month');
      return rtf.format(Math.round(seconds / (86_400 * 365)), 'year');
    },
  };
}

export function useFormatters(): Formatters {
  const { locale } = useI18n();
  return useMemo(() => createFormatters(locale), [locale]);
}

/** Current time, refreshed every `intervalMs` (for relative times). */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Initials of a name or email, for avatars. */
export function initials(name: string | null, email?: string | null): string {
  const source = (name ?? '').trim() || (email ?? '').split('@')[0] || '';
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase() || '?';
}

const AVATAR_HUES = [212, 152, 32, 280, 350, 190, 100, 250];

/** Stable avatar hue from any string. */
export function avatarHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_HUES[hash % AVATAR_HUES.length] ?? 212;
}

export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

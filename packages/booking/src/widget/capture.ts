import type { BookPayload, BookingTracking } from '../public';

/** Attribution facts of the host page: UTM parameters (kept for the session), analytics visitor cookie, page facts. */

const TRACKING_KEY = 'amb_booking_tracking';
const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;

function stored(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(TRACKING_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function collectTracking(): BookingTracking {
  const params = new URLSearchParams(location.search);
  const merged: Record<string, string> = { ...stored() };
  for (const key of UTM) {
    const value = params.get(key);
    if (value !== null && value !== '') merged[key] = value.slice(0, 255);
  }
  try {
    sessionStorage.setItem(TRACKING_KEY, JSON.stringify(merged));
  } catch {
    // storage disabled
  }
  const out: { -readonly [K in keyof BookingTracking]: string } = {};
  for (const key of UTM) if (merged[key] !== undefined) out[key] = merged[key];
  return out;
}

function cookie(name: string): string {
  const match = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(document.cookie);
  if (match?.[1] === undefined) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

export function collectMeta(element: Element): NonNullable<BookPayload['meta']> {
  const visitor = cookie('amb_vid');
  const pageId =
    element.getAttribute('data-amable-page') ??
    document.querySelector('meta[name="amable-page-id"]')?.getAttribute('content') ??
    '';
  return {
    page_url: location.href.slice(0, 2048),
    referrer: document.referrer.slice(0, 2048),
    page_id: pageId.slice(0, 64),
    visitor_id: /^[A-Za-z0-9_-]{8,64}$/.test(visitor) ? visitor : '',
  };
}

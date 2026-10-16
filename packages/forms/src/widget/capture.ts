import { TRACKING_PARAMS } from '../constants';
import type { FormField, SubmissionMeta } from '../schema';

/**
 * Attribution facts collected on the host page: tracking parameters (kept for
 * the browsing session, so a form on a second page still knows the campaign),
 * first touch, the analytics visitor cookie and URL prefill values.
 */

const TRACKING_KEY = 'amb_form_tracking';
const FIRST_TOUCH_KEY = 'amb_form_first_touch';

function readStorage(key: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function writeStorage(key: string, value: Record<string, string>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage disabled (private mode, sandboxed iframe)
  }
}

export function collectTracking(search: string = location.search): Record<string, string> {
  const params = new URLSearchParams(search);
  const fromUrl: Record<string, string> = {};
  for (const key of TRACKING_PARAMS) {
    const value = params.get(key);
    if (value !== null && value !== '') fromUrl[key] = value.slice(0, 500);
  }
  const merged = { ...readStorage(TRACKING_KEY), ...fromUrl };
  writeStorage(TRACKING_KEY, merged);
  return merged;
}

export function firstTouch(): { landing_url: string; first_referrer: string } {
  const stored = readStorage(FIRST_TOUCH_KEY);
  if (stored['landing_url'] === undefined) {
    const value = { landing_url: location.href, first_referrer: document.referrer };
    writeStorage(FIRST_TOUCH_KEY, value);
    return value;
  }
  return { landing_url: stored['landing_url'], first_referrer: stored['first_referrer'] ?? '' };
}

export function readCookie(name: string): string {
  const match = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(document.cookie);
  if (match?.[1] === undefined) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

/** Landing page id: `data-amable-page` on the embed element or `<meta name="amable-page-id">`. */
export function pageIdOf(element: Element): string {
  const own = element.getAttribute('data-amable-page');
  if (own !== null && own !== '') return own;
  return document.querySelector('meta[name="amable-page-id"]')?.getAttribute('content') ?? '';
}

export function collectMeta(element: Element): SubmissionMeta {
  const touch = firstTouch();
  const visitor = readCookie('amb_vid');
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = '';
  }
  return {
    page_url: location.href.slice(0, 2048),
    referrer: document.referrer.slice(0, 2048),
    landing_url: touch.landing_url.slice(0, 2048),
    first_referrer: touch.first_referrer.slice(0, 2048),
    page_id: pageIdOf(element).slice(0, 64),
    visitor_id: /^[A-Za-z0-9_-]{8,64}$/.test(visitor) ? visitor : '',
    locale: navigator.language.slice(0, 16),
    time_zone: timeZone.slice(0, 64),
    viewport: `${String(window.innerWidth)}x${String(window.innerHeight)}`,
  };
}

/** Initial values: field defaults, then URL prefill parameters, then hidden-field parameters. */
export function initialValues(
  fields: readonly FormField[],
  search: string = location.search,
): Record<string, unknown> {
  const params = new URLSearchParams(search);
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const fromUrl = field.prefill_param === '' ? null : params.get(field.prefill_param);
    const raw = fromUrl ?? (field.default_value === '' ? null : field.default_value);
    if (raw === null) continue;
    switch (field.kind) {
      case 'checkbox':
      case 'consent':
        if (fromUrl !== null) values[field.key] = ['1', 'true', 'yes', 'si', 'on'].includes(raw.toLowerCase());
        break;
      case 'multicheck': {
        const allowed = new Set(field.options.map((o) => o.value));
        values[field.key] = raw
          .split(',')
          .map((v) => v.trim())
          .filter((v) => allowed.has(v));
        break;
      }
      case 'select':
      case 'radio': {
        const match = field.options.find(
          (o) => o.value === raw || o.label.toLowerCase() === raw.toLowerCase(),
        );
        if (match !== undefined) values[field.key] = match.value;
        break;
      }
      case 'rating': {
        const n = Math.round(Number(raw));
        if (Number.isFinite(n) && n >= 1) values[field.key] = Math.min(n, field.max_rating);
        break;
      }
      case 'heading':
      case 'html':
      case 'page_break':
        break;
      default:
        values[field.key] = raw.slice(0, 1000);
    }
  }
  return values;
}

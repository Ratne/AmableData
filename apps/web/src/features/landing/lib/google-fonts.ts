import { canonicalFontFamily } from '@amable/builder';

const GENERIC = /system-ui|sans-serif|serif|monospace|inherit|cursive|fantasy/i;

/** Google Fonts CSS2 URL for a set of families (weights 300-800); the API is case-sensitive. */
export function googleFontHref(families: readonly string[]): string | null {
  const list = [
    ...new Set(
      families.filter((f) => f && !f.startsWith('var(') && !GENERIC.test(f)).map((f) => canonicalFontFamily(f)),
    ),
  ];
  if (list.length === 0) return null;
  const spec = list
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@300;400;500;600;700;800`)
    .join('&');
  return `https://fonts.googleapis.com/css2?${spec}&display=swap`;
}

/** Injects (once) the stylesheet of a family into the SPA head, for the picker preview. */
export function loadGoogleFont(family: string | undefined): void {
  if (!family || family.startsWith('var(') || GENERIC.test(family)) return;
  const id = `gf-${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  if (document.getElementById(id)) return;
  const href = googleFontHref([family]);
  if (!href) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

/**
 * Availability check against Google Fonts. The catalog changes without notice
 * ("Impact" vanished overnight): the picker uses this to warn right away when
 * a chosen family is not (or no longer) served by Google, instead of letting
 * the published page reveal it. Cached in memory + localStorage (7 days).
 */
const AVAILABILITY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const availabilityCache = new Map<string, boolean | Promise<boolean>>();

function readStoredAvailability(family: string): boolean | null {
  try {
    const raw = localStorage.getItem(`gf-check:${family}`);
    if (!raw) return null;
    const { ok, t } = JSON.parse(raw) as { ok: boolean; t: number };
    if (Date.now() - t > AVAILABILITY_TTL_MS) return null;
    return ok;
  } catch {
    return null;
  }
}

function writeStoredAvailability(family: string, ok: boolean): void {
  try {
    localStorage.setItem(`gf-check:${family}`, JSON.stringify({ ok, t: Date.now() }));
  } catch {
    /* storage full/denied: the in-memory cache still covers the session */
  }
}

/**
 * True when the family is served by Google Fonts (the css2 URL the page would
 * request answers 200). Generic names/tokens pass as available; a network
 * error does NOT mark the font as missing (no false alarms while offline).
 */
export async function isGoogleFontAvailable(family: string): Promise<boolean> {
  const canon = canonicalFontFamily(family.trim());
  if (!canon || canon.startsWith('var(') || GENERIC.test(canon)) return true;
  const cached = availabilityCache.get(canon);
  if (typeof cached === 'boolean') return cached;
  if (cached) return cached;
  const stored = readStoredAvailability(canon);
  if (stored !== null) {
    availabilityCache.set(canon, stored);
    return stored;
  }
  const href = googleFontHref([canon]);
  if (!href) return true;
  const promise = fetch(href)
    .then((res) => {
      const ok = res.ok;
      availabilityCache.set(canon, ok);
      writeStoredAvailability(canon, ok);
      return ok;
    })
    .catch(() => {
      availabilityCache.delete(canon);
      return true;
    });
  availabilityCache.set(canon, promise);
  return promise;
}

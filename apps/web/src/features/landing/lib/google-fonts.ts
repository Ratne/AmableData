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

import { useLayoutEffect, useMemo, type ReactNode } from 'react';

/** Per-tenant white label. Values come from tenant settings and are validated before touching CSS. */
export interface TenantBranding {
  readonly name: string;
  readonly logoUrl?: string | null;
  /** `#rrggbb` or `#rgb`; anything else falls back to the product color. */
  readonly primaryColor?: string | null;
}

/** Product mark served from each SPA's `public/brand/`; shown when the tenant has no own logo. */
export const PRODUCT_LOGO_URL = '/brand/logo.png';

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const BRAND_VARS = ['--brand', '--brand-foreground'] as const;

function expandHex(hex: string): string {
  return hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
}

/** Picks near-white or near-black text by WCAG relative luminance. */
export function readableForeground(hex: string): string {
  const full = expandHex(hex);
  const channel = (offset: number) => {
    const value = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.45 ? '#161616' : '#f9fbff';
}

export function isSafeColor(value: string | null | undefined): value is string {
  return typeof value === 'string' && HEX_RE.test(value);
}

function isSafeLogoUrl(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false;
  return value.startsWith('/') || /^https:\/\//i.test(value);
}

/**
 * Applies the tenant's primary color to the theme tokens (`--brand`, which feeds
 * `--primary`, chart and shell accents) and returns the logo node for the shell.
 * Restores the product defaults when the tenant changes or unmounts.
 */
export function useTenantBranding(branding: TenantBranding | null | undefined): {
  readonly name: string;
  readonly logo: ReactNode;
} {
  const color = isSafeColor(branding?.primaryColor) ? expandHex(branding.primaryColor) : null;

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (color === null) {
      BRAND_VARS.forEach((name) => root.style.removeProperty(name));
      return;
    }
    root.style.setProperty('--brand', color);
    root.style.setProperty('--brand-foreground', readableForeground(color));
    return () => BRAND_VARS.forEach((name) => root.style.removeProperty(name));
  }, [color]);

  const name = branding?.name ?? '';
  const logoUrl = isSafeLogoUrl(branding?.logoUrl) ? branding.logoUrl : null;

  const logo = useMemo<ReactNode>(
    () => (
      <img
        src={logoUrl ?? PRODUCT_LOGO_URL}
        alt=""
        className={logoUrl ? 'size-8 rounded-lg object-contain' : 'size-8 object-contain'}
      />
    ),
    [logoUrl],
  );

  return { name, logo };
}

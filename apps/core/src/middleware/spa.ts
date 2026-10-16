import { COOKIE_NAMES, randomToken, sessionState, sha256Hex } from '@amable/auth';
import { DEFAULT_THEME, isLocale, isTheme, negotiateLocale, type Locale, type Theme } from '@amable/i18n';
import { findSessionByHash, findUserById } from '../auth/store';
import type { Env } from '../env';
import { ensureInstallationMigrated } from '../migrate';

/**
 * Serves the SPA document with:
 * - a per-response CSP nonce on every script (strict CSP, no 'unsafe-inline' scripts);
 * - the user's language/theme injected before first paint (no flash): from the
 *   session's user row, else the `amb_prefs` cookie, else the browser language
 *   + system theme;
 * - the full set of security headers.
 * Non-document assets are passed through untouched.
 */

export interface BootConfig {
  locale: Locale;
  theme: Theme;
  authenticated: boolean;
  turnstileSiteKey: string | null;
}

function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function resolveBootConfig(request: Request, env: Env, now: number): Promise<BootConfig> {
  const cookies = request.headers.get('cookie');
  const base: BootConfig = {
    locale: negotiateLocale(request.headers.get('accept-language')),
    theme: DEFAULT_THEME,
    authenticated: false,
    turnstileSiteKey:
      env.TURNSTILE_SITE_KEY !== undefined && env.TURNSTILE_SITE_KEY !== ''
        ? env.TURNSTILE_SITE_KEY
        : null,
  };
  const prefs = readCookie(cookies, COOKIE_NAMES.prefs);
  if (prefs !== null) {
    const [locale = '', theme = ''] = prefs.split('.');
    if (isLocale(locale)) base.locale = locale;
    if (isTheme(theme)) base.theme = theme;
  }
  const token = readCookie(cookies, COOKIE_NAMES.session);
  if (token !== null && token.length >= 20 && token.length <= 128) {
    try {
      await ensureInstallationMigrated(env.DB);
      const session = await findSessionByHash(env.DB, await sha256Hex(token));
      if (session !== null && sessionState(session, now) === 'valid') {
        const user = await findUserById(env.DB, session.userId);
        if (user !== null) {
          base.authenticated = true;
          if (isLocale(user.locale)) base.locale = user.locale;
          if (isTheme(user.theme)) base.theme = user.theme;
        }
      }
    } catch (error) {
      console.warn('[spa] could not resolve preferences from session', error);
    }
  }
  return base;
}

export function contentSecurityPolicy(nonce: string, https: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    // Inline style attributes are common in UI libraries; scripts stay strict.
    // Google Fonts: the landing page canvas previews the fonts a page uses.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    // Media of landing pages is served by the edge origin (plain http only in local dev).
    `img-src 'self' data: blob: https:${https ? '' : ' http://localhost:*'}`,
    `media-src 'self' blob: https:${https ? '' : ' http://localhost:*'}`,
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self'",
    // Turnstile + video and map embeds shown by the landing page canvas.
    'frame-src https://challenges.cloudflare.com https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.google.com',
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function documentSecurityHeaders(headers: Headers, nonce: string, https: boolean) {
  headers.set('Content-Security-Policy', contentSecurityPolicy(nonce, https));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  );
  // The document embeds a nonce and per-user preferences: never cache it.
  headers.set('Cache-Control', 'no-store');
  headers.set('Vary', 'Cookie, Accept-Language');
  if (https) headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
}

/** Pure HTML transform (testable without HTMLRewriter). */
export function injectBoot(html: string, config: BootConfig, nonce: string): string {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const dark = config.theme === 'dark';
  const boot =
    `<script nonce="${nonce}">window.__AMABLE__=${json};` +
    `(function(){var d=document.documentElement,t=${JSON.stringify(config.theme)};` +
    `if(t==='dark'||(t==='system'&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches))` +
    `{d.classList.add('dark');d.style.colorScheme='dark'}})();</script>`;
  let out = html.replace(/<html\b[^>]*>/i, () => {
    const cls = dark ? ' class="dark"' : '';
    return `<html lang="${config.locale}" data-theme="${config.theme}"${cls}>`;
  });
  out = out.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
  out = out.replace(/<link\b(?=[^>]*\brel="modulepreload")(?![^>]*\bnonce=)/gi, `<link nonce="${nonce}"`);
  return out.includes('</head>') ? out.replace('</head>', `${boot}</head>`) : boot + out;
}

export async function serveSpa(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const looksLikeFile = /\.[a-z0-9]+$/i.test(url.pathname) && !url.pathname.endsWith('.html');
  if (looksLikeFile || (request.method !== 'GET' && request.method !== 'HEAD')) {
    return env.ASSETS.fetch(request);
  }
  // Fresh request (no conditional headers) so the shell always comes back with a body.
  const asset = await env.ASSETS.fetch(new Request(new URL('/', url).toString()));
  if (!(asset.headers.get('content-type') ?? '').includes('text/html')) return asset;

  const nonce = randomToken(16);
  const config = await resolveBootConfig(request, env, Date.now());
  const body = injectBoot(await asset.text(), config, nonce);
  const headers = new Headers(asset.headers);
  headers.delete('content-length');
  headers.delete('etag');
  headers.set('content-type', 'text/html; charset=utf-8');
  documentSecurityHeaders(headers, nonce, url.protocol === 'https:');
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

import { isLocale, resolveLocale, t as translate, type Locale, type MessageKey } from '@amable/i18n';
import { useCallback } from 'react';
import { stepUpFetch } from '../../lib/step-up';

/**
 * Minimal API client + i18n accessor for the auth pages. Self-contained on
 * purpose (works before/without the app shell providers).
 */

export class AuthApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>,
  ) {
    super(code);
  }
}

export async function authApi<T = Record<string, unknown>>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['x-amable-csrf'] = '1';
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await stepUpFetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: options.body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(options.body),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new AuthApiError(response.status, typeof body.error === 'string' ? body.error : 'error', body);
  }
  return body as T;
}

interface BootConfig {
  locale?: string;
  turnstileSiteKey?: string | null;
}

function boot(): BootConfig {
  const value: unknown = typeof window === 'undefined' ? undefined : Reflect.get(window, '__AMABLE__');
  return typeof value === 'object' && value !== null ? (value as BootConfig) : {};
}

export function currentLocale(): Locale {
  const injected = boot().locale;
  if (injected !== undefined && isLocale(injected)) return injected;
  return resolveLocale((typeof navigator === 'undefined' ? '' : navigator.language).split('-')[0]);
}

export function turnstileSiteKey(): string | null {
  return boot().turnstileSiteKey ?? null;
}

export function useT() {
  const locale = currentLocale();
  return useCallback(
    (key: MessageKey, vars?: Readonly<Record<string, string | number>>) => translate(locale, key, vars),
    [locale],
  );
}

/** Tokens travel in the URL fragment (never sent to servers or logs); read and scrub it. */
export function takeFragmentToken(): string | null {
  const match = /(?:^|[#&])token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (match?.[1] === undefined) return null;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return match[1];
}

export type VerifyMethod = 'totp' | 'email' | 'recovery' | 'enroll_totp' | 'enroll_email';

export interface ChallengeState {
  status: 'mfa_required';
  enrolled: boolean;
  methods: VerifyMethod[];
  attemptsLeft: number;
  expiresAt: number;
}

export interface AuthenticatedBody {
  status: 'authenticated';
  recoveryCodes: string[] | null;
  lastTenantSlug: string | null;
}

export function homePath(slug: string | null): string {
  return slug === null ? '/' : `/t/${slug}`;
}

/** Maps API error codes to messages. */
export function errorMessage(t: ReturnType<typeof useT>, error: unknown): string {
  if (!(error instanceof AuthApiError)) return t('common.error');
  switch (error.code) {
    case 'invalid_credentials':
      return t('auth.login.invalid');
    case 'rate_limited':
      return t('auth.login.rateLimited');
    case 'turnstile_required':
      return t('auth.login.turnstile');
    case 'account_locked': {
      const until = Number(error.body.lockedUntil);
      return t('auth.login.locked', { time: new Date(until).toLocaleTimeString(currentLocale()) });
    }
    case 'invalid_code':
      return t('auth.challenge.wrong', { count: Number(error.body.attemptsLeft) });
    case 'challenge_cancelled':
      return t('auth.challenge.cancelled');
    case 'challenge_expired':
    case 'no_challenge':
      return t('auth.challenge.expired');
    case 'password_too_short':
      return t('auth.password.tooShort');
    case 'password_too_long':
      return t('auth.password.tooLong');
    case 'password_breached':
      return t('auth.password.breached');
    case 'invalid_token':
      return t('auth.reset.invalid');
    case 'invalid_invite':
      return t('auth.invite.invalid');
    default:
      return t('common.error');
  }
}

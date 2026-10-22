import { SESSION_PARAM } from '../gateway';
import type { NextStep } from '../public';
import type { CheckoutApi } from './api';

/** Session tokens kept per checkout so a retry reuses the same purchase (and Stripe intent). */
const TOKEN_KEY = 'amb_checkout_';

export function storedToken(checkoutId: string): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY + checkoutId) ?? '';
  } catch {
    return '';
  }
}

export function storeToken(checkoutId: string, token: string | null): void {
  try {
    if (token === null) sessionStorage.removeItem(TOKEN_KEY + checkoutId);
    else sessionStorage.setItem(TOKEN_KEY + checkoutId, token);
  } catch {
    // storage disabled
  }
}

export function withParam(url: string, key: string, value: string): string {
  try {
    const target = new URL(url, location.href);
    target.searchParams.set(key, value);
    return target.toString();
  } catch {
    return url;
  }
}

/**
 * Follows the next step of a purchase: an offer page (the token rides along
 * in `amb_cs`), the thank-you page, or `null` when the built-in confirmation
 * should be shown in place.
 */
export function followNext(api: CheckoutApi, next: NextStep, token: string): 'navigating' | 'show_success' {
  if (next.kind === 'offer') {
    location.assign(withParam(next.url ?? api.offerPage(), SESSION_PARAM, token));
    return 'navigating';
  }
  if (next.url !== null) {
    location.assign(next.url);
    return 'navigating';
  }
  return 'show_success';
}

export function sessionTokenFromUrl(): string {
  const token = new URLSearchParams(location.search).get(SESSION_PARAM) ?? '';
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : '';
}

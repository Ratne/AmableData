import type { RateLimiter, TurnstileVerifier } from '@amable/auth';
import type { OAuthTokenProvider } from '@amable/core';
import { getAuthServices } from '../auth/services';
import type { Env } from '../env';
import { oauthTokenProvider } from '../providers/select';

/**
 * Outside-world dependencies of bookings (clock, OAuth tokens, outgoing HTTP
 * for Google Calendar, Turnstile, rate limit). Tests swap single pieces with
 * `overrideBookingRuntime` — no network, ever.
 */
export interface BookingRuntime {
  now(): number;
  oauth: OAuthTokenProvider;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  turnstile: TurnstileVerifier;
  turnstileSiteKey: string | null;
  /** Per-IP limit of public bookings. */
  limiter: RateLimiter;
}

type Override = (base: BookingRuntime, env: Env) => BookingRuntime;

let override: Override | null = null;

/** Test hook (pass `null` to restore). */
export function overrideBookingRuntime(next: Override | null): void {
  override = next;
}

export function oauthProviderFor(env: Env): OAuthTokenProvider {
  return oauthTokenProvider(env);
}

export async function bookingRuntime(env: Env): Promise<BookingRuntime> {
  const services = await getAuthServices(env);
  const base: BookingRuntime = {
    now: services.now,
    oauth: oauthProviderFor(env),
    fetch: (input, init) => fetch(input, init),
    turnstile: services.turnstile,
    turnstileSiteKey: services.turnstileSiteKey,
    limiter: services.ipLimiter,
  };
  return override === null ? base : override(base, env);
}

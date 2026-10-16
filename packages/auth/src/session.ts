import { AUTH_POLICY } from './policy';

export interface SessionTimes {
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly absoluteExpiresAt: number;
}

export function newSessionTimes(now: number): SessionTimes {
  const absoluteExpiresAt = now + AUTH_POLICY.sessionAbsoluteMs;
  return {
    createdAt: now,
    lastSeenAt: now,
    expiresAt: Math.min(now + AUTH_POLICY.sessionIdleMs, absoluteExpiresAt),
    absoluteExpiresAt,
  };
}

export type SessionState = 'valid' | 'idle_expired' | 'absolute_expired';

export function sessionState(session: SessionTimes, now: number): SessionState {
  if (now >= session.absoluteExpiresAt) return 'absolute_expired';
  if (now >= session.expiresAt) return 'idle_expired';
  return 'valid';
}

/**
 * Sliding refresh: returns the new (lastSeenAt, expiresAt) when the session was
 * last touched more than `sessionTouchIntervalMs` ago, otherwise null. The idle
 * expiry never extends past the absolute expiry.
 */
export function slideSession(
  session: SessionTimes,
  now: number,
): { lastSeenAt: number; expiresAt: number } | null {
  if (now - session.lastSeenAt < AUTH_POLICY.sessionTouchIntervalMs) return null;
  return {
    lastSeenAt: now,
    expiresAt: Math.min(now + AUTH_POLICY.sessionIdleMs, session.absoluteExpiresAt),
  };
}

/** Coarse, privacy-friendly device label from a User-Agent ("Chrome on macOS"). */
export function describeUserAgent(userAgent: string | null): string {
  if (userAgent === null || userAgent === '') return 'Unknown device';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : /curl\//.test(userAgent)
              ? 'curl'
              : 'Browser';
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /iPhone|iPad/.test(userAgent)
      ? 'iOS'
      : /Mac OS X|Macintosh/.test(userAgent)
        ? 'macOS'
        : /Android/.test(userAgent)
          ? 'Android'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'unknown OS';
  return `${browser} on ${os}`;
}

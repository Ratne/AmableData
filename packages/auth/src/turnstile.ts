/**
 * Bot verification contract (Turnstile). Required on magic-link and password
 * reset requests, invite acceptance for new accounts, and on login after
 * repeated failures.
 */
export interface TurnstileVerifier {
  /** Whether verification is active (a disabled verifier accepts everything). */
  readonly enabled: boolean;
  verify(token: string | undefined, remoteIp: string | null): Promise<boolean>;
}

/**
 * Production verifier: server-side Siteverify. `fetchFn` is injected so tests
 * and local dev never reach the network.
 */
export function createSiteverifyTurnstile(options: {
  secretKey: string;
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
  endpoint?: string;
}): TurnstileVerifier {
  const endpoint =
    options.endpoint ?? 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  return {
    enabled: true,
    async verify(token, remoteIp) {
      if (token === undefined || token === '' || token.length > 2048) return false;
      const body = new URLSearchParams({ secret: options.secretKey, response: token });
      if (remoteIp !== null) body.set('remoteip', remoteIp);
      try {
        const response = await options.fetchFn(endpoint, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return false;
        const result: unknown = await response.json();
        return (
          typeof result === 'object' &&
          result !== null &&
          'success' in result &&
          result.success === true
        );
      } catch {
        return false;
      }
    },
  };
}

/** Local dev / tests: accepts everything, or only the given token. */
export function createStaticTurnstile(options: { acceptToken?: string } = {}): TurnstileVerifier {
  return {
    enabled: options.acceptToken !== undefined,
    verify(token) {
      return Promise.resolve(options.acceptToken === undefined || token === options.acceptToken);
    },
  };
}

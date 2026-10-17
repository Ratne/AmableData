import { installationJwks, normalizeOrigin, type Fetch } from './discovery';
import { decodeJwt, verifyJwtSignature } from './keys';

/**
 * Session tokens of app screens: the CRM opens your iframe with
 * `?session_token=<JWT>` (5 minutes, signed by the installation key) and the
 * bridge renews it. Send it to your backend and verify it there; never trust
 * the iframe's own claims.
 */

export interface SessionClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly exp: number;
  readonly iat: number;
  readonly app_id: string;
  readonly install_id: string;
  readonly tenant: { readonly id: string; readonly slug: string };
  readonly user: { readonly id: string; readonly name: string | null; readonly locale: string };
  readonly role: string;
  readonly slot: string;
  readonly key: string;
  readonly contact_id?: string;
}

export class SessionTokenError extends Error {}

export async function verifySessionToken(
  token: string,
  options: {
    /** Your manifest `base_url` (the token audience). */
    audience: string;
    /** Installation origins you have installs on; `iss` must be one of them. */
    isTrustedIssuer: (issuer: string) => boolean | Promise<boolean>;
    appId?: string;
    nowMs?: number;
    fetch?: Fetch;
  },
): Promise<SessionClaims> {
  const decoded = decodeJwt(token);
  if (decoded === null) throw new SessionTokenError('malformed token');
  const claims = decoded.claims as unknown as SessionClaims;
  if (typeof claims.iss !== 'string') throw new SessionTokenError('missing issuer');
  const issuer = normalizeOrigin(claims.iss);
  if (!(await options.isTrustedIssuer(issuer))) throw new SessionTokenError('untrusted issuer');
  if (claims.aud !== options.audience.replace(/\/+$/, '')) throw new SessionTokenError('wrong audience');
  if (options.appId !== undefined && claims.app_id !== options.appId) throw new SessionTokenError('wrong app');
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + 30 < now) throw new SessionTokenError('expired');
  const fetcher = options.fetch ?? fetch;
  let ok = await verifyJwtSignature(token, await installationJwks(issuer, fetcher));
  // The installation may have rotated its key since the cached JWKS.
  if (!ok) ok = await verifyJwtSignature(token, await installationJwks(issuer, fetcher, true));
  if (!ok) throw new SessionTokenError('bad signature');
  return claims;
}

import type { AppUiSlot } from '@amable/core/apps';
import { ulid } from 'ulid';
import type { Env } from '../env';
import { appOriginOf } from '../providers/select';
import { AppError } from './errors';
import type { AppInstall } from './store';
import { signInstallationJwt } from './well-known';

/**
 * App screens inside the CRM (`extensions.ui`): sandboxed iframes on
 * `base_url + path`, opened with a short session token signed by the
 * installation key (`/.well-known/amable-apps/jwks.json`). The token tells the
 * app who is looking (tenant, user, role, slot, contact) with `aud = base_url`;
 * the iframe never calls the CRM API, the app backend does with its own token.
 */

export const FRAME_TOKEN_TTL_S = 300;
export const FRAME_TOKEN_PARAM = 'session_token';

const CONTACT_SLOTS: readonly AppUiSlot[] = ['contact.sidebar', 'contact.actions'];

export interface FrameRequest {
  readonly install: AppInstall;
  readonly key: string;
  readonly contactId: string | null;
  readonly tenant: { readonly id: string; readonly slug: string };
  readonly user: { readonly id: string; readonly name: string | null; readonly locale: string };
  readonly role: string;
  readonly theme: 'light' | 'dark';
  readonly nowMs: number;
}

export interface FrameSession {
  readonly url: string;
  readonly origin: string;
  readonly token: string;
  readonly expires_at: string;
  readonly slot: AppUiSlot;
  readonly height: number | null;
}

export function frameExtension(install: AppInstall, key: string) {
  return install.manifest.extensions.ui?.find((ui) => ui.key === key) ?? null;
}

export function isContactSlot(slot: AppUiSlot): boolean {
  return CONTACT_SLOTS.includes(slot);
}

export async function frameSession(env: Env, input: FrameRequest): Promise<FrameSession> {
  const { install } = input;
  if (install.status !== 'active') throw new AppError(409, 'app_not_active', 'the app is not active');
  const ui = frameExtension(install, input.key);
  if (ui === null) throw new AppError(404, 'not_found', 'screen not found');
  if (isContactSlot(ui.slot) && input.contactId === null) {
    throw new AppError(422, 'validation_failed', 'contact_id is required for contact screens');
  }
  const base = install.manifest.base_url.replace(/\/+$/, '');
  const iat = Math.floor(input.nowMs / 1000);
  const exp = iat + FRAME_TOKEN_TTL_S;
  const token = await signInstallationJwt(env, {
    aud: base,
    sub: input.user.id,
    iat,
    exp,
    jti: ulid(input.nowMs),
    app_id: install.appId,
    install_id: install.id,
    tenant: { id: input.tenant.id, slug: input.tenant.slug },
    user: { id: input.user.id, name: input.user.name, locale: input.user.locale },
    role: input.role,
    slot: ui.slot,
    key: ui.key,
    ...(input.contactId === null ? {} : { contact_id: input.contactId }),
  });
  const url = new URL(`${base}${ui.path}`);
  url.searchParams.set(FRAME_TOKEN_PARAM, token);
  url.searchParams.set('host', appOriginOf(env));
  url.searchParams.set('locale', input.user.locale);
  url.searchParams.set('theme', input.theme);
  return {
    url: url.toString(),
    origin: url.origin,
    token,
    expires_at: new Date(exp * 1000).toISOString(),
    slot: ui.slot,
    height: ui.height ?? null,
  };
}

/**
 * Origins the SPA may frame for a user: apps with screens installed in any
 * workspace they belong to (the CSP is per document, tenants switch client-side).
 */
export async function appFrameOrigins(db: D1Database, userId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT ai.manifest FROM app_installs ai
       JOIN memberships m ON m.tenant_id = ai.tenant_id
       WHERE m.user_id = ? AND ai.status = 'active'`,
    )
    .bind(userId)
    .all<{ manifest: string }>();
  const origins = new Set<string>();
  for (const row of rows.results) {
    try {
      const manifest = JSON.parse(row.manifest) as { base_url?: unknown; extensions?: { ui?: unknown[] } };
      if (typeof manifest.base_url !== 'string' || (manifest.extensions?.ui ?? []).length === 0) continue;
      const url = new URL(manifest.base_url);
      const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
      if (url.protocol === 'https:' || local) origins.add(url.origin);
    } catch {
      // A broken row never breaks the document.
    }
  }
  return [...origins].sort();
}

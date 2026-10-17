import type { Permission, Role } from '@amable/core';
import type { AuthServices } from '../auth/services';
import type { Env } from '../env';

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly locale: string;
  readonly theme: string;
  readonly lastTenantId: string | null;
}

export interface AuthSession {
  /** Public id (device list); never the token or its hash. */
  readonly publicId: string;
  /** Internal: hash of the session token (row key). */
  readonly hash: string;
  readonly stepUpAt: number | null;
}

export interface AuthApiKey {
  readonly id: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
  readonly createdBy: string;
}

/** A marketplace app acting through its install's access token. */
export interface AuthApp {
  readonly installId: string;
  readonly appId: string;
  readonly appName: string;
  readonly tenantId: string;
  /** Granted scopes; empty while the app only cleans up after an uninstall. */
  readonly scopes: readonly string[];
  readonly apiVersion: string;
  /** Uninstalled, inside the cleanup window: only its own data is reachable. */
  readonly cleanup: boolean;
}

export type AuthContext =
  | { readonly kind: 'session'; readonly user: AuthUser; readonly session: AuthSession; readonly apiKey: null; readonly app?: undefined }
  | { readonly kind: 'api_key'; readonly user: AuthUser; readonly session: null; readonly apiKey: AuthApiKey; readonly app?: undefined }
  | { readonly kind: 'app'; readonly user: AuthUser; readonly session: null; readonly apiKey: null; readonly app: AuthApp };

export interface TenantContext {
  readonly tenant: { readonly id: string; readonly slug: string; readonly name: string };
  /** Role of the user (for API keys: of the key's creator). */
  readonly role: Role;
  /** Effective permissions (for API keys: scopes ∩ creator role). */
  readonly permissions: ReadonlySet<Permission>;
  can(permission: Permission): boolean;
}

/** Hono environment of the core worker. Use `new Hono<AppEnv>()` for every router. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    schemaVersion: number;
    requestId: string;
    services: AuthServices;
    auth: AuthContext | undefined;
    tenant: TenantContext | undefined;
  };
};

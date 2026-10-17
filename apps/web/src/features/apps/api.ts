import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { apiFetch } from '../../lib/api';

export interface LocalizedText {
  readonly en: string;
  readonly it?: string;
}

export type AppUiSlot = 'contact.sidebar' | 'contact.actions' | 'app.page' | 'app.settings' | 'dashboard.widget';

export interface AppUiExtension {
  readonly slot: AppUiSlot;
  readonly key: string;
  readonly path: string;
  readonly title: LocalizedText;
  readonly height?: number;
}

export interface FrameSession {
  readonly url: string;
  readonly origin: string;
  readonly token: string;
  readonly expires_at: string;
  readonly slot: AppUiSlot;
  readonly height: number | null;
}

export interface AppManifestView {
  readonly id: string;
  readonly name: string;
  readonly tagline: LocalizedText;
  readonly description: LocalizedText;
  readonly developer: { readonly name: string; readonly url?: string; readonly email?: string };
  readonly categories: string[];
  readonly icon_url: string;
  readonly homepage?: string;
  readonly support_url: string;
  readonly privacy_url: string;
  readonly base_url: string;
  readonly scopes: string[];
  readonly sensitive_scopes: string[];
  readonly webhooks: { readonly events: string[] };
  readonly privacy: { readonly handles_personal_data: boolean };
  readonly custom_fields: Array<{ key: string; label: LocalizedText; type: string; entity: string }>;
  readonly pricing: { readonly model: 'free' | 'freemium' | 'paid' | 'external'; readonly note?: string; readonly billing_url?: string };
  readonly extensions: {
    readonly contact_validate?: { fields: string[] };
    readonly automation_actions?: AppAutomationAction[];
    readonly automation_triggers?: Array<{ key: string; name: LocalizedText; description?: LocalizedText }>;
    readonly ui?: AppUiExtension[];
    readonly form_connectors?: Array<{ key: string; name: LocalizedText }>;
    readonly channels?: Array<{ key: string; name: LocalizedText; kind: string }>;
  };
}

export interface AppInputProperty {
  readonly type: 'string' | 'number' | 'integer' | 'boolean';
  readonly title: LocalizedText;
  readonly description?: LocalizedText;
  readonly enum?: string[];
  readonly format?: 'text' | 'textarea' | 'email' | 'url' | 'phone';
  readonly default?: string | number | boolean;
  readonly max_length?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly merge_tags?: boolean;
}

export interface AppInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, AppInputProperty>>;
  readonly required?: string[];
}

export interface AppAutomationAction {
  readonly key: string;
  readonly name: LocalizedText;
  readonly description?: LocalizedText;
  readonly input_schema: AppInputSchema;
  readonly output_keys?: string[];
}

/** An installed app (active or paused) and what it adds, from `GET /apps/extensions`. */
export interface InstalledExtensions {
  readonly install_id: string;
  readonly app_id: string;
  readonly name: string;
  readonly icon_url: string;
  readonly status: 'active' | 'paused';
  readonly extensions: AppManifestView['extensions'];
}

export type InstallStatus = 'pending' | 'active' | 'paused' | 'uninstalling' | 'uninstalled' | 'revoked';

export interface AppInstallView {
  readonly id: string;
  readonly app_id: string;
  readonly source: 'catalog' | 'private';
  readonly verified: boolean;
  readonly manifest_url: string | null;
  readonly manifest: AppManifestView;
  readonly status: InstallStatus;
  readonly status_reason: string | null;
  readonly scopes: string[];
  readonly pending_scopes: string[];
  readonly api_version: string;
  readonly keep_data: boolean | null;
  readonly cleanup_until: string | null;
  readonly created_at: string | null;
  readonly activated_at: string | null;
}

export interface CatalogItem {
  readonly manifest: AppManifestView;
  readonly added_at: string | null;
  readonly install: AppInstallView | null;
}

export interface AppHealth {
  readonly since: string;
  readonly totals: Array<{ kind: string; calls: number; errors: number; avg_ms: number }>;
  readonly hourly: Array<{ hour: string; calls: number; errors: number }>;
  readonly queued_deliveries: number;
  readonly failed_deliveries: number;
  readonly last_success_at: string | null;
  readonly last_failure_at: string | null;
}

export interface AppEventRecord {
  readonly sequence: number;
  readonly id: string;
  readonly type: string;
  readonly created_at: string;
}

export interface AuthorizeInput {
  readonly app_id?: string;
  readonly manifest_url?: string;
  readonly redirect_uri?: string;
  readonly state?: string;
  readonly code_challenge?: string;
  readonly code_challenge_method?: 'S256';
}

export function appsApi(slug: string) {
  const base = `/api/t/${encodeURIComponent(slug)}/apps`;
  const post = <T>(path: string, body: unknown = {}) => apiFetch<T>(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  return {
    catalog: () =>
      apiFetch<{ enabled: boolean; synced_at: string | null; sync_error: string | null; data: CatalogItem[] }>(`${base}/catalog`),
    app: (appId: string) => apiFetch<CatalogItem>(`${base}/catalog/${encodeURIComponent(appId)}`),
    refresh: () => post<{ state: unknown }>('/catalog/refresh'),
    preview: (manifestUrl: string) =>
      post<{ manifest: AppManifestView; verified: false }>('/private/preview', { manifest_url: manifestUrl }),
    authorize: (input: AuthorizeInput) => post<{ redirect_url: string; install: AppInstallView }>('/authorize', input),
    installs: () => apiFetch<{ data: AppInstallView[] }>(`${base}/installs`),
    extensions: () => apiFetch<{ data: InstalledExtensions[] }>(`${base}/extensions`),
    frame: (input: { app_id: string; key: string; contact_id?: string; theme: 'light' | 'dark' }) => post<FrameSession>('/frames', input),
    install: (id: string, hours = 24) =>
      apiFetch<{ install: AppInstallView; health: AppHealth }>(`${base}/installs/${id}?hours=${String(hours)}`),
    events: (id: string) =>
      apiFetch<{ data: AppEventRecord[]; next_since: number | null }>(`${base}/installs/${id}/events?limit=50`),
    approveScopes: (id: string) => post<{ install: AppInstallView }>(`/installs/${id}/approve-scopes`),
    pause: (id: string) => post<{ install: AppInstallView }>(`/installs/${id}/pause`),
    resume: (id: string) => post<{ install: AppInstallView }>(`/installs/${id}/resume`),
    rotateSecret: (id: string) => post<{ ok: true }>(`/installs/${id}/rotate-secret`),
    uninstall: (id: string, keepData: boolean) =>
      post<{ install: AppInstallView }>(`/installs/${id}/uninstall`, { keep_data: keepData }),
  };
}

export const appKeys = {
  catalog: (slug: string) => ['apps', slug, 'catalog'] as const,
  app: (slug: string, appId: string) => ['apps', slug, 'catalog', appId] as const,
  installs: (slug: string) => ['apps', slug, 'installs'] as const,
  extensions: (slug: string) => ['apps', slug, 'extensions'] as const,
  frame: (slug: string, appId: string, key: string, contactId: string | null) => ['apps', slug, 'frame', appId, key, contactId] as const,
  install: (slug: string, id: string) => ['apps', slug, 'installs', id] as const,
  events: (slug: string, id: string) => ['apps', slug, 'installs', id, 'events'] as const,
};

export function useAppsApi() {
  const { tenant } = useParams({ strict: false });
  const slug = tenant ?? 'demo';
  return { slug, api: appsApi(slug) };
}

/** Active installed apps' screens for a slot. */
export function useAppScreens(slot: AppUiSlot): Array<{ app: InstalledExtensions; ui: AppUiExtension }> {
  const installed = useInstalledExtensions();
  return (installed.data?.data ?? [])
    .filter((app) => app.status === 'active')
    .flatMap((app) => (app.extensions.ui ?? []).filter((ui) => ui.slot === slot).map((ui) => ({ app, ui })));
}

export function text(value: LocalizedText | undefined, locale: string): string {
  if (value === undefined) return '';
  return locale.startsWith('it') && value.it !== undefined ? value.it : value.en;
}

/** Query string of an app-initiated authorization request, kept across the consent screen. */
export function authorizeParams(search: Record<string, unknown>): AuthorizeInput {
  const pick = (key: string) => (typeof search[key] === 'string' && search[key] !== '' ? (search[key] as string) : undefined);
  const challenge = pick('code_challenge');
  return {
    ...(pick('redirect_uri') === undefined ? {} : { redirect_uri: pick('redirect_uri')! }),
    ...(pick('state') === undefined ? {} : { state: pick('state')! }),
    ...(challenge === undefined ? {} : { code_challenge: challenge, code_challenge_method: 'S256' as const }),
  };
}

/** Installed apps with their extensions; empty while loading or on error (apps are optional). */
export function useInstalledExtensions() {
  const { slug, api } = useAppsApi();
  return useQuery({ queryKey: appKeys.extensions(slug), queryFn: api.extensions, staleTime: 60_000 });
}

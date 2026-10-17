import type { AnalyticsNamespace } from '@amable/app-edge/analytics';
import type { BookingCalendar } from './booking/calendar-do';
import type { Engine } from './do/engine';
import type { EditSession } from './pages/edit-session';
import type { TenantDb } from './do/tenant-db';
import type { MailDb } from './email/mail-db';

/** Bindings of the core worker — mirror of wrangler.jsonc. */
export interface Env {
  /** Installation D1 database (users, sessions, tenants, memberships, domains, …). */
  DB: D1Database;
  /** One SQLite-backed Durable Object per tenant, addressed by tenant id. */
  TENANT_DB: DurableObjectNamespace<TenantDb>;
  /** Automation engine DO per tenant — stub until the automation-engine phase. */
  ENGINE: DurableObjectNamespace<Engine>;
  EMAIL_SEND: Queue<unknown>;
  EVENTS_ROLLUP: Queue<unknown>;
  WEBHOOKS_OUT: Queue<unknown>;
  /** Files, images, nightly backups — stub binding for later phases. */
  FILES: R2Bucket;
  /**
   * Web analytics DOs, hosted by the edge worker (`script_name: "amable-edge"`).
   * Optional: without it the analytics routes answer 503 `analytics_unavailable`.
   */
  ANALYTICS?: AnalyticsNamespace;
  /** Public origin of the edge worker (tracking subdomain), used in snippets. */
  EDGE_ORIGIN?: string;
  /**
   * Dev only: the edge worker's default fetch, bound by `scripts/dev.mjs` (generated
   * config) so the edge port proxy can reach it inside the same wrangler session.
   */
  EDGE_DEV?: Fetcher;
  /** Static SPA assets built by apps/web. */
  ASSETS: Fetcher;
  /** "dev" enables the /api/dev/* routes; production deployments never set it. */
  ENVIRONMENT?: string;

  // --- Access & security (apps/core/src/auth) -------------------------------
  /** Public origin of the app (e.g. https://crm.example.com); used in email links and CSRF. */
  APP_ORIGIN?: string;
  /** Extra comma-separated origins accepted by the CSRF check (dev: the Vite server). */
  ALLOWED_ORIGINS?: string;
  /** Comma-separated browser origins allowed to call /api/v2 with an API key (CORS, never credentials); `*` = any. */
  API_CORS_ORIGINS?: string;
  /** Secret pepper mixed into every password hash (Wrangler secret). */
  PASSWORD_PEPPER?: string;
  /** Base64 32-byte AES-GCM key for secrets at rest, e.g. TOTP seeds (Wrangler secret). */
  AUTH_ENCRYPTION_KEY?: string;
  /** Turnstile keys; without a secret, verification is disabled (logged at boot). */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** "false" disables the online breached-password range check (offline list only). */
  HIBP_ENABLED?: string;
  /**
   * Photon geocoder used for address autocomplete (default: the public komoot instance,
   * fair use). Point it at a self-hosted Photon, or `off` to keep addresses manual only.
   */
  ADDRESS_LOOKUP_URL?: string;
  /** Notify service endpoint override (managed offering system email). */
  NOTIFY_ENDPOINT?: string;
  LICENSE_KEY?: string;
  /** System email: `auto` (default) | `cloudflare` | `notify` | `console` (dev only) — apps/core/src/providers/select.ts. */
  SYSTEM_EMAIL_PROVIDER?: string;
  /** Own Cloudflare Email Sending `send_email` binding (self-hosted system email). */
  SYSTEM_EMAIL?: SendEmail;
  /** Sender of system emails through SYSTEM_EMAIL (domain onboarded to Email Sending). */
  SYSTEM_EMAIL_FROM?: string;
  SYSTEM_EMAIL_FROM_NAME?: string;
  /** Own Google OAuth client (Sheets, Calendar); redirect URI `<APP_ORIGIN>/oauth/google/callback`. */
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  // --- Platform link (managed offering; apps/core/src/platform) -------------
  /** Control plane origin (default https://app.amabledata.com). Without LICENSE_KEY: open source mode. */
  CONTROL_PLANE_URL?: string;
  /** Raw Ed25519 public key (base64) of the control plane: signed calls + assisted-access tokens. */
  CONTROL_PLANE_PUBLIC_KEY?: string;
  /** Release tag of the deployed code (set by the installer and by `self-host:setup`). */
  APP_VERSION?: string;
  /** `off` disables the daily "new version available" check (managed installations, opt-out). */
  UPDATE_CHECK?: string;
  /** Error reporting sink: `local` (default: logs only), `control_plane` (needs LICENSE_KEY) or an https URL. */
  ERROR_REPORTING?: string;
  /** 0..1 sampling of repeated errors (default 1). */
  ERROR_SAMPLE_RATE?: string;
  /** Workers Rate Limiting bindings (optional — D1 counters are the fallback). */
  RL_AUTH?: RateLimit;
  RL_API?: RateLimit;

  // --- Forms, bookings, landing pages (apps/core/src/{forms,booking,pages,public}) ----
  /** Stored submissions to process: CRM mapping, `form.submitted`, external connections. */
  FORM_SUBMISSIONS?: Queue<unknown>;
  /** Editing lock of a landing page, one instance per page (`<tenantId>:<pageId>`). */
  EDIT_SESSION?: DurableObjectNamespace<EditSession>;
  /** One instance per booking calendar (`<tenantId>:<calendarId>`). */
  BOOKING_CALENDAR?: DurableObjectNamespace<BookingCalendar>;
  /** HMAC secret shared with the edge worker for `/_edge/*` calls (Wrangler secret on both). */
  EDGE_GATEWAY_SECRET?: string;

  // --- Email marketing (apps/core/src/email, apps/core/src/broadcast) --------
  /** Email DO per tenant: templates, messages, suppressions, broadcasts, email outbox. */
  MAIL_DB: DurableObjectNamespace<MailDb>;
  /** PostShiba Bearer key (Wrangler secret). Never used with ENVIRONMENT=dev (console provider). */
  POSTSHIBA_API_KEY?: string;
  /** Optional API root override (default https://app.postshiba.com/api/v1). */
  POSTSHIBA_BASE_URL?: string;
  /** Comma-separated HMAC secrets of the delivery webhooks (rotation). */
  POSTSHIBA_WEBHOOK_SECRET?: string;
  /** Signs click / open / unsubscribe / `_amb_c` tokens (Wrangler secret, shared with the edge). */
  EMAIL_TOKEN_SECRET?: string;
  /** Comma-separated previous signing secrets, still accepted for verification. */
  EMAIL_TOKEN_SECRET_PREVIOUS?: string;
  /** "true" lets an unverified tenant send — honored only with ENVIRONMENT=dev. */
  EMAIL_ALLOW_UNVERIFIED_DOMAIN?: string;

  // --- Developers & domains (apps/core/src/webhooks, apps/core/src/domains) ----
  /** "true" allows loopback webhook receivers (local testing) — honored only with ENVIRONMENT=dev. */
  WEBHOOKS_ALLOW_LOOPBACK?: string;
  /** Cloudflare API token with Zone.DNS + Workers Routes edit on the customer's zones (Wrangler secret). */
  CLOUDFLARE_DNS_API_TOKEN?: string;
  /** Hostname of the edge worker that custom tracking / site domains point to. */
  EDGE_HOSTNAME?: string;
  /** Worker script name used for Workers Routes on custom site paths (default amable-edge). */
  EDGE_SCRIPT_NAME?: string;

  // --- Marketplace apps (apps/core/src/apps) ------------------------------------
  /** `off` hides the marketplace and stops the catalog sync (private apps still install). */
  APP_CATALOG?: string;
  /** Own signed catalog index URL (default: the public amable-apps release). */
  APP_CATALOG_URL?: string;
  /** Extra trusted catalog keys, `<key_id>:<base64 raw Ed25519>` comma separated (required with APP_CATALOG_URL). */
  APP_CATALOG_PUBLIC_KEY?: string;
}

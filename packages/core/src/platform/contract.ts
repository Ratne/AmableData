/**
 * Versioned HTTP contract between an installation and the control plane (v1).
 *
 * The product never imports the control plane: both sides share only these
 * types (and `./signing`). Every installation → control plane call carries
 * `Authorization: Bearer <license key>` and goes to `${CONTROL_PLANE_URL}/v1/installation/...`.
 * Control plane → installation calls go to `${APP_ORIGIN}/api/platform/v1/...` and are
 * signed with the control plane Ed25519 key (`CP_SIGNATURE_HEADER`), which the
 * installation verifies with `CONTROL_PLANE_PUBLIC_KEY`.
 *
 * Telemetry is minimal by design: versions, health, aggregated counts, error
 * stacks without personal data. Contact data never leaves the installation.
 */

export const PLATFORM_API_VERSION = 1 as const;

/** Prefix of every installation → control plane route. */
export const CP_INSTALLATION_PREFIX = '/v1/installation' as const;
/** Prefix of every control plane → installation route (on the installation core worker). */
export const INSTALLATION_PLATFORM_PREFIX = '/api/platform/v1' as const;

export type ReleaseChannel = 'dev' | 'canary' | 'stable';
export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ['dev', 'canary', 'stable'];

/**
 * Commercial state of the account owning an installation, as seen by central services.
 * - `active` / `trial`: everything on;
 * - `grace`: payment failed, still on for 7 days;
 * - `suspended`: updates, notify and central services stop (the installation itself is never touched);
 * - `self_hosted`: open source installation linked to an account (wallet only, no included quota).
 */
export type ServiceState = 'trial' | 'active' | 'grace' | 'suspended' | 'self_hosted';

/** Error body of every control plane API: `{ error: code, ...extra }`. */
export interface PlatformErrorBody {
  readonly error: string;
  readonly [key: string]: unknown;
}

// ------------------------------------------------------------- heartbeat

/** `POST /v1/installation/heartbeat` (every 5 minutes from the installation cron). */
export interface HeartbeatRequest {
  /** Release tag of the running code, e.g. `2026.10.1`. */
  readonly version: string;
  /** Installation D1 schema version (`/api/health`). */
  readonly schemaVersion: number;
  readonly tenants: number;
  /** Messages waiting in the email-send queue (best effort, null when unknown). */
  readonly queueBacklog: number | null;
  /** Failed / attempted system + marketing sends over the last hour, 0..1 (null when unknown). */
  readonly emailFailureRate: number | null;
  /** p50 latency of `/api/health` measured by the installation itself, ms. */
  readonly latencyMs: number | null;
  /** Error events buffered locally and not yet delivered. */
  readonly pendingErrors: number;
  /** ISO 8601 timestamp of the installation clock. */
  readonly sentAt: string;
}

export interface HeartbeatResponse {
  readonly ok: true;
  readonly installationId: string;
  readonly serviceState: ServiceState;
  readonly channel: ReleaseChannel;
  /** Version the fleet manager wants this installation on (informational). */
  readonly targetVersion: string | null;
  /** Fresh quota snapshot, so the guard rarely has to ask separately. */
  readonly quota: QuotaSnapshot;
  /** Error reporting knobs pushed by the control plane. */
  readonly reporting: { readonly sampleRate: number; readonly maxBatch: number };
}

// ----------------------------------------------------------------- quota

/**
 * `GET /v1/installation/quota` — what the installation may spend right now.
 * The QuotaGuard caches it briefly and decides locally; the control plane ledger
 * stays the source of truth (usage is reported afterwards, see `UsageReportRequest`).
 * Money is always integer micro-dollars (1 $ = 1_000_000).
 */
export interface QuotaSnapshot {
  readonly serviceState: ServiceState;
  /** Included emails left in the current billing period (0 for self-hosted). */
  readonly includedRemaining: number;
  readonly includedMonthly: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Prepaid wallet balance, micro-dollars. */
  readonly balanceMicros: number;
  /** Overage price per 1,000 emails, micro-dollars (default 1 $ = 1_000_000). */
  readonly overagePer1000Micros: number;
  /** Sending caps assigned by the control plane (PostShiba capacity), null = no cap. */
  readonly caps: { readonly hourly: number | null; readonly daily: number | null };
  /** Usage already reported in the current period, for display. */
  readonly usedThisPeriod: number;
  readonly issuedAt: string;
  /** Snapshot validity: the guard refetches after this. */
  readonly ttlSeconds: number;
}

/**
 * `POST /v1/installation/usage` — idempotent usage blocks. A block is a closed hour
 * of sends of one tenant; `blockId` is deterministic (`<tenantId>:<channel>:<hourStartIso>`),
 * so retries never double charge. The control plane debits the included quota first,
 * then the wallet (overage).
 */
export interface UsageBlock {
  readonly blockId: string;
  readonly tenantId: string;
  readonly channel: 'email';
  readonly count: number;
  /** ISO 8601 hour start (UTC). */
  readonly periodStart: string;
}

export interface UsageReportRequest {
  readonly blocks: readonly UsageBlock[];
}

export interface UsageReportResponse {
  readonly accepted: readonly string[];
  /** Blocks already recorded earlier (idempotent replay). */
  readonly duplicates: readonly string[];
  readonly quota: QuotaSnapshot;
}

/** Wallet top-up packs, dollars. */
export type WalletTopUpPack = 10 | 25 | 50 | 100;

/** `POST /v1/installation/wallet/top-up` — opens a checkout so the CRM can show a "Top up" button. */
export interface WalletTopUpRequest {
  readonly pack: WalletTopUpPack;
}

export interface WalletTopUpResponse {
  /** Hosted checkout page; open it in a new tab. */
  readonly url: string;
  readonly sessionId: string;
}

// -------------------------------------------------------------- notify

/** `POST /v1/installation/notify` — a system email sent through the central sender. */
export interface NotifyRequest {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly locale: string;
  /** Optional system email kind, for metrics only. */
  readonly kind?: string;
}

export interface NotifyResponse {
  readonly accepted: true;
  readonly id: string;
}

// ----------------------------------------------------- marketing email

/**
 * Marketing email through the managed PostShiba account: the control plane
 * holds the team key and gives every CRM workspace its own PostShiba tenant.
 * `POST /v1/installation/email/workspaces` is idempotent (a repeat returns the
 * same credential); domain routes act only on tenants of the calling installation.
 */
export interface EmailWorkspaceRequest {
  /** CRM workspace (tenant) id. */
  readonly workspaceId: string;
  readonly name: string;
  /** `<APP_ORIGIN>/hooks/email/postshiba/<workspaceId>`. */
  readonly webhookUrl: string;
}

export interface EmailWorkspaceResponse {
  readonly providerTenantId: string;
  readonly smtp: { readonly username: string; readonly password: string };
  readonly webhookSecret: string;
  /** HTTP inject endpoint of the cluster. */
  readonly injectUrl: string;
}

/**
 * `POST /v1/installation/email/workspaces/credential` (body `EmailTenantRequest`):
 * the current credential of a tenant, after the control plane moved it to another cluster.
 */
export interface EmailCredentialResponse extends EmailWorkspaceResponse {
  readonly workspaceId: string;
}

/** `POST /v1/installation/email/domains` (add), `…/domains/verify`, `…/domains/remove`. */
export interface EmailDomainRequest {
  readonly providerTenantId: string;
  readonly hostname: string;
}

export interface EmailDomainResponse {
  readonly domain: string;
  readonly status: 'pending' | 'verified' | 'failed';
  readonly records: readonly { readonly type: 'TXT' | 'CNAME' | 'MX'; readonly name: string; readonly value: string; readonly unlessPrefix?: string }[];
}

/** `POST /v1/installation/email/tenants/suspend` / `…/resume` (sender health). */
export interface EmailTenantRequest {
  readonly providerTenantId: string;
}

// ------------------------------------------------------------- errors

export type ErrorSource = 'api' | 'edge' | 'durable_object' | 'queue' | 'cron';

export interface Breadcrumb {
  /** ms since epoch. */
  readonly at: number;
  readonly category: string;
  /** Free text WITHOUT personal data (scrubbed again by the reporter). */
  readonly message: string;
}

export interface StackFrame {
  readonly fn: string | null;
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
}

/** One error occurrence. No personal data: no emails, no contact content, no tokens. */
export interface ErrorEvent {
  /** Random id, used for idempotent ingest. */
  readonly eventId: string;
  readonly occurredAt: string;
  readonly source: ErrorSource;
  /** Module, e.g. `email`, `crm`, `automation`. */
  readonly module: string | null;
  /** Route pattern (never the concrete URL), e.g. `/api/v2/t/:slug/contacts/:id`. */
  readonly route: string | null;
  readonly errorType: string;
  /** Scrubbed message. */
  readonly message: string;
  readonly frames: readonly StackFrame[];
  readonly breadcrumbs: readonly Breadcrumb[];
  readonly release: string;
  /** How many identical events this one stands for (client-side sampling). */
  readonly sampleWeight: number;
}

/** `POST /v1/installation/errors` */
export interface ErrorBatchRequest {
  readonly events: readonly ErrorEvent[];
}

export interface ErrorBatchResponse {
  readonly accepted: number;
  readonly duplicates: number;
}

// ------------------------------------------------------- support + ideas

export type TicketStatus = 'open' | 'waiting_customer' | 'resolved';
export type TicketCategory = 'question' | 'bug' | 'billing' | 'feature' | 'other';

/** The CRM user acting through the installation proxy (never contact data). */
export interface ActingUser {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string;
  readonly role: string;
  readonly tenantId: string | null;
}

/** Assisted access window (plan: 5 days by default, adjustable, never more than a week). */
export const ASSIST_GRANT_DEFAULT_DAYS = 5;
export const ASSIST_GRANT_MAX_DAYS = 7;

/** `POST /v1/installation/support/grants` — the installation records a grant locally, then mirrors it. */
export interface AssistGrantMirror {
  readonly grantId: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly grantedBy: ActingUser;
  readonly reason: string;
  readonly ticketId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type IdeaStatus = 'under_review' | 'planned' | 'released';

// --------------------------------------------------------- central services

/** `GET /v1/installation/crawlers` — AI crawler list feed (user agents + IP ranges). */
export interface CrawlerEntry {
  readonly name: string;
  readonly provider: string;
  readonly category: 'ai_answers' | 'indexing' | 'training' | 'other';
  readonly userAgentPattern: string;
  readonly ipRanges: readonly string[];
}

export interface CrawlerFeed {
  readonly version: string;
  readonly updatedAt: string;
  readonly crawlers: readonly CrawlerEntry[];
}

/**
 * Central OAuth broker (`/v1/installation/oauth/*`): the control plane owns the
 * Google / Meta apps and stores tokens encrypted per installation + tenant; an
 * installation only ever receives short-lived access tokens of its own accounts.
 * Flow: `start` → browser to `authorizeUrl` → provider → control plane callback →
 * redirect to `returnUrl?state=…&code=…` (one-time code) → `finish`.
 */
export type OAuthBrokerProvider = 'google' | 'meta';

export interface OAuthStartRequest {
  readonly tenantId: string;
  readonly provider: OAuthBrokerProvider;
  readonly scopes: readonly string[];
  /** Absolute https URL on the installation (http only for localhost). */
  readonly returnUrl: string;
}

export interface OAuthStartResponse {
  readonly authorizeUrl: string;
  readonly state: string;
}

export interface OAuthFinishRequest {
  readonly tenantId: string;
  readonly state: string;
  readonly code: string;
}

export interface OAuthFinishResponse {
  readonly account: {
    readonly tenantId: string;
    readonly provider: OAuthBrokerProvider;
    readonly accountId: string;
  };
  readonly email: string | null;
  readonly scopes: readonly string[];
}

export interface OAuthTokenRequest {
  readonly tenantId: string;
  readonly accountId: string;
}

/** 404 `not_connected` when the account was revoked or never connected. */
export interface OAuthTokenResponse {
  readonly accessToken: string;
  /** Epoch ms. */
  readonly expiresAt: number;
  readonly scopes: readonly string[];
}

export interface OAuthRevokeRequest {
  readonly tenantId: string;
  readonly accountId: string;
}

export interface OAuthRevokeResponse {
  readonly ok: true;
}

/** `POST /v1/installation/ai/*` — not available yet (501). */
export interface AiGatewayUnavailableBody {
  readonly error: 'ai_gateway_not_available';
  readonly message: string;
}

// -------------------------------------------- control plane → installation

/** `POST /api/platform/v1/resume-email` (signed) — wallet topped up: resume paused email steps. */
export interface ResumeEmailRequest {
  readonly reason: 'top_up' | 'quota_reset' | 'manual';
  /** Fresh snapshot the installation stores immediately (no extra round-trip). */
  readonly quota: QuotaSnapshot;
}

export interface ResumeEmailResponse {
  readonly ok: true;
  readonly tenants: number;
  readonly resumed: number;
}

/**
 * `POST /api/platform/v1/restore` (signed) — after the control plane restored the
 * installation D1 to `at` (Time Travel), rewinds every tenant Durable Object to the
 * same instant (point-in-time recovery, last 30 days).
 */
export interface PointInTimeRestoreRequest {
  /** Epoch ms. */
  readonly at: number;
}

export interface PointInTimeRestoreResponse {
  readonly ok: true;
  readonly tenants: number;
  readonly objects: number;
  readonly failed: readonly { readonly tenantId: string; readonly object: string; readonly error: string }[];
}

/**
 * `POST /api/platform/v1/bootstrap-owner` (signed) — after the install, the control plane
 * asks for the owner invitation of the account's registered email. `has_users` once
 * anyone signed up (nothing changes); otherwise any previous bootstrap invitation is
 * replaced and the new link is returned, for the control plane to email.
 */
export interface BootstrapOwnerRequest {
  readonly email: string;
  readonly workspaceName: string;
  readonly locale: 'en' | 'it';
}

export type BootstrapOwnerResponse =
  | { readonly ok: true; readonly status: 'has_users' }
  | {
      readonly ok: true;
      readonly status: 'invited';
      readonly url: string;
      readonly expiresAt: number;
      readonly workspace: string;
    };

/** `POST /api/platform/v1/assist/revoke` (signed) — the control plane revoked a grant. */
export interface AssistRevokeRequest {
  readonly grantId: string;
}

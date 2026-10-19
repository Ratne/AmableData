import {
  EmailProviderError,
  type DnsRecord,
  type DomainVerification,
  type MarketingEmail,
} from './email-marketing';

/**
 * PostShiba REST API (https://www.postshiba.com/docs): the team-scoped account
 * client used by the control plane (and by a self-hosted installation with its
 * own account) plus HTTP inject, the high-volume send path authenticated with
 * a tenant's SMTP credential. Request bodies are wrapped in the resource name
 * (`{tenant: {...}}`), errors are `{error, field, message, retryable}`.
 */

export const POSTSHIBA_DEFAULT_BASE_URL = 'https://app.postshiba.com/api/v1';
export const POSTSHIBA_DEFAULT_INJECT_URL = 'https://inject.postshiba.com/api/inject/v1';
/** Delivery events forwarded to the CRM webhook (SendGrid Event Webhook names). */
export const POSTSHIBA_WEBHOOK_EVENTS = [
  'processed',
  'delivered',
  'deferred',
  'bounce',
  'dropped',
  'spamreport',
  'unsubscribe',
] as const;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Send errors where the message may already be queued: resending could deliver it twice. */
const NORMALIZED_CODES: Readonly<Record<string, string>> = {
  idempotency_outcome_unknown: 'outcome_unknown',
  inject_timeout_unknown: 'outcome_unknown',
};
/** Nothing was sent and the same request can go again later. */
const RETRYABLE_CODES = new Set([
  'rate_limited',
  'throttled',
  'idempotency_in_progress',
  'idempotency_unavailable',
  'inject_unavailable',
  'cluster_not_ready',
]);
/** Retrying the same request can never succeed. */
const PERMANENT_CODES = new Set([
  'suppressed',
  'domain_unverified',
  'domain_suspended',
  'credential_missing',
  'firewall',
  'sender_blocked',
  'kyc_required',
  'invalid',
  'too_many_recipients',
  'payload_too_large',
  'idempotency_conflict',
  'team_suspended',
]);

interface RequestOptions {
  readonly authorization: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

/** One JSON request; non-2xx answers become `EmailProviderError` with the provider code. */
export async function postshibaRequest(
  options: RequestOptions,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    authorization: options.authorization,
    accept: 'application/json',
    ...extraHeaders,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await doFetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    throw new EmailProviderError(`network error: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (response.ok) return parsed;
  const retryAfter = Number(response.headers.get('retry-after'));
  const rawCode = isRecord(parsed) && typeof parsed['error'] === 'string' ? parsed['error'] : null;
  const message =
    isRecord(parsed) && typeof parsed['message'] === 'string' ? parsed['message'] : (rawCode ?? `HTTP ${String(response.status)}`);
  const code = rawCode === null ? null : (NORMALIZED_CODES[rawCode] ?? rawCode);
  const hinted = isRecord(parsed) && typeof parsed['retryable'] === 'boolean' ? parsed['retryable'] : null;
  const retryable =
    code === 'outcome_unknown'
      ? false
      : (hinted ??
        (code !== null && RETRYABLE_CODES.has(code)
          ? true
          : code !== null && PERMANENT_CODES.has(code)
            ? false
            : response.status === 429 || response.status >= 500));
  throw new EmailProviderError(
    message.slice(0, 300),
    retryable,
    response.status,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    code,
  );
}

// ---------------------------------------------------------------- account

export interface PostShibaTenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly suspended: boolean;
}

export interface PostShibaSmtpCredential {
  readonly id: string;
  readonly username: string;
  /** Only on create: PostShiba never shows it again. */
  readonly password: string | null;
}

export interface PostShibaSendingDomain {
  readonly id: string;
  readonly name: string;
  readonly tenantId: string;
  readonly dkimStatus: string;
  readonly returnPathStatus: string;
  readonly dmarcStatus: string;
  readonly sendingAllowed: boolean;
  readonly dkimManual: boolean;
  readonly dkimTxt: string;
  readonly dkimCnameHost: string;
  readonly dkimCnameTarget: string | null;
  readonly dmarcHost: string;
  readonly dmarcRecord: string;
  readonly returnPathHost: string;
  readonly returnPathTarget: string;
  readonly lastVerificationError: string | null;
  readonly suspended: boolean;
}

export interface PostShibaWebhookEndpoint {
  readonly id: string;
  readonly url: string;
  readonly tenantId: string | null;
  /** On create and show, never on the list. */
  readonly secret: string | null;
}

export interface PostShibaAccountConfig {
  /** Team key with Full access. */
  readonly apiKey: string;
  /** Obfuscated team id (`GET /users/me` → `team_id`). */
  readonly teamId: string;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

function toTenant(value: unknown): PostShibaTenant {
  if (!isRecord(value) || typeof value['id'] !== 'string') throw new EmailProviderError('unexpected tenant response', true);
  return { id: value['id'], name: str(value['name']), slug: str(value['slug']), suspended: value['suspended'] === true };
}

function toCredential(value: unknown): PostShibaSmtpCredential {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['username'] !== 'string') {
    throw new EmailProviderError('unexpected smtp credential response', true);
  }
  return {
    id: value['id'],
    username: value['username'],
    password: typeof value['password'] === 'string' && value['password'] !== '' ? value['password'] : null,
  };
}

function toDomain(value: unknown): PostShibaSendingDomain {
  if (!isRecord(value) || typeof value['id'] !== 'string') throw new EmailProviderError('unexpected domain response', true);
  return {
    id: value['id'],
    name: str(value['name']),
    tenantId: str(value['tenant_id']),
    dkimStatus: str(value['dkim_status']) || 'pending',
    returnPathStatus: str(value['return_path_status']) || 'pending',
    dmarcStatus: str(value['dmarc_status']) || 'pending',
    sendingAllowed: value['sending_allowed'] === true,
    dkimManual: value['dkim_manual'] === true,
    dkimTxt: str(value['dkim_txt']),
    dkimCnameHost: str(value['dkim_cname_host']),
    dkimCnameTarget: str(value['dkim_cname_target']) || null,
    dmarcHost: str(value['dmarc_host']),
    dmarcRecord: str(value['dmarc_record']),
    returnPathHost: str(value['return_path_host']),
    returnPathTarget: str(value['return_path_target']),
    lastVerificationError: str(value['last_verification_error']) || null,
    suspended: value['suspended'] === true,
  };
}

function toEndpoint(value: unknown): PostShibaWebhookEndpoint {
  if (!isRecord(value) || typeof value['id'] !== 'string') throw new EmailProviderError('unexpected webhook response', true);
  return {
    id: value['id'],
    url: str(value['url']),
    tenantId: str(value['tenant_id']) || null,
    secret: str(value['secret']) || null,
  };
}

const list = <T>(value: unknown, map: (item: unknown) => T): T[] => (Array.isArray(value) ? value.map(map) : []);

/** Operations on a PostShiba team (implemented by `PostShibaAccount`, faked in tests). */
export interface PostShibaAccountApi {
  listTenants(): Promise<PostShibaTenant[]>;
  createTenant(name: string, slug: string): Promise<PostShibaTenant>;
  suspendTenant(id: string): Promise<void>;
  resumeTenant(id: string): Promise<void>;
  createSmtpCredential(clusterId: string, tenantId: string): Promise<PostShibaSmtpCredential>;
  disableSmtpCredential(clusterId: string, id: string): Promise<void>;
  listSendingDomains(): Promise<PostShibaSendingDomain[]>;
  createSendingDomain(name: string, tenantId: string): Promise<PostShibaSendingDomain>;
  getSendingDomain(id: string): Promise<PostShibaSendingDomain>;
  verifySendingDomain(id: string): Promise<PostShibaSendingDomain>;
  deleteSendingDomain(id: string): Promise<void>;
  listWebhookEndpoints(): Promise<PostShibaWebhookEndpoint[]>;
  createWebhookEndpoint(url: string, tenantId: string): Promise<PostShibaWebhookEndpoint>;
  getWebhookEndpoint(id: string): Promise<PostShibaWebhookEndpoint>;
  updateWebhookEndpointUrl(id: string, url: string): Promise<PostShibaWebhookEndpoint>;
  deleteWebhookEndpoint(id: string): Promise<void>;
}

/** Team-scoped PostShiba account: tenants, SMTP credentials, sending domains, webhook endpoints. */
export class PostShibaAccount implements PostShibaAccountApi {
  private readonly baseUrl: string;
  private readonly options: RequestOptions;

  constructor(private readonly config: PostShibaAccountConfig) {
    this.baseUrl = (config.baseUrl ?? POSTSHIBA_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.options = {
      authorization: `Bearer ${config.apiKey}`,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    };
  }

  private call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    if (this.config.apiKey === '' || this.config.teamId === '') {
      return Promise.reject(new EmailProviderError('PostShiba account is not configured', false));
    }
    return postshibaRequest(this.options, method, `${this.baseUrl}${path}`, body);
  }

  private get team(): string {
    return `/teams/${encodeURIComponent(this.config.teamId)}`;
  }

  async listTenants(): Promise<PostShibaTenant[]> {
    return list(await this.call('GET', `${this.team}/tenants`), toTenant);
  }

  async createTenant(name: string, slug: string): Promise<PostShibaTenant> {
    return toTenant(await this.call('POST', `${this.team}/tenants`, { tenant: { name, slug } }));
  }

  async suspendTenant(id: string): Promise<void> {
    await this.call('POST', `/tenants/${encodeURIComponent(id)}/suspend`);
  }

  async resumeTenant(id: string): Promise<void> {
    await this.call('POST', `/tenants/${encodeURIComponent(id)}/resume`);
  }

  async createSmtpCredential(clusterId: string, tenantId: string): Promise<PostShibaSmtpCredential> {
    const created = toCredential(
      await this.call('POST', `${this.team}/clusters/${encodeURIComponent(clusterId)}/smtp_credentials`, {
        smtp_credential: { tenant_id: tenantId },
      }),
    );
    if (created.password === null) throw new EmailProviderError('smtp credential without a password', true);
    return created;
  }

  async disableSmtpCredential(clusterId: string, id: string): Promise<void> {
    await this.call('DELETE', `${this.team}/clusters/${encodeURIComponent(clusterId)}/smtp_credentials/${encodeURIComponent(id)}`);
  }

  async listSendingDomains(): Promise<PostShibaSendingDomain[]> {
    return list(await this.call('GET', `${this.team}/sending_domains`), toDomain);
  }

  async createSendingDomain(name: string, tenantId: string): Promise<PostShibaSendingDomain> {
    return toDomain(await this.call('POST', `${this.team}/sending_domains`, { sending_domain: { name, tenant_id: tenantId } }));
  }

  async getSendingDomain(id: string): Promise<PostShibaSendingDomain> {
    return toDomain(await this.call('GET', `/sending_domains/${encodeURIComponent(id)}`));
  }

  /** Runs the DNS check now and returns the current statuses. */
  async verifySendingDomain(id: string): Promise<PostShibaSendingDomain> {
    return toDomain(await this.call('POST', `/sending_domains/${encodeURIComponent(id)}/verify`));
  }

  async deleteSendingDomain(id: string): Promise<void> {
    await this.call('DELETE', `/sending_domains/${encodeURIComponent(id)}`);
  }

  async listWebhookEndpoints(): Promise<PostShibaWebhookEndpoint[]> {
    return list(await this.call('GET', `${this.team}/webhook_endpoints`), toEndpoint);
  }

  /** Endpoint receiving only `tenantId`'s events; the signing secret is generated by PostShiba. */
  async createWebhookEndpoint(url: string, tenantId: string): Promise<PostShibaWebhookEndpoint> {
    return toEndpoint(
      await this.call('POST', `${this.team}/webhook_endpoints`, {
        webhook_endpoint: { url, tenant_id: tenantId, enabled: true, event_types: [...POSTSHIBA_WEBHOOK_EVENTS] },
      }),
    );
  }

  async getWebhookEndpoint(id: string): Promise<PostShibaWebhookEndpoint> {
    return toEndpoint(await this.call('GET', `/webhook_endpoints/${encodeURIComponent(id)}`));
  }

  async updateWebhookEndpointUrl(id: string, url: string): Promise<PostShibaWebhookEndpoint> {
    return toEndpoint(await this.call('PATCH', `/webhook_endpoints/${encodeURIComponent(id)}`, { webhook_endpoint: { url } }));
  }

  async deleteWebhookEndpoint(id: string): Promise<void> {
    await this.call('DELETE', `/webhook_endpoints/${encodeURIComponent(id)}`);
  }
}

/** Tenant with `slug`, created when missing (a retried provisioning never creates two). */
export async function ensurePostShibaTenant(account: PostShibaAccountApi, slug: string, name: string): Promise<PostShibaTenant> {
  const existing = (await account.listTenants()).find((t) => t.slug === slug);
  return existing ?? account.createTenant(name, slug);
}

/** Webhook endpoint of `tenantId` posting to `url`, with its signing secret. */
export async function ensurePostShibaWebhook(
  account: PostShibaAccountApi,
  tenantId: string,
  url: string,
): Promise<PostShibaWebhookEndpoint & { readonly secret: string }> {
  const existing = (await account.listWebhookEndpoints()).find((e) => e.tenantId === tenantId && e.url === url);
  const endpoint = existing === undefined ? await account.createWebhookEndpoint(url, tenantId) : await account.getWebhookEndpoint(existing.id);
  if (endpoint.secret === null) throw new EmailProviderError('webhook endpoint without a secret', true);
  return { ...endpoint, secret: endpoint.secret };
}

/** Sending domain `hostname` of `tenantId`, created when missing; 409 `hostname_taken` when another tenant owns it. */
export async function ensurePostShibaDomain(
  account: PostShibaAccountApi,
  tenantId: string,
  hostname: string,
): Promise<PostShibaSendingDomain> {
  const existing = await findPostShibaDomain(account, hostname);
  if (existing === null) return account.createSendingDomain(hostname, tenantId);
  if (existing.tenantId !== tenantId) {
    throw new EmailProviderError('the domain belongs to another sender', false, 409, null, 'hostname_taken');
  }
  return existing;
}

export async function findPostShibaDomain(account: PostShibaAccountApi, hostname: string): Promise<PostShibaSendingDomain | null> {
  const name = hostname.toLowerCase();
  return (await account.listSendingDomains()).find((d) => d.name.toLowerCase() === name) ?? null;
}

/**
 * DNS records of a sending domain: DKIM (CNAME to PostShiba, or the TXT key
 * when imported), the return-path CNAME and a DMARC policy that is only
 * written when the zone has none (a second DMARC record would void both).
 */
export function postshibaDnsRecords(domain: PostShibaSendingDomain): DnsRecord[] {
  const records: DnsRecord[] = [];
  if (domain.dkimCnameHost !== '') {
    if (!domain.dkimManual && domain.dkimCnameTarget !== null) {
      records.push({ type: 'CNAME', name: domain.dkimCnameHost, value: domain.dkimCnameTarget });
    } else if (domain.dkimTxt !== '') {
      records.push({ type: 'TXT', name: domain.dkimCnameHost, value: domain.dkimTxt });
    }
  }
  if (domain.returnPathHost !== '' && domain.returnPathTarget !== '') {
    records.push({ type: 'CNAME', name: domain.returnPathHost, value: domain.returnPathTarget });
  }
  if (domain.dmarcHost !== '' && domain.dmarcRecord !== '') {
    records.push({ type: 'TXT', name: domain.dmarcHost, value: domain.dmarcRecord, unlessPrefix: 'v=DMARC1' });
  }
  return records;
}

/**
 * PostShiba reports `failed` as soon as a record is missing and keeps
 * rechecking, so an unverified domain stays `pending`; only a suspended one fails.
 */
export function postshibaVerification(domain: PostShibaSendingDomain): DomainVerification {
  return {
    domain: domain.name,
    status: domain.suspended ? 'failed' : domain.sendingAllowed ? 'verified' : 'pending',
    records: postshibaDnsRecords(domain),
  };
}

// ----------------------------------------------------------------- inject

export interface PostShibaSmtpLogin {
  readonly username: string;
  readonly password: string;
}

/** Provider limits: at most 32 scalar keys, keys ≤ 64 bytes, values ≤ 256 bytes. */
export function postshibaUniqueArgs(metadata: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata).slice(0, 32)) {
    if (key.length > 64) continue;
    out[key] = value.slice(0, 256);
  }
  return out;
}

/** Bare address of a `Name <addr>` From, the envelope sender of the message. */
function envelopeSender(from: string): string {
  const match = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from);
  return (match?.[1] ?? from).trim();
}

/**
 * Sends one message through HTTP inject with a tenant's SMTP credential. No
 * idempotency key exists on this path: a timeout is reported as
 * `outcome_unknown` so the pipeline never resends a message that may be queued.
 */
export async function postshibaInject(
  login: PostShibaSmtpLogin,
  email: MarketingEmail,
  options: { readonly injectUrl?: string; readonly fetch?: FetchLike; readonly timeoutMs?: number } = {},
): Promise<void> {
  const headers: Record<string, string> = {
    ...(email.headers ?? {}),
    From: email.from,
    To: email.to,
    Subject: email.subject,
  };
  if (email.replyTo) headers['Reply-To'] = email.replyTo;
  const args = postshibaUniqueArgs(email.metadata ?? {});
  if (Object.keys(args).length > 0) headers['X-Capsule-Unique-Args'] = JSON.stringify(args);
  let body: unknown;
  try {
    body = await postshibaRequest(
      {
        authorization: `Basic ${btoa(`${login.username}:${login.password}`)}`,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        timeoutMs: options.timeoutMs ?? 20_000,
      },
      'POST',
      options.injectUrl ?? POSTSHIBA_DEFAULT_INJECT_URL,
      {
        envelope_sender: envelopeSender(email.from),
        content: { text_body: email.text, html_body: email.html, headers },
        recipients: [{ email: email.to }],
      },
    );
  } catch (error) {
    if (error instanceof EmailProviderError && error.status === null && /timeout|abort/i.test(error.message)) {
      throw new EmailProviderError('inject timed out: the message may be queued', false, null, null, 'outcome_unknown');
    }
    throw error;
  }
  const failCount = isRecord(body) && typeof body['fail_count'] === 'number' ? body['fail_count'] : 0;
  const successCount = isRecord(body) && typeof body['success_count'] === 'number' ? body['success_count'] : 0;
  if (failCount > 0 || successCount === 0) {
    const errors = isRecord(body) && Array.isArray(body['errors']) ? body['errors'].map(String).join('; ') : '';
    const reason = errors === '' ? 'recipient refused by the cluster' : errors;
    throw new EmailProviderError(
      reason.slice(0, 300),
      false,
      200,
      null,
      /suppress/i.test(reason) ? 'suppressed' : 'inject_failed',
    );
  }
}

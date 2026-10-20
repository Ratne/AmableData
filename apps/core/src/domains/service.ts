import { EmailProviderError, type DnsRecord, type EmailMarketingProvider } from '@amable/core';
import { ZoneAutomationError, type ZoneAutomation } from './zone';

export type DomainKind = 'sending' | 'tracking' | 'app';
export type DomainStatus = 'pending' | 'verified' | 'failed';

/** Edge paths a site on the customer's own hostname needs besides its landing paths. */
export const SITE_EDGE_PATHS = ['/health', '/m/*', '/b/*'] as const;
export const MAX_SITE_PATHS = 10;

export interface DomainDeps {
  readonly db: D1Database;
  readonly provider: EmailMarketingProvider;
  /** `null` = manual mode: records are shown, the customer creates them. */
  readonly zone: ZoneAutomation | null;
  /** Probe used in manual mode (no zone automation) to verify tracking / site hostnames. */
  readonly probeEdge: (hostname: string) => Promise<boolean>;
  readonly edgeHostname: string;
  readonly edgeScript: string;
  readonly now: () => number;
  readonly newId: () => string;
}

interface DomainRow {
  id: string;
  tenant_id: string;
  hostname: string;
  kind: DomainKind;
  status: DomainStatus;
  records: string;
  zone_id: string | null;
  paths: string;
  dns_applied_at: number | null;
  verified_at: number | null;
  checked_at: number | null;
  last_error: string | null;
  dns_changed_at: number | null;
  created_at: number;
}

export interface TenantDomain {
  readonly id: string;
  readonly hostname: string;
  readonly kind: DomainKind;
  readonly status: DomainStatus;
  readonly records: DnsRecord[];
  readonly paths: string[];
  /** Workers Routes patterns (site with paths). */
  readonly routes: string[];
  readonly zone_id: string | null;
  readonly dns_applied_at: string | null;
  readonly verified_at: string | null;
  readonly checked_at: string | null;
  readonly last_error: string | null;
  /** Sending: the provider changed the records (cluster move); publish them and verify again. */
  readonly dns_changed_at: string | null;
  readonly created_at: string;
}

export class DomainError extends Error {
  constructor(
    readonly status: 404 | 409 | 422 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Email provider failures as API errors (409 taken elsewhere, 503 retry later, 502 rejected). */
async function providerCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof EmailProviderError)) throw error;
    if (error.code === 'hostname_taken') throw new DomainError(409, 'hostname_taken', 'hostname already used by another sender');
    if (error.code === 'not_configured') throw new DomainError(409, 'email_not_configured', error.message);
    if (error.retryable) throw new DomainError(503, 'email_provider_unavailable', error.message);
    throw new DomainError(502, 'email_provider_error', error.message);
  }
}

const HOSTNAME_RE = /^(?=.{4,253}$)(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const PATH_RE = /^\/[a-z0-9][a-z0-9\-_/]{0,62}$/;

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function parseList<T>(raw: string): T[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

export function normalizeHostname(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  return HOSTNAME_RE.test(host) ? host : null;
}

export function normalizePath(input: string): string | null {
  const path = `/${input.trim().toLowerCase().replace(/^\/+|\/+$/g, '').replace(/\*$/, '')}`.replace(/\/+$/, '');
  return PATH_RE.test(path) ? path : null;
}

/** Workers Routes for a site served on some paths of an existing hostname. */
export function siteRoutes(hostname: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const own = paths.flatMap((p) => [`${hostname}${p}`, `${hostname}${p}/*`]);
  const edge = SITE_EDGE_PATHS.map((p) => `${hostname}${p}`);
  return [...new Set([...own, ...edge])];
}

export class DomainService {
  constructor(private readonly deps: DomainDeps) {}

  get automation(): 'cloudflare' | 'fake' | 'manual' {
    return this.deps.zone?.kind ?? 'manual';
  }

  private toDomain(row: DomainRow): TenantDomain {
    const paths = parseList<string>(row.paths);
    return {
      id: row.id,
      hostname: row.hostname,
      kind: row.kind,
      status: row.status,
      records: parseList<DnsRecord>(row.records),
      paths,
      routes: row.kind === 'app' ? siteRoutes(row.hostname, paths) : [],
      zone_id: row.zone_id,
      dns_applied_at: iso(row.dns_applied_at),
      verified_at: iso(row.verified_at),
      checked_at: iso(row.checked_at),
      last_error: row.last_error,
      dns_changed_at: iso(row.dns_changed_at),
      created_at: new Date(row.created_at).toISOString(),
    };
  }

  private async row(tenantId: string, id: string): Promise<DomainRow> {
    const row = await this.deps.db
      .prepare(`SELECT * FROM domains WHERE id = ? AND tenant_id = ?`)
      .bind(id, tenantId)
      .first<DomainRow>();
    if (row === null) throw new DomainError(404, 'not_found', 'domain not found');
    return row;
  }

  async list(tenantId: string): Promise<TenantDomain[]> {
    const rows = await this.deps.db
      .prepare(`SELECT * FROM domains WHERE tenant_id = ? ORDER BY kind, created_at`)
      .bind(tenantId)
      .all<DomainRow>();
    return rows.results.map((r) => this.toDomain(r));
  }

  /** Provider-side tenant of a CRM tenant, created on first use. */
  async providerTenantId(tenantId: string): Promise<string> {
    const key = `postshiba_tenant:${tenantId}`;
    const row = await this.deps.db
      .prepare(`SELECT value FROM installation_meta WHERE key = ?`)
      .bind(key)
      .first<{ value: string }>();
    if (row !== null) return row.value;
    const tenant = await this.deps.db
      .prepare(`SELECT slug FROM tenants WHERE id = ?`)
      .bind(tenantId)
      .first<{ slug: string }>();
    const created = await providerCall(() => this.deps.provider.createTenant(tenant?.slug ?? tenantId, tenantId));
    await this.deps.db
      .prepare(`INSERT OR IGNORE INTO installation_meta (key, value) VALUES (?, ?)`)
      .bind(key, created.providerTenantId)
      .run();
    return created.providerTenantId;
  }

  private manualRecords(kind: DomainKind, hostname: string, paths: readonly string[]): DnsRecord[] {
    if (kind === 'app' && paths.length > 0) return [];
    return [{ type: 'CNAME', name: hostname, value: this.deps.edgeHostname }];
  }

  async add(
    tenantId: string,
    input: { kind: DomainKind; hostname: string; paths?: readonly string[] },
  ): Promise<TenantDomain> {
    const hostname = normalizeHostname(input.hostname);
    if (hostname === null) throw new DomainError(422, 'invalid_hostname', 'not a valid hostname');
    const paths: string[] = [];
    if (input.kind === 'app') {
      for (const raw of input.paths ?? []) {
        const path = normalizePath(raw);
        if (path === null) throw new DomainError(422, 'invalid_path', `invalid path: ${raw}`);
        if ((SITE_EDGE_PATHS as readonly string[]).some((p) => p.replace('/*', '') === path)) {
          throw new DomainError(422, 'invalid_path', `${path} is reserved`);
        }
        if (!paths.includes(path)) paths.push(path);
      }
      if (paths.length > MAX_SITE_PATHS) throw new DomainError(422, 'invalid_path', 'too many paths');
    }
    const taken = await this.deps.db
      .prepare(`SELECT tenant_id FROM domains WHERE hostname = ?`)
      .bind(hostname)
      .first<{ tenant_id: string }>();
    if (taken !== null) throw new DomainError(409, 'hostname_taken', 'hostname already connected');

    let records: DnsRecord[];
    let status: DomainStatus = 'pending';
    if (input.kind === 'sending') {
      const providerTenantId = await this.providerTenantId(tenantId);
      const verification = await providerCall(() => this.deps.provider.addDomain(providerTenantId, hostname));
      records = [...verification.records];
      if (verification.status === 'verified') status = 'verified';
    } else {
      records = this.manualRecords(input.kind, hostname, paths);
    }
    const id = this.deps.newId();
    const now = this.deps.now();
    await this.deps.db
      .prepare(
        `INSERT INTO domains (id, tenant_id, hostname, kind, status, records, paths, verified_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, tenantId, hostname, input.kind, status, JSON.stringify(records), JSON.stringify(paths),
        status === 'verified' ? now : null, now)
      .run();
    return this.toDomain(await this.row(tenantId, id));
  }

  /** Creates the records / Workers custom domain / routes on the customer's Cloudflare zone. */
  async applyDns(tenantId: string, id: string): Promise<TenantDomain> {
    const zone = this.deps.zone;
    if (zone === null) {
      throw new DomainError(409, 'automation_unavailable', 'no Cloudflare API token configured: create the records manually');
    }
    const row = await this.row(tenantId, id);
    const domain = this.toDomain(row);
    try {
      const found = await zone.findZone(row.hostname);
      if (found === null) throw new DomainError(422, 'zone_not_found', 'no Cloudflare zone of this account covers the hostname');
      if (row.kind === 'sending') {
        await zone.upsertRecords(found.id, domain.records);
      } else if (row.kind === 'app' && domain.paths.length > 0) {
        await zone.addWorkerRoutes(found.id, domain.routes, this.deps.edgeScript);
      } else {
        await zone.attachWorkerDomain(found.id, row.hostname, this.deps.edgeScript);
      }
      await this.deps.db
        .prepare(`UPDATE domains SET zone_id = ?, dns_applied_at = ?, last_error = NULL WHERE id = ? AND tenant_id = ?`)
        .bind(found.id, this.deps.now(), id, tenantId)
        .run();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const message = error instanceof ZoneAutomationError ? error.message : 'Cloudflare API unreachable';
      await this.deps.db
        .prepare(`UPDATE domains SET last_error = ? WHERE id = ? AND tenant_id = ?`)
        .bind(message.slice(0, 300), id, tenantId)
        .run();
      throw new DomainError(502, 'dns_automation_failed', message);
    }
    return this.toDomain(await this.row(tenantId, id));
  }

  /** Checks a domain: provider verification (sending) or an edge probe (tracking / site). */
  async verify(tenantId: string, id: string): Promise<TenantDomain> {
    const row = await this.row(tenantId, id);
    const now = this.deps.now();
    let ok: boolean;
    let error: string | null = null;
    let records: DnsRecord[] | null = null;
    if (row.kind === 'sending') {
      const providerTenantId = await this.providerTenantId(tenantId);
      const result = await providerCall(() => this.deps.provider.verifyDomain(row.hostname, providerTenantId));
      ok = result.status === 'verified';
      if (result.records.length > 0) records = [...result.records];
      if (!ok) error = result.status === 'failed' ? 'records_invalid' : 'records_not_found_yet';
    } else {
      const probe = this.deps.zone === null ? this.deps.probeEdge : (h: string) => this.deps.zone?.probeEdge(h) ?? Promise.resolve(false);
      ok = await probe(row.hostname);
      if (!ok) error = 'edge_unreachable';
    }
    const status: DomainStatus = ok ? 'verified' : row.status === 'verified' ? 'failed' : 'pending';
    await this.deps.db
      .prepare(
        `UPDATE domains SET status = ?, checked_at = ?, last_error = ?, verified_at = CASE WHEN ? THEN COALESCE(verified_at, ?) ELSE verified_at END,
           records = COALESCE(?, records), dns_changed_at = CASE WHEN ? THEN NULL ELSE dns_changed_at END WHERE id = ? AND tenant_id = ?`,
      )
      .bind(status, now, error, ok ? 1 : 0, now, records === null ? null : JSON.stringify(records), ok ? 1 : 0, id, tenantId)
      .run();
    return this.toDomain(await this.row(tenantId, id));
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const row = await this.row(tenantId, id);
    const removeDomain = this.deps.provider.removeDomain?.bind(this.deps.provider);
    if (row.kind === 'sending' && removeDomain !== undefined) {
      const providerTenant = await this.deps.db
        .prepare(`SELECT value FROM installation_meta WHERE key = ?`)
        .bind(`postshiba_tenant:${tenantId}`)
        .first<{ value: string }>();
      if (providerTenant !== null) await providerCall(() => removeDomain(row.hostname, providerTenant.value));
    }
    await this.deps.db.prepare(`DELETE FROM domains WHERE id = ? AND tenant_id = ?`).bind(id, tenantId).run();
  }
}

const PROVIDER_TENANT_PREFIX = 'postshiba_tenant:';

/**
 * Sending domains with new DNS records reported by the control plane (managed
 * email moved to another cluster): stores the records to publish and flags the
 * domain; flags missing from the list were resolved there, so they are cleared.
 */
export async function applyDnsChanges(
  db: D1Database,
  changes: readonly { providerTenantId: string; hostname: string; records: readonly DnsRecord[]; detectedAt: string }[],
  now: number,
): Promise<number> {
  const { results: tenants } = await db
    .prepare(`SELECT key, value FROM installation_meta WHERE key LIKE '${PROVIDER_TENANT_PREFIX}%'`)
    .all<{ key: string; value: string }>();
  const tenantOf = new Map(tenants.map((r) => [r.value, r.key.slice(PROVIDER_TENANT_PREFIX.length)]));
  const flagged = new Set<string>();
  for (const change of changes) {
    const tenantId = tenantOf.get(change.providerTenantId);
    if (tenantId === undefined) continue;
    const hostname = change.hostname.toLowerCase();
    const detected = Date.parse(change.detectedAt);
    await db
      .prepare(
        `UPDATE domains SET records = ?, dns_changed_at = COALESCE(dns_changed_at, ?)
          WHERE tenant_id = ? AND hostname = ? AND kind = 'sending'`,
      )
      .bind(JSON.stringify(change.records), Number.isFinite(detected) ? detected : now, tenantId, hostname)
      .run();
    flagged.add(`${tenantId}\n${hostname}`);
  }
  const { results: open } = await db
    .prepare(`SELECT id, tenant_id, hostname FROM domains WHERE dns_changed_at IS NOT NULL`)
    .all<{ id: string; tenant_id: string; hostname: string }>();
  for (const row of open) {
    if (!flagged.has(`${row.tenant_id}\n${row.hostname}`)) {
      await db.prepare(`UPDATE domains SET dns_changed_at = NULL WHERE id = ?`).bind(row.id).run();
    }
  }
  return flagged.size;
}

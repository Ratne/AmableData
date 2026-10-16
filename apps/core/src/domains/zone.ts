import type { DnsRecord } from '@amable/core';
import { safeFetch } from '@amable/auth/security';

/**
 * Automation of the customer's Cloudflare zone: DNS records for the sending
 * domain, a Workers custom domain for tracking / site hostnames, Workers
 * Routes for site paths, and a reachability probe of the edge worker.
 * Implementations: Cloudflare API (token with Zone DNS + Workers Routes edit),
 * fake (dev and tests, state in `installation_meta`, never any network).
 */
export interface ZoneAutomation {
  readonly kind: 'cloudflare' | 'fake';
  findZone(hostname: string): Promise<{ id: string; name: string } | null>;
  upsertRecords(zoneId: string, records: readonly DnsRecord[]): Promise<number>;
  attachWorkerDomain(zoneId: string, hostname: string, service: string): Promise<void>;
  addWorkerRoutes(zoneId: string, patterns: readonly string[], script: string): Promise<number>;
  /** True when `https://<hostname>/health` is answered by the edge worker. */
  probeEdge(hostname: string): Promise<boolean>;
}

export class ZoneAutomationError extends Error {
  override readonly name = 'ZoneAutomationError';
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
}

const CF_API = 'https://api.cloudflare.com/client/v4';

/** `https://<hostname>/health` answered by the edge worker (SSRF-safe, no redirects). */
export async function probeEdgeHost(hostname: string, fetchFn: FetchFn): Promise<boolean> {
  try {
    const response = await safeFetch(`https://${hostname}/health`, { method: 'GET' }, {
      fetchFn,
      timeoutMs: 5000,
      maxBytes: 4096,
      maxRedirects: 0,
    });
    const body = JSON.parse(new TextDecoder().decode(response.body)) as { worker?: unknown };
    return response.status === 200 && body.worker === 'amable-edge';
  } catch {
    return false;
  }
}

/** Candidate zones of a hostname, longest first (`a.b.example.com` → `b.example.com`, `example.com`). */
export function zoneCandidates(hostname: string): string[] {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i += 1) out.push(labels.slice(i).join('.'));
  return out;
}

export class CloudflareZoneAutomation implements ZoneAutomation {
  readonly kind = 'cloudflare' as const;
  private accountId: string | null = null;

  constructor(
    private readonly token: string,
    private readonly fetchFn: FetchFn,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchFn(`${CF_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const envelope = (await response.json().catch(() => null)) as CfEnvelope<T> | null;
    if (envelope === null || !envelope.success) {
      const message = envelope?.errors?.map((e) => e.message).join('; ') ?? `HTTP ${String(response.status)}`;
      throw new ZoneAutomationError(`Cloudflare API ${method} ${path}: ${message}`);
    }
    return envelope.result;
  }

  async findZone(hostname: string): Promise<{ id: string; name: string } | null> {
    for (const name of zoneCandidates(hostname)) {
      const zones = await this.call<Array<{ id: string; name: string; account: { id: string } }>>(
        'GET',
        `/zones?name=${encodeURIComponent(name)}&status=active`,
      );
      const zone = zones[0];
      if (zone !== undefined) {
        this.accountId = zone.account.id;
        return { id: zone.id, name: zone.name };
      }
    }
    return null;
  }

  async upsertRecords(zoneId: string, records: readonly DnsRecord[]): Promise<number> {
    let changed = 0;
    for (const record of records) {
      const existing = await this.call<Array<{ id: string; content: string }>>(
        'GET',
        `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`,
      );
      const body = { type: record.type, name: record.name, content: record.value, ttl: 1, proxied: false };
      const same = existing.find((r) => r.content === record.value);
      if (same !== undefined) continue;
      const replace = record.type === 'CNAME' ? existing[0] : undefined;
      if (replace !== undefined) await this.call('PUT', `/zones/${zoneId}/dns_records/${replace.id}`, body);
      else await this.call('POST', `/zones/${zoneId}/dns_records`, body);
      changed += 1;
    }
    return changed;
  }

  async attachWorkerDomain(zoneId: string, hostname: string, service: string): Promise<void> {
    if (this.accountId === null) throw new ZoneAutomationError('zone lookup must run first');
    await this.call('PUT', `/accounts/${this.accountId}/workers/domains`, {
      hostname,
      service,
      zone_id: zoneId,
      environment: 'production',
    });
  }

  async addWorkerRoutes(zoneId: string, patterns: readonly string[], script: string): Promise<number> {
    const existing = await this.call<Array<{ pattern: string }>>('GET', `/zones/${zoneId}/workers/routes`);
    const have = new Set(existing.map((r) => r.pattern));
    let added = 0;
    for (const pattern of patterns) {
      if (have.has(pattern)) continue;
      await this.call('POST', `/zones/${zoneId}/workers/routes`, { pattern, script });
      added += 1;
    }
    return added;
  }

  probeEdge(hostname: string): Promise<boolean> {
    return probeEdgeHost(hostname, this.fetchFn);
  }
}

interface FakeZoneState {
  records: DnsRecord[];
  workerDomains: string[];
  routes: string[];
}

/**
 * Dev / test zone: every hostname belongs to a zone named after its last two
 * labels; changes are kept in `installation_meta` (`dev_zone:<name>`) so the
 * wizard can be exercised end to end without network.
 */
export class FakeZoneAutomation implements ZoneAutomation {
  readonly kind = 'fake' as const;

  constructor(private readonly db: D1Database) {}

  private async load(zoneId: string): Promise<FakeZoneState> {
    const row = await this.db
      .prepare(`SELECT value FROM installation_meta WHERE key = ?`)
      .bind(`dev_zone:${zoneId}`)
      .first<{ value: string }>();
    return row === null
      ? { records: [], workerDomains: [], routes: [] }
      : (JSON.parse(row.value) as FakeZoneState);
  }

  private async save(zoneId: string, state: FakeZoneState): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO installation_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind(`dev_zone:${zoneId}`, JSON.stringify(state))
      .run();
  }

  findZone(hostname: string): Promise<{ id: string; name: string } | null> {
    const candidates = zoneCandidates(hostname);
    const name = candidates[candidates.length - 1];
    return Promise.resolve(name === undefined ? null : { id: name, name });
  }

  async upsertRecords(zoneId: string, records: readonly DnsRecord[]): Promise<number> {
    const state = await this.load(zoneId);
    let changed = 0;
    for (const record of records) {
      if (state.records.some((r) => r.type === record.type && r.name === record.name && r.value === record.value)) continue;
      state.records = state.records.filter(
        (r) => !(record.type === 'CNAME' && r.type === 'CNAME' && r.name === record.name),
      );
      state.records.push({ ...record });
      changed += 1;
    }
    await this.save(zoneId, state);
    return changed;
  }

  async attachWorkerDomain(zoneId: string, hostname: string): Promise<void> {
    const state = await this.load(zoneId);
    if (!state.workerDomains.includes(hostname)) state.workerDomains.push(hostname);
    await this.save(zoneId, state);
  }

  async addWorkerRoutes(zoneId: string, patterns: readonly string[]): Promise<number> {
    const state = await this.load(zoneId);
    const added = patterns.filter((p) => !state.routes.includes(p));
    state.routes.push(...added);
    await this.save(zoneId, state);
    return added.length;
  }

  async probeEdge(hostname: string): Promise<boolean> {
    const zone = await this.findZone(hostname);
    if (zone === null) return false;
    const state = await this.load(zone.id);
    return state.workerDomains.includes(hostname) || state.routes.includes(`${hostname}/health`);
  }
}

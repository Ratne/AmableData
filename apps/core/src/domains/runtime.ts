import { monotonicFactory } from 'ulid';
import { marketingProvider } from '../email/runtime';
import type { Env } from '../env';
import { DomainService, type DomainDeps } from './service';
import { CloudflareZoneAutomation, FakeZoneAutomation, probeEdgeHost, type ZoneAutomation } from './zone';

const nextId = monotonicFactory();

type Override = (base: DomainDeps, env: Env) => DomainDeps;
let override: Override | null = null;

/** Test hook (pass `null` to restore). */
export function overrideDomainDeps(next: Override | null): void {
  override = next;
}

/** Fake zone in dev (no network ever), the Cloudflare API with a token, otherwise manual mode. */
export function zoneAutomation(env: Env): ZoneAutomation | null {
  if (env.ENVIRONMENT === 'dev') return new FakeZoneAutomation(env.DB);
  const token = env.CLOUDFLARE_DNS_API_TOKEN;
  if (token === undefined || token === '') return null;
  return new CloudflareZoneAutomation(token, (input, init) => fetch(input, init));
}

export function edgeHostname(env: Env): string {
  if (env.EDGE_HOSTNAME !== undefined && env.EDGE_HOSTNAME !== '') return env.EDGE_HOSTNAME;
  try {
    return new URL(env.EDGE_ORIGIN ?? '').hostname || 'edge.invalid';
  } catch {
    return 'edge.invalid';
  }
}

export function domainService(env: Env): DomainService {
  const base: DomainDeps = {
    db: env.DB,
    provider: marketingProvider(env),
    zone: zoneAutomation(env),
    probeEdge: (hostname) => probeEdgeHost(hostname, (input, init) => fetch(input, init)),
    edgeHostname: edgeHostname(env),
    edgeScript: env.EDGE_SCRIPT_NAME ?? 'amable-edge',
    now: () => Date.now(),
    newId: () => nextId(),
  };
  return new DomainService(override === null ? base : override(base, env));
}

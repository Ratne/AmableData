import { EmailProviderError } from './email-marketing';
import type {
  PostShibaAccountApi,
  PostShibaCluster,
  PostShibaIp,
  PostShibaPlan,
  PostShibaSendingDomain,
  PostShibaSmtpCredential,
  PostShibaTeamStatus,
  PostShibaTenant,
  PostShibaWebhookEndpoint,
} from './postshiba-api';

const fakeCluster = (id: string, name: string): PostShibaCluster => ({
  id,
  name,
  plan: 'small',
  classification: 'bulk',
  status: 'active',
  sendingReady: true,
  emailsPerHour: 40_000,
  emailsPerDay: 240_000,
  baseEmailsPerHour: 40_000,
  baseEmailsPerDay: 240_000,
  httpEndpoint: 'inject.postshiba.test:443',
});

const FAKE_THROTTLES: Readonly<Record<PostShibaPlan, { hourly: number; daily: number }>> = {
  nano: { hourly: 100, daily: 600 },
  micro: { hourly: 4_000, daily: 24_000 },
  small: { hourly: 40_000, daily: 240_000 },
  medium: { hourly: 100_000, daily: 600_000 },
  large: { hourly: 200_000, daily: 1_200_000 },
};

const withPlan = (cluster: PostShibaCluster, plan: PostShibaPlan): PostShibaCluster => ({
  ...cluster,
  plan,
  emailsPerHour: FAKE_THROTTLES[plan].hourly,
  emailsPerDay: FAKE_THROTTLES[plan].daily,
  baseEmailsPerHour: FAKE_THROTTLES[plan].hourly,
  baseEmailsPerDay: FAKE_THROTTLES[plan].daily,
});

/**
 * In-memory PostShiba team (dev, staging, tests): same answers as the real
 * API, no network. `failNext` makes the next call of a method fail once;
 * `verifyAll` makes every sending domain pass its DNS check.
 */
export class FakePostShibaAccount implements PostShibaAccountApi {
  readonly tenants = new Map<string, PostShibaTenant>();
  readonly credentials = new Map<string, PostShibaSmtpCredential & { tenantId: string; clusterId: string; disabled: boolean }>();
  readonly domains = new Map<string, PostShibaSendingDomain>();
  readonly endpoints = new Map<string, PostShibaWebhookEndpoint & { secret: string }>();
  readonly clusters = new Map<string, PostShibaCluster>([
    ['FakeCluster', fakeCluster('FakeCluster', 'fake-small')],
    ['FakeCluster2', fakeCluster('FakeCluster2', 'fake-small-2')],
  ]);
  /** Network inventory: free IPs are `available`, assigned ones list their clusters (see `stockIps`). */
  readonly ips = new Map<string, PostShibaIp>();
  /** Last `percents` sent per cluster. */
  readonly splits = new Map<string, Readonly<Record<string, number>>>();
  /** Ids reported in `clusters_at_cap`. */
  readonly atCap = new Set<string>();
  readonly calls: string[] = [];
  failNext: string | null = null;
  verifyAll = false;
  private seq = 0;

  private enter(method: string): void {
    this.calls.push(method);
    if (this.failNext === method) {
      this.failNext = null;
      throw new EmailProviderError(`${method} failed (fake)`, true, 503);
    }
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}${String(this.seq).padStart(4, '0')}`;
  }

  private tenant(id: string): PostShibaTenant {
    const tenant = this.tenants.get(id);
    if (tenant === undefined) throw new EmailProviderError('not found', false, 404, null, 'not_found');
    return tenant;
  }

  listTenants(): Promise<PostShibaTenant[]> {
    this.enter('listTenants');
    return Promise.resolve([...this.tenants.values()]);
  }

  createTenant(name: string, slug: string): Promise<PostShibaTenant> {
    this.enter('createTenant');
    if ([...this.tenants.values()].some((t) => t.slug === slug)) {
      return Promise.reject(new EmailProviderError('slug has already been taken', false, 422, null, 'invalid'));
    }
    const tenant = { id: this.id('Ten'), name, slug, suspended: false };
    this.tenants.set(tenant.id, tenant);
    return Promise.resolve(tenant);
  }

  suspendTenant(id: string): Promise<void> {
    this.enter('suspendTenant');
    this.tenants.set(id, { ...this.tenant(id), suspended: true });
    return Promise.resolve();
  }

  resumeTenant(id: string): Promise<void> {
    this.enter('resumeTenant');
    this.tenants.set(id, { ...this.tenant(id), suspended: false });
    return Promise.resolve();
  }

  createSmtpCredential(clusterId: string, tenantId: string): Promise<PostShibaSmtpCredential> {
    this.enter('createSmtpCredential');
    this.tenant(tenantId);
    const id = this.id('Cred');
    const credential = { id, username: `smtp_${id}`, password: `pw-${id}` };
    this.credentials.set(id, { ...credential, tenantId, clusterId, disabled: false });
    return Promise.resolve(credential);
  }

  disableSmtpCredential(_clusterId: string, id: string): Promise<void> {
    this.enter('disableSmtpCredential');
    const credential = this.credentials.get(id);
    if (credential !== undefined) this.credentials.set(id, { ...credential, disabled: true });
    return Promise.resolve();
  }

  listSendingDomains(): Promise<PostShibaSendingDomain[]> {
    this.enter('listSendingDomains');
    return Promise.resolve([...this.domains.values()]);
  }

  createSendingDomain(name: string, tenantId: string): Promise<PostShibaSendingDomain> {
    this.enter('createSendingDomain');
    this.tenant(tenantId);
    const id = this.id('Dom');
    const domain: PostShibaSendingDomain = {
      id,
      name,
      tenantId,
      dkimStatus: 'pending',
      returnPathStatus: 'pending',
      dmarcStatus: 'pending',
      sendingAllowed: false,
      dkimManual: false,
      dkimTxt: 'v=DKIM1; k=rsa; p=FAKE',
      dkimCnameHost: `ps1._domainkey.${name}`,
      dkimCnameTarget: `${id}.customers.postshiba.test`,
      dmarcHost: `_dmarc.${name}`,
      dmarcRecord: 'v=DMARC1; p=none;',
      returnPathHost: `rp.${name}`,
      returnPathTarget: 'rp.postshiba.test',
      lastVerificationError: null,
      suspended: false,
    };
    this.domains.set(id, domain);
    return Promise.resolve(domain);
  }

  getSendingDomain(id: string): Promise<PostShibaSendingDomain> {
    this.enter('getSendingDomain');
    const domain = this.domains.get(id);
    return domain === undefined ? Promise.reject(new EmailProviderError('not found', false, 404, null, 'not_found')) : Promise.resolve(domain);
  }

  verifySendingDomain(id: string): Promise<PostShibaSendingDomain> {
    this.enter('verifySendingDomain');
    const domain = this.domains.get(id);
    if (domain === undefined) return Promise.reject(new EmailProviderError('not found', false, 404, null, 'not_found'));
    if (!this.verifyAll) return Promise.resolve(domain);
    const verified = { ...domain, dkimStatus: 'verified', returnPathStatus: 'verified', dmarcStatus: 'verified', sendingAllowed: true };
    this.domains.set(id, verified);
    return Promise.resolve(verified);
  }

  deleteSendingDomain(id: string): Promise<void> {
    this.enter('deleteSendingDomain');
    this.domains.delete(id);
    return Promise.resolve();
  }

  listWebhookEndpoints(): Promise<PostShibaWebhookEndpoint[]> {
    this.enter('listWebhookEndpoints');
    return Promise.resolve([...this.endpoints.values()].map((e) => ({ ...e, secret: null })));
  }

  createWebhookEndpoint(url: string, tenantId: string): Promise<PostShibaWebhookEndpoint> {
    this.enter('createWebhookEndpoint');
    this.tenant(tenantId);
    const id = this.id('Hook');
    const endpoint = { id, url, tenantId, secret: `whsec-${id}` };
    this.endpoints.set(id, endpoint);
    return Promise.resolve(endpoint);
  }

  getWebhookEndpoint(id: string): Promise<PostShibaWebhookEndpoint> {
    this.enter('getWebhookEndpoint');
    const endpoint = this.endpoints.get(id);
    return endpoint === undefined ? Promise.reject(new EmailProviderError('not found', false, 404, null, 'not_found')) : Promise.resolve(endpoint);
  }

  updateWebhookEndpointUrl(id: string, url: string): Promise<PostShibaWebhookEndpoint> {
    this.enter('updateWebhookEndpointUrl');
    const endpoint = this.endpoints.get(id);
    if (endpoint === undefined) return Promise.reject(new EmailProviderError('not found', false, 404, null, 'not_found'));
    const updated = { ...endpoint, url };
    this.endpoints.set(id, updated);
    return Promise.resolve({ ...updated, secret: null });
  }

  deleteWebhookEndpoint(id: string): Promise<void> {
    this.enter('deleteWebhookEndpoint');
    this.endpoints.delete(id);
    return Promise.resolve();
  }

  listClusters(): Promise<PostShibaCluster[]> {
    this.enter('listClusters');
    return Promise.resolve([...this.clusters.values()]);
  }

  createCluster(input: { name: string; plan: PostShibaPlan; classification: PostShibaCluster['classification'] }): Promise<PostShibaCluster> {
    this.enter('createCluster');
    const id = this.id('Clu');
    const cluster = withPlan({ ...fakeCluster(id, input.name), classification: input.classification }, input.plan);
    this.clusters.set(id, cluster);
    return Promise.resolve(cluster);
  }

  updateClusterPlan(id: string, plan: PostShibaPlan): Promise<PostShibaCluster> {
    this.enter('updateClusterPlan');
    const cluster = this.clusters.get(id);
    if (cluster === undefined) return Promise.reject(new EmailProviderError('not found', false, 404, null, 'not_found'));
    const updated = withPlan(cluster, plan);
    this.clusters.set(id, updated);
    return Promise.resolve(updated);
  }

  /** Puts `count` buyable IPs of `kind` in the inventory (bulk class). */
  stockIps(kind: PostShibaIp['kind'], count: number): void {
    for (let i = 0; i < count; i += 1) {
      const id = this.id(kind === 'shared' ? 'Shr' : 'Ded');
      this.ips.set(id, { id, address: `203.0.113.${String(this.seq)}`, status: 'active', warmupEndsAt: null, kind, classification: 'bulk', owned: false, available: true, clusterIds: [] });
    }
  }

  listNetwork(filter: { clusterId?: string }): Promise<PostShibaIp[]> {
    this.enter('listNetwork');
    const cluster = filter.clusterId === undefined ? undefined : this.clusters.get(filter.clusterId);
    return Promise.resolve([...this.ips.values()].filter((ip) => cluster === undefined || ip.classification === cluster.classification));
  }

  addNetworkIp(input: { ipAddressId: string; clusterId: string; percents?: Readonly<Record<string, number>> }): Promise<PostShibaIp> {
    this.enter('addNetworkIp');
    const ip = this.ips.get(input.ipAddressId);
    if (ip === undefined || !ip.available) return Promise.reject(new EmailProviderError('already claimed', false, 422, null, 'already_claimed'));
    if (!this.clusters.has(input.clusterId)) return Promise.reject(new EmailProviderError('not found', false, 404, null, 'not_found'));
    const onCluster = [...this.ips.values()].filter((i) => i.clusterIds.includes(input.clusterId));
    if (ip.kind === 'dedicated' && onCluster.some((i) => i.kind === 'dedicated')) {
      return Promise.reject(new EmailProviderError('dedicated taken', false, 422, null, 'dedicated_taken'));
    }
    const added: PostShibaIp = {
      ...ip,
      owned: ip.kind === 'dedicated',
      available: false,
      status: ip.kind === 'dedicated' ? 'warming' : 'active',
      clusterIds: [input.clusterId],
    };
    this.ips.set(ip.id, added);
    if (input.percents !== undefined) this.splits.set(input.clusterId, input.percents);
    return Promise.resolve(added);
  }

  unassignNetworkIp(input: { ipAddressId: string; clusterId: string }): Promise<PostShibaIp> {
    this.enter('unassignNetworkIp');
    const ip = this.ips.get(input.ipAddressId);
    if (ip === undefined || !ip.clusterIds.includes(input.clusterId)) return Promise.reject(new EmailProviderError('not found', false, 404, null, 'not_found'));
    const updated: PostShibaIp = { ...ip, clusterIds: ip.clusterIds.filter((c) => c !== input.clusterId), available: ip.kind === 'shared' };
    this.ips.set(ip.id, updated);
    return Promise.resolve(updated);
  }

  releaseNetworkIp(ipAddressId: string): Promise<PostShibaIp> {
    this.enter('releaseNetworkIp');
    const ip = this.ips.get(ipAddressId);
    if (ip === undefined || !ip.owned) return Promise.reject(new EmailProviderError('not found', false, 404, null, 'not_found'));
    const released: PostShibaIp = { ...ip, owned: false, available: false, status: 'reserved', clusterIds: [] };
    this.ips.set(ip.id, released);
    return Promise.resolve(released);
  }

  deleteCluster(id: string): Promise<void> {
    this.enter('deleteCluster');
    this.clusters.delete(id);
    for (const ip of this.ips.values()) {
      if (ip.clusterIds.includes(id)) this.ips.set(ip.id, { ...ip, clusterIds: ip.clusterIds.filter((c) => c !== id), available: ip.kind === 'shared' });
    }
    for (const [credentialId, credential] of this.credentials) {
      if (credential.clusterId === id) this.credentials.set(credentialId, { ...credential, disabled: true });
    }
    return Promise.resolve();
  }

  teamStatus(): Promise<PostShibaTeamStatus> {
    this.enter('teamStatus');
    return Promise.resolve({
      suspended: false,
      clustersAtCap: [...this.atCap].map((id) => ({ id, hourlyRemaining: 0, dailyRemaining: 0, queued: 0 })),
      heldTenants: [],
    });
  }
}

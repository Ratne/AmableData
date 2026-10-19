import { EmailProviderError } from './email-marketing';
import type {
  PostShibaAccountApi,
  PostShibaSendingDomain,
  PostShibaSmtpCredential,
  PostShibaTenant,
  PostShibaWebhookEndpoint,
} from './postshiba-api';

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
}

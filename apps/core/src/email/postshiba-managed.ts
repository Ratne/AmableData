import { EmailProviderError, type DomainVerification, type PostShibaWorkspace, type PostShibaWorkspaceAdmin } from '@amable/core';
import type {
  EmailDomainRequest,
  EmailDomainResponse,
  EmailTenantRequest,
  EmailWorkspaceRequest,
  EmailWorkspaceResponse,
} from '@amable/core/platform';
import { ControlPlaneError, type ControlPlaneClient } from '../platform/client';

/**
 * PostShiba tenants of the managed offering, provisioned by the control plane
 * (`/v1/installation/email/*`): the installation never sees the team key, only
 * the SMTP credential and webhook secret of its own workspaces.
 */
export class ControlPlanePostShibaAdmin implements PostShibaWorkspaceAdmin {
  constructor(private readonly client: ControlPlaneClient) {}

  private async post<T>(route: string, body: unknown): Promise<T> {
    try {
      return await this.client.post<T>(route, body);
    } catch (error) {
      if (!(error instanceof ControlPlaneError)) throw error;
      const retryable = error.status === 0 || error.status === 429 || error.status >= 500;
      throw new EmailProviderError(`control plane: ${error.code}`, retryable, error.status === 0 ? null : error.status, null, error.code);
    }
  }

  async ensureWorkspace(input: { workspaceId: string; name: string; webhookUrl: string }): Promise<PostShibaWorkspace> {
    const body: EmailWorkspaceRequest = input;
    const res = await this.post<EmailWorkspaceResponse>('/email/workspaces', body);
    return { providerTenantId: res.providerTenantId, smtp: res.smtp, webhookSecret: res.webhookSecret, injectUrl: res.injectUrl };
  }

  private domain(route: string, providerTenantId: string, hostname: string): Promise<DomainVerification> {
    const body: EmailDomainRequest = { providerTenantId, hostname };
    return this.post<EmailDomainResponse>(route, body);
  }

  addDomain(providerTenantId: string, hostname: string): Promise<DomainVerification> {
    return this.domain('/email/domains', providerTenantId, hostname);
  }

  verifyDomain(providerTenantId: string, hostname: string): Promise<DomainVerification> {
    return this.domain('/email/domains/verify', providerTenantId, hostname);
  }

  async removeDomain(providerTenantId: string, hostname: string): Promise<void> {
    const body: EmailDomainRequest = { providerTenantId, hostname };
    await this.post('/email/domains/remove', body);
  }

  async suspend(providerTenantId: string): Promise<void> {
    const body: EmailTenantRequest = { providerTenantId };
    await this.post('/email/tenants/suspend', body);
  }

  async resume(providerTenantId: string): Promise<void> {
    const body: EmailTenantRequest = { providerTenantId };
    await this.post('/email/tenants/resume', body);
  }
}

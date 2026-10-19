import {
  EmailProviderError,
  type DomainVerification,
  type EmailMarketingProvider,
  type MarketingEmail,
  type ProviderTenant,
  type SendEmailResult,
} from './email-marketing';
import {
  ensurePostShibaDomain,
  ensurePostShibaTenant,
  ensurePostShibaWebhook,
  findPostShibaDomain,
  postshibaInject,
  postshibaVerification,
  type FetchLike,
  type PostShibaAccountApi,
  type PostShibaSmtpLogin,
} from './postshiba-api';

/** What a CRM workspace needs to send through its own PostShiba tenant. */
export interface PostShibaWorkspace {
  readonly providerTenantId: string;
  readonly smtp: PostShibaSmtpLogin;
  /** Signing secret of the tenant's delivery webhook. */
  readonly webhookSecret: string;
  /** HTTP inject endpoint of the cluster (null = default). */
  readonly injectUrl: string | null;
}

/**
 * Tenant and domain management behind the provider: the control plane in the
 * managed offering (it alone holds the team key), or `DirectPostShibaAdmin`
 * on an installation that brings its own PostShiba account.
 */
export interface PostShibaWorkspaceAdmin {
  ensureWorkspace(input: { workspaceId: string; name: string; webhookUrl: string }): Promise<PostShibaWorkspace>;
  addDomain(providerTenantId: string, hostname: string): Promise<DomainVerification>;
  verifyDomain(providerTenantId: string, hostname: string): Promise<DomainVerification>;
  removeDomain(providerTenantId: string, hostname: string): Promise<void>;
  suspend(providerTenantId: string): Promise<void>;
  resume(providerTenantId: string): Promise<void>;
  /** Current credential of a tenant the control plane moved to another cluster. */
  refreshWorkspace?(providerTenantId: string): Promise<{ workspaceId: string; workspace: PostShibaWorkspace }>;
}

/** Per-workspace sending credentials, kept encrypted by the installation. */
export interface PostShibaSenderStore {
  get(providerTenantId: string): Promise<PostShibaWorkspace | null>;
  put(workspaceId: string, workspace: PostShibaWorkspace): Promise<void>;
}

export interface PostShibaConfig {
  readonly admin: PostShibaWorkspaceAdmin;
  readonly senders: PostShibaSenderStore;
  /** Delivery webhook of a CRM workspace (`<APP_ORIGIN>/hooks/email/postshiba/<id>`). */
  readonly webhookUrl: (workspaceId: string) => string;
  /** Injected transport — tests pass a fake; nothing in dev or tests reaches the network. */
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

/** Thrown by provider stubs whose real implementation belongs to a later phase. */
export class ProviderNotImplementedError extends Error {
  override readonly name = 'ProviderNotImplementedError';
  constructor(provider: string, method: string, phase: string) {
    super(`${provider}.${method} is a stub — implemented in the "${phase}" phase`);
  }
}

/**
 * PostShiba-backed EmailMarketingProvider: one PostShiba tenant per CRM
 * workspace, each with its own SMTP credential (it can only send from that
 * tenant's verified domains), delivery webhook and suppression list.
 * Messages go out through HTTP inject; `metadata` travels as
 * `X-Capsule-Unique-Args` and comes back on every delivery webhook.
 */
export class PostShibaEmailMarketingProvider implements EmailMarketingProvider {
  constructor(private readonly config: PostShibaConfig) {}

  async sendEmail(email: MarketingEmail): Promise<SendEmailResult> {
    const tenantId = email.providerTenantId ?? null;
    const sender = tenantId === null ? null : await this.config.senders.get(tenantId);
    if (tenantId === null || sender === null) {
      throw new EmailProviderError('the workspace has no PostShiba sender yet', false, null, null, 'credential_missing');
    }
    try {
      await this.inject(sender, email);
    } catch (error) {
      // A rejected login sent nothing: the credential was replaced (cluster move), fetch it and retry once.
      const refresh = this.config.admin.refreshWorkspace?.bind(this.config.admin);
      if (!(error instanceof EmailProviderError) || error.status !== 401 || refresh === undefined) throw error;
      const { workspaceId, workspace } = await refresh(tenantId);
      await this.config.senders.put(workspaceId, workspace);
      await this.inject(workspace, email);
    }
    // Inject returns no message id: delivery events match on the unique args.
    return { messageId: email.idempotencyKey ?? '', accepted: true };
  }

  private inject(sender: PostShibaWorkspace, email: MarketingEmail): Promise<void> {
    return postshibaInject(sender.smtp, email, {
      ...(sender.injectUrl === null ? {} : { injectUrl: sender.injectUrl }),
      ...(this.config.fetch === undefined ? {} : { fetch: this.config.fetch }),
      ...(this.config.timeoutMs === undefined ? {} : { timeoutMs: this.config.timeoutMs }),
    });
  }

  async createTenant(name: string, workspaceId: string): Promise<ProviderTenant> {
    const workspace = await this.config.admin.ensureWorkspace({ workspaceId, name, webhookUrl: this.config.webhookUrl(workspaceId) });
    await this.config.senders.put(workspaceId, workspace);
    return { providerTenantId: workspace.providerTenantId, name };
  }

  suspendTenant(providerTenantId: string): Promise<void> {
    return this.config.admin.suspend(providerTenantId);
  }

  resumeTenant(providerTenantId: string): Promise<void> {
    return this.config.admin.resume(providerTenantId);
  }

  addDomain(providerTenantId: string, domain: string): Promise<DomainVerification> {
    return this.config.admin.addDomain(providerTenantId, domain);
  }

  verifyDomain(domain: string, providerTenantId?: string): Promise<DomainVerification> {
    if (providerTenantId === undefined) {
      return Promise.reject(new EmailProviderError('verifyDomain needs the provider tenant id', false));
    }
    return this.config.admin.verifyDomain(providerTenantId, domain);
  }

  removeDomain(domain: string, providerTenantId: string): Promise<void> {
    return this.config.admin.removeDomain(providerTenantId, domain);
  }
}

/**
 * Workspace admin on the installation's own PostShiba account (team key +
 * cluster): self-hosted installations that do not use the managed service.
 */
export class DirectPostShibaAdmin implements PostShibaWorkspaceAdmin {
  constructor(
    private readonly account: PostShibaAccountApi,
    private readonly options: { readonly clusterId: string; readonly injectUrl?: string | null },
  ) {}

  async ensureWorkspace(input: { workspaceId: string; name: string; webhookUrl: string }): Promise<PostShibaWorkspace> {
    const tenant = await ensurePostShibaTenant(this.account, `ws-${input.workspaceId.toLowerCase()}`, input.name);
    const credential = await this.account.createSmtpCredential(this.options.clusterId, tenant.id);
    const webhook = await ensurePostShibaWebhook(this.account, tenant.id, input.webhookUrl);
    return {
      providerTenantId: tenant.id,
      smtp: { username: credential.username, password: credential.password ?? '' },
      webhookSecret: webhook.secret,
      injectUrl: this.options.injectUrl ?? null,
    };
  }

  async addDomain(providerTenantId: string, hostname: string): Promise<DomainVerification> {
    return postshibaVerification(await ensurePostShibaDomain(this.account, providerTenantId, hostname));
  }

  async verifyDomain(providerTenantId: string, hostname: string): Promise<DomainVerification> {
    const domain = await ensurePostShibaDomain(this.account, providerTenantId, hostname);
    return postshibaVerification(await this.account.verifySendingDomain(domain.id));
  }

  async removeDomain(providerTenantId: string, hostname: string): Promise<void> {
    const domain = await findPostShibaDomain(this.account, hostname);
    if (domain !== null && domain.tenantId === providerTenantId) await this.account.deleteSendingDomain(domain.id);
  }

  suspend(providerTenantId: string): Promise<void> {
    return this.account.suspendTenant(providerTenantId);
  }

  resume(providerTenantId: string): Promise<void> {
    return this.account.resumeTenant(providerTenantId);
  }
}

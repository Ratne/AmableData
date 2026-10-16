import type { SystemEmail, SystemEmailProvider } from './system-email';

/**
 * Structural subset of the Workers `send_email` binding (Cloudflare Email
 * Sending) used here: the builder form, no raw MIME needed. Kept local so this
 * package does not depend on the Workers types.
 */
export interface SendEmailBindingLike {
  send(message: {
    from: { email: string; name: string };
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<unknown>;
}

export interface CloudflareSystemEmailConfig {
  readonly binding: SendEmailBindingLike;
  /** Sender address on a domain onboarded to Email Sending of the installation's account. */
  readonly from: string;
  readonly fromName?: string;
}

/**
 * SystemEmailProvider of self-hosted installations: sends through the
 * installation's own `send_email` binding. No control plane, no API key.
 * Errors propagate: OTP codes and magic links must go out now or fail visibly.
 */
export class CloudflareSystemEmailProvider implements SystemEmailProvider {
  constructor(private readonly config: CloudflareSystemEmailConfig) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.from)) {
      throw new Error('SYSTEM_EMAIL_FROM must be a valid sender address');
    }
  }

  async send(email: SystemEmail): Promise<void> {
    await this.config.binding.send({
      from: { email: this.config.from, name: this.config.fromName ?? 'amable' },
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
  }
}

/** Installations with no usable system email transport: every send fails with a configuration hint. */
export class UnconfiguredSystemEmailProvider implements SystemEmailProvider {
  constructor(private readonly hint: string) {}

  send(): Promise<void> {
    return Promise.reject(new Error(this.hint));
  }
}

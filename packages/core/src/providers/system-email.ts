/**
 * Provider interface for transactional system emails (verification, magic links,
 * OTP codes, invitations, security notices). Marketing email never goes through here.
 *
 * Implementations:
 * - notify service (managed offering: installations forward to the control plane's
 *   central sender, authenticated by license key);
 * - Cloudflare Email Sending through the installation's own `send_email` binding
 *   (self-hosted default, no control plane);
 * - console (local dev only): logs the email instead of sending.
 * Selection by configuration: `apps/core/src/providers/select.ts`.
 */

export interface SystemEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /** 'en' | 'it' — the catalog used to render the message. */
  readonly locale: string;
}

export interface SystemEmailProvider {
  send(email: SystemEmail): Promise<void>;
}

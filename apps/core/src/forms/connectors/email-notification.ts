import { emailNotificationConfigSchema, type EmailNotificationConfig } from '@amable/api-types';
import { displayValue } from '@amable/forms';
import { renderEmailLayout } from '@amable/i18n';
import { mergeContext, renderTags, zodConfig } from './merge';
import { failure, type Connector, type ConnectorContext } from './types';

export function notificationEmail(ctx: ConnectorContext<EmailNotificationConfig>): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = renderTags(ctx.connection.config.subject, mergeContext(ctx))
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
  const rows = ctx.form.fields
    .filter((f) => !f.sensitive && ctx.submission.values[f.key] !== undefined)
    .map((f) => {
      const value = ctx.submission.values[f.key];
      return { label: f.label || f.key, value: value === undefined ? '' : displayValue(f, value) };
    });
  const link = ctx.submissionUrl;
  const { text, html } = renderEmailLayout({
    lang: 'en',
    title: `New submission of "${ctx.form.name}"`,
    blocks: [
      { type: 'paragraph', text: `Submitted at ${ctx.submission.submittedAt}` },
      ...(rows.length === 0 ? [] : [{ type: 'details' as const, rows: rows.map((r) => [r.label, r.value] as const) }]),
      ...(link === null ? [] : [{ type: 'action' as const, label: 'Open in amabledata', url: link }]),
    ],
    ...(link === null ? {} : { logoUrl: `${new URL(link).origin}/brand/logo.png` }),
  });
  return { subject, text, html };
}

/** Staff notification through the installation's system email provider (console in dev). */
export const emailNotificationConnector: Connector<EmailNotificationConfig> = {
  type: 'email_notification',
  secret: 'none',
  oauthProvider: null,
  available: () => true,
  parseConfig: zodConfig(emailNotificationConfigSchema),
  async run(ctx) {
    const message = notificationEmail(ctx);
    const recipients = ctx.connection.config.recipients;
    const request = `email to ${String(recipients.length)} recipient(s): ${message.subject}`;
    try {
      for (const to of recipients) {
        await ctx.runtime.email.send({ to, subject: message.subject, text: message.text, html: message.html, locale: 'en' });
      }
      return { status: 'success', retryable: false, statusCode: null, request, response: 'sent' };
    } catch (error) {
      return failure(`send failed: ${error instanceof Error ? error.message : String(error)}`, true, request);
    }
  },
};

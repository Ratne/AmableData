import { emailNotificationConfigSchema, type EmailNotificationConfig } from '@amable/api-types';
import { escapeHtmlAttr, escapeHtmlText } from '@amable/auth/security';
import { displayValue } from '@amable/forms';
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
  const text = [
    `New submission of "${ctx.form.name}" (${ctx.submission.submittedAt})`,
    '',
    ...rows.map((r) => `${r.label}: ${r.value}`),
    ...(link === null ? [] : ['', `Open in amabledata: ${link}`]),
  ].join('\n');
  const html = [
    `<p>New submission of <strong>${escapeHtmlText(ctx.form.name)}</strong> (${escapeHtmlText(ctx.submission.submittedAt)})</p>`,
    '<table cellpadding="6" style="border-collapse:collapse">',
    ...rows.map(
      (r) =>
        `<tr><td style="font-weight:600;vertical-align:top">${escapeHtmlText(r.label)}</td><td>${escapeHtmlText(r.value).replace(/\n/g, '<br>')}</td></tr>`,
    ),
    '</table>',
    ...(link === null ? [] : [`<p><a href="${escapeHtmlAttr(link)}">Open in amabledata</a></p>`]),
  ].join('\n');
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

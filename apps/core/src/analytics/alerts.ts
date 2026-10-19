import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from '@amable/auth';
import type { SystemEmailProvider } from '@amable/core';
import { renderEmailLayout } from '@amable/i18n';
import type { AlertDelivery } from './sync';

/**
 * Goal alert delivery: an email to the configured recipients that are members
 * of the tenant (team notification, sent through the installation's system
 * email provider), and a signed webhook (`Amable-Signature: t=…,v1=…`, HMAC-SHA256
 * of `<t>.<body>` with the alert's secret; same scheme as every outgoing webhook).
 */

export interface AlertTransport {
  email: SystemEmailProvider;
  /** Emails of the tenant's members (lowercase): recipients outside it are dropped. */
  memberEmails(tenantId: string): Promise<ReadonlySet<string>>;
  /** POSTs the webhook (SSRF-safe in production); resolves with the HTTP status. */
  post(url: string, body: string, headers: Record<string, string>): Promise<number>;
  now(): number;
  /** Public origin of the app, for links in the email. */
  appOrigin: string;
}

export function alertEmail(d: AlertDelivery, to: string, appOrigin: string): {
  to: string;
  subject: string;
  text: string;
  html: string;
  locale: string;
} {
  const { payload, site, alert } = d;
  const what = payload.test
    ? `Test alert "${alert.name}" for goal "${payload.goal}" on ${site.name}.`
    : `Goal "${payload.goal}" was completed ${payload.count} time${payload.count === 1 ? '' : 's'} on ${site.name} (alert "${alert.name}").`;
  const origin = appOrigin.replace(/\/+$/, '');
  const { html, text } = renderEmailLayout({
    lang: 'en',
    title: payload.test ? `Test alert: ${alert.name}` : `${payload.goal} on ${site.name}`,
    blocks: [
      { type: 'paragraph', text: what },
      { type: 'details', rows: [['First', payload.first_at], ['Last', payload.last_at]] },
      { type: 'action', label: 'Open amabledata', url: `${origin}/` },
    ],
    logoUrl: `${origin}/brand/logo.png`,
  });
  return {
    to,
    subject: payload.test ? `[amabledata] Test: ${alert.name}` : `[amabledata] ${payload.goal} on ${site.name}`,
    text,
    html,
    locale: 'en',
  };
}

export async function deliverAlert(
  t: AlertTransport,
  d: AlertDelivery,
): Promise<Array<{ channel: 'email' | 'webhook'; ok: boolean }>> {
  const results: Array<{ channel: 'email' | 'webhook'; ok: boolean }> = [];
  if (d.alert.emailRecipients.length > 0) {
    const members = await t.memberEmails(d.tenantId);
    const recipients = d.alert.emailRecipients.filter((e) => members.has(e.toLowerCase()));
    let ok = recipients.length > 0;
    for (const to of recipients) {
      try {
        await t.email.send(alertEmail(d, to, t.appOrigin));
      } catch {
        ok = false;
      }
    }
    results.push({ channel: 'email', ok });
  }
  if (d.alert.webhookUrl !== null && d.alert.webhookSecret !== null) {
    const body = JSON.stringify(d.payload);
    let ok = false;
    try {
      const status = await t.post(d.alert.webhookUrl, body, {
        'content-type': 'application/json',
        [WEBHOOK_SIGNATURE_HEADER]: await signWebhook(d.alert.webhookSecret, body, t.now()),
        'user-agent': 'amabledata-webhooks/1',
      });
      ok = status >= 200 && status < 300;
    } catch {
      ok = false;
    }
    results.push({ channel: 'webhook', ok });
  }
  return results;
}

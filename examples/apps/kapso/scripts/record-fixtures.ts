/**
 * Records the Kapso answers the tests replay, from a real project:
 *
 *   KAPSO_API_KEY=... pnpm --filter @amable/example-app-kapso record-fixtures
 *
 * Only calls without lasting effects: reads, errors, and a webhook and a setup
 * link that are deleted or revoked right after. Templates and production sends
 * need a production number and Meta's review: their fixtures come from Kapso's
 * API reference (`source: "docs"`) and are not touched here.
 * Every answer goes through `redact()`; read the diff before committing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact, type Fixture } from '@amable/app-sdk/testing';

const PLATFORM = 'https://api.kapso.ai/platform/v1';
const WHATSAPP = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const apiKey = process.env['KAPSO_API_KEY'] ?? '';
if (apiKey === '') {
  console.error('KAPSO_API_KEY is not set');
  process.exit(1);
}
const out = join(process.cwd(), 'test', 'fixtures', 'kapso');
mkdirSync(out, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const secrets = [apiKey];

async function record(
  file: string,
  description: string,
  request: { method: string; url: string; body?: unknown; key?: string },
  pattern: string = request.url,
): Promise<unknown> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: { 'X-API-Key': request.key ?? apiKey, 'content-type': 'application/json' },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  const text = await response.text();
  const body: unknown = text === '' ? undefined : JSON.parse(text);
  const fixture: Fixture = {
    provider: 'kapso',
    description,
    source: 'live',
    recorded_at: today,
    request: {
      method: request.method,
      url: pattern,
      ...(request.body === undefined ? {} : { body: redact(request.body, { secrets }) }),
    },
    response: {
      status: response.status,
      ...(body === undefined ? {} : { body: redact(body, { secrets }) }),
    },
  };
  writeFileSync(join(out, `${file}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${String(response.status)} ${file}`);
  return body;
}

const numbers = (await record(
  'phone-numbers-sandbox',
  'Numbers of a project that only has the Kapso sandbox number',
  {
    method: 'GET',
    url: `${PLATFORM}/whatsapp/phone_numbers?per_page=100`,
  },
)) as { data: Array<{ phone_number_id: string; business_account_id: string }> };
const sandbox = numbers.data[0];
if (sandbox === undefined) throw new Error('the project needs its sandbox number');

await record('error-invalid-key', 'Any call with a wrong API key', {
  method: 'GET',
  url: `${PLATFORM}/whatsapp/phone_numbers?per_page=100`,
  key: 'not-a-key',
});
await record('customers-none', 'No customer with this external id yet', {
  method: 'GET',
  url: `${PLATFORM}/customers?external_customer_id=amable-t_fixture_none`,
});
await record(
  'templates-sandbox-forbidden',
  'Templates of the sandbox WhatsApp Business Account: not available',
  { method: 'GET', url: `${WHATSAPP}/${sandbox.business_account_id}/message_templates?limit=100` },
  `${WHATSAPP}/{waba_id}/message_templates`,
);
await record(
  'send-no-session',
  'Sandbox send to a phone that has not joined the sandbox',
  {
    method: 'POST',
    url: `${WHATSAPP}/${sandbox.phone_number_id}/messages`,
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15550001111',
      type: 'text',
      text: { body: 'fixture' },
    },
  },
  `${WHATSAPP}/{phone_number_id}/messages`,
);
const webhook = (await record(
  'webhook-create',
  'Webhook created on a number',
  {
    method: 'POST',
    url: `${PLATFORM}/whatsapp/phone_numbers/${sandbox.phone_number_id}/webhooks`,
    body: {
      whatsapp_webhook: {
        kind: 'kapso',
        url: 'https://example.com/amable-fixture',
        events: [
          'whatsapp.message.received',
          'whatsapp.message.sent',
          'whatsapp.message.delivered',
          'whatsapp.message.read',
          'whatsapp.message.failed',
          'whatsapp.contact.marketing_preference_changed',
        ],
        secret_key: 'fixture_secret_0123456789abcdef',
        active: true,
      },
    },
  },
  `${PLATFORM}/whatsapp/phone_numbers/{phone_number_id}/webhooks`,
)) as { data: { id: string } };
await record(
  'webhook-delete',
  'Webhook deleted',
  {
    method: 'DELETE',
    url: `${PLATFORM}/whatsapp/phone_numbers/${sandbox.phone_number_id}/webhooks/${webhook.data.id}`,
  },
  `${PLATFORM}/whatsapp/phone_numbers/{phone_number_id}/webhooks/{webhook_id}`,
);
await record(
  'webhook-delete-missing',
  'Deleting a webhook that is already gone',
  {
    method: 'DELETE',
    url: `${PLATFORM}/whatsapp/phone_numbers/${sandbox.phone_number_id}/webhooks/${webhook.data.id}`,
  },
  `${PLATFORM}/whatsapp/phone_numbers/{phone_number_id}/webhooks/{webhook_id}`,
);
const customers = (await fetch(`${PLATFORM}/customers?per_page=1`, {
  headers: { 'X-API-Key': apiKey },
}).then((r) => r.json())) as { data: Array<{ id: string }> };
const customer = customers.data[0];
if (customer !== undefined) {
  const link = (await record(
    'setup-link-create',
    'Setup link (hosted WhatsApp onboarding) for a customer',
    {
      method: 'POST',
      url: `${PLATFORM}/customers/${customer.id}/setup_links`,
      body: {
        setup_link: {
          success_redirect_url:
            'https://apps.amabledata.com/kapso/setup/connected/0123456789abcdef0123456789abcdef',
          failure_redirect_url:
            'https://apps.amabledata.com/kapso/setup/failed/0123456789abcdef0123456789abcdef',
        },
      },
    },
    `${PLATFORM}/customers/{customer_id}/setup_links`,
  )) as { data: { id: string; token: string } };
  secrets.push(link.data.token);
  await fetch(`${PLATFORM}/customers/${customer.id}/setup_links/${link.data.id}`, {
    method: 'PATCH',
    headers: { 'X-API-Key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ setup_link: { status: 'revoked' } }),
  });
  // Rewrite with the link token redacted too.
  const { readFileSync } = await import('node:fs');
  const path = join(out, 'setup-link-create.json');
  writeFileSync(
    path,
    `${JSON.stringify(redact(JSON.parse(readFileSync(path, 'utf8')), { secrets }), null, 2)}\n`,
  );
}

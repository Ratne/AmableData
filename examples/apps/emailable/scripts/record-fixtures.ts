/**
 * Records the Emailable answers the tests replay, from a real account:
 *
 *   EMAILABLE_API_KEY=... pnpm --filter @amable/example-app-emailable record-fixtures
 *
 * Each verification costs one credit (a few in total). The addresses are
 * public role or made-up ones, never real people. The account owner's email
 * and the key are redacted; read the diff before committing.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact, type Fixture } from '@amable/app-sdk/testing';

const API = 'https://api.emailable.com/v1';
const apiKey = process.env['EMAILABLE_API_KEY'] ?? '';
if (apiKey === '') {
  console.error('EMAILABLE_API_KEY is not set');
  process.exit(1);
}
const out = join(process.cwd(), 'test', 'fixtures', 'emailable');
mkdirSync(out, { recursive: true });
const today = new Date().toISOString().slice(0, 10);

const account = (await fetch(`${API}/account`, {
  headers: { authorization: `Bearer ${apiKey}` },
}).then((r) => r.json())) as { owner_email?: string };
const replace: Record<string, string> = {};
if (typeof account.owner_email === 'string') replace[account.owner_email] = 'owner@example.com';

async function record(
  file: string,
  description: string,
  path: string,
  options: { key?: string | null; query?: Record<string, string> } = {},
): Promise<void> {
  const query = new URLSearchParams(options.query ?? {});
  const url = `${API}${path}${query.size === 0 ? '' : `?${query.toString()}`}`;
  const key = options.key === undefined ? apiKey : options.key;
  const response = await fetch(url, {
    headers: key === null ? {} : { authorization: `Bearer ${key}` },
  });
  const text = await response.text();
  const fixture: Fixture = {
    provider: 'emailable',
    description,
    source: 'live',
    recorded_at: today,
    // `timeout` only tells Emailable how long to wait: the fixture matches on the email.
    request: {
      method: 'GET',
      url: url.replace(/&timeout=\d+/, ''),
      ...(query.size === 0 ? {} : { match_query: true }),
    },
    response: {
      status: response.status,
      ...(text === '' ? {} : { body: redact(JSON.parse(text), { secrets: [apiKey], replace }) }),
    },
  };
  writeFileSync(join(out, `${file}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${String(response.status)} ${file}`);
}

await record('account', 'Account of a valid API key', '/account');
await record('error-no-key', 'Call without an API key', '/account', { key: null });
await record('error-invalid-key', 'Call with a wrong API key', '/account', {
  key: 'live_not_a_key',
});
const verify = (email: string) => ({ query: { email, timeout: '10' } });
await record(
  'verify-deliverable',
  'A mailbox that receives mail',
  '/verify',
  verify('support@emailable.com'),
);
await record(
  'verify-undeliverable',
  'A mailbox that does not exist on a real domain',
  '/verify',
  verify('no-such-user-amable-fixture-7f3a@gmail.com'),
);
await record(
  'verify-disposable',
  'An address of a disposable email service',
  '/verify',
  verify('amable-fixture@mailinator.com'),
);
await record(
  'verify-typo',
  'A misspelled domain: Emailable suggests the fix',
  '/verify',
  verify('amable.fixture@gmial.com'),
);

import { describe, expect, it } from 'vitest';
import {
  NotifyError,
  NotifySystemEmailProvider,
  type NotifyFetch,
} from '../../../../../packages/core/src/providers/notify';
import { LICENSE_KEY } from './helpers';

const ENDPOINT = 'https://cp.test/v1/installation/notify';
const email = { to: 'ada@example.com', subject: 'Your code', html: '<p>123456</p>', text: '123456', locale: 'it' };

function recording(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch: NotifyFetch = async (url, init) => {
    calls.push({ url, init });
    return response();
  };
  return { calls, fetch };
}

async function failure(status: number, body: unknown = { error: 'x' }): Promise<NotifyError> {
  const { fetch } = recording(() => new Response(JSON.stringify(body), { status }));
  const provider = new NotifySystemEmailProvider({ endpoint: ENDPOINT, licenseKey: LICENSE_KEY, fetch });
  const error: unknown = await provider.send(email).catch((e: unknown) => e);
  if (!(error instanceof NotifyError)) throw new Error('expected a NotifyError');
  return error;
}

describe('notify system email provider', () => {
  it('posts a NotifyRequest with the license as Bearer, once', async () => {
    const { calls, fetch } = recording(() => new Response(JSON.stringify({ accepted: true, id: 'n1' }), { status: 202 }));
    const provider = new NotifySystemEmailProvider({ endpoint: ENDPOINT, licenseKey: LICENSE_KEY, fetch });
    await provider.send(email);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(ENDPOINT);
    expect(call?.init?.method).toBe('POST');
    const headers = new Headers(call?.init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${LICENSE_KEY}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(call?.init?.body))).toEqual(email);
  });

  it('maps control plane answers to typed errors', async () => {
    expect(await failure(401)).toMatchObject({ code: 'invalid_license', status: 401, retryable: false });
    expect(await failure(402)).toMatchObject({ code: 'services_suspended', retryable: false });
    expect(await failure(429)).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(await failure(503)).toMatchObject({ code: 'server_error', retryable: true });
    const rejected = await failure(422, { error: 'validation_failed' });
    expect(rejected).toMatchObject({ code: 'rejected', status: 422 });
    expect(rejected.message).toContain('validation_failed');
  });

  it('surfaces network failures as unreachable', async () => {
    const provider = new NotifySystemEmailProvider({
      endpoint: ENDPOINT,
      licenseKey: LICENSE_KEY,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(provider.send(email)).rejects.toMatchObject({ code: 'unreachable', retryable: true });
  });

  it('fails clearly without a license (open source must configure its own provider)', async () => {
    const { calls, fetch } = recording(() => new Response('{}'));
    const provider = new NotifySystemEmailProvider({ endpoint: ENDPOINT, licenseKey: '', fetch });
    const error: unknown = await provider.send(email).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotifyError);
    expect(error).toMatchObject({ code: 'not_configured' });
    expect((error as Error).message).toMatch(/LICENSE_KEY/);
    expect(calls).toHaveLength(0);
  });
});

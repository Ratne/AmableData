import {
  EDGE_GATEWAY_DEV_SECRET,
  EDGE_GATEWAY_ENVELOPE_HEADER,
  EDGE_GATEWAY_PATH,
  EDGE_GATEWAY_RAW_PATH,
  EDGE_GATEWAY_SIGNATURE_HEADER,
} from '@amable/api-types';
import { signWebhook } from '@amable/auth/security';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { handleEdgeGateway } from '../../src/public/gateway';

const env = { ENVIRONMENT: 'dev' } as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

const makeEnvelope = (nonce: string, op = 'nope.unknown') =>
  JSON.stringify({
    nonce,
    op,
    tenant: { slug: 'demo' },
    client: { ip: null, userAgent: null, country: null, visitorId: null, referer: null, acceptLanguage: null },
    input: {},
  });
let counter = 0;
const freshNonce = () => `test-nonce-${String(Date.now())}-${String((counter += 1))}`;

const envelope = JSON.stringify({
  nonce: 'static-nonce-for-unsigned-test',
  op: 'nope.unknown',
  tenant: { slug: 'demo' },
  client: { ip: null, userAgent: null, country: null, visitorId: null, referer: null, acceptLanguage: null },
  input: {},
});

const base64Url = (text: string): string =>
  Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('edge gateway authentication', () => {
  it('hides itself from unsigned callers', async () => {
    const res = await handleEdgeGateway(
      new Request(`https://core${EDGE_GATEWAY_PATH}`, { method: 'POST', body: envelope }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
  });

  it('accepts a signed JSON envelope and dispatches by op', async () => {
    const envelope = makeEnvelope(freshNonce());
    const res = await handleEdgeGateway(
      new Request(`https://core${EDGE_GATEWAY_PATH}`, {
        method: 'POST',
        headers: { [EDGE_GATEWAY_SIGNATURE_HEADER]: await signWebhook(EDGE_GATEWAY_DEV_SECRET, envelope) },
        body: envelope,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: 'unknown_op' } });
  });

  it('reads the signed envelope from a header on WebSocket upgrades', async () => {
    const envelope = makeEnvelope(freshNonce());
    const signature = await signWebhook(EDGE_GATEWAY_DEV_SECRET, envelope);
    const upgrade = (sig: string) =>
      handleEdgeGateway(
        new Request(`https://core${EDGE_GATEWAY_RAW_PATH}`, {
          headers: {
            upgrade: 'websocket',
            [EDGE_GATEWAY_SIGNATURE_HEADER]: sig,
            [EDGE_GATEWAY_ENVELOPE_HEADER]: base64Url(envelope),
          },
        }),
        env,
        ctx,
      );
    const accepted = await upgrade(signature);
    expect(await accepted.json()).toMatchObject({ ok: false, error: { code: 'unknown_op' } });
    const tampered = await upgrade(signature.replace(/v1=(.)/, (_m, c: string) => `v1=${c === '0' ? '1' : '0'}`));
    expect(await tampered.text()).toBe('Not found');
  });

  it('refuses replayed nonces, envelopes without a nonce and stale timestamps', async () => {
    const send = async (body: string, signedAt?: number) =>
      handleEdgeGateway(
        new Request(`https://core${EDGE_GATEWAY_PATH}`, {
          method: 'POST',
          headers: { [EDGE_GATEWAY_SIGNATURE_HEADER]: await signWebhook(EDGE_GATEWAY_DEV_SECRET, body, signedAt) },
          body,
        }),
        env,
        ctx,
      );
    const once = makeEnvelope(freshNonce());
    expect(await (await send(once)).json()).toMatchObject({ error: { code: 'unknown_op' } });
    const replay = await send(once);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: { code: 'replayed' } });

    const missing = JSON.stringify({ ...JSON.parse(once), nonce: undefined });
    expect((await send(missing)).status).toBe(400);

    const stale = await send(makeEnvelope(freshNonce()), Date.now() - 2 * 60_000);
    expect(stale.status).toBe(404);
  });

  it('refuses plain GETs without an upgrade', async () => {
    const res = await handleEdgeGateway(new Request(`https://core${EDGE_GATEWAY_RAW_PATH}`), env, ctx);
    expect(res.status).toBe(404);
  });
});

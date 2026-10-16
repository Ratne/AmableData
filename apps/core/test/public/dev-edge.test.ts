import { describe, expect, it } from 'vitest';
import { DEV_EDGE_HEADER, forwardToDevEdge, isDevEdgeRequest } from '../../src/public/dev-edge';

function fakeEdge() {
  const seen: Request[] = [];
  const fetcher = {
    fetch: async (input: RequestInfo | URL) => {
      seen.push(input as Request);
      return new Response('edge');
    },
    connect: () => {
      throw new Error('not used');
    },
  } as unknown as Fetcher;
  return { fetcher, seen };
}

describe('dev edge forwarding', () => {
  it('only applies in dev, with the binding and the proxy header', () => {
    const { fetcher } = fakeEdge();
    const marked = new Request('http://127.0.0.1:8787/e', { headers: { [DEV_EDGE_HEADER]: '127.0.0.1:8788' } });
    expect(isDevEdgeRequest(marked, { ENVIRONMENT: 'dev', EDGE_DEV: fetcher })).toBe(true);
    expect(isDevEdgeRequest(marked, { ENVIRONMENT: 'production', EDGE_DEV: fetcher })).toBe(false);
    expect(isDevEdgeRequest(marked, { ENVIRONMENT: 'dev' })).toBe(false);
    expect(isDevEdgeRequest(new Request('http://127.0.0.1:8787/e'), { ENVIRONMENT: 'dev', EDGE_DEV: fetcher })).toBe(false);
  });

  it('restores the public edge host, drops the marker and keeps method and body', async () => {
    const { fetcher, seen } = fakeEdge();
    const request = new Request('http://127.0.0.1:8787/e?x=1', {
      method: 'POST',
      headers: { [DEV_EDGE_HEADER]: 'localhost:8788', origin: 'https://www.example.com' },
      body: '{"type":"pageview"}',
    });
    const response = await forwardToDevEdge(request, { EDGE_DEV: fetcher });
    expect(await response.text()).toBe('edge');
    const forwarded = seen[0]!;
    expect(forwarded.url).toBe('http://localhost:8788/e?x=1');
    expect(forwarded.method).toBe('POST');
    expect(forwarded.headers.has(DEV_EDGE_HEADER)).toBe(false);
    expect(forwarded.headers.get('origin')).toBe('https://www.example.com');
    expect(await forwarded.text()).toBe('{"type":"pageview"}');
  });

  it('ignores a malformed host value', async () => {
    const { fetcher, seen } = fakeEdge();
    await forwardToDevEdge(
      new Request('http://127.0.0.1:8787/s.js', { headers: { [DEV_EDGE_HEADER]: 'evil/host' } }),
      { EDGE_DEV: fetcher },
    );
    expect(seen[0]!.url).toBe('http://127.0.0.1:8787/s.js');
  });
});

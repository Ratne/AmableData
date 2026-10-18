import { describe, expect, it } from 'vitest';
import { conversionTime } from '../src/analytics/links/postback';
import { T0 } from './helpers';
import { linkHarness, OTHER_HOST, vidOf } from './link-fixtures';

type Harness = ReturnType<typeof linkHarness>;

const CONVERTING_SOURCE = {
  conversion: {
    ad_connection_id: 'conn_meta',
    platform: 'meta' as const,
    mapping: [{ event: 'sale', platform_event: 'Purchase' }],
  },
};

/** Entrance + click to the offer; returns the visitor and the hit of the offer view. */
async function visitOffer(h: Harness): Promise<{ vid: string; lander: string; hit: string }> {
  const vid = vidOf(await h.get(`/go/${h.graph.id}-${h.source.id}?cid=CAMP1&fbclid=FB1`));
  h.clock.now += 60_000;
  await h.get(`/a/1?vid=${vid}&rn=lander`);
  h.clock.now += 60_000;
  const views = h.touches(vid).filter((t) => t.kind === 'view');
  return { vid, lander: views[0]!.id, hit: views[1]!.id };
}

function dump(h: Harness, table: string): string {
  const db = (h.store as unknown as { db: { all: (q: string) => unknown[] } }).db;
  return JSON.stringify(db.all(`SELECT * FROM ${table}`)).toLowerCase();
}

describe('GET /pb', () => {
  it('records the conversion of a hit idempotently on hit + tx', async () => {
    const h = linkHarness();
    const { vid, hit } = await visitOffer(h);
    const first = await h.get(`/pb?hit=${hit}&rev=12.50&tx=ORD-1`);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('ok');
    const again = await h.get(`/pb/?hit=${hit}&rev=12.50&tx=ORD-1`);
    expect(again.status).toBe(200);
    expect(h.store.listConversions({ hit })).toHaveLength(1);
    expect(h.store.listConversions({ hit })[0]).toMatchObject({
      tx: 'ORD-1',
      event: 'sale',
      status: 'approved',
      revenue_minor: 1250,
      currency: 'EUR',
      visitor_id: vid,
      funnel_id: h.graph.id,
      node_id: 'offer',
      page_id: 'o1',
      traffic_source_id: h.source.id,
      source: 'postback',
      ts: h.clock.now,
    });
    await h.get(`/pb?hit=${hit}&rev=5&tx=ORD-2`);
    expect(h.store.listConversions({ hit }).map((c) => c.revenue_minor)).toEqual([1250, 500]);
  });

  it('maps pending to 0.01 and rejected to a reversal that never creates', async () => {
    const h = linkHarness();
    const { hit } = await visitOffer(h);
    await h.get(`/pb?hit=${hit}&rev=40&tx=T1&status=hold`);
    expect(h.store.listConversions({ hit })[0]).toMatchObject({ status: 'pending', revenue_minor: 1 });
    await h.get(`/pb?hit=${hit}&rev=40&tx=T1`);
    expect(h.store.listConversions({ hit })[0]).toMatchObject({ status: 'approved', revenue_minor: 4000 });
    await h.get(`/pb?hit=${hit}&tx=T1&status=trash`);
    expect(h.store.listConversions({ hit })[0]).toMatchObject({ status: 'rejected', revenue_minor: 0 });

    const unknownTx = await h.get(`/pb?hit=${hit}&tx=T2&status=rejected`);
    expect(unknownTx.status).toBe(200);
    await h.get(`/pb?hit=${hit}&tx=T3&rev=-1`);
    expect(h.store.listConversions({ hit })).toHaveLength(1);
    await h.get(`/pb?hit=${hit}&tx=T4&rev=3&status=whatever`);
    expect(h.store.listConversions({ hit }).at(-1)).toMatchObject({ tx: 'T4', status: 'approved', revenue_minor: 300 });
  });

  it('scales rev by rev_share', async () => {
    const h = linkHarness();
    const { hit } = await visitOffer(h);
    await h.get(`/pb?hit=${hit}&rev=25&rev_share=70`);
    expect(h.store.listConversions({ hit })[0]).toMatchObject({ revenue_minor: 1750, tx: '' });
  });

  it('overrides the conversion time, falling back to the postback time when invalid or before the hit', async () => {
    const h = linkHarness();
    const { hit } = await visitOffer(h);
    const at = Math.floor((h.clock.now - 30_000) / 1000);
    await h.get(`/pb?hit=${hit}&tx=A&conversion_time=${at}`);
    await h.get(`/pb?hit=${hit}&tx=B&conversion_time=${Math.floor(T0 / 1000) - 3600}`);
    await h.get(`/pb?hit=${hit}&tx=C&conversion_time=yesterday`);
    expect(h.store.listConversions({ hit }).map((c) => [c.tx, c.ts])).toEqual([
      ['A', at * 1000],
      ['B', h.clock.now],
      ['C', h.clock.now],
    ]);
    expect(conversionTime(String(h.clock.now - 1000), 0, h.clock.now)).toBe(h.clock.now - 1000);
    expect(conversionTime(String(h.clock.now + 10_000), 0, h.clock.now)).toBe(h.clock.now);
  });

  it('converts by vid + p, or the latest offer view of the visitor', async () => {
    const h = linkHarness();
    const { vid, lander, hit } = await visitOffer(h);
    await h.get(`/pb?vid=${vid}&p=l1&tx=L`);
    await h.get(`/pb?vid=${vid}&tx=O`);
    expect(h.store.listConversions({ visitor_id: vid }).map((c) => [c.tx, c.hit])).toEqual([
      ['L', lander],
      ['O', hit],
    ]);
    expect((await h.get(`/pb?vid=${vid}&p=nope`)).status).toBe(404);
  });

  it('answers 400 on invalid parameters and 404 on unknown hits and hosts', async () => {
    const h = linkHarness();
    const { hit } = await visitOffer(h);
    expect((await h.get('/pb?rev=1')).status).toBe(400);
    expect((await h.get(`/pb?hit=${hit}&rev=abc`)).status).toBe(400);
    expect((await h.get(`/pb?hit=${hit}&rev=-5`)).status).toBe(400);
    expect((await h.get(`/pb?hit=${hit}&rev_share=150`)).status).toBe(400);
    expect((await h.get(`/pb?hit=bad%20hit`)).status).toBe(400);
    expect((await h.get('/pb?hit=unknownhit')).status).toBe(404);
    expect((await h.get(`/pb?hit=${hit}`, {}, OTHER_HOST)).status).toBe(404);
    expect((await h.get(`/pb?hit=${hit}`, {}, 'unknown.test')).status).toBe(404);
    expect(h.store.listConversions({ hit })).toEqual([]);
  });
});

describe('outbound and PII', () => {
  function converting(): Harness {
    const h = linkHarness({ source: CONVERTING_SOURCE });
    h.store.upsertAdConnection({ id: 'conn_meta', platform: 'meta', account_id: 'act_1' });
    return h;
  }

  it('enqueues the conversion for the source connection unless disable_postbacks', async () => {
    const h = converting();
    const { hit } = await visitOffer(h);
    await h.get(`/pb?hit=${hit}&rev=10&tx=K1&disable_postbacks=1`);
    expect(h.store.listOutbound()).toEqual([]);
    await h.get(`/pb?hit=${hit}&rev=10&tx=K2`);
    const jobs = h.store.listOutbound();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ platform: 'meta', connection_id: 'conn_meta', status: 'pending' });
    expect(jobs[0]!.payload).toMatchObject({ event_name: 'Purchase', value_minor: 1000, order_id: 'K2', click_ids: { fbclid: 'FB1' } });
    // Pending conversions wait for their approval before being forwarded.
    await h.get(`/pb?hit=${hit}&rev=10&tx=K3&status=pending`);
    expect(h.store.listOutbound()).toHaveLength(1);
  });

  it('passes PII through to the outbound queue only, never to conversions nor touches', async () => {
    const h = converting();
    const { hit } = await visitOffer(h);
    const res = await h.get(
      `/pb?hit=${hit}&rev=10&tx=P1&pii_email=Ann.Doe%40Example.com&pii_phone=%2B393331234567&event_data1=blue`,
    );
    expect(res.status).toBe(200);
    expect(h.store.listConversions({ hit })[0]!.data).toEqual({ event_data1: 'blue' });
    for (const table of ['conversion_log', 'touches', 'funnel_sessions', 'identity_keys', 'visitors']) {
      expect(dump(h, table)).not.toContain('ann.doe@example.com');
      expect(dump(h, table)).not.toContain('3331234567');
    }
    expect(h.store.listOutbound()[0]!.payload).toMatchObject({ email: 'ann.doe@example.com', phone: '+393331234567' });
  });
});

describe('GET /pb/event', () => {
  it('records numbered custom events without tx, deduplicated per hit', async () => {
    const h = linkHarness();
    const { hit } = await visitOffer(h);
    expect((await h.get(`/pb/event?hit=${hit}&e=3&rev=2`)).status).toBe(200);
    expect((await h.get(`/pb/event/?hit=${hit}&e=3&rev=2&tx=ignored`)).status).toBe(200);
    await h.get(`/pb/event?hit=${hit}&num=4`);
    expect(h.store.listConversions({ hit }).map((c) => [c.event, c.tx, c.revenue_minor])).toEqual([
      ['event:3', '', 200],
      ['event:4', '', 0],
    ]);
    expect((await h.get(`/pb/event?hit=${hit}`)).status).toBe(400);
    expect((await h.get(`/pb/event?hit=${hit}&e=11`)).status).toBe(400);
  });
});

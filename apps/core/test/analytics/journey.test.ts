import { contactJourneySchema } from '@amable/api-types';
import type { AnalyticsNamespace } from '@amable/app-edge/analytics';
import { describe, expect, it } from 'vitest';
import { ev, FakeAnalyticsNamespace, siteInit, T0 } from '../../../edge/test/helpers';
import { contactJourney } from '../../src/analytics/journey';

const TENANT = 'tenant_1';
const SITE = 'st_aaaaaaaaaaaaaaaaaaaa';
const MIN = 60_000;

function setup() {
  const ns = new FakeAnalyticsNamespace(() => T0 + 10 * MIN);
  const site = ns.store(`site:${SITE}`);
  site.initSite(siteInit());
  ns.store(`tenant:${TENANT}`).indexAdd(SITE);
  return { ns, site };
}

const noCrm = { exists: true, orders: [], activities: [] };

describe('contact journey API', () => {
  it('forwards merged visitors, funnel touches and tags of the identity graph', async () => {
    const { ns, site } = setup();
    site.ingest(
      [
        ev({ vid: 'v-phone', sid: 's-p', ts: T0, firstSeen: T0 }),
        ev({ vid: 'v-desk', sid: 's-d', ts: T0 + 5 * MIN, firstSeen: T0 + 5 * MIN }),
      ],
      [],
    );
    site.recordTouch({
      id: 'hit_1', ts: T0, visitor_id: 'v-phone', session_id: 's-p', funnel_id: 'fg_1', node_id: 'n1',
      traffic_source_id: 'ts_paid', kind: 'entrance', campaign: 'cmp_1', external_click_id: 'fbclid-1',
    });
    site.recordTouch({
      id: 'hit_2', ts: T0 + MIN, visitor_id: 'v-phone', session_id: 's-p', funnel_id: 'fg_1', node_id: 'n2',
      kind: 'action', action_number: 1,
    });
    expect(site.mergeVisitors('v-phone', 'v-desk')).toMatchObject({ ok: true });
    site.applyVisitorTags('v-phone', ['hot']);
    site.applyCrmFacts([{ kind: 'link', id: 'l1', contactId: 'ct_1', visitorId: 'v-desk', source: 'form', ts: T0 + 6 * MIN }]);
    ns.store(`tenant:${TENANT}`).registerLinks([
      { siteId: SITE, visitorId: 'v-desk', contactId: 'ct_1', linkedAt: T0 + 6 * MIN, source: 'form' },
    ]);

    const journey = await contactJourney(ns as unknown as AnalyticsNamespace, TENANT, 'ct_1', noCrm, 50);
    expect(contactJourneySchema.parse(journey)).toEqual(journey);
    expect(journey.merged_visitor_ids).toEqual(['v-phone']);
    expect(journey.tags).toEqual(['hot']);
    expect(journey.funnel_touches?.map((t) => [t.id, t.kind, t.site_id, t.ts])).toEqual([
      ['hit_1', 'entrance', SITE, new Date(T0).toISOString()],
      ['hit_2', 'action', SITE, new Date(T0 + MIN).toISOString()],
    ]);
    expect(journey.funnel_touches?.[0]).toMatchObject({
      traffic_source_id: 'ts_paid',
      campaign: 'cmp_1',
      external_click_id: 'fbclid-1',
      visitor_id: 'v-phone',
    });

    const limited = await contactJourney(ns as unknown as AnalyticsNamespace, TENANT, 'ct_1', noCrm, 1);
    expect(limited.funnel_touches?.map((t) => t.id)).toEqual(['hit_2']);
  });

  it('returns empty identity extras for a contact without funnel data', async () => {
    const { ns, site } = setup();
    site.ingest([ev({ vid: 'v1', sid: 's1', ts: T0 })], []);
    site.applyCrmFacts([{ kind: 'link', id: 'l1', contactId: 'ct_2', visitorId: 'v1', source: 'form', ts: T0 + MIN }]);
    ns.store(`tenant:${TENANT}`).registerLinks([
      { siteId: SITE, visitorId: 'v1', contactId: 'ct_2', linkedAt: T0 + MIN, source: 'form' },
    ]);
    const journey = await contactJourney(ns as unknown as AnalyticsNamespace, TENANT, 'ct_2', noCrm, 50);
    expect(journey).toMatchObject({ merged_visitor_ids: [], funnel_touches: [], tags: [] });
    expect(contactJourneySchema.safeParse(journey).success).toBe(true);
  });
});

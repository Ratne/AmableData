import {
  AD_PARAM_NAMES,
  ANALYTICS_EVENT_TYPES,
  SOURCE_PARAM_NAMES,
  trackerEventSchema,
} from '@amable/api-types';
import { SOURCE_PARAMS, type EventPayload, type EventType } from '../src/protocol';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type SchemaInput = z.input<typeof trackerEventSchema>;

// The tracker bundle cannot import zod: these fail to compile when the two definitions drift apart.
const payloadFitsSchema: EventPayload extends SchemaInput ? true : false = true;
const sameFields: Equal<keyof EventPayload, keyof SchemaInput> = true;
const sameEventTypes: Equal<EventType, (typeof ANALYTICS_EVENT_TYPES)[number]> = true;

describe('tracker protocol', () => {
  it('matches the ingest schema', () => {
    expect([payloadFitsSchema, sameFields, sameEventTypes]).toEqual([true, true, true]);
    const payload: EventPayload = {
      type: 'pageview',
      site: 'site_1',
      url: 'https://example.com/',
      vw: 1280,
      vh: 800,
      sw: 1440,
      sh: 900,
      dl: { f: 'fg_1', n: 'lander' },
      la: { sl: 'news' },
    };
    expect(trackerEventSchema.parse(payload)).toEqual(payload);
  });

  it('captures the same source params the ingest accepts, ad ids included', () => {
    expect([...SOURCE_PARAMS]).toEqual([...SOURCE_PARAM_NAMES]);
    for (const name of AD_PARAM_NAMES) expect(SOURCE_PARAMS).toContain(name);
  });
});

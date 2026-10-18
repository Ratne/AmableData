import {
  trafficSourceInputSchema,
  type CustomTrackingField,
  type TrafficSource,
  type TrafficSourceInput,
} from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import {
  addField,
  conversionMode,
  fieldToken,
  isRemovable,
  nextFreeSlot,
  removeField,
  setConversionMode,
  sourceIssues,
  toDraft,
  toSourceInput,
  updateField,
  updateReserved,
  urlParamError,
  urlParamErrors,
} from '../src/features/analytics/sources/tracking-fields';

const T0 = Date.UTC(2026, 9, 15, 10);

function field(n: number, name = `f${String(n)}`): CustomTrackingField {
  return { slot: `c${String(n)}` as `c${number}`, name, url_param: name, source_token: '', append: true };
}

const template: TrafficSourceInput = {
  name: 'Social ads',
  category: 'Social',
  template: 'meta',
  reserved_fields: {
    campaign: { url_param: 'campaign', source_token: '{{campaign.id}}' },
    external: { url_param: 'fbclid', source_token: '', append: false },
  },
  fields: [field(1, 'adset'), field(2, 'ad')],
  conversion: { platform: 'meta', mapping: [{ event: 'sale', platform_event: 'Purchase' }] },
};

describe('tracking fields editor', () => {
  it('finds the lowest free slot and reports a full table', () => {
    expect(nextFreeSlot([])).toBe('c1');
    expect(nextFreeSlot([field(1), field(3)])).toBe('c2');
    const all = Array.from({ length: 20 }, (_, i) => field(i + 1));
    expect(nextFreeSlot(all)).toBeNull();
    expect(addField(all)).toHaveLength(20);
  });

  it('adds fields in the free slot, ordered by slot, with a unique URL parameter', () => {
    const fields = addField([field(1), field(3, 'c2')]);
    expect(fields.map((f) => f.slot)).toEqual(['c1', 'c2', 'c3']);
    const added = fields.find((f) => f.slot === 'c2');
    expect(added).toMatchObject({ name: 'c2', source_token: '', append: true });
    // `c2` is already the URL parameter of the c3 field.
    expect(added?.url_param).toBe('c2_2');
  });

  it('removes and renames custom fields without touching previous_name', () => {
    const stored = [{ ...field(1, 'adset'), previous_name: 'adgroup' }, field(2)];
    const renamed = updateField(stored, 'c1', { name: 'ad_set' });
    expect(renamed[0]).toMatchObject({ name: 'ad_set', previous_name: 'adgroup' });
    expect(removeField(renamed, 'c1').map((f) => f.slot)).toEqual(['c2']);
  });

  it('keeps the reserved fields: never removable, only URL parameter / token editable', () => {
    expect(isRemovable('campaign')).toBe(false);
    expect(isRemovable('external')).toBe(false);
    expect(isRemovable('c1')).toBe(true);
    const draft = updateReserved(toDraft(template), 'external', { url_param: 'click_id', source_token: '{clickid}' });
    expect(draft.reserved_fields.external).toEqual({
      url_param: 'click_id',
      source_token: '{clickid}',
      append: false,
    });
    expect(draft.reserved_fields.campaign.url_param).toBe('campaign');
    expect(fieldToken('external')).toBe('{external}');
    expect(fieldToken(field(4, 'keyword'))).toBe('{data-keyword}');
  });

  it('validates URL parameters, reserved ones included', () => {
    expect(urlParamError('utm_source', [])).toBeNull();
    expect(urlParamError('has space', [])).toBe('invalid');
    expect(urlParamError('', [])).toBe('invalid');
    expect(urlParamError('vid', [])).toBe('reserved');
    expect(urlParamError('TS', [])).toBe('reserved');
    expect(urlParamError('Campaign', ['campaign'])).toBe('duplicate');

    const draft = updateReserved(toDraft(template), 'campaign', { url_param: 'n' });
    draft.fields = [...draft.fields, field(3, 'fbclid')];
    const errors = urlParamErrors(draft);
    expect(errors.get('reserved_fields.campaign.url_param')).toBe('reserved');
    expect(errors.get('fields.2.url_param')).toBe('duplicate');
    expect(errors.has('reserved_fields.external.url_param')).toBe(false);
    // The API schema agrees and reports the same paths.
    const issues = sourceIssues(draft);
    expect(issues.has('reserved_fields.campaign.url_param')).toBe(true);
    expect(issues.has('fields.2.url_param')).toBe(true);
  });

  it('round-trips a template and a stored source into a valid API body', () => {
    const body = toSourceInput(toDraft(template));
    expect(trafficSourceInputSchema.safeParse(body).success).toBe(true);
    expect(body.fields?.map((f) => f.slot)).toEqual(['c1', 'c2']);

    const stored: TrafficSource = {
      ...trafficSourceInputSchema.parse(template),
      fields: [{ ...field(1, 'adset'), previous_name: 'adgroup' }],
      id: 'ts_1',
      status: 'active',
      created_at: T0,
      updated_at: T0,
    };
    const input = toSourceInput(toDraft(stored));
    expect(input).not.toHaveProperty('id');
    expect(input).not.toHaveProperty('status');
    expect(input.fields?.[0]?.previous_name).toBe('adgroup');
    expect(trafficSourceInputSchema.safeParse(input).success).toBe(true);
    expect(sourceIssues(toDraft(stored)).size).toBe(0);
  });

  it('switches conversion delivery modes exclusively', () => {
    const conversion = toDraft(template).conversion;
    expect(conversionMode(conversion)).toBe('integration');
    const postback = setConversionMode({ ...conversion, ad_connection_id: 'ac_1' }, 'postback');
    expect(postback).toMatchObject({ postback_url: '', ad_connection_id: null, mapping: [] });
    expect(conversionMode({ ...postback, postback_url: 'https://x.example/pb?c={external}' })).toBe('postback');
    expect(setConversionMode(postback, 'none')).toEqual({
      postback_url: null,
      ad_connection_id: null,
      platform: null,
      mapping: [],
    });
    expect(setConversionMode({ ...postback, postback_url: 'https://x.example' }, 'integration').postback_url).toBeNull();
    // An empty postback URL is sent as null.
    const draft = toDraft(template);
    draft.conversion = postback;
    expect(toSourceInput(draft).conversion?.postback_url).toBeNull();
  });
});

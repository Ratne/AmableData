import type { TrafficSource } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import {
  changeAttr,
  changeOp,
  fieldNames,
  graphTags,
  operatorsFor,
  staticOptions,
  valueEditorFor,
  weekdayOptions,
} from '../src/features/analytics/funnel-builder/condition-ui';

const ctx = {
  locale: 'en',
  sources: [
    { id: 'ts_1', name: 'Meta', status: 'active', fields: [{ name: 'adset' }, { name: 'ad' }] },
    { id: 'ts_2', name: 'Old', status: 'archived', fields: [{ name: 'adset' }] },
  ] as unknown as TrafficSource[],
  deviceLabel: (d: string) => d.toUpperCase(),
  archivedLabel: 'archived',
};

describe('condition operators', () => {
  it('offers only the operators that make sense for the attribute', () => {
    expect(operatorsFor('device')).toEqual(['is', 'is_not', 'exists', 'not_exists']);
    expect(operatorsFor('hour')).toEqual(['is', 'is_not', 'gt', 'lt', 'between']);
    expect(operatorsFor('field:adset')).toHaveLength(10);
    expect(operatorsFor('referrer')).toContain('contains');
  });

  it('keeps a stored operator outside the subset listed', () => {
    expect(operatorsFor('device', 'contains')).toEqual(['is', 'is_not', 'contains', 'exists', 'not_exists']);
  });
});

describe('value editors', () => {
  it('picks from known lists for categorical attributes', () => {
    expect(valueEditorFor('device', 'is')).toEqual({ kind: 'options', set: 'device', custom: false, single: false });
    expect(valueEditorFor('os', 'is_not')).toMatchObject({ kind: 'options', set: 'os', custom: true });
    expect(valueEditorFor('country', 'is')).toMatchObject({ kind: 'options', set: 'country' });
    expect(valueEditorFor('traffic_source', 'is')).toMatchObject({ kind: 'options', set: 'traffic_source' });
  });

  it('suggests site values for tags, cities, regions and campaigns', () => {
    for (const attr of ['tag', 'city', 'region', 'campaign'] as const) {
      expect(valueEditorFor(attr, 'is')).toEqual({ kind: 'suggest', attr });
    }
    expect(valueEditorFor('city', 'contains')).toEqual({ kind: 'suggest', attr: 'city' });
  });

  it('handles clock, numeric, free text and valueless operators', () => {
    expect(valueEditorFor('hour', 'between')).toEqual({ kind: 'range', set: 'hour' });
    expect(valueEditorFor('weekday', 'gt')).toMatchObject({ kind: 'options', set: 'weekday', single: true });
    expect(valueEditorFor('field:x', 'lt')).toEqual({ kind: 'number' });
    expect(valueEditorFor('field:x', 'between')).toEqual({ kind: 'range', set: null });
    expect(valueEditorFor('referrer', 'is')).toEqual({ kind: 'free' });
    expect(valueEditorFor('country', 'exists')).toEqual({ kind: 'none' });
  });
});

describe('rule edits', () => {
  it('resets values and an unsupported operator when the attribute changes', () => {
    expect(changeAttr({ attr: 'country', op: 'is', values: ['IT'] }, 'device')).toEqual({
      attr: 'device',
      op: 'is',
      values: [],
    });
    expect(changeAttr({ attr: 'city', op: 'contains', values: ['ro'] }, 'device').op).toBe('is');
  });

  it('keeps values while the editor stays the same', () => {
    expect(changeOp({ attr: 'country', op: 'is', values: ['IT'] }, 'is_not').values).toEqual(['IT']);
    expect(changeOp({ attr: 'hour', op: 'is', values: ['9'] }, 'between').values).toEqual([]);
  });
});

describe('options', () => {
  it('builds weekday numbers the engine compares (Monday = 1)', () => {
    const days = weekdayOptions('en');
    expect(days[0]).toMatchObject({ value: '1', label: 'Monday' });
    expect(days[6]).toMatchObject({ value: '7', label: 'Sunday' });
  });

  it('lists devices, countries with ISO codes and traffic sources by name', () => {
    expect(staticOptions('device', ctx).map((o) => o.value)).toEqual(['desktop', 'mobile', 'tablet']);
    expect(staticOptions('country', ctx).find((o) => o.value === 'IT')?.label).toBe('Italy');
    expect(staticOptions('traffic_source', ctx)).toEqual([
      { value: 'ts_1', label: 'Meta', keywords: ['ts_1'] },
      { value: 'ts_2', label: 'Old', hint: 'archived', keywords: ['ts_2'] },
    ]);
    expect(staticOptions('hour', ctx)).toHaveLength(24);
  });

  it('collects field names and draft tags', () => {
    expect(fieldNames(ctx.sources)).toEqual(['ad', 'adset']);
    expect(
      graphTags({
        nodes: [
          { id: 'a', kind: 'tag', position: { x: 0, y: 0 }, config: { add: ['lead'], remove: ['cold'] } },
          { id: 'b', kind: 'tag', position: { x: 0, y: 0 }, deleted_at: 1, config: { add: ['gone'], remove: [] } },
        ],
      }),
    ).toEqual(['lead', 'cold']);
  });
});

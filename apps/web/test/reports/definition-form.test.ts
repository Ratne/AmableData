import {
  createCustomReportSchema,
  REPORT_SOURCE_SPECS,
  type CustomReport,
} from '@amable/api-types/reports';
import { describe, expect, it } from 'vitest';
import {
  changeSource,
  emptyForm,
  formFromReport,
  formToPayload,
  toggleMeasure,
  validateForm,
  type ReportFormState,
} from '../../src/features/reports/lib/definition-form';
import {
  emptyGroup,
  fieldCondition,
  tagCondition,
  type FieldKind,
  type UiGroup,
} from '../../src/features/search/query-model';

const kinds = new Map<string, FieldKind>([
  ['email', 'text'],
  ['score_value', 'number'],
]);

function filterWithEmailAndTag(): UiGroup {
  const group = emptyGroup('and');
  return {
    ...group,
    conditions: [
      { ...fieldCondition('email', 'contains'), value: '@example.com' },
      { ...fieldCondition('score_value', 'gt'), value: '' },
      { ...tagCondition('any'), tagIds: ['tag_1'] },
    ],
  };
}

describe('report definition form → API payload', () => {
  it('maps every field to a valid POST /customReports body', () => {
    const state: ReportFormState = {
      ...emptyForm('orders'),
      name: '  Big EU orders  ',
      description: ' ',
      chart: 'bar',
      shared: false,
      measures: ['revenue', 'count'],
      dimension: 'status',
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-03-31',
      compare: 'previous_year',
      currency: 'eur',
      limit: 25,
      params: { ignored: 'x' },
      filter: filterWithEmailAndTag(),
    };
    const payload = formToPayload(state, kinds);
    expect(payload).toEqual({
      name: 'Big EU orders',
      description: null,
      chart: 'bar',
      shared: false,
      definition: {
        source: 'orders',
        measures: ['revenue', 'count'],
        dimension: 'status',
        granularity: 'month',
        filter: {
          type: 'group',
          op: 'and',
          conditions: [
            { type: 'field', field: 'email', operator: 'contains', value: '@example.com' },
            { type: 'tags', match: 'any', tag_ids: ['tag_1'] },
          ],
        },
        date_range: { from: '2026-01-01', to: '2026-03-31' },
        compare: 'previous_year',
        currency: 'EUR',
        limit: 25,
      },
    });
    expect(createCustomReportSchema.safeParse(payload).success).toBe(true);
  });

  it('drops the filter, currency and unknown params for sources that do not support them', () => {
    const state: ReportFormState = {
      ...changeSource({ ...emptyForm('orders'), filter: filterWithEmailAndTag() }, 'broadcasts'),
      name: 'Broadcasts',
      currency: 'USD',
      preset: 'last_90_days',
      params: { broadcast_id: 'b1' },
    };
    const { definition } = formToPayload(state, kinds);
    expect(definition.filter).toBeUndefined();
    expect(definition.currency).toBeUndefined();
    expect(definition.params).toBeUndefined();
    expect(definition.date_range).toEqual({ preset: 'last_90_days' });

    const links = formToPayload(
      { ...changeSource(state, 'broadcast_links'), params: { broadcast_id: 'b1', other: 'z' } },
      kinds,
    );
    expect(links.definition.params).toEqual({ broadcast_id: 'b1' });
  });

  it('keeps supported measures and dimension when switching source and caps measures at 8', () => {
    const orders: ReportFormState = {
      ...emptyForm('orders'),
      measures: ['revenue', 'count'],
      dimension: 'date',
    };
    const payments = changeSource(orders, 'payments');
    expect(payments.measures).toEqual(['count']);
    expect(payments.dimension).toBe('date');
    const receivables = changeSource(orders, 'receivables');
    expect(receivables.measures).toEqual(['count']);
    expect(receivables.dimension).toBe(REPORT_SOURCE_SPECS.receivables.dimensions[0]);

    let subs: ReportFormState = { ...emptyForm('subscriptions'), measures: [] };
    for (const m of Object.keys(REPORT_SOURCE_SPECS.subscriptions.measures))
      subs = toggleMeasure(subs, m);
    expect(subs.measures).toHaveLength(8);
    expect(toggleMeasure(subs, 'mrr').measures).not.toContain('mrr');
  });

  it('reports missing name, measures and incomplete custom ranges', () => {
    expect(
      validateForm({ ...emptyForm(), measures: [], preset: 'custom', from: '2026-01-01' }),
    ).toEqual(['name', 'measures', 'range']);
    expect(validateForm({ ...emptyForm(), name: 'x' })).toEqual([]);
  });

  it('round-trips a stored custom report through the form', () => {
    const stored: CustomReport = {
      id: 'cr_1',
      name: 'MRR by plan, EU',
      description: 'Only EU',
      chart: 'line',
      shared: true,
      owner_id: 'u1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      definition: {
        source: 'subscriptions',
        measures: ['mrr', 'active'],
        dimension: 'plan',
        granularity: 'week',
        filter: {
          type: 'group',
          op: 'or',
          conditions: [{ type: 'field', field: 'email', operator: 'ends_with', value: '.eu' }],
        },
        date_range: { preset: 'this_year' },
        compare: 'previous_period',
        limit: 50,
      },
    };
    const payload = formToPayload(formFromReport(stored), kinds);
    expect(payload.definition).toEqual(stored.definition);
    expect(payload).toMatchObject({
      name: stored.name,
      description: 'Only EU',
      chart: 'line',
      shared: true,
    });
  });
});

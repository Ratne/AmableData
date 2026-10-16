import {
  updateDashboardSchema,
  type DashboardWidget,
  type WidgetLayout,
} from '@amable/api-types/reports';
import { describe, expect, it } from 'vitest';
import {
  clampLayout,
  collides,
  compact,
  freeSlot,
  parseWidgets,
  placeWidget,
  serializeWidgets,
  widgetId,
} from '../../src/features/reports/lib/layout';
import { widgetFormFrom, widgetFromForm } from '../../src/features/reports/lib/widget-form';

function widget(
  id: string,
  layout: WidgetLayout,
  extra: Partial<DashboardWidget> = {},
): DashboardWidget {
  return { id, type: 'kpi', title: null, report_id: 'sales_monthly', layout, ...extra };
}

const at = (widgets: readonly DashboardWidget[], id: string) =>
  widgets.find((w) => w.id === id)?.layout;

function noOverlaps(widgets: readonly DashboardWidget[]): boolean {
  return widgets.every((a, i) => widgets.every((b, j) => i === j || !collides(a.layout, b.layout)));
}

describe('widget layout serialization', () => {
  it('orders by position, clamps layouts, trims titles and drops empty lists; the result is a valid PATCH body', () => {
    const widgets = [
      widget('b', { x: 10, y: 4, w: 6, h: 20 }, { title: '  Revenue  ', measures: [] }),
      widget('a', { x: 0, y: 0, w: 3, h: 2 }, { title: '   ', overrides: {} }),
      widget(
        'c',
        { x: 3, y: 0, w: 3, h: 2 },
        { measures: ['mrr'], overrides: { compare: 'previous_period' } },
      ),
    ];
    const out = serializeWidgets(widgets);
    expect(out.map((w) => w.id)).toEqual(['a', 'c', 'b']);
    expect(out[0]).toEqual({
      id: 'a',
      type: 'kpi',
      title: null,
      report_id: 'sales_monthly',
      layout: { x: 0, y: 0, w: 3, h: 2 },
    });
    expect(out[1]).toMatchObject({ measures: ['mrr'], overrides: { compare: 'previous_period' } });
    // x + w never exceeds the 12 columns and h is capped at 12 rows.
    expect(out[2]).toEqual({
      id: 'b',
      type: 'kpi',
      title: 'Revenue',
      report_id: 'sales_monthly',
      layout: { x: 6, y: 4, w: 6, h: 12 },
    });
    expect(updateDashboardSchema.safeParse({ widgets: out }).success).toBe(true);
  });

  it('round-trips through JSON and drops invalid entries when parsing', () => {
    const widgets = [
      widget('k1', { x: 0, y: 0, w: 3, h: 2 }),
      widget('l1', { x: 0, y: 2, w: 6, h: 4 }, { type: 'line' }),
    ];
    const json = JSON.parse(JSON.stringify(serializeWidgets(widgets))) as unknown;
    expect(parseWidgets(json)).toEqual(serializeWidgets(widgets));
    expect(parseWidgets([{ id: 'bad id!', type: 'kpi' }, ...(json as unknown[])])).toHaveLength(2);
    expect(parseWidgets('nope')).toEqual([]);
  });

  it('resolves overlapping stored layouts on parse', () => {
    const parsed = parseWidgets([
      widget('a', { x: 0, y: 0, w: 6, h: 2 }),
      widget('b', { x: 2, y: 1, w: 6, h: 2 }),
    ]);
    expect(noOverlaps(parsed)).toBe(true);
    expect(at(parsed, 'b')).toEqual({ x: 2, y: 2, w: 6, h: 2 });
  });
});

describe('widget layout editing', () => {
  const base = [
    widget('a', { x: 0, y: 0, w: 6, h: 2 }),
    widget('b', { x: 6, y: 0, w: 6, h: 2 }),
    widget('c', { x: 0, y: 2, w: 12, h: 4 }),
  ];

  it('pushes overlapped widgets down and compacts the grid', () => {
    const moved = placeWidget(base, 'c', { x: 0, y: 0, w: 12, h: 4 });
    expect(at(moved, 'c')).toEqual({ x: 0, y: 0, w: 12, h: 4 });
    expect(at(moved, 'a')).toEqual({ x: 0, y: 4, w: 6, h: 2 });
    expect(at(moved, 'b')).toEqual({ x: 6, y: 4, w: 6, h: 2 });
    expect(noOverlaps(moved)).toBe(true);
  });

  it('swaps a widget dragged below the one under it', () => {
    const stacked = [
      widget('a', { x: 0, y: 0, w: 6, h: 2 }),
      widget('b', { x: 0, y: 2, w: 6, h: 2 }),
    ];
    const moved = placeWidget(stacked, 'a', { x: 0, y: 3, w: 6, h: 2 });
    expect(at(moved, 'b')).toEqual({ x: 0, y: 0, w: 6, h: 2 });
    expect(at(moved, 'a')).toEqual({ x: 0, y: 2, w: 6, h: 2 });
  });

  it('clamps resizes to the grid and keeps the widget inside the columns', () => {
    const resized = placeWidget(base, 'b', { x: 6, y: 0, w: 9, h: 0 });
    expect(at(resized, 'b')).toEqual({ x: 3, y: 0, w: 9, h: 1 });
    expect(noOverlaps(resized)).toBe(true);
    expect(clampLayout({ x: -3, y: -1, w: 40, h: 99 })).toEqual({ x: 0, y: 0, w: 12, h: 12 });
  });

  it('compacts gaps upwards', () => {
    const gappy = compact([
      widget('a', { x: 0, y: 5, w: 4, h: 2 }),
      widget('b', { x: 4, y: 9, w: 4, h: 2 }),
    ]);
    expect(at(gappy, 'a')?.y).toBe(0);
    expect(at(gappy, 'b')?.y).toBe(0);
  });

  it('finds the first free slot and unique ids for new widgets', () => {
    expect(freeSlot(base, { w: 3, h: 2 })).toEqual({ x: 0, y: 6, w: 3, h: 2 });
    expect(freeSlot([widget('a', { x: 0, y: 0, w: 6, h: 2 })], { w: 6, h: 4 })).toEqual({
      x: 6,
      y: 0,
      w: 6,
      h: 4,
    });
    expect(widgetId([widget('kpi_1', { x: 0, y: 0, w: 1, h: 1 })], 'kpi')).toBe('kpi_2');
  });

  it('builds widgets from the widget form, keeping unedited overrides', () => {
    const fresh = widgetFromForm(
      {
        ...widgetFormFrom(null, 'subscription_mrr'),
        measures: ['mrr'],
        preset: 'this_month',
        compare: 'previous_period',
      },
      null,
      base,
    );
    expect(fresh).toEqual({
      id: 'kpi_1',
      type: 'kpi',
      title: null,
      report_id: 'subscription_mrr',
      measures: ['mrr'],
      overrides: {
        date_range: { preset: 'this_month' },
        compare: 'previous_period',
        dimension: null,
      },
      layout: { x: 0, y: 6, w: 3, h: 2 },
    });
    const existing = widget(
      't',
      { x: 0, y: 0, w: 12, h: 4 },
      {
        type: 'kpi',
        overrides: { dimension: null, params: { site_id: 's1' }, limit: 5 },
      },
    );
    const edited = widgetFromForm(
      { ...widgetFormFrom(existing), type: 'table', limit: '' },
      existing,
      [],
    );
    expect(edited.overrides).toEqual({ params: { site_id: 's1' } });
    expect(edited.layout).toEqual(existing.layout);
  });
});

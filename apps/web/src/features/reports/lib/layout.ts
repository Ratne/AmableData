import {
  dashboardWidgetSchema,
  GRID_COLUMNS,
  type DashboardWidget,
  type WidgetLayout,
} from '@amable/api-types/reports';

/**
 * Pure layout math of the widget grid (12 columns, unit rows): clamping,
 * collision push-down, vertical compaction, free-slot search and the
 * serialization sent to `PATCH /dashboards/{id}`.
 */

export const MAX_ROWS_PER_WIDGET = 12;
export const MAX_Y = 1000;

/** Default size of a new widget per type. */
export const DEFAULT_SIZE: Readonly<Record<DashboardWidget['type'], { w: number; h: number }>> = {
  kpi: { w: 3, h: 2 },
  line: { w: 6, h: 4 },
  bar: { w: 6, h: 4 },
  table: { w: 12, h: 4 },
  funnel: { w: 4, h: 4 },
};

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** A layout inside the grid bounds the API accepts. */
export function clampLayout(layout: WidgetLayout): WidgetLayout {
  const w = clampInt(layout.w, 1, GRID_COLUMNS);
  return {
    w,
    h: clampInt(layout.h, 1, MAX_ROWS_PER_WIDGET),
    x: clampInt(layout.x, 0, GRID_COLUMNS - w),
    y: clampInt(layout.y, 0, MAX_Y),
  };
}

export function collides(a: WidgetLayout, b: WidgetLayout): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function byPosition(a: DashboardWidget, b: DashboardWidget): number {
  return a.layout.y - b.layout.y || a.layout.x - b.layout.x;
}

/** Moves every widget up as far as it goes without overlapping the ones above it. */
export function compact(widgets: readonly DashboardWidget[]): DashboardWidget[] {
  const placed: DashboardWidget[] = [];
  for (const widget of [...widgets].sort(byPosition)) {
    let layout = { ...widget.layout, y: 0 };
    while (placed.some((p) => collides(p.layout, layout))) layout = { ...layout, y: layout.y + 1 };
    placed.push({ ...widget, layout });
  }
  return placed;
}

/**
 * Places `id` at `next` (clamped), moves the widgets it now overlaps out of
 * the way (above when they started above it and fit, else below), then compacts.
 */
export function placeWidget(
  widgets: readonly DashboardWidget[],
  id: string,
  next: WidgetLayout,
): DashboardWidget[] {
  const target = widgets.find((w) => w.id === id);
  if (target === undefined) return [...widgets];
  const moved = { ...target, layout: clampLayout(next) };
  const placed: DashboardWidget[] = [moved];
  for (const widget of widgets.filter((w) => w.id !== id).sort(byPosition)) {
    let layout = widget.layout;
    if (collides(layout, moved.layout) && layout.y < moved.layout.y) {
      // Dragging a widget down over one that started above it swaps them.
      const above = { ...layout, y: moved.layout.y - layout.h };
      if (above.y >= 0 && !placed.some((p) => collides(p.layout, above))) layout = above;
    }
    while (placed.some((p) => collides(p.layout, layout))) layout = { ...layout, y: layout.y + 1 };
    placed.push({ ...widget, layout });
  }
  return compact(placed);
}

/** Grid cells moved by a pointer delta in pixels. */
export function cellsFromDelta(
  dx: number,
  dy: number,
  cell: { width: number; height: number },
): { dx: number; dy: number } {
  return {
    dx: cell.width > 0 ? Math.round(dx / cell.width) : 0,
    dy: cell.height > 0 ? Math.round(dy / cell.height) : 0,
  };
}

/** First free slot of a `w`×`h` widget, scanning rows top to bottom. */
export function freeSlot(
  widgets: readonly DashboardWidget[],
  size: { w: number; h: number },
): WidgetLayout {
  const w = clampInt(size.w, 1, GRID_COLUMNS);
  const h = clampInt(size.h, 1, MAX_ROWS_PER_WIDGET);
  for (let y = 0; y <= MAX_Y; y += 1) {
    for (let x = 0; x + w <= GRID_COLUMNS; x += 1) {
      const candidate = { x, y, w, h };
      if (!widgets.some((widget) => collides(widget.layout, candidate))) return candidate;
    }
  }
  return { x: 0, y: MAX_Y, w, h };
}

export function gridHeight(widgets: readonly DashboardWidget[]): number {
  return widgets.reduce((max, w) => Math.max(max, w.layout.y + w.layout.h), 0);
}

/**
 * Widgets as persisted: ordered by position, layouts clamped, titles trimmed
 * (empty = null), empty measure lists dropped; validated against the API schema.
 */
export function serializeWidgets(widgets: readonly DashboardWidget[]): DashboardWidget[] {
  return [...widgets].sort(byPosition).map((widget) => {
    const title = widget.title?.trim() ?? '';
    const out: DashboardWidget = {
      id: widget.id,
      type: widget.type,
      title: title === '' ? null : title,
      report_id: widget.report_id,
      layout: clampLayout(widget.layout),
    };
    if (widget.measures !== undefined && widget.measures.length > 0)
      out.measures = [...widget.measures];
    if (widget.overrides !== undefined && Object.keys(widget.overrides).length > 0)
      out.overrides = widget.overrides;
    return dashboardWidgetSchema.parse(out);
  });
}

/** Widgets read back from the API (or any JSON): invalid entries are dropped, overlaps resolved. */
export function parseWidgets(raw: unknown): DashboardWidget[] {
  if (!Array.isArray(raw)) return [];
  const valid: DashboardWidget[] = [];
  for (const item of raw) {
    const parsed = dashboardWidgetSchema.safeParse(item);
    if (parsed.success) valid.push(parsed.data);
  }
  return compact(valid);
}

/** Widget id unique within the dashboard. */
export function widgetId(widgets: readonly DashboardWidget[], type: string): string {
  const taken = new Set(widgets.map((w) => w.id));
  for (let n = 1; ; n += 1) {
    const id = `${type}_${String(n)}`;
    if (!taken.has(id)) return id;
  }
}

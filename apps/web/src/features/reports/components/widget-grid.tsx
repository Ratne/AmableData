import { GRID_COLUMNS, type DashboardWidget, type WidgetLayout } from '@amable/api-types/reports';
import { cn } from '@amable/ui';
import { GripVertical, MoveDiagonal2 } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '../../../i18n';
import { cellsFromDelta, gridHeight, placeWidget } from '../lib/layout';

const ROW_HEIGHT = 72;
const GAP = 12;
/** Below this width the grid stacks widgets in one column (layout untouched). */
const STACK_BELOW = 640;

interface DragState {
  readonly id: string;
  readonly mode: 'move' | 'resize';
  readonly startX: number;
  readonly startY: number;
  readonly origin: WidgetLayout;
}

export interface WidgetGridProps {
  readonly widgets: readonly DashboardWidget[];
  readonly editing: boolean;
  /** Called once per drop / resize end with the new compacted layout. */
  readonly onLayoutChange: (widgets: DashboardWidget[]) => void;
  readonly renderWidget: (widget: DashboardWidget) => ReactNode;
}

export function WidgetGrid({ widgets, editing, onLayoutChange, renderWidget }: WidgetGridProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [preview, setPreview] = useState<DashboardWidget[] | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? node.clientWidth);
    });
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  const shown = preview ?? widgets;
  const stacked = width > 0 && width < STACK_BELOW;
  const colWidth = width > 0 ? (width - GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS : 0;

  const start = (
    event: ReactPointerEvent<HTMLElement>,
    widget: DashboardWidget,
    mode: DragState['mode'],
  ) => {
    if (!editing || stacked || event.button !== 0) return;
    event.preventDefault();
    setDrag({
      id: widget.id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      origin: widget.layout,
    });
  };

  const latest = useRef({ widgets, preview, onLayoutChange, colWidth });
  latest.current = { widgets, preview, onLayoutChange, colWidth };

  // Window listeners keep the drag alive when the pointer leaves the small handle.
  useEffect(() => {
    if (drag === null) return;
    const move = (event: PointerEvent) => {
      const { widgets: current, colWidth: cw } = latest.current;
      const delta = cellsFromDelta(event.clientX - drag.startX, event.clientY - drag.startY, {
        width: cw + GAP,
        height: ROW_HEIGHT + GAP,
      });
      const o = drag.origin;
      const next =
        drag.mode === 'move'
          ? { ...o, x: o.x + delta.dx, y: Math.max(0, o.y + delta.dy) }
          : { ...o, w: Math.min(GRID_COLUMNS - o.x, o.w + delta.dx), h: o.h + delta.dy };
      setPreview(placeWidget(current, drag.id, next));
    };
    const end = () => {
      const { preview: last, onLayoutChange: commit } = latest.current;
      if (last !== null) commit(last);
      setDrag(null);
      setPreview(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [drag]);

  if (stacked) {
    return (
      <div ref={ref} className="grid gap-3" data-testid="widget-grid">
        {[...widgets]
          .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
          .map((widget) => (
            <div key={widget.id} style={{ height: widget.layout.h * ROW_HEIGHT }}>
              {renderWidget(widget)}
            </div>
          ))}
      </div>
    );
  }

  const rows = Math.max(gridHeight(shown), 1) + (editing ? 2 : 0);
  return (
    <div
      ref={ref}
      className={cn(
        'relative',
        editing &&
          'rounded-lg bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:24px_24px]',
      )}
      style={{ height: rows * ROW_HEIGHT + (rows - 1) * GAP }}
      data-testid="widget-grid"
    >
      {width > 0
        ? shown.map((widget) => {
            const { x, y, w, h } = widget.layout;
            const active = drag?.id === widget.id;
            return (
              <div
                key={widget.id}
                data-widget-id={widget.id}
                className={cn(
                  'absolute transition-[left,top,width,height] duration-150',
                  active && 'z-10 opacity-90 shadow-lg transition-none',
                )}
                style={{
                  left: x * (colWidth + GAP),
                  top: y * (ROW_HEIGHT + GAP),
                  width: w * colWidth + (w - 1) * GAP,
                  height: h * ROW_HEIGHT + (h - 1) * GAP,
                }}
              >
                {renderWidget(widget)}
                {editing ? (
                  <>
                    <button
                      type="button"
                      aria-label={t('rep.dash.move')}
                      title={t('rep.dash.move')}
                      data-testid="widget-move"
                      className="absolute left-1.5 top-2.5 cursor-grab touch-none rounded p-0.5 text-muted-foreground hover:bg-muted active:cursor-grabbing"
                      onPointerDown={(e) => start(e, widget, 'move')}
                    >
                      <GripVertical className="size-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label={t('rep.dash.resize')}
                      title={t('rep.dash.resize')}
                      data-testid="widget-resize"
                      className="absolute bottom-0.5 right-0.5 cursor-nwse-resize touch-none rounded p-0.5 text-muted-foreground hover:bg-muted"
                      onPointerDown={(e) => start(e, widget, 'resize')}
                    >
                      <MoveDiagonal2 className="size-3.5" aria-hidden />
                    </button>
                  </>
                ) : null}
              </div>
            );
          })
        : null}
    </div>
  );
}

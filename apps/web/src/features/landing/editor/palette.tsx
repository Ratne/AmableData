import { cn } from '@amable/ui';
import { Input } from '@amable/ui/ui/input';
import { WIDGET_LIST, type WidgetDef } from '@amable/builder';
import { useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useBuilderLabel } from '../lib/builder-i18n';

const CATEGORY_ORDER = ['layout', 'basic', 'media', 'content', 'form'] as const;
type Category = (typeof CATEGORY_ORDER)[number];

function PaletteItem({
  def,
  label,
  disabled,
  onAdd,
  onStartDrag,
}: {
  def: WidgetDef;
  label: string;
  disabled?: boolean;
  onAdd: (type: string) => void;
  onStartDrag: (type: string) => void;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(e) => {
        if (disabled) return;
        start.current = { x: e.clientX, y: e.clientY };
        dragged.current = false;
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 6) {
          start.current = null;
          dragged.current = true;
          onStartDrag(def.type);
        }
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      onClick={() => {
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        onAdd(def.type);
      }}
      className={cn(
        'cursor-grab touch-none rounded-md border bg-background px-2 py-2 text-left text-xs transition select-none',
        'hover:border-primary hover:bg-muted active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50',
      )}
    >
      {label}
    </button>
  );
}

/** Widget palette grouped by category: click to add, drag onto the canvas to place. */
export function Palette({
  disabled,
  onAdd,
  onStartDrag,
}: {
  disabled?: boolean;
  onAdd: (type: string) => void;
  onStartDrag: (type: string) => void;
}) {
  const { t } = useI18n();
  const label = useBuilderLabel();
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const byCat = new Map<Category, WidgetDef[]>();
  for (const w of WIDGET_LIST) {
    // Popups are created from the popups manager, never dropped inline.
    if (w.type === 'popup') continue;
    if (needle && !label(w.title).toLowerCase().includes(needle) && !w.title.toLowerCase().includes(needle)) continue;
    const list = byCat.get(w.category) ?? [];
    list.push(w);
    byCat.set(w.category, list);
  }
  return (
    <div className="flex flex-col gap-3">
      <Input
        type="search"
        className="h-8 text-xs"
        placeholder={t('landing.editor.searchWidgets')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {CATEGORY_ORDER.filter((c) => byCat.has(c)).map((cat) => (
        <div key={cat}>
          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t(`landing.editor.category.${cat}`)}
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {(byCat.get(cat) ?? []).map((w) => (
              <PaletteItem key={w.type} def={w} label={label(w.title)} disabled={disabled} onAdd={onAdd} onStartDrag={onStartDrag} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

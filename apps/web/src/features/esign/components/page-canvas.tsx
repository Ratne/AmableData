import type { EsignField, EsignFieldType, EsignPage, EsignParty } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Calendar, CalendarCheck, CircleDot, Hash, ImageIcon, List, PenLine, Signature, SquareCheck, Type, type LucideIcon } from 'lucide-react';
import { useRef, type DragEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useI18n } from '../../../i18n';
import { clamp, MIN_SIZE, partyColor, round } from '../lib/fields';

export const FIELD_ICONS: Record<EsignFieldType, LucideIcon> = {
  signature: Signature,
  initials: PenLine,
  text: Type,
  number: Hash,
  date: Calendar,
  checkbox: SquareCheck,
  select: List,
  radio: CircleDot,
  image: ImageIcon,
  signed_date: CalendarCheck,
};

/** MIME type of palette items dragged onto a page. */
export const FIELD_DRAG_TYPE = 'application/x-amable-esign-field';

type Mode = 'move' | 'resize';

/**
 * One page of the template with its fields. Geometry is normalized to the
 * page (0..1), so the overlay works at whatever width the page is shown.
 */
export function PageCanvas({
  page,
  imageUrl,
  fields,
  parties,
  selectedId,
  armed,
  readOnly,
  onSelect,
  onChange,
  onPlace,
}: {
  page: EsignPage;
  imageUrl: string | null;
  fields: readonly EsignField[];
  parties: readonly EsignParty[];
  selectedId: string | null;
  armed: EsignFieldType | null;
  readOnly: boolean;
  onSelect: (id: string | null) => void;
  onChange: (field: EsignField) => void;
  onPlace: (type: EsignFieldType, page: EsignPage, cx: number, cy: number) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);

  const point = (clientX: number, clientY: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || rect.height === 0) return null;
    return { cx: clamp((clientX - rect.left) / rect.width, 0, 1), cy: clamp((clientY - rect.top) / rect.height, 0, 1) };
  };

  const startDrag = (event: ReactPointerEvent<HTMLElement>, field: EsignField, mode: Mode) => {
    if (readOnly || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    onSelect(field.id);
    const rect = ref.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const target = event.currentTarget;
    const origin = { x: event.clientX, y: event.clientY };
    target.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - origin.x) / rect.width;
      const dy = (ev.clientY - origin.y) / rect.height;
      if (mode === 'move') {
        onChange({ ...field, x: round(clamp(field.x + dx, 0, 1 - field.w)), y: round(clamp(field.y + dy, 0, 1 - field.h)) });
      } else {
        onChange({ ...field, w: round(clamp(field.w + dx, MIN_SIZE, 1 - field.x)), h: round(clamp(field.h + dy, MIN_SIZE, 1 - field.y)) });
      }
    };
    const stop = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      target.removeEventListener('pointercancel', stop);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
  };

  const click = (event: MouseEvent<HTMLDivElement>) => {
    if (armed === null || readOnly) {
      onSelect(null);
      return;
    }
    const at = point(event.clientX, event.clientY);
    if (at !== null) onPlace(armed, page, at.cx, at.cy);
  };

  const drop = (event: DragEvent<HTMLDivElement>) => {
    const type = event.dataTransfer.getData(FIELD_DRAG_TYPE) as EsignFieldType | '';
    if (type === '' || readOnly) return;
    event.preventDefault();
    const at = point(event.clientX, event.clientY);
    if (at !== null) onPlace(type, page, at.cx, at.cy);
  };

  return (
    <div
      ref={ref}
      role="presentation"
      className={cn('relative w-full overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-black/10', armed !== null && !readOnly && 'cursor-crosshair')}
      style={{ aspectRatio: `${String(page.width)} / ${String(page.height)}` }}
      onClick={click}
      onDragOver={(event) => {
        if (!readOnly && event.dataTransfer.types.includes(FIELD_DRAG_TYPE)) event.preventDefault();
      }}
      onDrop={drop}
    >
      {imageUrl !== null ? (
        <img src={imageUrl} alt={t('esign.editor.pageAlt', { page: page.index + 1 })} className="pointer-events-none absolute inset-0 size-full select-none" draggable={false} />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">{t('esign.editor.noImage')}</div>
      )}
      {fields.map((field) => {
        const color = partyColor(parties, field.party_id);
        const selected = field.id === selectedId;
        const Icon = FIELD_ICONS[field.type];
        return (
          <div
            key={field.id}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={`${field.label || t(`esign.fieldType.${field.type}`)} — ${parties.find((p) => p.id === field.party_id)?.name ?? field.party_id}`}
            className={cn(
              'absolute flex touch-none items-center gap-1 overflow-hidden rounded-[3px] border px-1 text-[11px] leading-tight select-none',
              readOnly ? 'cursor-default' : 'cursor-move',
              selected && 'ring-2 ring-offset-1',
            )}
            style={{
              left: `${String(field.x * 100)}%`,
              top: `${String(field.y * 100)}%`,
              width: `${String(field.w * 100)}%`,
              height: `${String(field.h * 100)}%`,
              borderColor: color,
              backgroundColor: `${color}26`,
              color,
              ['--tw-ring-color' as string]: color,
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(field.id);
            }}
            onFocus={() => onSelect(field.id)}
            onPointerDown={(event) => startDrag(event, field, 'move')}
          >
            <Icon className="size-3 shrink-0" aria-hidden />
            <span className="truncate font-medium">
              {field.label || t(`esign.fieldType.${field.type}`)}
              {field.required ? '*' : ''}
            </span>
            {selected && !readOnly ? (
              <span
                aria-hidden
                className="absolute right-0 bottom-0 size-2.5 cursor-se-resize rounded-tl-sm"
                style={{ backgroundColor: color }}
                onPointerDown={(event) => startDrag(event, field, 'resize')}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

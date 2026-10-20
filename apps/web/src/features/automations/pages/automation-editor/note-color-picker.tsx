import type { GraphNode } from '@amable/api-types';
import { cn } from '@amable/ui';
import { useI18n } from '../../../../i18n';
import { NOTE_COLOR_NAMES } from '../../components/canvas-nodes';

type NoteNode = Extract<GraphNode, { type: 'note' }>;

/** Side panel of a sticky note: its color swatches. */
export function NoteColorPicker({
  node,
  disabled,
  onChange,
}: {
  node: NoteNode;
  disabled: boolean;
  onChange: (node: GraphNode) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-2">
      <p className="text-xs font-medium text-muted-foreground">{t('auto.note.color')}</p>
      <div className="flex gap-1.5">
        {NOTE_COLOR_NAMES.map((color) => (
          <button
            key={color}
            type="button"
            disabled={disabled}
            aria-label={color}
            onClick={() => onChange({ ...node, color })}
            className={cn(
              'size-7 rounded-full border-2',
              {
                yellow: 'bg-yellow-200',
                blue: 'bg-sky-200',
                green: 'bg-emerald-200',
                pink: 'bg-pink-200',
              }[color],
              (node.color ?? 'yellow') === color ? 'border-primary' : 'border-transparent',
            )}
          />
        ))}
      </div>
    </div>
  );
}

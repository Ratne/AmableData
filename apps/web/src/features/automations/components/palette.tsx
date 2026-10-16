import { cn } from '@amable/ui';
import { Diamond, ListOrdered, StickyNote } from 'lucide-react';
import type { DragEvent, ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { GOAL_TYPES, type PaletteItem } from '../lib/defaults';
import { GoalIcon } from './node-icons';

export const PALETTE_MIME = 'application/x-amable-automation-node';

function Item({
  item,
  icon,
  label,
  tone,
  onAdd,
}: {
  item: PaletteItem;
  icon: ReactNode;
  label: string;
  tone: string;
  onAdd: (item: PaletteItem) => void;
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(event: DragEvent<HTMLButtonElement>) => {
        event.dataTransfer.setData(PALETTE_MIME, JSON.stringify(item));
        event.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onAdd(item)}
      className="flex w-full cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted active:cursor-grabbing"
      data-testid={`palette-${item.kind === 'goal' ? item.trigger : item.kind}`}
    >
      <span className={cn('flex size-5 shrink-0 items-center justify-center rounded', tone)}>
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** Left rail: goals (one item per trigger type) and the flow nodes, draggable or clickable. */
export function Palette({ onAdd }: { onAdd: (item: PaletteItem) => void }) {
  const { t } = useI18n();
  const goalTone = 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  return (
    <aside
      className="flex w-52 shrink-0 flex-col border-r bg-background"
      aria-label={t('auto.palette.hint')}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className="px-2 pt-1 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t('auto.palette.flow')}
        </p>
        <Item
          item={{ kind: 'sequence' }}
          icon={<ListOrdered className="size-3" />}
          label={t('auto.palette.sequence')}
          tone="bg-sky-500/15 text-sky-700 dark:text-sky-300"
          onAdd={onAdd}
        />
        <Item
          item={{ kind: 'decision' }}
          icon={<Diamond className="size-3" />}
          label={t('auto.palette.decision')}
          tone="bg-amber-500/15 text-amber-700 dark:text-amber-300"
          onAdd={onAdd}
        />
        <Item
          item={{ kind: 'note' }}
          icon={<StickyNote className="size-3" />}
          label={t('auto.palette.note')}
          tone="bg-yellow-400/20 text-yellow-700 dark:text-yellow-300"
          onAdd={onAdd}
        />
        <p className="px-2 pt-3 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t('auto.palette.goals')}
        </p>
        {GOAL_TYPES.map((type) => (
          <Item
            key={type}
            item={{ kind: 'goal', trigger: type }}
            icon={<GoalIcon type={type} className="size-3" />}
            label={t(`auto.goal.${type}`)}
            tone={goalTone}
            onAdd={onAdd}
          />
        ))}
      </div>
      <p className="border-t p-2 text-[10px] leading-snug text-muted-foreground">
        {t('auto.palette.hint')}
      </p>
    </aside>
  );
}

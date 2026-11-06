import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@amable/ui/ui/popover';
import { ClipboardList, GripVertical, Layers, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { clipAge, countNodes, type ClipEntry } from '../hooks/use-block-clipboard';

/**
 * Clipboard tray: the user's personal copies of the last 24 hours. Drag an
 * entry onto the canvas to drop it exactly where wanted, or click it to paste
 * after the selection (or at the end of the page).
 */
export function ClipboardTray({
  items,
  open,
  onOpenChange,
  highlightId,
  disabled,
  onPaste,
  onStartDrag,
  onRemove,
  onClear,
}: {
  items: readonly ClipEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Entry that was just copied: highlighted on top. */
  highlightId?: string | null;
  disabled?: boolean;
  onPaste: (entry: ClipEntry) => void;
  onStartDrag: (entry: ClipEntry) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant={open ? 'secondary' : 'outline'} size="sm" title={t('landing.clipboard.hint')}>
          <ClipboardList aria-hidden /> {t('landing.clipboard.button')}
          {items.length > 0 ? (
            <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground">
              {items.length}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2">
          <div className="text-sm font-medium">{t('landing.clipboard.title')}</div>
          <div className="text-[11px] text-muted-foreground">{t('landing.clipboard.subtitle')}</div>
        </div>
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">{t('landing.clipboard.empty')}</div>
        ) : (
          <ul className="max-h-80 overflow-y-auto py-1">
            {items.map((entry) => (
              <TrayRow
                key={entry.id}
                entry={entry}
                highlight={entry.id === highlightId}
                disabled={disabled}
                onPaste={() => onPaste(entry)}
                onStartDrag={() => onStartDrag(entry)}
                onRemove={() => onRemove(entry.id)}
              />
            ))}
          </ul>
        )}
        {items.length > 0 ? (
          <div className="flex items-center justify-between border-t px-3 py-1.5 text-[11px] text-muted-foreground">
            <span>{t('landing.clipboard.expires')}</span>
            <button type="button" className="font-medium text-destructive hover:underline" onClick={onClear}>
              {t('landing.clipboard.clear')}
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function TrayRow({
  entry,
  highlight,
  disabled,
  onPaste,
  onStartDrag,
  onRemove,
}: {
  entry: ClipEntry;
  highlight: boolean;
  disabled?: boolean;
  onPaste: () => void;
  onStartDrag: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const start = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const total = countNodes(entry.nodes);
  const age = clipAge(entry.createdAt);
  const meta = [
    entry.sourcePageName ? t('landing.editor.fromPage', { name: entry.sourcePageName }) : '',
    age,
    total > 1 ? t('landing.clipboard.elements', { count: total }) : '',
  ].filter(Boolean);

  return (
    <li className={cn('group flex items-center gap-1 px-2', highlight && 'bg-primary/10')}>
      <button
        type="button"
        disabled={disabled}
        title={t('landing.clipboard.rowHint')}
        className="flex min-w-0 flex-1 cursor-grab touch-none select-none items-center gap-2 rounded px-1 py-1.5 text-left hover:bg-muted active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50"
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
            onStartDrag();
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
          onPaste();
        }}
      >
        <GripVertical aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        {entry.wholePage ? <Layers aria-hidden className="size-3.5 shrink-0 text-primary" /> : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{entry.label}</span>
          {meta.length > 0 ? <span className="block truncate text-[11px] text-muted-foreground">{meta.join(' · ')}</span> : null}
        </span>
      </button>
      <button
        type="button"
        aria-label={t('landing.clipboard.remove')}
        title={t('landing.clipboard.remove')}
        className="rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
        onClick={onRemove}
      >
        <Trash2 aria-hidden className="size-3.5" />
      </button>
    </li>
  );
}

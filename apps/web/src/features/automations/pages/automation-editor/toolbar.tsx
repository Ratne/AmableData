import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@amable/ui/ui/tooltip';
import { CheckCircle2, CircleAlert, CloudOff, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../../../i18n';
import type { DraftStatus } from '../../lib/draft-sync';

export function SaveIndicator({ status }: { status: DraftStatus }) {
  const { t } = useI18n();
  const map: Record<DraftStatus, { icon: ReactNode; text: string; tone: string }> = {
    saved: {
      icon: <CheckCircle2 className="size-3.5" />,
      text: t('auto.save.saved'),
      tone: 'text-muted-foreground',
    },
    dirty: {
      icon: <Loader2 className="size-3.5" />,
      text: t('auto.save.dirty'),
      tone: 'text-muted-foreground',
    },
    saving: {
      icon: <Loader2 className="size-3.5 animate-spin" />,
      text: t('auto.save.saving'),
      tone: 'text-muted-foreground',
    },
    invalid: {
      icon: <CircleAlert className="size-3.5" />,
      text: t('auto.save.invalid'),
      tone: 'text-amber-600 dark:text-amber-400',
    },
    error: {
      icon: <CloudOff className="size-3.5" />,
      text: t('auto.save.error'),
      tone: 'text-destructive',
    },
    conflict: {
      icon: <CircleAlert className="size-3.5" />,
      text: t('auto.save.conflict'),
      tone: 'text-destructive',
    },
  };
  const item = map[status];
  return (
    <span
      className={cn('flex min-w-0 items-center gap-1 text-xs', item.tone)}
      data-testid="save-status"
      data-status={status}
    >
      {item.icon}
      <span className="truncate">{item.text}</span>
    </span>
  );
}

export function ToolButton({
  label,
  onClick,
  children,
  active,
  disabled,
  testId,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? 'secondary' : 'ghost'}
          size="sm"
          className="h-8 gap-1.5 px-2"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          data-testid={testId}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

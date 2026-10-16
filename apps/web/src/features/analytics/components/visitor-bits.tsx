import type { Prediction, VisitorSummary } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Laptop, Monitor, Smartphone, Tablet } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { avatarHue, initials, shortId } from '../lib/format';
import { Initials } from './ui';

export function scoreTone(score: number): string {
  if (score >= 70) return 'bg-success/15 text-success';
  if (score >= 40) return 'bg-warning/15 text-warning';
  return 'bg-foreground/[0.06] text-muted-foreground';
}

export function ScoreBadge({
  prediction,
  className,
}: {
  prediction: Prediction | null;
  className?: string;
}) {
  const { t } = useI18n();
  if (!prediction) return <span className="text-xs text-muted-foreground">—</span>;
  const score = Math.round(prediction.score);
  return (
    <span
      title={t('analytics.visitors.scoreTitle', { score })}
      className={cn(
        'inline-flex h-5 min-w-9 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
        scoreTone(score),
        className,
      )}
    >
      {score}
    </span>
  );
}

export function DeviceIcon({ device, className }: { device: string | null; className?: string }) {
  const value = (device ?? '').toLowerCase();
  const Icon =
    value.includes('mobile') || value.includes('phone')
      ? Smartphone
      : value.includes('tablet')
        ? Tablet
        : value.includes('laptop')
          ? Laptop
          : Monitor;
  return <Icon className={cn('size-3.5 shrink-0 text-muted-foreground', className)} aria-hidden />;
}

export function visitorName(
  visitor: Pick<VisitorSummary, 'name' | 'email' | 'visitor_id'>,
  anonymous: string,
): string {
  return visitor.name ?? visitor.email ?? `${anonymous} ${shortId(visitor.visitor_id)}`;
}

export function VisitorIdentity({
  visitor,
  size = 28,
}: {
  visitor: VisitorSummary;
  size?: number;
}) {
  const { t } = useI18n();
  const identified = !!(visitor.name ?? visitor.email);
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {identified ? (
        <Initials
          text={initials(visitor.name, visitor.email)}
          hue={avatarHue(visitor.contact_id ?? visitor.visitor_id)}
          size={size}
        />
      ) : (
        <span
          aria-hidden
          className="inline-flex shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-[10px] font-medium text-muted-foreground"
          style={{ width: size, height: size }}
        >
          {visitor.visitor_id.slice(0, 2).toUpperCase()}
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] font-medium">
          {visitorName(visitor, t('analytics.visitors.anonymous'))}
        </span>
        {visitor.name && visitor.email ? (
          <span className="truncate text-[11px] text-muted-foreground">{visitor.email}</span>
        ) : !identified ? (
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {shortId(visitor.visitor_id)}
          </span>
        ) : null}
      </span>
    </span>
  );
}

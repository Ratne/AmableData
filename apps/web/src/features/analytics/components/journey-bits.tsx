import type { Prediction, TimeToConversion, Touch } from '@amable/api-types';
import { cn } from '@amable/ui';
import { useI18n } from '../../../i18n';
import { useFormatters } from '../lib/format';
import { scoreTone } from './visitor-bits';

export function TouchSummary({ label, touch }: { label: string; touch: Touch | null }) {
  const { t } = useI18n();
  const f = useFormatters();
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-foreground/[0.03] px-3 py-2">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {touch ? (
        <>
          <span className="truncate text-sm font-medium">{touch.channel}</span>
          <span className="truncate text-xs text-muted-foreground">
            {[touch.source ?? touch.referrer_host, touch.campaign].filter(Boolean).join(' · ') ||
              t('analytics.journey.noSource')}
          </span>
          <span className="text-[11px] text-muted-foreground">{f.dateTime(touch.ts)}</span>
        </>
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      )}
    </div>
  );
}

export function TimeToConversionFacts({ value }: { value: TimeToConversion }) {
  const { t } = useI18n();
  const f = useFormatters();
  if (!value.first_purchase_at)
    return <p className="text-xs text-muted-foreground">{t('analytics.journey.notConverted')}</p>;
  return (
    <dl className="grid grid-cols-3 gap-2">
      <div className="flex flex-col">
        <dt className="text-[11px] text-muted-foreground">
          {t('analytics.journey.sessionsBefore')}
        </dt>
        <dd className="text-base font-medium tabular-nums">
          {value.sessions_before_purchase ?? '—'}
        </dd>
      </div>
      <div className="flex flex-col">
        <dt className="text-[11px] text-muted-foreground">{t('analytics.journey.daysTo')}</dt>
        <dd className="text-base font-medium tabular-nums">
          {value.days_to_purchase === null ? '—' : f.number(value.days_to_purchase, 1)}
        </dd>
      </div>
      <div className="flex flex-col">
        <dt className="text-[11px] text-muted-foreground">{t('analytics.journey.hoursTo')}</dt>
        <dd className="text-base font-medium tabular-nums">
          {value.hours_to_purchase === null ? '—' : f.number(value.hours_to_purchase, 1)}
        </dd>
      </div>
    </dl>
  );
}

/** Semi-circle gauge of the 0..100 conversion score. */
export function ScoreGauge({
  prediction,
  currency,
  compact,
}: {
  prediction: Prediction | null;
  currency: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  if (!prediction)
    return <p className="text-xs text-muted-foreground">{t('analytics.prediction.none')}</p>;
  const score = Math.max(0, Math.min(100, prediction.score));
  const radius = 42;
  const length = Math.PI * radius;
  const color =
    score >= 70 ? 'var(--success)' : score >= 40 ? 'var(--warning)' : 'var(--muted-foreground)';
  return (
    <div className={cn('flex items-center gap-4', compact && 'gap-3')}>
      <svg viewBox="0 0 100 58" className={cn('shrink-0', compact ? 'w-24' : 'w-32')} aria-hidden>
        <path
          d="M8 50 A42 42 0 0 1 92 50"
          fill="none"
          stroke="color-mix(in oklab, var(--foreground) 9%, transparent)"
          strokeWidth="8"
          strokeLinecap="round"
        />
        <path
          d="M8 50 A42 42 0 0 1 92 50"
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${(score / 100) * length} ${length}`}
          style={{ transition: 'stroke-dasharray 700ms cubic-bezier(0.22,1,0.36,1)' }}
        />
        <text
          x="50"
          y="47"
          textAnchor="middle"
          fontSize="20"
          fontWeight="600"
          fill="var(--foreground)"
        >
          {Math.round(score)}
        </text>
      </svg>
      <dl className="flex flex-col gap-1 text-xs">
        <div>
          <dt className="text-muted-foreground">{t('analytics.prediction.probability')}</dt>
          <dd
            className={cn(
              'inline-flex rounded-full px-1.5 text-[12px] font-medium',
              scoreTone(score),
            )}
          >
            {f.percent(prediction.conversion_rate, 1)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('analytics.prediction.expectedValue')}</dt>
          <dd className="text-sm font-medium">
            {f.money(prediction.expected_value_minor, currency)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

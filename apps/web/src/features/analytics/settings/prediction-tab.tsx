import type { Site } from '@amable/api-types';
import { DashboardButton } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { BrainCircuit } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { analyticsApi, analyticsKeys, useAnalyticsMutation, usePrediction } from '../api';
import { ErrorState, Fact, Panel } from '../components/ui';
import { useFormatters, useNow } from '../lib/format';

export function PredictionTab({
  tenant,
  site,
  canConfigure,
}: {
  tenant: string;
  site: Site;
  canConfigure: boolean;
}) {
  const { t } = useI18n();
  const f = useFormatters();
  const now = useNow(60_000);
  const model = usePrediction(tenant, site.id);
  const api = analyticsApi(tenant);
  const train = useAnalyticsMutation(tenant, () => api.prediction.train(site.id), {
    invalidate: [analyticsKeys.site(tenant, site.id, 'prediction'), analyticsKeys.root(tenant)],
    success: 'analytics.prediction.trained',
  });

  const data = model.data;
  const maxWeight = Math.max(
    Number.EPSILON,
    ...(data?.top_features ?? []).map((feature) => Math.abs(feature.weight)),
  );

  return (
    <Panel
      title={t('analytics.prediction.modelTitle')}
      actions={
        canConfigure ? (
          <DashboardButton
            variant="primary"
            onClick={() => train.mutate(undefined)}
            disabled={train.isPending}
          >
            <BrainCircuit aria-hidden />
            {train.isPending ? t('analytics.prediction.training') : t('analytics.prediction.train')}
          </DashboardButton>
        ) : null
      }
    >
      <p className="mb-4 text-xs text-muted-foreground">{t('analytics.prediction.hint')}</p>
      {model.error ? (
        <ErrorState error={model.error} />
      ) : !data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <dl className="grid grid-cols-2 gap-4">
            <Fact label={t('analytics.prediction.trainedAt')}>
              {data.trained_at ? f.relative(data.trained_at, now) : t('analytics.prediction.never')}
            </Fact>
            <Fact label={t('analytics.prediction.samples')}>
              {t('analytics.prediction.samplesValue', {
                samples: f.number(data.samples),
                positives: f.number(data.positives),
              })}
            </Fact>
            <Fact label={t('analytics.prediction.baseRate')}>{f.percent(data.base_rate, 2)}</Fact>
            <Fact label={t('analytics.prediction.accuracy')}>
              {data.accuracy === null ? '—' : f.percent(data.accuracy, 1)}
            </Fact>
            <Fact label={t('analytics.prediction.aov')}>
              {f.money(data.average_order_value_minor, data.currency)}
            </Fact>
          </dl>
          <div className="flex flex-col gap-2">
            <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t('analytics.prediction.features')}
            </h3>
            {data.top_features.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('analytics.prediction.noFeatures')}
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {data.top_features.map((feature) => {
                  const share = (Math.abs(feature.weight) / maxWeight) * 50;
                  const positive = feature.weight >= 0;
                  return (
                    <li
                      key={feature.feature}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_48px] items-center gap-2 text-xs"
                    >
                      <span className="truncate font-mono text-[11.5px]">{feature.feature}</span>
                      <span className="relative h-2 rounded-full bg-foreground/[0.05]">
                        <span
                          aria-hidden
                          className="absolute inset-y-0 left-1/2 w-px bg-foreground/20"
                        />
                        <span
                          className={`absolute inset-y-0 rounded-full ${positive ? 'bg-success' : 'bg-destructive'}`}
                          style={
                            positive
                              ? { left: '50%', width: `${share}%` }
                              : { right: '50%', width: `${share}%` }
                          }
                        />
                      </span>
                      <span className="text-right tabular-nums text-muted-foreground">
                        {f.number(feature.weight, 2)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

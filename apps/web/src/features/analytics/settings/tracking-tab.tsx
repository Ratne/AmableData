import type { Site } from '@amable/api-types';
import { DashboardButton } from '@amable/ui';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { useCrawlerSnippets, useInstallCheck, useSnippet } from '../api';
import { CodeBlock, CopyButton } from '../components/copy';
import { ErrorState, Fact, Panel, PulseDot, Segmented, StatusPill } from '../components/ui';
import { useFormatters, useNow } from '../lib/format';

type Variant = 'recommended' | 'default' | 'cookieless' | 'hash';
type Runtime = 'worker' | 'node' | 'php';

function InstallCheckCard({ tenant, site }: { tenant: string; site: Site }) {
  const { t } = useI18n();
  const f = useFormatters();
  const now = useNow(30_000);
  const check = useInstallCheck(tenant, site.id);
  return (
    <Panel
      title={t('analytics.tracking.installCheck')}
      actions={
        <DashboardButton
          variant="secondary"
          onClick={() => void check.refetch()}
          disabled={check.isFetching}
        >
          <RefreshCw className={check.isFetching ? 'animate-spin' : undefined} aria-hidden />
          {t('analytics.tracking.refresh')}
        </DashboardButton>
      }
    >
      {check.error ? (
        <ErrorState error={check.error} />
      ) : !check.data ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <div className="flex flex-col gap-3">
          <span>
            {check.data.receiving ? (
              <StatusPill tone="success">
                <PulseDot className="size-1.5 [&>span]:size-1.5" />
                {t('analytics.tracking.receiving')}
              </StatusPill>
            ) : (
              <StatusPill tone="warning">{t('analytics.tracking.waiting')}</StatusPill>
            )}
          </span>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Fact label={t('analytics.tracking.lastEvent')}>
              {check.data.last_event_at
                ? f.relative(check.data.last_event_at, now)
                : t('analytics.common.never')}
            </Fact>
            <Fact label={t('analytics.tracking.lastUrl')}>
              <span className="font-mono text-xs">{check.data.last_event_url ?? '—'}</span>
            </Fact>
            <Fact label={t('analytics.tracking.events24h')}>{f.number(check.data.events_24h)}</Fact>
            <Fact label={t('analytics.sites.hostnames')}>{check.data.hostnames.join(', ')}</Fact>
          </dl>
          {!check.data.receiving ? (
            <p className="text-xs text-muted-foreground">{t('analytics.tracking.waitingHint')}</p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

export function TrackingTab({ tenant, site }: { tenant: string; site: Site }) {
  const { t } = useI18n();
  const snippet = useSnippet(tenant, site.id);
  const crawler = useCrawlerSnippets(tenant, site.id);
  const [variant, setVariant] = useState<Variant>('recommended');
  const [runtime, setRuntime] = useState<Runtime>('worker');

  const code = snippet.data
    ? variant === 'recommended'
      ? snippet.data.html
      : snippet.data.scripts[variant]
    : '';

  return (
    <div className="flex flex-col gap-[7px]">
      <InstallCheckCard tenant={tenant} site={site} />
      <Panel
        title={t('analytics.tracking.snippet')}
        actions={
          <Segmented<Variant>
            label={t('analytics.tracking.snippet')}
            value={variant}
            onChange={setVariant}
            options={[
              { value: 'recommended', label: t('analytics.tracking.recommended') },
              { value: 'default', label: t('analytics.tracking.default') },
              { value: 'cookieless', label: t('analytics.sites.cookieless') },
              { value: 'hash', label: t('analytics.tracking.hash') },
            ]}
          />
        }
      >
        {snippet.error ? (
          <ErrorState error={snippet.error} />
        ) : !snippet.data ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              {t(`analytics.tracking.hint.${variant}`)}
            </p>
            <CodeBlock code={code} />
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {t('analytics.tracking.serverEndpoint')}
              </span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs">
                {snippet.data.server_endpoint}
              </code>
              <CopyButton text={snippet.data.server_endpoint} />
            </div>
            <p className="text-xs text-muted-foreground">{t('analytics.tracking.serverHint')}</p>
          </div>
        )}
      </Panel>
      <Panel
        title={t('analytics.tracking.crawlers')}
        actions={
          <Segmented<Runtime>
            label={t('analytics.tracking.crawlers')}
            value={runtime}
            onChange={setRuntime}
            options={[
              { value: 'worker', label: 'Worker' },
              { value: 'node', label: 'Node' },
              { value: 'php', label: 'PHP' },
            ]}
          />
        }
      >
        {crawler.error ? (
          <ErrorState error={crawler.error} />
        ) : !crawler.data ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              {t('analytics.tracking.crawlersHint', {
                placeholder: crawler.data.secret_placeholder,
              })}
            </p>
            <CodeBlock code={crawler.data[runtime]} />
          </div>
        )}
      </Panel>
    </div>
  );
}

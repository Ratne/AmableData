import type { Shortlink, ShortlinkStats } from '@amable/api-types';
import { ChartContainer, type ChartConfig } from '@amable/ui/ui/chart';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { ApiErrorNotice, ChoiceSelect } from '../../../components/feature-kit';
import { useI18n } from '../../../i18n';
import { errorMessage, useLinkStats } from '../api/hooks';
import { displayShortUrl } from '../lib/links';

const PERIODS = [7, 30, 90] as const;

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</div>
    </div>
  );
}

function Breakdown({
  title,
  rows,
  unknown,
  format,
}: {
  title: string;
  rows: ShortlinkStats['countries'];
  unknown: string;
  format?: (value: string) => string;
}) {
  const { t } = useI18n();
  const total = rows.reduce((sum, r) => sum + r.clicks, 0);
  return (
    <section className="grid content-start gap-2 rounded-lg border p-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('shortlinks.stats.noData')}</p>
      ) : (
        <ul className="grid gap-1.5 text-sm">
          {rows.map((r) => (
            <li key={r.value} className="grid gap-0.5">
              <div className="flex justify-between gap-2">
                <span className="truncate">{r.value === '' ? unknown : (format?.(r.value) ?? r.value)}</span>
                <span className="tabular-nums text-muted-foreground">{r.clicks.toLocaleString()}</span>
              </div>
              <div className="h-1 rounded bg-muted">
                <div
                  className="h-1 rounded bg-primary"
                  style={{ width: `${String(total === 0 ? 0 : Math.round((r.clicks / total) * 100))}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function StatsDialog({ link, onClose }: { link: Shortlink; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [days, setDays] = useState<number>(30);
  const stats = useLinkStats(link.id, days);
  const config = {
    humans: { label: t('shortlinks.stats.humans'), color: 'var(--chart-1)' },
    bots: { label: t('shortlinks.stats.bots'), color: 'var(--chart-3)' },
  } satisfies ChartConfig;
  const dayLabel = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const countryName = (() => {
    try {
      const names = new Intl.DisplayNames([locale], { type: 'region' });
      return (code: string) => names.of(code) ?? code;
    } catch {
      return (code: string) => code;
    }
  })();
  const data = stats.data;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('shortlinks.stats.title')}</DialogTitle>
          <DialogDescription className="break-all">{displayShortUrl(link)}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <ChoiceSelect
            value={String(days)}
            onChange={(value) => setDays(Number(value))}
            ariaLabel={t('shortlinks.stats.period')}
            choices={PERIODS.map((d) => ({ value: String(d), label: t('shortlinks.stats.lastDays', { days: d }) }))}
          />
        </div>
        {stats.error ? (
          <ApiErrorNotice
            error={stats.error}
            message={errorMessage(t, stats.error)}
            forbiddenTitle={t('shortlinks.error.forbidden')}
          />
        ) : data === undefined ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : (
          <div className="grid gap-4">
            <div className="grid grid-cols-3 gap-3">
              <StatCard label={t('shortlinks.stats.total')} value={data.total_clicks} />
              <StatCard label={t('shortlinks.stats.humansPeriod')} value={data.human_clicks} />
              <StatCard label={t('shortlinks.stats.botsPeriod')} value={data.bot_clicks} />
            </div>
            <ChartContainer config={config} className="aspect-auto h-[240px] w-full">
              <LineChart data={data.series} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={24}
                  tickFormatter={(day: string) => dayLabel.format(Date.parse(day))}
                />
                <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
                <Tooltip
                  labelFormatter={(day) => dayLabel.format(Date.parse(String(day)))}
                  formatter={(value, name) => [Number(value).toLocaleString(), config[name as keyof typeof config]?.label ?? name]}
                />
                <Legend formatter={(name: string) => config[name as keyof typeof config]?.label ?? name} />
                <Line type="monotone" dataKey="humans" stroke="var(--color-humans)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="bots" stroke="var(--color-bots)" strokeWidth={2} dot={false} />
              </LineChart>
            </ChartContainer>
            <div className="grid gap-3 sm:grid-cols-2">
              <Breakdown
                title={t('shortlinks.stats.countries')}
                rows={data.countries}
                unknown={t('shortlinks.stats.unknown')}
                format={countryName}
              />
              <Breakdown
                title={t('shortlinks.stats.referrers')}
                rows={data.referrers}
                unknown={t('shortlinks.stats.direct')}
              />
              <Breakdown title={t('shortlinks.stats.devices')} rows={data.devices} unknown={t('shortlinks.stats.unknown')} />
              <Breakdown title={t('shortlinks.stats.browsers')} rows={data.browsers} unknown={t('shortlinks.stats.unknown')} />
            </div>
            <p className="text-xs text-muted-foreground">{t('shortlinks.stats.humanOnly')}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

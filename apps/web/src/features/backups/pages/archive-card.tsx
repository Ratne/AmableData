import { ARCHIVE_RETENTION_FAMILIES, type ArchiveRetention, type ArchiveRetentionFamily } from '@amable/api-types';
import { formatNumber, type MessageKey } from '@amable/i18n';
import { toast } from '@amable/ui';
import { Alert, AlertDescription } from '@amable/ui/ui/alert';
import { Button } from '@amable/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import { Label } from '@amable/ui/ui/label';
import { Progress } from '@amable/ui/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@amable/ui/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@amable/ui/ui/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { backupErrorKey, backupKeys, backupsApi, isStepUpRequired, type ArchiveOverview } from '../api';

const MONTH_CHOICES = [3, 6, 12, 24, 36, 60, 120, 0] as const;

const FAMILY_KEYS: Readonly<Record<ArchiveRetentionFamily, MessageKey>> = {
  crm_events: 'backups.archive.family.crm_events',
  email: 'backups.archive.family.email',
  clicks: 'backups.archive.family.clicks',
  submissions: 'backups.archive.family.submissions',
  esign: 'backups.archive.family.esign',
};

const STREAM_KEYS: Readonly<Record<ArchiveOverview['streams'][number]['stream'], MessageKey>> = {
  crm_activities: 'backups.archive.stream.crm_activities',
  form_submissions: 'backups.archive.stream.form_submissions',
  esign_events: 'backups.archive.stream.esign_events',
  mail_messages: 'backups.archive.stream.mail_messages',
  mail_clicks: 'backups.archive.stream.mail_clicks',
};

const DATABASE_KEYS: Readonly<Record<ArchiveOverview['storage']['databases'][number]['name'], MessageKey>> = {
  tenant_db: 'backups.archive.db.tenant_db',
  mail_db: 'backups.archive.db.mail_db',
  engine: 'backups.archive.db.engine',
};

function formatSize(locale: Parameters<typeof formatNumber>[0], bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${formatNumber(locale, value, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit] ?? 'B'}`;
}

/** Settings > Backups > Data & archiving (owner only, like the rest of the page). */
export function ArchiveCard({ slug }: { slug: string }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: backupKeys.archive(slug), queryFn: () => backupsApi.archive(slug) });
  const [draft, setDraft] = useState<Partial<ArchiveRetention>>({});
  const save = useMutation({
    mutationFn: (input: Partial<ArchiveRetention>) => backupsApi.saveArchive(slug, input),
    onSuccess: (data) => {
      queryClient.setQueryData(backupKeys.archive(slug), data);
      setDraft({});
      toast.success(t('backups.archive.saved'));
    },
    onError: (error) => {
      if (!isStepUpRequired(error)) toast.error(t(backupErrorKey(error)));
    },
  });

  const data = overview.data;
  const monthsLabel = (months: number) =>
    months === 0 ? t('backups.archive.forever') : t('backups.archive.months', { count: months });
  const dirty = Object.keys(draft).length > 0;
  const nearLimit = data?.storage.databases.filter((d) => d.bytes !== null && d.bytes >= data.storage.warning) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('backups.archive.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">{t('backups.archive.subtitle')}</p>
        {overview.isPending ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : !data ? (
          <p className="text-sm text-destructive">{t('backups.error.generic')}</p>
        ) : (
          <>
            {nearLimit.length > 0 ? (
              <Alert variant="destructive">
                <TriangleAlert className="size-4" />
                <AlertDescription>
                  {t('backups.archive.nearLimit', {
                    databases: nearLimit.map((d) => t(DATABASE_KEYS[d.name])).join(', '),
                  })}
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              {ARCHIVE_RETENTION_FAMILIES.map((family) => {
                const value = draft[family] ?? data.retention[family];
                const choices = (MONTH_CHOICES as readonly number[]).includes(value) ? MONTH_CHOICES : [...MONTH_CHOICES, value];
                return (
                  <div key={family} className="grid gap-1.5">
                    <Label htmlFor={`archive-${family}`}>{t(FAMILY_KEYS[family])}</Label>
                    <Select
                      value={String(value)}
                      onValueChange={(next) => setDraft((d) => ({ ...d, [family]: Number(next) }))}
                    >
                      <SelectTrigger id={`archive-${family}`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {choices.map((months) => (
                          <SelectItem key={months} value={String(months)}>
                            {monthsLabel(months)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">{t('backups.archive.help')}</p>
              <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
                {t('backups.archive.save')}
              </Button>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('backups.archive.col.stream')}</TableHead>
                  <TableHead className="text-right">{t('backups.archive.col.rows')}</TableHead>
                  <TableHead className="text-right">{t('backups.col.size')}</TableHead>
                  <TableHead>{t('backups.archive.col.period')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.streams.map((s) => (
                  <TableRow key={s.stream}>
                    <TableCell>{t(STREAM_KEYS[s.stream])}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(locale, s.rows)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatSize(locale, s.bytes)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.oldest === null ? '—' : s.oldest === s.newest ? s.oldest : `${s.oldest} – ${s.newest ?? ''}`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="grid gap-3">
              <p className="text-sm font-medium">{t('backups.archive.storage')}</p>
              {data.storage.databases.map((d) => (
                <div key={d.name} className="grid gap-1">
                  <div className="flex justify-between text-xs">
                    <span>{t(DATABASE_KEYS[d.name])}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {d.bytes === null ? '—' : `${formatSize(locale, d.bytes)} / ${formatSize(locale, data.storage.limit)}`}
                    </span>
                  </div>
                  <Progress value={d.bytes === null ? 0 : Math.min(100, (d.bytes / data.storage.limit) * 100)} />
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

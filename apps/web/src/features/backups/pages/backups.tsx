import { formatDateTime, formatNumber, type MessageKey } from '@amable/i18n';
import { DashboardButton, PageBody, PageToolbar, toast, usePageChrome } from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Badge } from '@amable/ui/ui/badge';
import { Button } from '@amable/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@amable/ui/ui/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { DatabaseBackup, Download, Info, RotateCcw, ShieldAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import {
  backupErrorKey,
  backupKeys,
  backupsApi,
  isStepUpRequired,
  type BackupItem,
  type BackupKind,
} from '../api';

const KIND_KEYS: Readonly<Record<BackupKind, MessageKey>> = {
  scheduled: 'backups.kind.scheduled',
  manual: 'backups.kind.manual',
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

export function BackupsPage() {
  const { t, locale } = useI18n();
  const { tenant } = useParams({ strict: false });
  const slug = tenant ?? 'demo';
  usePageChrome({ title: t('backups.title') });
  const queryClient = useQueryClient();
  const [restoring, setRestoring] = useState<BackupItem | null>(null);
  const [confirm, setConfirm] = useState('');

  const me = useQuery({ queryKey: backupKeys.me(slug), queryFn: () => backupsApi.me(slug), staleTime: 60_000 });
  const isOwner = me.data?.role === 'owner';
  const list = useQuery({
    queryKey: backupKeys.list(slug),
    queryFn: () => backupsApi.list(slug),
    enabled: isOwner,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: backupKeys.list(slug) });
  // Step-up is asked app-wide and the call replayed; it only lands here if the user closed that dialog.
  const fail = (error: unknown) => {
    if (!isStepUpRequired(error)) toast.error(t(backupErrorKey(error)));
  };

  const create = useMutation({
    mutationFn: () => backupsApi.create(slug),
    onSuccess: () => {
      toast.success(t('backups.created'));
      refresh();
    },
    onError: fail,
  });
  const download = useMutation({
    mutationFn: (id: string) => backupsApi.download(slug, id),
    onError: fail,
  });
  const restore = useMutation({
    mutationFn: (input: { id: string; confirm: string }) => backupsApi.restore(slug, input.id, input.confirm),
    onSuccess: () => {
      toast.success(t('backups.restore.done'));
      setRestoring(null);
      setConfirm('');
      refresh();
      void queryClient.invalidateQueries();
    },
    onError: fail,
  });

  const submitRestore = (event: FormEvent) => {
    event.preventDefault();
    if (restoring !== null) restore.mutate({ id: restoring.id, confirm });
  };
  const date = (iso: string) => formatDateTime(locale, Date.parse(iso));
  const backups = list.data?.backups ?? [];

  if (me.isSuccess && !isOwner) {
    return (
      <PageBody className="max-w-3xl pt-4">
        <Alert>
          <ShieldAlert className="size-4" />
          <AlertTitle>{t('backups.ownerOnly')}</AlertTitle>
        </Alert>
      </PageBody>
    );
  }

  return (
    <>
      <PageToolbar
        actions={
          isOwner ? (
            <DashboardButton variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>
              <DatabaseBackup className="size-4" />
              {create.isPending ? t('backups.creating') : t('backups.create')}
            </DashboardButton>
          ) : null
        }
      />
      <PageBody className="grid max-w-5xl gap-4 pt-4">
        <p className="text-sm text-muted-foreground">{t('backups.subtitle')}</p>

        <Card>
          <CardHeader>
            <CardTitle>{t('backups.list')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {list.isPending && isOwner ? (
              <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
            ) : backups.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('backups.empty')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('backups.col.date')}</TableHead>
                    <TableHead>{t('backups.col.kind')}</TableHead>
                    <TableHead className="text-right">{t('backups.col.size')}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {backups.map((backup) => (
                    <TableRow key={backup.id}>
                      <TableCell>{date(backup.createdAt)}</TableCell>
                      <TableCell>
                        <Badge variant={backup.kind === 'manual' ? 'outline' : 'secondary'}>
                          {t(KIND_KEYS[backup.kind])}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatSize(locale, backup.size)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={download.isPending}
                            onClick={() => download.mutate(backup.id)}
                          >
                            <Download className="size-4" />
                            {t('backups.download')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setConfirm('');
                              setRestoring(backup);
                            }}
                          >
                            <RotateCcw className="size-4" />
                            {t('backups.restore')}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {list.data ? (
              <p className="text-xs text-muted-foreground">
                {t('backups.retention', {
                  scheduled: list.data.retention.scheduled,
                  manual: list.data.retention.manual,
                })}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Alert>
          <Info className="size-4" />
          <AlertTitle>{t('backups.help.title')}</AlertTitle>
          <AlertDescription>{t('backups.help.body')}</AlertDescription>
        </Alert>
      </PageBody>

      <Dialog open={restoring !== null} onOpenChange={(open) => (open ? undefined : setRestoring(null))}>
        <DialogContent>
          <form onSubmit={submitRestore} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t('backups.restore.title')}</DialogTitle>
              <DialogDescription>
                {t('backups.restore.body', { date: restoring ? date(restoring.createdAt) : '' })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="backup-restore-confirm">{t('backups.restore.confirmLabel', { slug })}</Label>
              <Input
                id="backup-restore-confirm"
                autoComplete="off"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRestoring(null)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" variant="destructive" disabled={confirm !== slug || restore.isPending}>
                {t('backups.restore.submit')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

import type { Segment } from '@amable/api-types';
import {
  DashboardButton,
  DashboardConfirmDialog,
  DashboardMenu,
  DashboardMenuContent,
  DashboardMenuItem,
  DashboardMenuLabel,
  DashboardMenuSeparator,
  DashboardMenuTrigger,
} from '@amable/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Bookmark, BookmarkPlus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { analyticsApi, analyticsKeys, useAnalyticsMutation, useSegments } from '../api';
import type { AnalyticsState } from '../lib/query-state';
import { useAnalyticsPermissions } from '../lib/permissions';

/** Saved filter sets: apply, save the current filters, delete. */
export function SegmentsMenu({ state }: { state: AnalyticsState }) {
  const { t } = useI18n();
  const { tenant, site } = state;
  const siteId = site?.id ?? null;
  const permissions = useAnalyticsPermissions(tenant);
  const segments = useSegments(tenant, siteId);
  const api = analyticsApi(tenant);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<Segment | null>(null);
  const invalidate = [analyticsKeys.site(tenant, siteId ?? '', 'segments')];

  const create = useAnalyticsMutation(
    tenant,
    (input: { name: string }) =>
      api.segments.create(siteId ?? '', { name: input.name, filters: state.filters }),
    { invalidate, success: 'analytics.segments.saved', onSuccess: () => setSaving(false) },
  );
  const remove = useAnalyticsMutation(
    tenant,
    (id: string) => api.segments.remove(siteId ?? '', id),
    {
      invalidate,
      success: 'analytics.segments.deleted',
    },
  );

  if (!site) return null;
  const list = segments.data?.data ?? [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) create.mutate({ name: name.trim() });
  };

  return (
    <>
      <DashboardMenu>
        <DashboardMenuTrigger asChild>
          <DashboardButton variant="secondary" size="sm">
            <Bookmark aria-hidden />
            {t('analytics.segments.title')}
          </DashboardButton>
        </DashboardMenuTrigger>
        <DashboardMenuContent align="start" className="w-64">
          <DashboardMenuLabel>{t('analytics.segments.title')}</DashboardMenuLabel>
          {list.length === 0 ? (
            <p className="px-2.5 pb-2 text-xs text-muted-foreground">
              {t('analytics.segments.empty')}
            </p>
          ) : (
            list.map((segment) => (
              <DashboardMenuItem
                key={segment.id}
                onSelect={() => state.setFilters(segment.filters)}
              >
                <span className="min-w-0 flex-1 truncate">{segment.name}</span>
                <span className="text-[11px] text-muted-foreground">{segment.filters.length}</span>
                {permissions.editReports ? (
                  <button
                    type="button"
                    aria-label={t('analytics.segments.delete')}
                    className="inline-flex size-5 items-center justify-center rounded hover:bg-foreground/10"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setDeleting(segment);
                    }}
                  >
                    <Trash2 className="size-3!" aria-hidden />
                  </button>
                ) : null}
              </DashboardMenuItem>
            ))
          )}
          {permissions.editReports ? (
            <>
              <DashboardMenuSeparator />
              <DashboardMenuItem
                disabled={state.filters.length === 0}
                onSelect={() => {
                  setName('');
                  setSaving(true);
                }}
              >
                <BookmarkPlus aria-hidden />
                {t('analytics.segments.saveCurrent')}
              </DashboardMenuItem>
            </>
          ) : null}
        </DashboardMenuContent>
      </DashboardMenu>

      <Dialog open={saving} onOpenChange={setSaving}>
        <DialogContent className="sm:max-w-sm">
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t('analytics.segments.saveTitle')}</DialogTitle>
              <DialogDescription>
                {t('analytics.segments.saveHint', { count: state.filters.length })}
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('analytics.segments.namePlaceholder')}
              aria-label={t('analytics.common.name')}
            />
            <DialogFooter>
              <DashboardButton variant="secondary" onClick={() => setSaving(false)}>
                {t('common.cancel')}
              </DashboardButton>
              <DashboardButton
                type="submit"
                variant="primary"
                disabled={!name.trim() || create.isPending}
              >
                {t('common.save')}
              </DashboardButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DashboardConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('analytics.segments.deleteTitle', { name: deleting?.name ?? '' })}
        confirmLabel={t('analytics.common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
      />
    </>
  );
}

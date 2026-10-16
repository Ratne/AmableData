import { DashboardConfirmDialog } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Spinner } from '@amable/ui/ui/spinner';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, History, RotateCcw } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { landingKeys, useDates, useLanding, useLandingMutation, usePermissions } from '../api/hooks';
import type { LandingPage, PageVersion } from '../api/types';
import { ErrorNotice, FormField, Pill } from './common';

/**
 * Publish with an optional note. `beforePublish` lets the editor flush its
 * pending draft first, so what goes live is what the user sees.
 */
export function PublishDialog({
  page,
  beforePublish,
  onClose,
  onPublished,
}: {
  page: LandingPage;
  beforePublish?: () => Promise<boolean>;
  onClose: () => void;
  onPublished?: (page: LandingPage, version: PageVersion) => void;
}) {
  const { t } = useI18n();
  const { api } = useLanding();
  const [note, setNote] = useState('');
  const publish = useLandingMutation({
    mutationFn: async () => {
      if (beforePublish && !(await beforePublish())) throw new Error('draft_not_saved');
      return api.pages.publish(page.id, note.trim() || undefined);
    },
    success: (result) => t('landing.publish.done', { version: result.version.version }),
    onSuccess: (result) => {
      onPublished?.(result.page, result.version);
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    publish.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('landing.publish.title')}</DialogTitle>
            <DialogDescription>
              {page.public_url ? t('landing.publish.descriptionUrl', { url: page.public_url }) : t('landing.publish.description')}
            </DialogDescription>
          </DialogHeader>
          <FormField label={t('landing.publish.note')} hint={t('landing.publish.noteHint')}>
            {(id) => <Textarea id={id} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={publish.isPending}>
              {publish.isPending ? <Spinner /> : null} {t('landing.publish.action')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function UnpublishButton({ page, size = 'sm' }: { page: LandingPage; size?: 'sm' | 'default' }) {
  const { t } = useI18n();
  const { api } = useLanding();
  const [confirming, setConfirming] = useState(false);
  const unpublish = useLandingMutation({
    mutationFn: () => api.pages.unpublish(page.id),
    success: t('landing.publish.unpublished'),
  });
  return (
    <>
      <Button type="button" variant="outline" size={size} disabled={unpublish.isPending} onClick={() => setConfirming(true)}>
        {t('landing.publish.unpublish')}
      </Button>
      <DashboardConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('landing.publish.unpublishTitle')}
        description={t('landing.publish.unpublishBody')}
        confirmLabel={t('landing.publish.unpublish')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          setConfirming(false);
          unpublish.mutate(undefined);
        }}
      />
    </>
  );
}

/** Published versions, newest first; restoring copies a version into the draft. */
export function VersionsPanel({ page, onRestored }: { page: LandingPage; onRestored?: () => void }) {
  const { t } = useI18n();
  const { slug, api } = useLanding();
  const { can } = usePermissions();
  const { dateTime } = useDates();
  const versions = useQuery({
    queryKey: landingKeys.versions(slug, page.id),
    queryFn: async () => (await api.pages.versions(page.id)).data,
  });
  const [restoring, setRestoring] = useState<PageVersion | null>(null);
  const restore = useLandingMutation({
    mutationFn: (versionId: string) => api.pages.restoreVersion(page.id, versionId),
    success: t('landing.versions.restored'),
    onSuccess: () => onRestored?.(),
  });
  const sorted = [...(versions.data ?? [])].sort((a, b) => b.version - a.version);
  if (versions.error) return <ErrorNotice error={versions.error} />;
  if (versions.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }
  if (sorted.length === 0) {
    return (
      <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <History aria-hidden className="size-4" /> {t('landing.versions.empty')}
      </p>
    );
  }
  return (
    <>
      <ul className="grid gap-2">
        {sorted.map((version) => {
          const live = version.id === page.published_version_id && page.status === 'published';
          return (
            <li key={version.id} className="flex items-start gap-3 rounded-lg border px-3 py-2">
              <div className="grid min-w-0 flex-1 gap-0.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {t('landing.versions.version', { version: version.version })}
                  {live ? <Pill tone="success">{t('landing.versions.live')}</Pill> : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {dateTime(version.published_at)}
                  {version.published_by ? ` · ${version.published_by}` : ''}
                </p>
                {version.note ? <p className="text-sm break-words">{version.note}</p> : null}
              </div>
              {can('pages:write') ? (
                <Button type="button" variant="ghost" size="sm" disabled={restore.isPending} onClick={() => setRestoring(version)}>
                  <RotateCcw aria-hidden /> {t('landing.versions.restore')}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <DashboardConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => (open ? undefined : setRestoring(null))}
        title={t('landing.versions.restoreTitle', { version: restoring?.version ?? '' })}
        description={t('landing.versions.restoreBody')}
        confirmLabel={t('landing.versions.restore')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          if (restoring) restore.mutate(restoring.id);
          setRestoring(null);
        }}
      />
    </>
  );
}

export function LiveLink({ page }: { page: LandingPage }) {
  const { t } = useI18n();
  if (page.status !== 'published' || !page.public_url) return null;
  return (
    <Button asChild variant="ghost" size="sm">
      <a href={page.public_url} target="_blank" rel="noopener noreferrer">
        <ExternalLink aria-hidden /> {t('landing.action.viewLive')}
      </a>
    </Button>
  );
}

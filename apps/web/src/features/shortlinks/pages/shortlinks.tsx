import type { Shortlink } from '@amable/api-types';
import {
  DashboardButton,
  ListTable,
  PageBody,
  PageToolbar,
  toast,
  usePageChrome,
  type ListTableColumn,
} from '@amable/ui';
import { Alert, AlertDescription, AlertTitle } from '@amable/ui/ui/alert';
import { Button } from '@amable/ui/ui/button';
import { Switch } from '@amable/ui/ui/switch';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BarChart3, Copy, FolderCog, Pencil, Plus, QrCode, Waypoints } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApiErrorNotice, ChoiceSelect, Pill, SearchInput } from '../../../components/feature-kit';
import { useI18n } from '../../../i18n';
import { listTableLabels } from '../../../lib/labels';
import {
  errorMessage,
  shortlinkKeys,
  useFolders,
  useLinks,
  useShortlinkDomains,
  useShortlinkPermissions,
  useShortlinks,
} from '../api/hooks';
import { FoldersDialog } from '../components/folders-dialog';
import { LinkDialog } from '../components/link-dialog';
import { QrDialog } from '../components/qr-dialog';
import { StatsDialog } from '../components/stats-dialog';
import { displayShortUrl, isExpired } from '../lib/links';

type Open =
  | { kind: 'edit'; link: Shortlink | null }
  | { kind: 'qr'; link: Shortlink }
  | { kind: 'stats'; link: Shortlink }
  | { kind: 'folders' }
  | null;

function copy(text: string, done: string): void {
  void navigator.clipboard.writeText(text).then(() => toast.success(done));
}

export function ShortlinksPage() {
  const { t, locale } = useI18n();
  usePageChrome({ title: t('nav.shortlinks') });
  const { slug, api } = useShortlinks();
  const { can } = useShortlinkPermissions();
  const writable = can('shortlinks:write');
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [folderFilter, setFolderFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const links = useLinks(showArchived);
  const folders = useFolders();
  const domains = useShortlinkDomains();
  const folderList = folders.data ?? [];
  const domainList = domains.data ?? [];
  const folderById = useMemo(() => new Map(folderList.map((f) => [f.id, f])), [folderList]);
  const verifiedDomains = domainList.filter((d) => d.status === 'verified');
  const date = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }), [locale]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (links.data ?? []).filter((link) => {
      if (folderFilter === 'none' ? link.folder_id !== null : folderFilter !== '' && link.folder_id !== folderFilter) {
        return false;
      }
      if (needle === '') return true;
      return [link.key, link.url, link.title ?? '', link.hostname ?? ''].some((v) => v.toLowerCase().includes(needle));
    });
  }, [links.data, q, folderFilter]);

  const columns: ListTableColumn<Shortlink>[] = [
    {
      id: 'link',
      header: t('shortlinks.col.link'),
      cell: (link) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{displayShortUrl(link)}</span>
            {link.title ? <span className="truncate text-xs text-muted-foreground">{link.title}</span> : null}
          </span>
          {link.short_url !== null ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              aria-label={t('shortlinks.copy')}
              title={t('shortlinks.copy')}
              onClick={(event) => {
                event.stopPropagation();
                copy(link.short_url ?? '', t('shortlinks.copied'));
              }}
            >
              <Copy className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </span>
      ),
      sortable: true,
      sortValue: (link) => displayShortUrl(link),
    },
    {
      id: 'url',
      header: t('shortlinks.col.destination'),
      cell: (link) => (
        <span className="block max-w-xs truncate text-muted-foreground" title={link.url}>
          {link.url}
        </span>
      ),
      hideBelow: 'lg',
    },
    {
      id: 'folder',
      header: t('shortlinks.field.folder'),
      cell: (link) => (link.folder_id ? (folderById.get(link.folder_id)?.name ?? '—') : '—'),
      sortable: true,
      sortValue: (link) => (link.folder_id ? (folderById.get(link.folder_id)?.name ?? '') : ''),
      hideBelow: 'xl',
    },
    {
      id: 'status',
      header: t('shortlinks.col.status'),
      cell: (link) => (
        <span className="flex flex-wrap gap-1">
          {link.archived ? <Pill tone="neutral">{t('shortlinks.status.archived')}</Pill> : null}
          {isExpired(link) ? <Pill tone="warning">{t('shortlinks.status.expired')}</Pill> : null}
          {link.hostname === null ? <Pill tone="danger">{t('shortlinks.status.noDomain')}</Pill> : null}
          {!link.archived && !isExpired(link) && link.hostname !== null ? (
            <Pill tone="success">{t('shortlinks.status.active')}</Pill>
          ) : null}
        </span>
      ),
      hideBelow: 'md',
    },
    {
      id: 'created',
      header: t('shortlinks.col.created'),
      cell: (link) => (
        <span className="flex flex-col text-xs">
          <span>{date.format(Date.parse(link.created_at))}</span>
          {link.created_by_name ? <span className="text-muted-foreground">{link.created_by_name}</span> : null}
        </span>
      ),
      sortable: true,
      sortValue: (link) => link.created_at,
      firstDirection: 'desc',
      hideBelow: 'lg',
    },
    {
      id: 'clicks',
      header: t('shortlinks.col.clicks'),
      cell: (link) => <span className="tabular-nums">{link.clicks.toLocaleString(locale)}</span>,
      align: 'right',
      sortable: true,
      sortValue: (link) => link.clicks,
      firstDirection: 'desc',
    },
  ];

  const error = links.error ?? folders.error ?? domains.error;

  return (
    <>
      <PageToolbar
        filters={
          <>
            <SearchInput value={q} onChange={setQ} placeholder={t('shortlinks.search')} />
            <ChoiceSelect
              value={folderFilter}
              onChange={setFolderFilter}
              emptyLabel={t('shortlinks.folder.all')}
              ariaLabel={t('shortlinks.field.folder')}
              choices={[
                { value: 'none', label: t('shortlinks.folder.none') },
                ...folderList.map((f) => ({ value: f.id, label: f.name })),
              ]}
            />
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={showArchived} onCheckedChange={setShowArchived} />
              {t('shortlinks.showArchived')}
            </label>
          </>
        }
        actions={
          <>
            <DashboardButton onClick={() => setOpen({ kind: 'folders' })}>
              <FolderCog aria-hidden /> {t('shortlinks.folders.title')}
            </DashboardButton>
            {writable ? (
              <DashboardButton
                variant="primary"
                disabled={verifiedDomains.length === 0}
                onClick={() => setOpen({ kind: 'edit', link: null })}
              >
                <Plus aria-hidden /> {t('shortlinks.new')}
              </DashboardButton>
            ) : null}
          </>
        }
      />
      {domains.isSuccess && verifiedDomains.length === 0 ? (
        <PageBody className="pb-0">
          <Alert>
            <Waypoints aria-hidden />
            <AlertTitle>{t('shortlinks.noDomain.title')}</AlertTitle>
            <AlertDescription>
              <span>
                {t('shortlinks.noDomain.body')}{' '}
                <Link to="/t/$tenant/settings/domains" params={{ tenant: slug }} className="underline">
                  {t('shortlinks.noDomain.link')}
                </Link>
              </span>
            </AlertDescription>
          </Alert>
        </PageBody>
      ) : null}
      {error ? (
        <PageBody>
          <ApiErrorNotice error={error} message={errorMessage(t, error)} forbiddenTitle={t('shortlinks.error.forbidden')} />
        </PageBody>
      ) : (
        <ListTable<Shortlink>
          className="px-4"
          rows={rows}
          getRowId={(link) => link.id}
          getRowLabel={(link) => displayShortUrl(link)}
          columns={columns}
          labels={listTableLabels(t)}
          defaultSort={{ columnId: 'created', direction: 'desc' }}
          selectable={writable}
          loading={links.isPending}
          onRowOpen={(link) => setOpen(writable ? { kind: 'edit', link } : { kind: 'stats', link })}
          rowActions={(link) => [
            ...(writable
              ? [{ id: 'edit', label: t('shortlinks.edit'), icon: Pencil, onSelect: () => setOpen({ kind: 'edit', link }) }]
              : []),
            { id: 'stats', label: t('shortlinks.stats.title'), icon: BarChart3, onSelect: () => setOpen({ kind: 'stats', link }) },
            { id: 'qr', label: t('shortlinks.qr.title'), icon: QrCode, onSelect: () => setOpen({ kind: 'qr', link }) },
            ...(link.short_url !== null
              ? [
                  {
                    id: 'copy',
                    label: t('shortlinks.copy'),
                    icon: Copy,
                    onSelect: () => copy(link.short_url ?? '', t('shortlinks.copied')),
                  },
                ]
              : []),
          ]}
          deletion={
            writable
              ? {
                  confirm: true,
                  onDelete: async (selected) => {
                    await Promise.all(selected.map((link) => api.links.remove(link.id)));
                    await queryClient.invalidateQueries({ queryKey: shortlinkKeys.root(slug) });
                  },
                }
              : undefined
          }
          emptyState={
            <p className="py-10 text-center text-sm text-muted-foreground">
              {q !== '' || folderFilter !== '' ? t('shortlinks.emptyFiltered') : t('shortlinks.empty')}
            </p>
          }
        />
      )}
      {open?.kind === 'edit' ? (
        <LinkDialog
          link={open.link}
          domains={domainList}
          folders={folderList}
          defaultFolderId={folderFilter === 'none' ? '' : folderFilter}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === 'qr' ? <QrDialog link={open.link} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'stats' ? <StatsDialog link={open.link} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'folders' ? (
        <FoldersDialog
          folders={folderList}
          domains={domainList}
          writable={writable}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

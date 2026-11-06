import type { ShortlinkDomain, ShortlinkFolder } from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Checkbox } from '@amable/ui/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Check, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { useShortlinkMutation, useShortlinks } from '../api/hooks';

function DomainPicker({
  domains,
  value,
  onChange,
  disabled,
}: {
  domains: readonly ShortlinkDomain[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  if (domains.length === 0) return <p className="text-xs text-muted-foreground">{t('shortlinks.folders.noDomains')}</p>;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
      {domains.map((d) => (
        <label key={d.id} className="flex items-center gap-1.5 text-xs">
          <Checkbox
            checked={value.includes(d.id)}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange(checked === true ? [...value, d.id] : value.filter((id) => id !== d.id))
            }
          />
          {d.hostname}
        </label>
      ))}
    </div>
  );
}

function FolderRow({
  folder,
  domains,
  writable,
}: {
  folder: ShortlinkFolder;
  domains: readonly ShortlinkDomain[];
  writable: boolean;
}) {
  const { t } = useI18n();
  const { api } = useShortlinks();
  const [name, setName] = useState(folder.name);
  const [domainIds, setDomainIds] = useState<string[]>(folder.domain_ids);
  const dirty =
    name.trim() !== folder.name ||
    domainIds.length !== folder.domain_ids.length ||
    domainIds.some((id) => !folder.domain_ids.includes(id));
  const update = useShortlinkMutation({
    mutationFn: () => api.folders.update(folder.id, { name: name.trim(), domain_ids: domainIds }),
    success: t('shortlinks.saved'),
  });
  const remove = useShortlinkMutation({
    mutationFn: () => api.folders.remove(folder.id),
    success: t('shortlinks.folders.deleted'),
  });
  return (
    <li className="grid gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          aria-label={t('shortlinks.folders.name')}
          disabled={!writable}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          className="h-8"
        />
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('shortlinks.folders.linkCount', { count: folder.link_count })}
        </span>
        {writable ? (
          <>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t('common.save')}
              disabled={!dirty || name.trim() === '' || update.isPending}
              onClick={() => update.mutate(undefined)}
            >
              <Check aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t('shortlinks.folders.delete')}
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(t('shortlinks.folders.confirmDelete', { name: folder.name }))) remove.mutate(undefined);
              }}
            >
              <Trash2 aria-hidden />
            </Button>
          </>
        ) : null}
      </div>
      <DomainPicker domains={domains} value={domainIds} onChange={setDomainIds} disabled={!writable} />
    </li>
  );
}

export function FoldersDialog({
  folders,
  domains,
  writable,
  onClose,
}: {
  folders: readonly ShortlinkFolder[];
  domains: readonly ShortlinkDomain[];
  writable: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { api } = useShortlinks();
  const [name, setName] = useState('');
  const [domainIds, setDomainIds] = useState<string[]>([]);
  const create = useShortlinkMutation({
    mutationFn: () => api.folders.create({ name: name.trim(), domain_ids: domainIds }),
    success: t('shortlinks.folders.created'),
    onSuccess: () => {
      setName('');
      setDomainIds([]);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '') create.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('shortlinks.folders.title')}</DialogTitle>
          <DialogDescription>{t('shortlinks.folders.description')}</DialogDescription>
        </DialogHeader>
        {writable ? (
          <form onSubmit={submit} className="grid gap-2 rounded-lg border border-dashed p-3">
            <div className="flex gap-2">
              <Input
                value={name}
                maxLength={120}
                placeholder={t('shortlinks.folders.newPlaceholder')}
                aria-label={t('shortlinks.folders.name')}
                onChange={(e) => setName(e.target.value)}
                className="h-8"
              />
              <Button type="submit" size="sm" disabled={name.trim() === '' || create.isPending}>
                <Plus aria-hidden /> {t('shortlinks.folders.create')}
              </Button>
            </div>
            <DomainPicker domains={domains} value={domainIds} onChange={setDomainIds} />
          </form>
        ) : null}
        {folders.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{t('shortlinks.folders.empty')}</p>
        ) : (
          <ul className="grid gap-2">
            {folders.map((folder) => (
              <FolderRow
                key={`${folder.id}:${folder.name}:${folder.domain_ids.join(',')}`}
                folder={folder}
                domains={domains}
                writable={writable}
              />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

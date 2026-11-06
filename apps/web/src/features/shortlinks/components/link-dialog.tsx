import {
  SHORTLINK_UTM_FIELDS,
  type CreateShortlinkInput,
  type Shortlink,
  type ShortlinkDomain,
  type ShortlinkFolder,
  type ShortlinkUtmField,
} from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
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
import { Switch } from '@amable/ui/ui/switch';
import { Textarea } from '@amable/ui/ui/textarea';
import { useMemo, useState, type FormEvent } from 'react';
import { ChoiceSelect, FormField } from '../../../components/feature-kit';
import { useI18n } from '../../../i18n';
import { useShortlinkMutation, useShortlinks } from '../api/hooks';
import { composePreview, fromLocalInput, toLocalInput } from '../lib/links';

const KEY_RE = /^[a-zA-Z0-9_-]{0,64}$/;

/** Domains a link may use: the folder's ones when it has any, else every given domain. */
export function domainChoices(
  domains: readonly ShortlinkDomain[],
  folder: ShortlinkFolder | undefined,
): ShortlinkDomain[] {
  if (folder === undefined || folder.domain_ids.length === 0) return [...domains];
  return domains.filter((d) => folder.domain_ids.includes(d.id));
}

export function LinkDialog({
  link,
  domains,
  folders,
  defaultFolderId,
  onClose,
}: {
  link: Shortlink | null;
  domains: readonly ShortlinkDomain[];
  folders: readonly ShortlinkFolder[];
  defaultFolderId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { api } = useShortlinks();
  const [folderId, setFolderId] = useState(link?.folder_id ?? defaultFolderId);
  const folder = folders.find((f) => f.id === folderId);
  // Verified domains only, plus the current one of the link (it may have lost its verification).
  const usable = useMemo(
    () => domains.filter((d) => d.status === 'verified' || d.id === link?.domain_id),
    [domains, link?.domain_id],
  );
  const choices = domainChoices(usable, folder);
  const [domainId, setDomainId] = useState(link?.domain_id ?? choices[0]?.id ?? '');
  const effectiveDomain = choices.some((d) => d.id === domainId) ? domainId : (choices[0]?.id ?? '');
  const [key, setKey] = useState(link?.key ?? '');
  const [url, setUrl] = useState(link?.url ?? '');
  const [title, setTitle] = useState(link?.title ?? '');
  const [utm, setUtm] = useState<Record<ShortlinkUtmField, string>>(() => {
    const initial = {} as Record<ShortlinkUtmField, string>;
    for (const field of SHORTLINK_UTM_FIELDS) initial[field] = link?.[field] ?? '';
    return initial;
  });
  const [passQuery, setPassQuery] = useState(link?.pass_query ?? false);
  const [expiresAt, setExpiresAt] = useState(toLocalInput(link?.expires_at ?? null));
  const [expiredUrl, setExpiredUrl] = useState(link?.expired_url ?? '');
  const [ogTitle, setOgTitle] = useState(link?.og_title ?? '');
  const [ogDescription, setOgDescription] = useState(link?.og_description ?? '');
  const [ogImage, setOgImage] = useState(link?.og_image ?? '');
  const [archived, setArchived] = useState(link?.archived ?? false);

  const keyValid = KEY_RE.test(key) && (link === null || key !== '');
  const canSubmit = effectiveDomain !== '' && url.trim() !== '' && keyValid;
  const preview = url.trim() === '' ? '' : composePreview(url.trim(), utm);
  const host = usable.find((d) => d.id === effectiveDomain)?.hostname ?? '';

  const save = useShortlinkMutation({
    mutationFn: () => {
      const nullable = (value: string) => (value.trim() === '' ? null : value.trim());
      const body = {
        folder_id: folderId === '' ? null : folderId,
        url: url.trim(),
        title: nullable(title),
        utm_source: nullable(utm.utm_source),
        utm_medium: nullable(utm.utm_medium),
        utm_campaign: nullable(utm.utm_campaign),
        utm_term: nullable(utm.utm_term),
        utm_content: nullable(utm.utm_content),
        pass_query: passQuery,
        expires_at: fromLocalInput(expiresAt),
        expired_url: nullable(expiredUrl),
        og_title: nullable(ogTitle),
        og_description: nullable(ogDescription),
        og_image: nullable(ogImage),
        archived,
      } satisfies Omit<CreateShortlinkInput, 'domain_id' | 'key'>;
      return link === null
        ? api.links.create({ ...body, domain_id: effectiveDomain, key: key.trim() })
        : api.links.update(link.id, { ...body, domain_id: effectiveDomain, key: key.trim() });
    },
    success: t('shortlinks.saved'),
    onSuccess: onClose,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) save.mutate(undefined);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{link === null ? t('shortlinks.new') : t('shortlinks.edit')}</DialogTitle>
            <DialogDescription>{t('shortlinks.dialog.description')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('shortlinks.field.folder')}>
              {(id) => (
                <ChoiceSelect
                  id={id}
                  value={folderId}
                  onChange={setFolderId}
                  emptyLabel={t('shortlinks.folder.none')}
                  choices={folders.map((f) => ({ value: f.id, label: f.name }))}
                  className="w-full"
                />
              )}
            </FormField>
            <FormField
              label={t('shortlinks.field.domain')}
              hint={folder !== undefined && folder.domain_ids.length > 0 ? t('shortlinks.field.domainFolderHint') : undefined}
            >
              {(id) => (
                <ChoiceSelect
                  id={id}
                  value={effectiveDomain}
                  onChange={setDomainId}
                  placeholder={t('shortlinks.field.domainPlaceholder')}
                  choices={choices.map((d) => ({ value: d.id, label: d.hostname }))}
                  className="w-full"
                />
              )}
            </FormField>
            <FormField
              label={t('shortlinks.field.key')}
              hint={host !== '' ? `${host}/${key.trim() === '' ? '…' : key.trim()}` : undefined}
              error={keyValid ? null : t('shortlinks.field.keyInvalid')}
            >
              {(id) => (
                <Input
                  id={id}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={link === null ? t('shortlinks.field.keyPlaceholder') : undefined}
                  maxLength={64}
                />
              )}
            </FormField>
            <FormField label={t('shortlinks.field.title')}>
              {(id) => (
                <Input id={id} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
              )}
            </FormField>
            <FormField label={t('shortlinks.field.url')} className="sm:col-span-2">
              {(id) => (
                <Input
                  id={id}
                  type="url"
                  required
                  autoFocus={link === null}
                  value={url}
                  maxLength={2000}
                  placeholder="https://example.com/offer"
                  onChange={(e) => setUrl(e.target.value)}
                />
              )}
            </FormField>
          </div>

          <fieldset className="grid gap-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{t('shortlinks.utm.title')}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {SHORTLINK_UTM_FIELDS.map((field) => (
                <FormField key={field} label={field}>
                  {(id) => (
                    <Input
                      id={id}
                      value={utm[field]}
                      maxLength={200}
                      onChange={(e) => setUtm((prev) => ({ ...prev, [field]: e.target.value }))}
                    />
                  )}
                </FormField>
              ))}
            </div>
            {preview !== '' ? (
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">{t('shortlinks.utm.preview')}</span>
                <code className="break-all rounded bg-muted px-2 py-1 text-xs">{preview}</code>
              </div>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={passQuery} onCheckedChange={setPassQuery} />
              <span>
                {t('shortlinks.field.passQuery')}
                <span className="block text-xs text-muted-foreground">{t('shortlinks.field.passQueryHint')}</span>
              </span>
            </label>
          </fieldset>

          <fieldset className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
            <legend className="px-1 text-sm font-medium">{t('shortlinks.expiry.title')}</legend>
            <FormField label={t('shortlinks.field.expiresAt')}>
              {(id) => (
                <Input id={id} type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              )}
            </FormField>
            <FormField label={t('shortlinks.field.expiredUrl')} hint={t('shortlinks.field.expiredUrlHint')}>
              {(id) => (
                <Input
                  id={id}
                  type="url"
                  value={expiredUrl}
                  maxLength={2000}
                  disabled={expiresAt === ''}
                  onChange={(e) => setExpiredUrl(e.target.value)}
                />
              )}
            </FormField>
          </fieldset>

          <fieldset className="grid gap-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{t('shortlinks.og.title')}</legend>
            <p className="text-xs text-muted-foreground">{t('shortlinks.og.hint')}</p>
            <FormField label={t('shortlinks.field.ogTitle')}>
              {(id) => <Input id={id} value={ogTitle} maxLength={300} onChange={(e) => setOgTitle(e.target.value)} />}
            </FormField>
            <FormField label={t('shortlinks.field.ogDescription')}>
              {(id) => (
                <Textarea
                  id={id}
                  rows={2}
                  value={ogDescription}
                  maxLength={600}
                  onChange={(e) => setOgDescription(e.target.value)}
                />
              )}
            </FormField>
            <FormField label={t('shortlinks.field.ogImage')}>
              {(id) => (
                <Input
                  id={id}
                  type="url"
                  value={ogImage}
                  maxLength={2000}
                  placeholder="https://…"
                  onChange={(e) => setOgImage(e.target.value)}
                />
              )}
            </FormField>
          </fieldset>

          <div className="flex items-center gap-2">
            <Switch id="shortlink-archived" checked={archived} onCheckedChange={setArchived} />
            <Label htmlFor="shortlink-archived">{t('shortlinks.field.archived')}</Label>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit || save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

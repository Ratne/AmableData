import type { Permission } from '@amable/core';
import { DashboardButton, PageBody, PageToolbar, usePageChrome } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import { Checkbox } from '@amable/ui/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@amable/ui/ui/table';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BookOpen, KeyRound, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { devKeys, useDevelopersApi, useDevMutation, useTenantAccess, type ApiKey } from '../api';
import { formatDateTime, Pill, SecretReveal, useStepUp } from '../components';

type Preset = 'read' | 'full' | 'custom';

function groupScopes(permissions: readonly Permission[]): Array<[string, Permission[]]> {
  const groups = new Map<string, Permission[]>();
  for (const p of permissions) {
    const group = p.split(':')[0] ?? p;
    groups.set(group, [...(groups.get(group) ?? []), p]);
  }
  return [...groups.entries()];
}

export function ApiKeysPage() {
  const { t, locale } = useI18n();
  const { slug, api } = useDevelopersApi();
  const access = useTenantAccess();
  usePageChrome({ title: t('dev.apiKeys.title') });
  const keys = useQuery({ queryKey: devKeys.apiKeys(slug), queryFn: api.apiKeys.list, enabled: access.can('api_keys:manage') });
  const { guard, dialog: stepUpDialog } = useStepUp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<Preset>('read');
  const [custom, setCustom] = useState<Set<Permission>>(new Set());
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);

  const available = access.permissions;
  const readScopes = useMemo(() => available.filter((p) => p.endsWith(':read') || p.endsWith('_read')), [available]);
  const scopes: Permission[] = preset === 'read' ? readScopes : preset === 'full' ? [...available] : [...custom];

  const create = useDevMutation({
    mutationFn: () => api.apiKeys.create({ name: name.trim(), scopes }),
    invalidate: [devKeys.apiKeys(slug)],
    onSuccess: (result) => {
      setCreated({ key: result.key, name: name.trim() });
      setOpen(false);
      setName('');
    },
    onError: (error) => guard(error, () => create.mutate(undefined)),
  });
  const revoke = useDevMutation({
    mutationFn: (id: string) => api.apiKeys.revoke(id),
    invalidate: [devKeys.apiKeys(slug)],
    success: t('dev.apiKeys.revoked'),
    onError: (error, id) => guard(error, () => revoke.mutate(id)),
  });

  if (access.ready && !access.can('api_keys:manage')) {
    return <PageBody className="pt-4 text-sm">{t('dev.noAccess')}</PageBody>;
  }
  const rows: ApiKey[] = keys.data?.apiKeys ?? [];
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <>
      <PageToolbar
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/t/$tenant/settings/api-docs" params={{ tenant: slug }}>
                <BookOpen className="size-4" />
                {t('dev.docs.open')}
              </Link>
            </Button>
            <DashboardButton variant="primary" onClick={() => setOpen(true)}>
              <Plus className="size-4" />
              {t('dev.apiKeys.new')}
            </DashboardButton>
          </>
        }
      />
      <PageBody className="grid max-w-5xl gap-4 pt-4">
        <p className="text-sm text-(--obsidian-dashboard-shell-text-subtle)">{t('dev.apiKeys.intro')}</p>
        {created !== null ? (
          <div className="grid gap-2">
            <SecretReveal title={t('dev.apiKeys.createdTitle', { name: created.name })} value={created.key} hint={t('dev.apiKeys.createdHint')} />
            <pre className="overflow-x-auto rounded-lg border border-border p-3 font-mono text-xs">
              {`curl -H "Authorization: Bearer ${created.key}" \\\n  ${origin}/api/v2/t/${slug}/contacts?limit=5`}
            </pre>
            <div>
              <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
                {t('dev.done')}
              </Button>
            </div>
          </div>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4" />
              {t('dev.apiKeys.listTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <p className="text-sm">{keys.isPending ? t('common.loading') : t('dev.apiKeys.empty')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('dev.apiKeys.name')}</TableHead>
                    <TableHead>{t('dev.apiKeys.key')}</TableHead>
                    <TableHead>{t('dev.apiKeys.scopes')}</TableHead>
                    <TableHead>{t('dev.apiKeys.created')}</TableHead>
                    <TableHead>{t('dev.apiKeys.lastUsed')}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell className="font-medium">{key.name}</TableCell>
                      <TableCell className="font-mono text-xs">{key.prefix}…</TableCell>
                      <TableCell title={key.scopes.join(', ')}>{t('dev.apiKeys.scopeCount', { count: key.scopes.length })}</TableCell>
                      <TableCell>{formatDateTime(locale, key.createdAt)}</TableCell>
                      <TableCell>{key.lastUsedAt === null ? t('dev.never') : formatDateTime(locale, key.lastUsedAt)}</TableCell>
                      <TableCell className="text-right">
                        {key.revokedAt !== null ? (
                          <Pill tone="neutral">{t('dev.apiKeys.revokedPill')}</Pill>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              if (window.confirm(t('dev.apiKeys.confirmRevoke', { name: key.name }))) revoke.mutate(key.id);
                            }}
                          >
                            {t('dev.apiKeys.revoke')}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </PageBody>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('dev.apiKeys.new')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="key-name">{t('dev.apiKeys.name')}</Label>
              <Input id="key-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t('dev.apiKeys.namePlaceholder')} />
            </div>
            <div className="grid gap-2">
              <Label>{t('dev.apiKeys.scopes')}</Label>
              <div className="flex flex-wrap gap-2">
                {(['read', 'full', 'custom'] as const).map((p) => (
                  <Button key={p} type="button" size="sm" variant={preset === p ? 'default' : 'outline'} onClick={() => setPreset(p)}>
                    {t(`dev.apiKeys.preset.${p}`)}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{t('dev.apiKeys.scopeHint')}</p>
              {preset === 'custom' ? (
                <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
                  {groupScopes(available).map(([group, perms]) => (
                    <fieldset key={group} className="grid gap-1">
                      <legend className="text-xs font-semibold uppercase tracking-wide">{group}</legend>
                      {perms.map((p) => (
                        <label key={p} className="flex items-center gap-2 font-mono text-xs">
                          <Checkbox
                            checked={custom.has(p)}
                            onCheckedChange={(checked) =>
                              setCustom((prev) => {
                                const next = new Set(prev);
                                if (checked === true) next.add(p);
                                else next.delete(p);
                                return next;
                              })
                            }
                          />
                          {p}
                        </label>
                      ))}
                    </fieldset>
                  ))}
                </div>
              ) : (
                <p className="font-mono text-xs leading-relaxed">{scopes.join(', ')}</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={name.trim() === '' || scopes.length === 0 || create.isPending} onClick={() => create.mutate(undefined)}>
              {t('dev.apiKeys.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {stepUpDialog}
    </>
  );
}

import type { GlobalSearchHit } from '@amable/api-types/crm';
import { DashboardButton } from '@amable/ui';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@amable/ui/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Kbd } from '@amable/ui/ui/kbd';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Building2, FileText, Search, ShoppingCart, User } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { crmClient } from '../crm/api/client';

const ICONS = { contact: User, company: Building2, note: FileText, order: ShoppingCart } as const;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Global search (Cmd/Ctrl+K): full-text over contacts, companies and notes via
 * `GET /search?q=`. Mounted once in the workspace header.
 */
export function GlobalSearch({ tenant }: { tenant: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const api = useMemo(() => crmClient(tenant), [tenant]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const term = useDebounced(q.trim(), 200);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const results = useQuery({
    queryKey: ['crm', tenant, 'globalSearch', term],
    queryFn: () => api.search.global(term, 20),
    enabled: open && term.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const groups = useMemo(() => {
    const byType = new Map<GlobalSearchHit['type'], GlobalSearchHit[]>();
    for (const hit of results.data?.data ?? []) {
      byType.set(hit.type, [...(byType.get(hit.type) ?? []), hit]);
    }
    return [...byType.entries()];
  }, [results.data]);

  const openHit = async (hit: GlobalSearchHit) => {
    setOpen(false);
    setQ('');
    if (hit.type === 'contact') {
      await navigate({
        to: '/t/$tenant/contacts/$contactId',
        params: { tenant, contactId: hit.id },
      });
    } else if (hit.type === 'company') {
      await navigate({
        to: '/t/$tenant/companies/$companyId',
        params: { tenant, companyId: hit.id },
      });
    } else if (hit.type === 'note') {
      const found = await api.notes.get(hit.id).catch(() => null);
      if (found?.contact_id)
        await navigate({
          to: '/t/$tenant/contacts/$contactId',
          params: { tenant, contactId: found.contact_id },
        });
      else if (found?.company_id)
        await navigate({
          to: '/t/$tenant/companies/$companyId',
          params: { tenant, companyId: found.company_id },
        });
    }
  };

  return (
    <>
      <DashboardButton
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={t('search.global.open')}
        aria-keyshortcuts="Meta+K Control+K"
        className="gap-2"
      >
        <Search className="size-4" aria-hidden />
        <span className="hidden text-muted-foreground lg:inline">{t('search.global.button')}</span>
        <Kbd className="hidden lg:inline-flex">⌘K</Kbd>
      </DashboardButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-hidden p-0" showCloseButton={false}>
          <DialogHeader className="sr-only">
            <DialogTitle>{t('search.global.title')}</DialogTitle>
            <DialogDescription>{t('search.global.description')}</DialogDescription>
          </DialogHeader>
          <Command shouldFilter={false}>
            <CommandInput
              value={q}
              onValueChange={setQ}
              placeholder={t('search.global.placeholder')}
              aria-label={t('search.global.placeholder')}
            />
            <CommandList>
              {term.length > 0 && !results.isFetching && groups.length === 0 ? (
                <CommandEmpty>{t('search.global.empty')}</CommandEmpty>
              ) : null}
              {term.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {t('search.global.hint')}
                </p>
              ) : null}
              {groups.map(([type, hits]) => {
                const Icon = ICONS[type];
                return (
                  <CommandGroup key={type} heading={t(`search.global.type.${type}`)}>
                    {hits.map((hit) => (
                      <CommandItem
                        key={`${hit.type}:${hit.id}`}
                        value={`${hit.type}:${hit.id}`}
                        onSelect={() => void openHit(hit)}
                      >
                        <Icon className="size-4 text-muted-foreground" aria-hidden />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{hit.title}</span>
                          {hit.snippet && hit.snippet !== hit.title ? (
                            <span className="truncate text-xs text-muted-foreground">
                              {hit.snippet}
                            </span>
                          ) : null}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}

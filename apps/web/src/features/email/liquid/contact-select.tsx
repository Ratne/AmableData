import type { Contact } from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '../../../i18n';
import { emailKeys, useEmailApi } from '../api';
import { contactLabel } from '../components';

/** Server-side contact search with cursor pagination ("load more"), for previews against a real contact. */
export function ContactSelect({
  value,
  onChange,
}: {
  value: Contact | null;
  onChange: (contact: Contact | null) => void;
}) {
  const { t } = useI18n();
  const { slug, api } = useEmailApi();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [q]);
  const pages = useInfiniteQuery({
    queryKey: emailKeys.crm(slug, `liquid-contacts:${debounced}`),
    queryFn: ({ pageParam }) => api.crm.contactsPage(debounced, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: open,
  });
  const contacts = pages.data?.pages.flatMap((page) => page.data) ?? [];

  if (value !== null && !open) {
    return (
      <div className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm" data-testid="liquid-contact-selected">
        <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => setOpen(true)}>
          {contactLabel(value)}
        </button>
        <Button type="button" size="icon" variant="ghost" className="size-6" onClick={() => onChange(null)} aria-label={t('email.liquid.preview.useSample')}>
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }
  return (
    <div className="grid gap-1">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 opacity-60" />
        <Input
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          placeholder={t('email.preview.searchContact')}
          className="pl-7"
          aria-label={t('email.liquid.preview.contact')}
        />
      </div>
      {open ? (
        <div className="max-h-60 overflow-auto rounded-md border text-sm" role="listbox">
          {contacts.map((contact) => (
            <button
              key={contact.id}
              type="button"
              role="option"
              aria-selected={value?.id === contact.id}
              className="block w-full truncate px-2 py-1.5 text-left hover:bg-(--obsidian-dashboard-shell-muted)"
              onClick={() => {
                onChange(contact);
                setOpen(false);
                setQ('');
              }}
            >
              {contactLabel(contact)}
            </button>
          ))}
          {pages.isPending ? <p className="px-2 py-1.5 text-xs opacity-70">{t('email.liquid.loading')}</p> : null}
          {!pages.isPending && contacts.length === 0 ? (
            <p className="px-2 py-1.5 text-xs opacity-70">{t('email.liquid.preview.noContacts')}</p>
          ) : null}
          <div className="flex items-center justify-between gap-2 border-t px-2 py-1">
            {pages.hasNextPage ? (
              <Button type="button" variant="ghost" size="sm" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
                {t('email.liquid.preview.loadMore')}
              </Button>
            ) : (
              <span />
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {t('email.common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

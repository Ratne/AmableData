import type { Contact } from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { useQuery } from '@tanstack/react-query';
import { Check, Search, UserRound, X } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { commerceKeys, useCommerce } from '../api/hooks';
import { useDebounced } from './common';

export interface PickedContact {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export function contactLabel(contact: Contact): PickedContact {
  const name = [contact.given_name, contact.family_name].filter(Boolean).join(' ').trim();
  const email = contact.emails.find((e) => e.is_primary)?.email ?? contact.emails[0]?.email ?? '';
  return { id: contact.id, name, email };
}

/** Contact search (CRM full-text search) with a single selection. */
export function ContactPicker({
  value,
  onChange,
}: {
  value: PickedContact | null;
  onChange: (contact: PickedContact | null) => void;
}) {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.trim(), 250);
  const results = useQuery({
    queryKey: [...commerceKeys.contacts(slug), 'search', debounced],
    enabled: value === null,
    queryFn: async () => (await api.contacts.list({ q: debounced || undefined, limit: 8 })).data,
    staleTime: 30_000,
  });

  if (value !== null) {
    return (
      <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2">
        <UserRound className="size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{value.name || value.email || value.id}</p>
          {value.email && value.name ? (
            <p className="truncate text-xs text-muted-foreground">{value.email}</p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('commerce.wizard.changeContact')}
          onClick={() => onChange(null)}
        >
          <X aria-hidden />
        </Button>
      </div>
    );
  }

  const rows = results.data ?? [];
  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          autoFocus
          type="search"
          value={q}
          className="pl-9"
          placeholder={t('commerce.wizard.searchContact')}
          aria-label={t('commerce.wizard.searchContact')}
          onChange={(event) => setQ(event.target.value)}
        />
      </div>
      <ul className="grid gap-1" role="listbox" aria-label={t('commerce.wizard.contactResults')}>
        {results.isPending ? (
          <li className="px-3 py-2 text-sm text-muted-foreground">{t('common.loading')}</li>
        ) : rows.length === 0 ? (
          <li className="px-3 py-2 text-sm text-muted-foreground">
            {t('commerce.wizard.noContacts')}
          </li>
        ) : (
          rows.map((contact) => {
            const label = contactLabel(contact);
            return (
              <li key={contact.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  onClick={() => onChange(label)}
                >
                  <Check className="size-4 opacity-0" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {label.name || label.email || t('commerce.common.unnamed')}
                    </span>
                    {label.email && label.name ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {label.email}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

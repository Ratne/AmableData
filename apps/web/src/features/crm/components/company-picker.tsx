import { Badge } from '@amable/ui/ui/badge';
import { Input } from '@amable/ui/ui/input';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { crmKeys, useCrm } from '../api/hooks';

/** Type-ahead over `GET /companies?q=`; emits the chosen company (or null to clear). */
export function CompanyPicker({
  value,
  onChange,
  ariaLabel,
  autoFocus = true,
}: {
  value: { id: string; name: string } | null;
  onChange: (company: { id: string; name: string } | null) => void;
  ariaLabel?: string;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const [q, setQ] = useState(value?.name ?? '');
  const [open, setOpen] = useState(false);
  const results = useQuery({
    queryKey: [...crmKeys.companies(slug), 'picker', q],
    queryFn: () => api.companies.list({ q, limit: 8 }),
    enabled: open && q.trim().length >= 1,
  });
  return (
    <div className="relative">
      <Input
        value={q}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        autoFocus={autoFocus}
        placeholder={t('crm.companies.searchPlaceholder')}
        className="h-8"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQ(event.target.value);
          setOpen(true);
          if (event.target.value === '') onChange(null);
        }}
      />
      {open && (results.data?.data.length ?? 0) > 0 ? (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {(results.data?.data ?? []).map((company) => (
            <li key={company.id}>
              <button
                type="button"
                role="option"
                aria-selected={company.id === value?.id}
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => {
                  onChange({ id: company.id, name: company.name });
                  setQ(company.name);
                  setOpen(false);
                }}
              >
                {company.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function useCompanyName(id: string): string | null {
  const { slug, api } = useCrm();
  const company = useQuery({
    queryKey: crmKeys.company(slug, id),
    queryFn: () => api.companies.get(id),
    enabled: id !== '',
    retry: false,
  });
  return company.data?.name ?? null;
}

/** Company id chosen by name (query builder `company_id` conditions). */
export function CompanyIdSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
}) {
  const name = useCompanyName(value);
  return (
    <div className="w-56">
      <CompanyPicker
        key={name ?? value}
        autoFocus={false}
        value={value && name ? { id: value, name } : null}
        onChange={(company) => onChange(company?.id ?? '')}
        ariaLabel={ariaLabel}
      />
    </div>
  );
}

function CompanyChip({ id, onRemove }: { id: string; onRemove: () => void }) {
  const { t } = useI18n();
  const name = useCompanyName(id);
  return (
    <Badge variant="secondary" className="gap-1">
      {name ?? id}
      <button
        type="button"
        className="rounded-full hover:text-destructive"
        aria-label={t('crm.common.remove')}
        onClick={onRemove}
      >
        <X className="size-3" aria-hidden />
      </button>
    </Badge>
  );
}

/** Several companies chosen by name (`in` / `not_in` on `company_id`). */
export function CompanyIdsSelect({
  values,
  onChange,
  ariaLabel,
}: {
  values: readonly string[];
  onChange: (ids: string[]) => void;
  ariaLabel?: string;
}) {
  const [round, setRound] = useState(0);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((id) => (
        <CompanyChip key={id} id={id} onRemove={() => onChange(values.filter((v) => v !== id))} />
      ))}
      <div className="w-48">
        <CompanyPicker
          key={round}
          autoFocus={round > 0}
          value={null}
          ariaLabel={ariaLabel}
          onChange={(company) => {
            if (company && !values.includes(company.id)) onChange([...values, company.id]);
            if (company) setRound((r) => r + 1);
          }}
        />
      </div>
    </div>
  );
}

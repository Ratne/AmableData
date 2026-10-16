import { LIQUID_FIELD_GROUPS, type LiquidSchema, type LiquidSchemaField } from '@amable/api-types';
import { Badge } from '@amable/ui/ui/badge';
import { Input } from '@amable/ui/ui/input';
import { ChevronDown, ChevronRight, Lock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { codeForField, fieldLabel, GROUP_LABELS } from './schema';

/** Searchable tree of every context variable; a click inserts it (with the fallback) at the cursor. */
export function FieldTree({ schema, onPick }: { schema: LiquidSchema | undefined; onPick: (code: string) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [fallback, setFallback] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const needle = q.trim().toLowerCase();
  const groups = useMemo(() => {
    const fields = schema?.fields ?? [];
    return LIQUID_FIELD_GROUPS.map((group) => ({
      group,
      fields: fields.filter(
        (f) =>
          f.group === group &&
          (needle === '' || f.path.toLowerCase().includes(needle) || fieldLabel(t, f).toLowerCase().includes(needle)),
      ),
    })).filter((g) => g.fields.length > 0);
  }, [schema, needle, t]);

  const toggle = (group: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('email.liquid.fields.search')} aria-label={t('email.liquid.fields.search')} />
        <Input
          value={fallback}
          onChange={(e) => setFallback(e.target.value)}
          placeholder={t('email.liquid.fields.fallbackPlaceholder')}
          aria-label={t('email.liquid.fields.fallback')}
        />
      </div>
      <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{t('email.liquid.fields.hint')}</p>
      {groups.length === 0 ? <p className="text-sm opacity-70">{t('email.liquid.fields.none')}</p> : null}
      {groups.map(({ group, fields }) => (
        <section key={group} className="grid gap-1">
          <button type="button" className="flex items-center gap-1 text-left text-xs font-semibold tracking-wide uppercase opacity-80" onClick={() => toggle(group)}>
            {collapsed.has(group) ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {t(GROUP_LABELS[group])} <span className="font-normal">({fields.length})</span>
          </button>
          {collapsed.has(group) ? null : (
            <ul className="grid gap-0.5">
              {fields.map((field) => (
                <FieldRow key={field.path} field={field} onPick={() => onPick(codeForField(field, fallback))} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function FieldRow({ field, onPick }: { field: LiquidSchemaField; onPick: () => void }) {
  const { t } = useI18n();
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-(--obsidian-dashboard-shell-muted)"
        title={t('email.liquid.fields.insert')}
        data-path={field.path}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate">{fieldLabel(t, field)}</span>
          <code className="block truncate text-[11px] opacity-70">{field.path}</code>
        </span>
        {field.masked ? <Lock className="size-3.5 opacity-70" aria-label={t('email.liquid.fields.masked')} /> : null}
        <Badge variant="outline" className="text-[10px]">
          {field.custom_field_type ?? field.kind}
        </Badge>
      </button>
    </li>
  );
}

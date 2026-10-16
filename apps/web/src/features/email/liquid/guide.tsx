import type { LiquidSchema } from '@amable/api-types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { LiquidCode } from './code-editor';
import { LIQUID_GUIDE, type GuideBlock, type GuideSection } from './guide-content';
import { fieldLabel, GROUP_LABELS, useLiquidSchema } from './schema';
import './liquid.css';

function highlight(text: string, needle: string, key: string): ReactNode {
  if (needle === '') return text;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  let index = lower.indexOf(needle);
  while (index !== -1) {
    if (index > from) parts.push(text.slice(from, index));
    parts.push(<mark key={`${key}-${String(index)}`}>{text.slice(index, index + needle.length)}</mark>);
    from = index + needle.length;
    index = lower.indexOf(needle, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

/** Text with `inline code`, search matches highlighted. */
function Rich({ text, needle }: { text: string; needle: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? <code key={i}>{highlight(part, needle, String(i))}</code> : <Fragment key={i}>{highlight(part, needle, String(i))}</Fragment>,
      )}
    </>
  );
}

function blockText(block: GuideBlock): string {
  switch (block.type) {
    case 'p':
      return block.text;
    case 'list':
      return block.items.join(' ');
    case 'code':
      return `${block.code} ${block.note ?? ''}`;
    default:
      return '';
  }
}

function SchemaBlock({ block, schema, needle }: { block: GuideBlock; schema: LiquidSchema | undefined; needle: string }) {
  const { t } = useI18n();
  if (schema === undefined) return <p className="text-sm opacity-70">{t('email.liquid.loading')}</p>;
  if (block.type === 'fields') {
    const rows = schema.fields.filter(
      (f) => needle === '' || f.path.toLowerCase().includes(needle) || fieldLabel(t, f).toLowerCase().includes(needle),
    );
    return (
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-left text-xs" data-testid="liquid-guide-fields">
          <thead className="bg-(--obsidian-dashboard-shell-muted)">
            <tr>
              <th className="px-2 py-1.5">{t('email.liquid.guide.colField')}</th>
              <th className="px-2 py-1.5">{t('email.liquid.guide.colLiquid')}</th>
              <th className="px-2 py-1.5">{t('email.liquid.guide.colType')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.path} className="border-t">
                <td className="px-2 py-1">
                  {fieldLabel(t, f)} <span className="opacity-60">· {t(GROUP_LABELS[f.group])}</span>
                </td>
                <td className="px-2 py-1">
                  <code>{f.path === 'now' ? '"now" | date: "…"' : `{{ ${f.path} }}`}</code>
                </td>
                <td className="px-2 py-1">{f.custom_field_type ?? f.kind}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.type === 'filters') {
    return (
      <p className="flex flex-wrap gap-1" data-testid="liquid-guide-filters">
        {schema.filters.map((name) => (
          <code key={name}>{highlight(name, needle, name)}</code>
        ))}
      </p>
    );
  }
  if (block.type === 'limits') {
    const l = schema.limits;
    return (
      <ul className="list-disc pl-5">
        <li>{t('email.liquid.guide.limitSize', { kb: Math.round(l.template_bytes / 1000) })}</li>
        <li>{t('email.liquid.guide.limitTime', { ms: l.render_ms, snippetMs: l.snippet_render_ms })}</li>
        <li>{t('email.liquid.guide.limitMemory', { mb: Math.round(l.memory_bytes / 1_000_000) })}</li>
      </ul>
    );
  }
  return null;
}

function Section({ section, schema, needle }: { section: GuideSection; schema: LiquidSchema | undefined; needle: string }) {
  return (
    <section id={`liquid-guide-${section.id}`} className="grid scroll-mt-4 gap-2">
      <h3>{highlight(section.title, needle, section.id)}</h3>
      {section.blocks.map((block, i) => {
        switch (block.type) {
          case 'p':
            return (
              <p key={i}>
                <Rich text={block.text} needle={needle} />
              </p>
            );
          case 'list':
            return (
              <ul key={i} className="list-disc pl-5">
                {block.items.map((item, k) => (
                  <li key={k}>
                    <Rich text={item} needle={needle} />
                  </li>
                ))}
              </ul>
            );
          case 'code':
            return (
              <div key={i} className="grid gap-1">
                <LiquidCode code={block.code} className="rounded-md border bg-(--obsidian-dashboard-shell-muted) p-2" />
                {block.note !== undefined ? (
                  <p className="text-xs opacity-80">
                    <Rich text={block.note} needle={needle} />
                  </p>
                ) : null}
              </div>
            );
          default:
            return <SchemaBlock key={i} block={block} schema={schema} needle={needle} />;
        }
      })}
    </section>
  );
}

/** The Dynamic Content / Liquid guide with a searchable table of contents. */
export function GuideView({ compact = false }: { compact?: boolean }) {
  const { t, locale } = useI18n();
  const { schema } = useLiquidSchema();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const sections = useMemo(() => {
    const all = LIQUID_GUIDE[locale];
    if (needle === '') return all;
    return all.filter(
      (s) =>
        s.title.toLowerCase().includes(needle) ||
        s.blocks.some((b) => blockText(b).toLowerCase().includes(needle)) ||
        (s.blocks.some((b) => b.type === 'fields') &&
          (schema?.fields ?? []).some((f) => f.path.includes(needle) || fieldLabel(t, f).toLowerCase().includes(needle))) ||
        (s.blocks.some((b) => b.type === 'filters') && (schema?.filters ?? []).some((name) => name.includes(needle))),
    );
  }, [locale, needle, schema, t]);
  const jump = (id: string) =>
    document.getElementById(`liquid-guide-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className={compact ? 'grid gap-3' : 'grid h-full min-h-0 gap-4 md:grid-cols-[14rem_1fr]'}>
      <nav className="grid content-start gap-2" aria-label={t('email.liquid.guide.toc')}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('email.liquid.guide.search')} aria-label={t('email.liquid.guide.search')} />
        <ul className={compact ? 'flex flex-wrap gap-1' : 'grid gap-0.5'}>
          {sections.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={
                  compact
                    ? 'rounded-full border px-2 py-0.5 text-xs hover:bg-(--obsidian-dashboard-shell-muted)'
                    : 'w-full rounded px-2 py-1 text-left text-sm hover:bg-(--obsidian-dashboard-shell-muted)'
                }
                onClick={() => jump(s.id)}
              >
                {s.title}
              </button>
            </li>
          ))}
        </ul>
        {sections.length === 0 ? <p className="text-sm opacity-70">{t('email.liquid.guide.noResults')}</p> : null}
      </nav>
      <article className={['liquid-guide grid content-start gap-4', compact ? '' : 'min-h-0 overflow-y-auto pr-2'].join(' ')} data-testid="liquid-guide">
        {sections.map((s) => (
          <Section key={s.id} section={s} schema={schema} needle={needle} />
        ))}
      </article>
    </div>
  );
}

export function GuideDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t('email.liquid.guide.title')}</DialogTitle>
          <DialogDescription>{t('email.liquid.guide.subtitle')}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          <GuideView />
        </div>
      </DialogContent>
    </Dialog>
  );
}

import type { Contact, LiquidPreviewIssue } from '@amable/api-types';
import { validateLiquid } from '@amable/email-render';
import { Label } from '@amable/ui/ui/label';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info, RefreshCw, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { emailKeys, errorMessage, useEmailApi } from '../api';
import { CodeEditor } from './code-editor';
import { ContactSelect } from './contact-select';

export interface DocumentSource {
  readonly label: string;
  /** Current Liquid of the snippet / email being edited. */
  readonly get: () => string;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function IssueList({ errors }: { errors: readonly LiquidPreviewIssue[] }) {
  const { t } = useI18n();
  if (errors.length === 0) return null;
  return (
    <ul className="grid gap-1" data-testid="liquid-errors">
      {errors.map((error, index) => (
        <li key={index} className="flex items-start gap-1.5 rounded-md bg-red-500/10 px-2 py-1.5 text-xs text-(--obsidian-dashboard-shell-danger)">
          <XCircle className="mt-0.5 size-3.5 flex-none" />
          <span>
            {error.line !== null
              ? t('email.liquid.preview.errorAt', { line: error.line, column: error.column ?? 1 })
              : t('email.liquid.preview.error')}{' '}
            {error.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Live render of the expression or the whole document for a real contact (server-side, send-time sandbox). */
export function PreviewPane({
  expression,
  onExpressionChange,
  documentSource,
}: {
  expression: string;
  onExpressionChange: (code: string) => void;
  documentSource: DocumentSource | null;
}) {
  const { t } = useI18n();
  const { slug, api } = useEmailApi();
  const [contact, setContact] = useState<Contact | null>(null);
  const [target, setTarget] = useState<'expression' | 'document'>(documentSource !== null && expression === '' ? 'document' : 'expression');
  const [format, setFormat] = useState<'text' | 'html'>('text');
  const [docSource, setDocSource] = useState(() => documentSource?.get() ?? '');
  useEffect(() => {
    if (target !== 'document' || documentSource === null) return undefined;
    setDocSource(documentSource.get());
    const timer = window.setInterval(() => setDocSource(documentSource.get()), 1500);
    return () => window.clearInterval(timer);
  }, [target, documentSource]);

  const source = target === 'document' ? docSource : expression;
  const debounced = useDebounced(source, 400);
  const local = useMemo(() => validateLiquid(source), [source]);
  const preview = useQuery({
    queryKey: [...emailKeys.liquidSchema(slug), 'preview', debounced, contact?.id ?? '', format],
    queryFn: () =>
      api.liquid.preview({ template: debounced, format, ...(contact === null ? {} : { contact_id: contact.id }) }),
    enabled: debounced.trim() !== '' && validateLiquid(debounced).ok,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const errors = local.ok ? (preview.data?.errors ?? []) : local.errors;
  const errorLine = errors[0]?.line ?? null;
  const result = local.ok ? preview.data : undefined;

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label>{t('email.liquid.preview.contact')}</Label>
        <ContactSelect value={contact} onChange={setContact} />
        {contact === null ? <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{t('email.liquid.preview.sampleHint')}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border p-0.5" role="tablist">
          <button type="button" role="tab" aria-selected={target === 'expression'} className="rounded px-2 py-1 text-xs aria-selected:bg-(--obsidian-dashboard-shell-accent) aria-selected:text-(--obsidian-dashboard-shell-accent-foreground)" onClick={() => setTarget('expression')}>
            {t('email.liquid.preview.expression')}
          </button>
          {documentSource !== null ? (
            <button type="button" role="tab" aria-selected={target === 'document'} className="rounded px-2 py-1 text-xs aria-selected:bg-(--obsidian-dashboard-shell-accent) aria-selected:text-(--obsidian-dashboard-shell-accent-foreground)" onClick={() => setTarget('document')}>
              {documentSource.label}
            </button>
          ) : null}
        </div>
        <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label={t('email.liquid.preview.format')}>
          {(['text', 'html'] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={format === value} className="rounded px-2 py-1 text-xs aria-selected:bg-(--obsidian-dashboard-shell-accent) aria-selected:text-(--obsidian-dashboard-shell-accent-foreground)" onClick={() => setFormat(value)}>
              {value === 'text' ? t('email.liquid.preview.formatText') : t('email.liquid.preview.formatHtml')}
            </button>
          ))}
        </div>
        {preview.isFetching ? <RefreshCw className="size-3.5 animate-spin opacity-60" aria-label={t('email.liquid.loading')} /> : null}
      </div>
      {target === 'expression' ? (
        <CodeEditor
          value={expression}
          onChange={onExpressionChange}
          errorLine={errorLine}
          rows={6}
          ariaLabel={t('email.liquid.preview.expression')}
          placeholder={'{% if contact.tags contains "VIP" %}…{% endif %}'}
        />
      ) : (
        <CodeEditor value={docSource} onChange={() => undefined} errorLine={errorLine} rows={6} readOnly ariaLabel={documentSource?.label} />
      )}
      <IssueList errors={errors} />
      {preview.isError ? <p className="text-xs text-(--obsidian-dashboard-shell-danger)">{errorMessage(preview.error)}</p> : null}
      {result !== undefined && result.unknown.length > 0 ? (
        <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs" data-testid="liquid-unknown">
          <AlertTriangle className="mt-0.5 size-3.5 flex-none text-(--obsidian-dashboard-shell-warning)" />
          <span>
            {t('email.liquid.preview.unknown')} <code>{result.unknown.join(', ')}</code>
          </span>
        </p>
      ) : null}
      {result !== undefined && result.missing.length > 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-(--obsidian-dashboard-shell-text-subtle)">
          <Info className="mt-0.5 size-3.5 flex-none" />
          <span>
            {t('email.liquid.preview.missing')} <code>{result.missing.join(', ')}</code>
          </span>
        </p>
      ) : null}
      <div className="grid gap-1">
        <Label>{t('email.liquid.preview.output')}</Label>
        <pre className="min-h-16 rounded-md border bg-(--obsidian-dashboard-shell-muted) p-2 text-sm whitespace-pre-wrap" data-testid="liquid-output">
          {source.trim() === '' ? (
            <span className="opacity-60">{t('email.liquid.preview.empty')}</span>
          ) : result?.ok === true ? (
            result.output
          ) : (
            ''
          )}
        </pre>
      </div>
    </div>
  );
}

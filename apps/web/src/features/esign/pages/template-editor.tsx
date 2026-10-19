import {
  ESIGN_FIELD_TYPES,
  ESIGN_PDF_MAX_BYTES,
  type EsignField,
  type EsignFieldType,
  type EsignPage,
  type EsignParty,
  type EsignSettings,
  type EsignTemplate,
} from '@amable/api-types';
import { DashboardButton, PageToolbar, toast } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { Progress } from '@amable/ui/ui/progress';
import { Switch } from '@amable/ui/ui/switch';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useParams } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Copy, FileUp, ImagePlus, Plus, Save, Send, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { ChoiceSelect, FormField } from '../../commerce/components/common';
import { EsignApiError } from '../api/client';
import { errorMessage, esignKeys, useEsign, useEsignMutation, useEsignPermissions, useTemplate } from '../api/hooks';
import { PageState, TemplateStatusPill, useEsignChrome } from '../components/common';
import { FIELD_DRAG_TYPE, FIELD_ICONS, PageCanvas } from '../components/page-canvas';
import { SendDialog } from '../components/send-dialog';
import { clamp, newField, newFieldId, newParty, PARTY_COLORS, round, templateReady } from '../lib/fields';
import { renderPdfPages } from '../lib/render-pdf';

interface Draft {
  readonly name: string;
  readonly parties: readonly EsignParty[];
  readonly fields: readonly EsignField[];
  readonly signing_order: EsignTemplate['signing_order'];
  readonly settings: EsignSettings;
}

function draftOf(template: EsignTemplate): Draft {
  return {
    name: template.name,
    parties: template.parties,
    fields: template.fields,
    signing_order: template.signing_order,
    settings: template.settings,
  };
}

type Work = { readonly phase: 'upload' } | { readonly phase: 'render' | 'images'; readonly done: number; readonly total: number };

export function EsignTemplateEditorPage() {
  const { templateId } = useParams({ from: '/t/$tenant/signatures/templates/$templateId' });
  const template = useTemplate(templateId);
  return (
    <PageState isPending={template.isPending} error={template.error}>
      {() => (template.data === undefined ? null : <TemplateEditor key={template.data.id} template={template.data} />)}
    </PageState>
  );
}

function TemplateEditor({ template: initial }: { template: EsignTemplate }) {
  const { t } = useI18n();
  const { slug, api } = useEsign();
  const { can } = useEsignPermissions();
  const queryClient = useQueryClient();
  const [server, setServer] = useState(initial);
  const [draft, setDraftState] = useState<Draft>(() => draftOf(initial));
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeParty, setActiveParty] = useState<string>(initial.parties[0]?.id ?? '');
  const [armed, setArmed] = useState<EsignFieldType | null>(null);
  const [progress, setProgress] = useState<Work | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const writable = can('esign:write');
  const readOnly = !writable || progress !== null;

  useEsignChrome('templates', draft.name || server.name, {
    label: t(`esign.templateStatus.${server.status}`),
    tone: server.status === 'active' ? 'success' : server.status === 'archived' ? 'warning' : 'neutral',
  });

  const update = useCallback((patch: Partial<Draft> | ((current: Draft) => Partial<Draft>)) => {
    setDraftState((current) => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }));
    setDirty(true);
  }, []);

  const adopt = useCallback(
    (next: EsignTemplate) => {
      setServer(next);
      setDraftState(draftOf(next));
      setDirty(false);
      queryClient.setQueryData(esignKeys.template(slug, next.id), next);
      void queryClient.invalidateQueries({ queryKey: esignKeys.templates(slug) });
    },
    [queryClient, slug],
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm(t('esign.editor.leaveConfirm')),
    enableBeforeUnload: false,
  });

  const save = useEsignMutation({
    mutationFn: (status: EsignTemplate['status'] | undefined) =>
      api.templates.update(server.id, {
        name: draft.name.trim() || server.name,
        parties: [...draft.parties],
        fields: [...draft.fields],
        signing_order: draft.signing_order,
        settings: draft.settings,
        ...(status === undefined ? {} : { status }),
      }),
    invalidate: [esignKeys.templates(slug)],
    success: (result) => (result.status !== server.status ? t(`esign.editor.status.${result.status}`) : t('esign.editor.saved')),
    onSuccess: adopt,
  });

  const selected = draft.fields.find((f) => f.id === selectedId) ?? null;
  const party = draft.parties.find((p) => p.id === activeParty) ?? draft.parties[0];
  const ready = templateReady(server.pages, draft.parties, draft.fields);
  const missingImages = server.source !== null && server.pages.some((p) => !p.has_image);

  const changeField = useCallback(
    (field: EsignField) => update((current) => ({ fields: current.fields.map((f) => (f.id === field.id ? field : f)) })),
    [update],
  );
  const removeField = useCallback(
    (id: string) => {
      update((current) => ({ fields: current.fields.filter((f) => f.id !== id) }));
      setSelectedId(null);
    },
    [update],
  );
  const place = (type: EsignFieldType, page: EsignPage, cx: number, cy: number) => {
    if (party === undefined) return;
    const field = newField(type, party.id, page, cx, cy);
    update((current) => ({ fields: [...current.fields, field] }));
    setSelectedId(field.id);
    setArmed(null);
  };

  // Keyboard: delete, nudge with the arrows (Shift: bigger steps), Escape to deselect.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (event.key === 'Escape') {
        setSelectedId(null);
        setArmed(null);
        return;
      }
      if (selected === null || readOnly) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeField(selected.id);
        return;
      }
      const step = event.shiftKey ? 0.01 : 0.002;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const move = moves[event.key];
      if (move === undefined) return;
      event.preventDefault();
      changeField({
        ...selected,
        x: round(clamp(selected.x + move[0], 0, 1 - selected.w)),
        y: round(clamp(selected.y + move[1], 0, 1 - selected.h)),
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, readOnly, removeField, changeField]);

  const renderImages = async (target: EsignTemplate, data: ArrayBuffer) => {
    const sha = target.source?.sha256;
    if (sha === undefined) return target;
    const rendered = await renderPdfPages(data, (done, total) => setProgress({ phase: 'render', done, total }));
    let current = target;
    const pages = rendered.filter((p) => p.index < target.pages.length);
    for (const [i, page] of pages.entries()) {
      setProgress({ phase: 'images', done: i, total: pages.length });
      current = await api.templates.uploadPageImage(target.id, page.index, page.image, sha);
    }
    return current;
  };

  const run = async (task: () => Promise<EsignTemplate>) => {
    try {
      adopt(await task());
    } catch (error) {
      toast.error(error instanceof EsignApiError ? errorMessage(t, error) : t('esign.editor.renderFailed'));
      const fresh = await api.templates.get(server.id).catch(() => null);
      if (fresh !== null) adopt(fresh);
    } finally {
      setProgress(null);
    }
  };

  const uploadDocument = async (file: File) => {
    if (file.size > ESIGN_PDF_MAX_BYTES) {
      toast.error(t('esign.error.tooLarge'));
      return;
    }
    if (dirty) await save.mutateAsync(undefined).catch(() => undefined);
    setSelectedId(null);
    await run(async () => {
      setProgress({ phase: 'upload' });
      const data = await file.arrayBuffer();
      const uploaded = await api.templates.uploadDocument(server.id, file, file.name);
      adopt(uploaded);
      return renderImages(uploaded, data);
    });
  };

  const regenerateImages = () =>
    run(async () => {
      setProgress({ phase: 'upload' });
      const response = await fetch(api.templates.documentUrl(server.id), { credentials: 'same-origin' });
      if (!response.ok) throw new Error('document_unavailable');
      return renderImages(server, await response.arrayBuffer());
    });

  // An archived template goes back to draft first (Restore), as from the list.
  const statusAction =
    server.status === 'active'
      ? { label: t('esign.editor.deactivate'), status: 'draft' as const }
      : server.status === 'draft'
        ? { label: t('esign.editor.activate'), status: 'active' as const }
        : null;
  const [dragging, setDragging] = useState(false);
  const dropPdf = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (!writable || progress !== null) return;
    const file = Array.from(event.dataTransfer.files).find((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (file === undefined) toast.error(t('esign.editor.dropNotPdf'));
    else void uploadDocument(file);
  };

  return (
    <>
      <PageToolbar
        filters={
          <div className="flex items-center gap-3">
            <Link to="/t/$tenant/signatures/templates" params={{ tenant: slug }} className="text-sm text-muted-foreground hover:text-foreground">
              ← {t('esign.editor.back')}
            </Link>
            <TemplateStatusPill status={server.status} />
            {dirty ? <span className="text-xs text-amber-600 dark:text-amber-400">{t('esign.editor.unsaved')}</span> : null}
          </div>
        }
        actions={
          writable ? (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file !== undefined) void uploadDocument(file);
                }}
              />
              <DashboardButton onClick={() => fileInput.current?.click()} disabled={progress !== null}>
                <FileUp aria-hidden /> {server.source === null ? t('esign.editor.upload') : t('esign.editor.replace')}
              </DashboardButton>
              <DashboardButton
                onClick={() => save.mutate(server.status === 'archived' ? 'draft' : 'archived')}
                disabled={save.isPending || progress !== null}
              >
                {server.status === 'archived' ? (
                  <>
                    <ArchiveRestore aria-hidden /> {t('esign.action.restore')}
                  </>
                ) : (
                  <>
                    <Archive aria-hidden /> {t('esign.action.archive')}
                  </>
                )}
              </DashboardButton>
              {statusAction !== null ? (
                <DashboardButton
                  onClick={() => save.mutate(statusAction.status)}
                  disabled={save.isPending || progress !== null || (statusAction.status === 'active' && !ready)}
                  title={statusAction.status === 'active' && !ready ? t('esign.editor.notReady') : undefined}
                >
                  {statusAction.label}
                </DashboardButton>
              ) : null}
              {server.status === 'active' && server.ready && !dirty ? (
                <DashboardButton onClick={() => setSending(true)}>
                  <Send aria-hidden /> {t('esign.action.send')}
                </DashboardButton>
              ) : null}
              <DashboardButton variant="primary" onClick={() => save.mutate(undefined)} disabled={!dirty || save.isPending || progress !== null}>
                <Save aria-hidden /> {t('esign.editor.save')}
              </DashboardButton>
            </>
          ) : null
        }
      />
      <div className="grid min-h-0 flex-1 gap-4 px-4 pb-6 lg:grid-cols-[15rem_minmax(0,1fr)_18rem]">
        <aside className="grid content-start gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-10rem)] lg:overflow-y-auto">
          <PartiesPanel
            parties={draft.parties}
            fields={draft.fields}
            active={party?.id ?? ''}
            readOnly={readOnly}
            onActive={setActiveParty}
            onChange={(parties) => {
              const kept = new Set(parties.map((p) => p.id));
              update((current) => ({ parties, fields: current.fields.filter((f) => kept.has(f.party_id)) }));
              if (!kept.has(activeParty)) setActiveParty(parties[0]?.id ?? '');
            }}
          />
          <Panel title={t('esign.editor.palette')}>
            <p className="mb-2 text-xs text-muted-foreground">{t('esign.editor.paletteHint')}</p>
            <div className="grid grid-cols-2 gap-1.5">
              {ESIGN_FIELD_TYPES.map((type) => {
                const Icon = FIELD_ICONS[type];
                return (
                  <button
                    key={type}
                    type="button"
                    draggable={!readOnly && server.pages.length > 0}
                    disabled={readOnly || server.pages.length === 0}
                    aria-pressed={armed === type}
                    onClick={() => setArmed((current) => (current === type ? null : type))}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(FIELD_DRAG_TYPE, type);
                      event.dataTransfer.effectAllowed = 'copy';
                    }}
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50 ${armed === type ? 'border-primary bg-primary/10' : ''}`}
                  >
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{t(`esign.fieldType.${type}`)}</span>
                  </button>
                );
              })}
            </div>
          </Panel>
        </aside>

        <main className="min-w-0" aria-label={t('esign.editor.pages')}>
          {progress !== null ? <ProgressBanner progress={progress} /> : null}
          {missingImages && progress === null ? (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <span>{t('esign.editor.missingImages')}</span>
              {writable ? (
                <Button type="button" size="sm" variant="outline" onClick={() => void regenerateImages()}>
                  <ImagePlus aria-hidden /> {t('esign.editor.generateImages')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {server.source === null ? (
            <button
              type="button"
              disabled={!writable || progress !== null}
              onClick={() => fileInput.current?.click()}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={dropPdf}
              className={`grid min-h-80 w-full place-items-center rounded-xl border-2 border-dashed p-8 text-center text-sm text-muted-foreground hover:bg-muted/40 ${dragging ? 'border-primary bg-primary/5' : ''}`}
            >
              <span className="grid justify-items-center gap-2">
                <FileUp className="size-8" aria-hidden />
                {t('esign.editor.dropHint')}
              </span>
            </button>
          ) : (
            <div className="mx-auto grid max-w-3xl gap-6">
              {server.pages.map((page) => (
                <figure key={page.index} className="grid gap-1">
                  <PageCanvas
                    page={page}
                    imageUrl={page.has_image ? api.templates.pageImageUrl(server.id, page.index, server.source?.sha256 ?? '') : null}
                    fields={draft.fields.filter((f) => f.page === page.index)}
                    parties={draft.parties}
                    selectedId={selectedId}
                    armed={armed}
                    readOnly={readOnly}
                    onSelect={setSelectedId}
                    onChange={changeField}
                    onPlace={place}
                  />
                  <figcaption className="text-center text-xs text-muted-foreground">
                    {t('esign.editor.pageOf', { page: page.index + 1, count: server.pages.length })}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </main>

        <aside className="grid content-start gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-10rem)] lg:overflow-y-auto">
          {selected !== null ? (
            <FieldPanel
              field={selected}
              parties={draft.parties}
              readOnly={readOnly}
              onChange={changeField}
              onRemove={() => removeField(selected.id)}
              onDuplicate={() => {
                const shifted = { ...selected, id: newFieldId(), y: round(clamp(selected.y + selected.h + 0.01, 0, 1 - selected.h)) };
                update((current) => ({ fields: [...current.fields, shifted] }));
                setSelectedId(shifted.id);
              }}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <SettingsPanel draft={draft} template={server} readOnly={readOnly} onChange={update} />
          )}
        </aside>
      </div>
      {sending ? <SendDialog template={server} onClose={() => setSending(false)} /> : null}
    </>
  );
}

function Panel({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function ProgressBanner({ progress }: { progress: Work }) {
  const { t } = useI18n();
  const value = progress.phase === 'upload' ? 5 : progress.phase === 'render' ? (progress.done / progress.total) * 50 : 50 + (progress.done / progress.total) * 50;
  const label =
    progress.phase === 'upload'
      ? t('esign.editor.progress.upload')
      : progress.phase === 'render'
        ? t('esign.editor.progress.render', { done: progress.done, total: progress.total })
        : t('esign.editor.progress.images', { done: progress.done, total: progress.total });
  return (
    <div className="mb-3 grid gap-2 rounded-lg border bg-card p-3 text-sm" role="status">
      <span>{label}</span>
      <Progress value={value} />
    </div>
  );
}

function PartiesPanel({
  parties,
  fields,
  active,
  readOnly,
  onActive,
  onChange,
}: {
  parties: readonly EsignParty[];
  fields: readonly EsignField[];
  active: string;
  readOnly: boolean;
  onActive: (id: string) => void;
  onChange: (parties: EsignParty[]) => void;
}) {
  const { t } = useI18n();
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of fields) map.set(f.party_id, (map.get(f.party_id) ?? 0) + 1);
    return map;
  }, [fields]);
  return (
    <Panel
      title={t('esign.field.parties')}
      actions={
        !readOnly && parties.length < 10 ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t('esign.editor.addParty')}
            onClick={() => {
              const next = newParty(parties, t('esign.editor.partyName', { n: parties.length + 1 }));
              onChange([...parties, next]);
              onActive(next.id);
            }}
          >
            <Plus aria-hidden />
          </Button>
        ) : null
      }
    >
      <p className="mb-2 text-xs text-muted-foreground">{t('esign.editor.partiesHint')}</p>
      <ul className="grid gap-1.5">
        {parties.map((party, index) => (
          <li key={party.id} className={`flex items-center gap-1.5 rounded-md border p-1.5 ${party.id === active ? 'border-primary bg-primary/5' : ''}`}>
            <button
              type="button"
              className="size-4 shrink-0 rounded-full ring-offset-1 focus-visible:ring-2"
              style={{ backgroundColor: party.color ?? PARTY_COLORS[index % PARTY_COLORS.length] }}
              aria-label={t('esign.editor.selectParty', { name: party.name })}
              aria-pressed={party.id === active}
              onClick={() => onActive(party.id)}
            />
            <Input
              value={party.name}
              disabled={readOnly}
              maxLength={100}
              className="h-7 min-w-0 flex-1 px-1.5 text-xs"
              aria-label={t('esign.editor.partyNameLabel')}
              onFocus={() => onActive(party.id)}
              onChange={(event) => onChange(parties.map((p) => (p.id === party.id ? { ...p, name: event.target.value } : p)))}
              onBlur={(event) => {
                if (event.target.value.trim() === '') onChange(parties.map((p) => (p.id === party.id ? { ...p, name: t('esign.editor.partyName', { n: index + 1 }) } : p)));
              }}
            />
            <span className="w-5 text-right text-xs text-muted-foreground tabular-nums" title={t('esign.field.fields')}>
              {counts.get(party.id) ?? 0}
            </span>
            {!readOnly && parties.length > 1 ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t('esign.editor.removeParty', { name: party.name })}
                onClick={() => onChange(parties.filter((p) => p.id !== party.id))}
              >
                <X aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function FieldPanel({
  field,
  parties,
  readOnly,
  onChange,
  onRemove,
  onDuplicate,
  onClose,
}: {
  field: EsignField;
  parties: readonly EsignParty[];
  readOnly: boolean;
  onChange: (field: EsignField) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const requiredId = useId();
  const choices = field.type === 'select' || field.type === 'radio';
  return (
    <Panel
      title={t('esign.editor.fieldTitle')}
      actions={
        <Button type="button" size="icon-sm" variant="ghost" aria-label={t('esign.editor.closeField')} onClick={onClose}>
          <X aria-hidden />
        </Button>
      }
    >
      <div className="grid gap-3">
        <FormField label={t('esign.field.type')}>
          {(id) => (
            <ChoiceSelect
              id={id}
              className="w-full"
              value={field.type}
              disabled={readOnly}
              onChange={(type) => {
                const next = type as EsignFieldType;
                const needsOptions = next === 'select' || next === 'radio';
                onChange({ ...field, type: next, options: needsOptions ? (field.options.length > 0 ? field.options : ['1', '2']) : [] });
              }}
              choices={ESIGN_FIELD_TYPES.map((type) => ({ value: type, label: t(`esign.fieldType.${type}`) }))}
            />
          )}
        </FormField>
        <FormField label={t('esign.field.party')}>
          {(id) => (
            <ChoiceSelect
              id={id}
              className="w-full"
              value={field.party_id}
              disabled={readOnly}
              onChange={(partyId) => onChange({ ...field, party_id: partyId })}
              choices={parties.map((p) => ({ value: p.id, label: p.name }))}
            />
          )}
        </FormField>
        <FormField label={t('esign.field.label')} hint={t('esign.editor.labelHint')}>
          {(id) => <Input id={id} value={field.label} disabled={readOnly} maxLength={200} onChange={(e) => onChange({ ...field, label: e.target.value })} />}
        </FormField>
        {field.type !== 'signed_date' ? (
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={requiredId}>{t('esign.field.required')}</Label>
            <Switch id={requiredId} checked={field.required} disabled={readOnly} onCheckedChange={(required) => onChange({ ...field, required })} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t('esign.editor.signedDateHint')}</p>
        )}
        {choices ? (
          <OptionsEditor options={field.options} readOnly={readOnly} onChange={(options) => onChange({ ...field, options })} />
        ) : null}
        <p className="text-xs text-muted-foreground tabular-nums">
          {t('esign.editor.position', { page: field.page + 1, x: Math.round(field.x * 100), y: Math.round(field.y * 100) })}
        </p>
        {!readOnly ? (
          <div className="flex gap-1.5">
            <Button type="button" size="sm" variant="outline" onClick={onDuplicate}>
              <Copy aria-hidden /> {t('esign.editor.duplicate')}
            </Button>
            <Button type="button" size="sm" variant="outline" className="text-destructive" onClick={onRemove}>
              <Trash2 aria-hidden /> {t('esign.editor.removeField')}
            </Button>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function OptionsEditor({ options, readOnly, onChange }: { options: readonly string[]; readOnly: boolean; onChange: (options: string[]) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(options.join('\n'));
  useEffect(() => {
    setText((current) => (current.split('\n').map((o) => o.trim()).filter(Boolean).join('\n') === options.join('\n') ? current : options.join('\n')));
  }, [options]);
  return (
    <FormField label={t('esign.field.options')} hint={t('esign.editor.optionsHint')}>
      {(id) => (
        <Textarea
          id={id}
          rows={4}
          value={text}
          disabled={readOnly}
          onChange={(event) => {
            setText(event.target.value);
            const list = Array.from(new Set(event.target.value.split('\n').map((o) => o.trim()).filter(Boolean))).slice(0, 50);
            if (list.length > 0) onChange(list.map((o) => o.slice(0, 200)));
          }}
        />
      )}
    </FormField>
  );
}

function SettingsPanel({
  draft,
  template,
  readOnly,
  onChange,
}: {
  draft: Draft;
  template: EsignTemplate;
  readOnly: boolean;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const { t } = useI18n();
  const otpId = useId();
  const remindersId = useId();
  const settings = draft.settings;
  const setSettings = (patch: Partial<EsignSettings>) => onChange({ settings: { ...settings, ...patch } });
  const setReminders = (patch: Partial<EsignSettings['reminders']>) => setSettings({ reminders: { ...settings.reminders, ...patch } });
  const intIn = (value: string, min: number, max: number, fallback: number) => {
    const n = Number(value);
    return Number.isInteger(n) ? clamp(n, min, max) : fallback;
  };
  return (
    <>
      <Panel title={t('esign.editor.general')}>
        <div className="grid gap-3">
          <FormField label={t('esign.field.name')}>
            {(id) => <Input id={id} value={draft.name} disabled={readOnly} maxLength={200} onChange={(e) => onChange({ name: e.target.value })} />}
          </FormField>
          {template.source !== null ? (
            <p className="text-xs break-all text-muted-foreground">
              {t('esign.templates.pages', { name: template.source.filename, count: template.pages.length })}
            </p>
          ) : null}
          <FormField label={t('esign.field.signingOrder')} hint={t(`esign.signingOrder.${draft.signing_order}Hint`)}>
            {(id) => (
              <ChoiceSelect
                id={id}
                className="w-full"
                value={draft.signing_order}
                disabled={readOnly}
                onChange={(value) => onChange({ signing_order: value as Draft['signing_order'] })}
                choices={(['parallel', 'sequential'] as const).map((value) => ({ value, label: t(`esign.signingOrder.${value}`) }))}
              />
            )}
          </FormField>
        </div>
      </Panel>
      <Panel title={t('esign.editor.security')}>
        <div className="grid gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-0.5">
              <Label htmlFor={otpId}>{t('esign.field.requireOtp')}</Label>
              <p className="text-xs text-muted-foreground">{t('esign.editor.otpHint')}</p>
            </div>
            <Switch id={otpId} checked={settings.require_otp} disabled={readOnly} onCheckedChange={(require_otp) => setSettings({ require_otp })} />
          </div>
          <FormField label={t('esign.field.expireDays')} hint={t('esign.editor.expireHint')}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={365}
                className="w-28"
                disabled={readOnly}
                value={settings.expire_days === null ? '' : String(settings.expire_days)}
                onChange={(e) => setSettings({ expire_days: e.target.value.trim() === '' ? null : intIn(e.target.value, 1, 365, 30) })}
              />
            )}
          </FormField>
        </div>
      </Panel>
      <Panel title={t('esign.editor.reminders')}>
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={remindersId}>{t('esign.field.remindersEnabled')}</Label>
            <Switch id={remindersId} checked={settings.reminders.enabled} disabled={readOnly} onCheckedChange={(enabled) => setReminders({ enabled })} />
          </div>
          {settings.reminders.enabled ? (
            <div className="grid grid-cols-3 gap-2">
              <FormField label={t('esign.field.firstAfterDays')}>
                {(id) => (
                  <Input id={id} type="number" min={1} max={60} disabled={readOnly} value={settings.reminders.first_after_days} onChange={(e) => setReminders({ first_after_days: intIn(e.target.value, 1, 60, 3) })} />
                )}
              </FormField>
              <FormField label={t('esign.field.everyDays')}>
                {(id) => (
                  <Input id={id} type="number" min={1} max={60} disabled={readOnly} value={settings.reminders.every_days} onChange={(e) => setReminders({ every_days: intIn(e.target.value, 1, 60, 3) })} />
                )}
              </FormField>
              <FormField label={t('esign.field.maxReminders')}>
                {(id) => (
                  <Input id={id} type="number" min={0} max={10} disabled={readOnly} value={settings.reminders.max} onChange={(e) => setReminders({ max: intIn(e.target.value, 0, 10, 3) })} />
                )}
              </FormField>
            </div>
          ) : null}
        </div>
      </Panel>
      <Panel title={t('esign.editor.email')}>
        <div className="grid gap-3">
          <FormField label={t('esign.field.subject')} hint={t('esign.editor.subjectHint')}>
            {(id) => <Input id={id} value={settings.email_subject} disabled={readOnly} maxLength={300} onChange={(e) => setSettings({ email_subject: e.target.value })} />}
          </FormField>
          <FormField label={t('esign.field.message')} hint={t('esign.editor.messageHint')}>
            {(id) => <Textarea id={id} rows={4} value={settings.email_message} disabled={readOnly} maxLength={5000} onChange={(e) => setSettings({ email_message: e.target.value })} />}
          </FormField>
          <FormField label={t('esign.field.locale')}>
            {(id) => (
              <ChoiceSelect
                id={id}
                className="w-full"
                value={settings.locale}
                disabled={readOnly}
                onChange={(value) => setSettings({ locale: value as EsignSettings['locale'] })}
                choices={(['auto', 'en', 'it'] as const).map((value) => ({ value, label: t(`esign.locale.${value}`) }))}
              />
            )}
          </FormField>
        </div>
      </Panel>
    </>
  );
}

import type {
  ConnectionTestResult,
  ConnectorInfo,
  ConnectorType,
  CreateConnectionInput,
  FormConnection,
} from '@amable/api-types';
import { collectsValue, type FormField } from '@amable/forms';
import { DashboardButton, PageBody, PageToolbar } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { FlaskConical, KeyRound, Pencil, Plus, Trash2, Wand2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { text, type AppInputSchema } from '../../apps/api';
import { AppSchemaInputs } from '../../automations/components/app-forms';
import { useStepUp } from '../../developers/components';
import { formsKeys, useDates, useForm, useForms, useFormsMutation, usePermissions } from '../api/hooks';
import { Choice, ErrorNotice, FormField as Field, Pill, SectionCard } from '../components/common';
import { useFormChrome } from '../components/form-chrome';
import { applyWebhookBody, buildWebhookBody, parseBodyTemplate } from '../lib/webhook-body';

type Config = Record<string, unknown>;
type Pair = [string, string];

const STANDARD_SOURCES = ['submission_id', 'form_name', 'submitted_at', 'contact_id', 'page_url', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign'];

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

type AppConnectorInfo = NonNullable<ConnectorInfo['app']>;
type Editing = { connection: FormConnection | null; type: ConnectorType; app: AppConnectorInfo | null };

const appKeyOf = (app_id: unknown, key: unknown) => `${str(app_id)}:${str(key)}`;

/** Catalog entry of the app behind an `app` connection (null once the app is gone). */
function appOfConnection(catalog: readonly ConnectorInfo[] | undefined, connection: FormConnection): AppConnectorInfo | null {
  if (connection.type !== 'app') return null;
  const wanted = appKeyOf(connection.config['app_id'], connection.config['key']);
  return catalog?.find((info) => info.app !== undefined && appKeyOf(info.app.app_id, info.app.key) === wanted)?.app ?? null;
}
const pairsOf = (value: unknown, a: string, b: string): Pair[] =>
  Array.isArray(value) ? value.map((item: Record<string, unknown>) => [str(item[a]), str(item[b])] as Pair) : [];

function PairsEditor({
  pairs,
  onChange,
  sources,
  rightLabel,
}: {
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
  sources: ReadonlyArray<{ value: string; label: string }>;
  rightLabel: string;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-1.5">
      {pairs.map(([source, target], index) => (
        <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
          <Choice value={source || null} options={sources} onChange={(value) => onChange(pairs.map((p, i) => (i === index ? [value ?? '', p[1]] : p)))} />
          <Input aria-label={rightLabel} value={target} placeholder={rightLabel} onChange={(e) => onChange(pairs.map((p, i) => (i === index ? [p[0], e.target.value] : p)))} />
          <Button type="button" size="icon" variant="ghost" aria-label={t('forms.connections.removeRow')} onClick={() => onChange(pairs.filter((_, i) => i !== index))}>
            <X aria-hidden />
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="ghost" className="justify-self-start" onClick={() => onChange([...pairs, [sources[0]?.value ?? '', '']])}>
        <Plus aria-hidden /> {t('forms.connections.addRow')}
      </Button>
    </div>
  );
}

export function ConnectionsPage() {
  const { t } = useI18n();
  const { formId = '' } = useParams({ strict: false }) as { formId?: string };
  const { slug, api } = useForms();
  const { can } = usePermissions();
  const { dateTime } = useDates();
  const form = useForm(formId);
  useFormChrome(formId, form.data, 'connections');
  const manage = can('forms:connections_manage');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ name: string; result: ConnectionTestResult } | null>(null);
  const connections = useQuery({ queryKey: formsKeys.connections(slug, formId), queryFn: async () => (await api.connections.list(formId)).data });
  const catalog = useQuery({ queryKey: formsKeys.catalog(slug), queryFn: async () => (await api.connections.catalog()).data, staleTime: 60_000 });
  const invalidate = [formsKeys.connections(slug, formId)];
  const { locale } = useI18n();
  const connectorLabel = (type: ConnectorType, app: AppConnectorInfo | null) =>
    app === null ? t(`forms.connector.${type}`) : `${text(app.name, locale)} · ${app.app_name}`;

  const { guard, dialog: stepUpDialog } = useStepUp();
  const toggle = useFormsMutation({
    mutationFn: (c: FormConnection) => api.connections.update(formId, c.id, { enabled: !c.enabled }),
    invalidate,
  });
  const remove = useFormsMutation({
    mutationFn: (id: string) => api.connections.remove(formId, id),
    invalidate,
    success: t('forms.connections.deleted'),
  });
  const test = useFormsMutation({
    mutationFn: (c: FormConnection) => api.connections.test(formId, c.id).then((result) => ({ name: c.name, result })),
    invalidate,
    onSuccess: (result) => setTestResult(result),
  });
  const rotate = useFormsMutation({
    mutationFn: (id: string) => api.connections.rotateSecret(formId, id),
    invalidate,
    onSuccess: (c) => setSecret(c.signing_secret),
    onError: (error, id) => guard(error, () => rotate.mutate(id)),
  });

  return (
    <>
      <PageToolbar
        actions={
          manage ? (
            <div className="flex flex-wrap gap-2">
              {(catalog.data ?? []).map((info) => (
                <DashboardButton
                  key={info.app === undefined ? info.type : appKeyOf(info.app.app_id, info.app.key)}
                  variant="ghost"
                  disabled={!info.available}
                  onClick={() => setEditing({ connection: null, type: info.type, app: info.app ?? null })}
                >
                  <Plus aria-hidden /> {connectorLabel(info.type, info.app ?? null)}
                </DashboardButton>
              ))}
            </div>
          ) : null
        }
      />
      <PageBody className="grid gap-3 pt-2">
        <p className="text-sm text-muted-foreground">{t('forms.connections.intro')}</p>
        {connections.error ? <ErrorNotice error={connections.error} /> : null}
        {connections.data?.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('forms.connections.empty')}</p>
        ) : null}
        {(connections.data ?? []).map((c) => (
          <SectionCard
            key={c.id}
            title={
              <span className="flex items-center gap-2">
                {c.name}
                <Pill tone="neutral">
                  {c.type === 'app' && appOfConnection(catalog.data, c) === null
                    ? t('forms.connector.appMissing', { app: str(c.config['app_id']) })
                    : connectorLabel(c.type, appOfConnection(catalog.data, c))}
                </Pill>
                {c.last_delivery ? (
                  <Pill tone={c.last_delivery.status === 'success' ? 'success' : c.last_delivery.status === 'skipped' ? 'neutral' : 'danger'}>
                    {t(`forms.delivery.${c.last_delivery.status}`)} · {dateTime(c.last_delivery.at)}
                  </Pill>
                ) : null}
              </span>
            }
            actions={
              manage ? (
                <>
                  <Switch checked={c.enabled} aria-label={t('forms.connections.enabled')} onCheckedChange={() => toggle.mutate(c)} />
                  <Button size="sm" variant="ghost" disabled={test.isPending} onClick={() => test.mutate(c)}>
                    <FlaskConical aria-hidden /> {t('forms.connections.test')}
                  </Button>
                  {c.type === 'webhook' ? (
                    <Button size="sm" variant="ghost" onClick={() => rotate.mutate(c.id)}>
                      <KeyRound aria-hidden /> {t('forms.connections.rotate')}
                    </Button>
                  ) : null}
                  <Button size="icon" variant="ghost" aria-label={t('forms.action.edit')} onClick={() => setEditing({ connection: c, type: c.type, app: appOfConnection(catalog.data, c) })}>
                    <Pencil aria-hidden />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={t('forms.connections.delete')} onClick={() => remove.mutate(c.id)}>
                    <Trash2 aria-hidden />
                  </Button>
                </>
              ) : null
            }
          >
            <ConnectionSummary connection={c} />
          </SectionCard>
        ))}
      </PageBody>
      {editing !== null && form.data ? (
        <ConnectionDialog
          formId={formId}
          fields={form.data.definition.fields}
          connection={editing.connection}
          type={editing.type}
          app={editing.app}
          onClose={() => setEditing(null)}
          onSecret={setSecret}
          guard={guard}
        />
      ) : null}
      {stepUpDialog}
      <Dialog open={secret !== null} onOpenChange={(open) => (open ? undefined : setSecret(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('forms.connections.secretTitle')}</DialogTitle>
            <DialogDescription>{t('forms.connections.secretHint')}</DialogDescription>
          </DialogHeader>
          <code className="block break-all rounded-lg bg-muted p-3 text-sm">{secret}</code>
          <DialogFooter>
            <Button onClick={() => void navigator.clipboard.writeText(secret ?? '')}>{t('common.copy')}</Button>
            <Button variant="ghost" onClick={() => setSecret(null)}>
              {t('forms.connections.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={testResult !== null} onOpenChange={(open) => (open ? undefined : setTestResult(null))}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('forms.connections.testTitle', { name: testResult?.name ?? '' })}</DialogTitle>
          </DialogHeader>
          {testResult ? (
            <div className="grid gap-2 text-sm">
              <Pill tone={testResult.result.status === 'success' ? 'success' : testResult.result.status === 'skipped' ? 'neutral' : 'danger'}>
                {t(`forms.delivery.${testResult.result.status}`)}
                {testResult.result.status_code !== null ? ` · HTTP ${String(testResult.result.status_code)}` : ''}
              </Pill>
              {testResult.result.request ? <code className="block break-all text-xs text-muted-foreground">{testResult.result.request}</code> : null}
              {testResult.result.response ? <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs">{testResult.result.response}</pre> : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConnectionSummary({ connection }: { connection: FormConnection }) {
  const { t } = useI18n();
  const c = connection.config;
  const line = (() => {
    switch (connection.type) {
      case 'webhook':
        return `${str(c['method'], 'POST')} ${str(c['url'])}`;
      case 'google_sheets':
        return `${str(c['spreadsheet_id'])} · ${str(c['sheet_name'])}`;
      case 'email_notification':
        return Array.isArray(c['recipients']) ? c['recipients'].join(', ') : '';
      case 'docuseal':
        return `${t('forms.connections.template')} ${String(c['template_id'] ?? '')}`;
      case 'app':
        return `${str(c['app_id'])} · ${str(c['key'])}`;
    }
  })();
  return (
    <p className="truncate text-sm text-muted-foreground">
      {line}
      {connection.secret_hint ? ` · ${t('forms.connections.secret')} ${connection.secret_hint}` : ''}
      {connection.enabled ? '' : ` · ${t('forms.connections.disabled')}`}
    </p>
  );
}

function ConnectionDialog({
  formId,
  fields,
  connection,
  type,
  app,
  onClose,
  onSecret,
  guard,
}: {
  formId: string;
  fields: readonly FormField[];
  connection: FormConnection | null;
  type: ConnectorType;
  /** `type: 'app'`: the app connector, from the catalog. */
  app: AppConnectorInfo | null;
  onClose: () => void;
  onSecret: (secret: string | null) => void;
  /** Step-up dialog of the page: replays the save once the second factor is verified. */
  guard: (error: unknown, retry: () => void) => boolean;
}) {
  const { t, locale } = useI18n();
  const { slug, api } = useForms();
  const initial = connection?.config ?? {};
  const title = app === null ? t(`forms.connector.${type}`) : text(app.name, locale);
  const [name, setName] = useState(connection?.name ?? title);
  const [settings, setSettings] = useState<Record<string, unknown>>(
    (initial['settings'] as Record<string, unknown> | undefined) ?? {},
  );
  const [config, setConfig] = useState<Config>(initial);
  const [pairs, setPairs] = useState<Pair[]>(
    type === 'webhook'
      ? pairsOf(initial['field_map'], 'source', 'target')
      : type === 'google_sheets'
        ? pairsOf(initial['columns'], 'source', 'column')
        : type === 'docuseal'
          ? pairsOf(initial['prefill'], 'source', 'field')
          : [],
  );
  const [headers, setHeaders] = useState(
    Object.entries((initial['headers'] as Record<string, string> | undefined) ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
  );
  const [apiKey, setApiKey] = useState('');
  const [bodyTemplate, setBodyTemplate] = useState(str(initial['body_template']));
  const [mapConfirm, setMapConfirm] = useState(false);
  const bodyValid = parseBodyTemplate(bodyTemplate).ok;
  const mapAllFields = (mode: 'merge' | 'replace') => {
    setBodyTemplate(applyWebhookBody(bodyTemplate, buildWebhookBody(fields), mode));
    setMapConfirm(false);
  };
  const set = (patch: Config) => setConfig((prev) => ({ ...prev, ...patch }));
  const sources = [
    ...fields.filter((f) => collectsValue(f.kind)).map((f) => ({ value: f.key, label: f.label || f.key })),
    ...STANDARD_SOURCES.map((s) => ({ value: s, label: s })),
  ];

  const buildConfig = (): Config => {
    const clean = pairs.filter(([a, b]) => a !== '' && b.trim() !== '');
    switch (type) {
      case 'webhook':
        return {
          url: str(config['url']).trim(),
          method: str(config['method'], 'POST'),
          format: str(config['format'], 'json'),
          headers: Object.fromEntries(
            headers
              .split('\n')
              .map((line) => line.split(':'))
              .filter((parts) => parts.length >= 2 && (parts[0] ?? '').trim() !== '')
              .map((parts) => [(parts[0] ?? '').trim(), parts.slice(1).join(':').trim()]),
          ),
          field_map: clean.map(([source, target]) => ({ source, target: target.trim() })),
          body_template: bodyTemplate.trim() === '' ? null : bodyTemplate,
        };
      case 'google_sheets':
        return {
          account_id: str(config['account_id']).trim(),
          spreadsheet_id: str(config['spreadsheet_id']).trim(),
          sheet_name: str(config['sheet_name'], 'Sheet1').trim(),
          columns: clean.map(([source, column]) => ({ source, column: column.trim() })),
        };
      case 'email_notification':
        return {
          recipients: str(config['recipients_text'], Array.isArray(config['recipients']) ? config['recipients'].join(', ') : '')
            .split(/[\s,;]+/)
            .filter((e) => e !== ''),
          subject: str(config['subject'], 'New submission: {{form_name}}'),
        };
      case 'docuseal':
        return {
          region: str(config['region'], 'global'),
          base_url: str(config['base_url']).trim(),
          template_id: Math.trunc(Number(config['template_id'] ?? 0)),
          role: str(config['role']),
          email_source: str(config['email_source'], 'email'),
          name_source: str(config['name_source']),
          subject: str(config['subject']),
          message: str(config['message']),
          prefill: clean.map(([source, field]) => ({ source, field: field.trim() })),
          send_email: config['send_email'] !== false,
        };
      case 'app':
        return { app_id: app?.app_id ?? str(initial['app_id']), key: app?.key ?? str(initial['key']), settings };
    }
  };

  const save = useFormsMutation({
    mutationFn: async () => {
      const built = buildConfig();
      if (connection !== null) {
        return api.connections.update(formId, connection.id, {
          name: name.trim(),
          config: built,
          ...(apiKey.trim() === '' ? {} : { secret: apiKey.trim() }),
        });
      }
      const input = { type, name: name.trim(), config: built, ...(type === 'docuseal' ? { secret: apiKey.trim() } : {}) } as CreateConnectionInput;
      const created = await api.connections.create(formId, input);
      if (created.signing_secret !== null) onSecret(created.signing_secret);
      return created;
    },
    invalidate: [formsKeys.connections(slug, formId)],
    success: t('forms.connections.saved'),
    onSuccess: onClose,
    onError: (error) => guard(error, () => save.mutate(undefined)),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(undefined);
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {app === null
                ? t(`forms.connector.${type}.hint`)
                : app.description === null
                  ? t('forms.connector.app.hint', { app: app.app_name })
                  : text(app.description, locale)}
            </DialogDescription>
          </DialogHeader>
          <Field label={t('forms.field.name')}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          {type === 'webhook' ? (
            <>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
                <Field label={t('forms.connections.url')}>
                  {(id) => <Input id={id} type="url" required value={str(config['url'])} onChange={(e) => set({ url: e.target.value })} />}
                </Field>
                <Field label={t('forms.connections.method')}>
                  {(id) => <Choice id={id} value={str(config['method'], 'POST')} options={['POST', 'PUT', 'PATCH'].map((m) => ({ value: m, label: m }))} onChange={(v) => set({ method: v ?? 'POST' })} />}
                </Field>
                <Field label={t('forms.connections.format')}>
                  {(id) => <Choice id={id} value={str(config['format'], 'json')} options={[{ value: 'json', label: 'JSON' }, { value: 'form', label: 'Form' }]} onChange={(v) => set({ format: v ?? 'json' })} />}
                </Field>
              </div>
              <Field label={t('forms.connections.headers')} hint={t('forms.connections.headersHint')}>
                {(id) => <Textarea id={id} rows={2} className="font-mono text-xs" value={headers} onChange={(e) => setHeaders(e.target.value)} />}
              </Field>
              {str(config['format'], 'json') === 'json' ? (
                <div className="grid gap-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="webhook-body" className="text-sm font-medium">
                      {t('forms.connections.bodyTemplate')}
                    </label>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => (bodyTemplate.trim() === '' ? mapAllFields('replace') : setMapConfirm(true))}
                    >
                      <Wand2 className="size-3.5" aria-hidden />
                      {t('forms.connections.mapAll')}
                    </Button>
                  </div>
                  <Textarea
                    id="webhook-body"
                    rows={10}
                    spellCheck={false}
                    className="font-mono text-xs"
                    value={bodyTemplate}
                    onChange={(e) => setBodyTemplate(e.target.value)}
                    placeholder={t('forms.connections.bodyTemplatePlaceholder')}
                    aria-invalid={!bodyValid}
                  />
                  <p className={bodyValid ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>
                    {bodyValid ? t('forms.connections.bodyTemplateHint') : t('forms.connections.bodyTemplateInvalid')}
                  </p>
                </div>
              ) : null}
              <Field label={t('forms.connections.fieldMap')} hint={t('forms.connections.fieldMapHint')}>
                {() => <PairsEditor pairs={pairs} onChange={setPairs} sources={sources} rightLabel={t('forms.connections.parameter')} />}
              </Field>
              <Dialog open={mapConfirm} onOpenChange={setMapConfirm}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>{t('forms.connections.mapAllTitle')}</DialogTitle>
                    <DialogDescription>{t('forms.connections.mapAllBody')}</DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button type="button" variant="ghost" onClick={() => setMapConfirm(false)}>
                      {t('common.cancel')}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => mapAllFields('replace')}>
                      {t('forms.connections.mapAllReplace')}
                    </Button>
                    <Button type="button" onClick={() => mapAllFields('merge')}>
                      {t('forms.connections.mapAllMerge')}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          ) : null}
          {type === 'google_sheets' ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('forms.connections.account')} hint={t('forms.connections.accountHint')}>
                  {(id) => <Input id={id} required value={str(config['account_id'])} onChange={(e) => set({ account_id: e.target.value })} />}
                </Field>
                <Field label={t('forms.connections.spreadsheet')}>
                  {(id) => <Input id={id} required value={str(config['spreadsheet_id'])} onChange={(e) => set({ spreadsheet_id: e.target.value })} />}
                </Field>
                <Field label={t('forms.connections.sheet')}>
                  {(id) => <Input id={id} value={str(config['sheet_name'], 'Sheet1')} onChange={(e) => set({ sheet_name: e.target.value })} />}
                </Field>
              </div>
              <Field label={t('forms.connections.columns')} hint={t('forms.connections.columnsHint')}>
                {() => <PairsEditor pairs={pairs} onChange={setPairs} sources={sources} rightLabel={t('forms.connections.column')} />}
              </Field>
            </>
          ) : null}
          {type === 'email_notification' ? (
            <>
              <Field label={t('forms.connections.recipients')} hint={t('forms.connections.recipientsHint')}>
                {(id) => (
                  <Input
                    id={id}
                    required
                    value={str(config['recipients_text'], Array.isArray(config['recipients']) ? config['recipients'].join(', ') : '')}
                    onChange={(e) => set({ recipients_text: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t('forms.connections.subject')} hint={t('forms.connections.mergeHint')}>
                {(id) => <Input id={id} value={str(config['subject'], 'New submission: {{form_name}}')} onChange={(e) => set({ subject: e.target.value })} />}
              </Field>
            </>
          ) : null}
          {type === 'docuseal' ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('forms.connections.region')}>
                  {(id) => (
                    <Choice
                      id={id}
                      value={str(config['region'], 'global')}
                      options={(['global', 'eu', 'custom'] as const).map((value) => ({ value, label: t(`forms.connections.region.${value}`) }))}
                      onChange={(v) => set({ region: v ?? 'global' })}
                    />
                  )}
                </Field>
                {str(config['region']) === 'custom' ? (
                  <Field label={t('forms.connections.baseUrl')} className="sm:col-span-2">
                    {(id) => <Input id={id} type="url" value={str(config['base_url'])} onChange={(e) => set({ base_url: e.target.value })} />}
                  </Field>
                ) : null}
                <Field label={t('forms.connections.apiKey')} hint={connection?.has_secret ? t('forms.connections.apiKeyKeep') : undefined}>
                  {(id) => <Input id={id} type="password" autoComplete="off" required={connection === null} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />}
                </Field>
                <Field label={t('forms.connections.template')}>
                  {(id) => <Input id={id} type="number" min={1} required value={String(config['template_id'] ?? '')} onChange={(e) => set({ template_id: e.target.value })} />}
                </Field>
                <Field label={t('forms.connections.role')}>
                  {(id) => <Input id={id} value={str(config['role'])} onChange={(e) => set({ role: e.target.value })} />}
                </Field>
                <Field label={t('forms.connections.emailSource')}>
                  {(id) => <Choice id={id} value={str(config['email_source'], 'email')} options={sources} onChange={(v) => set({ email_source: v ?? 'email' })} />}
                </Field>
                <Field label={t('forms.connections.nameSource')}>
                  {(id) => <Choice id={id} value={str(config['name_source']) || null} noneLabel={t('forms.connections.automatic')} options={sources} onChange={(v) => set({ name_source: v ?? '' })} />}
                </Field>
              </div>
              <Field label={t('forms.connections.subject')} hint={t('forms.connections.mergeHint')}>
                {(id) => <Input id={id} value={str(config['subject'])} onChange={(e) => set({ subject: e.target.value })} />}
              </Field>
              <Field label={t('forms.connections.message')} hint={t('forms.connections.messageHint')}>
                {(id) => <Textarea id={id} rows={3} value={str(config['message'])} onChange={(e) => set({ message: e.target.value })} />}
              </Field>
              <Field label={t('forms.connections.prefill')}>
                {() => <PairsEditor pairs={pairs} onChange={setPairs} sources={sources} rightLabel={t('forms.connections.templateField')} />}
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={config['send_email'] !== false} onCheckedChange={(send_email) => set({ send_email })} />
                {t('forms.connections.sendEmail')}
              </label>
            </>
          ) : null}
          {type === 'app' && app === null ? (
            <p className="text-sm text-destructive">{t('forms.connector.appMissing', { app: str(initial['app_id']) })}</p>
          ) : null}
          {type === 'app' && app !== null && app.settings_schema !== null ? (
            <AppSchemaInputs
              schema={app.settings_schema as unknown as AppInputSchema}
              input={settings}
              source={{ appId: app.app_id, kind: 'connector', key: app.key }}
              onChange={setSettings}
            />
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={save.isPending || name.trim() === '' || (type === 'webhook' && !bodyValid) || (type === 'app' && app === null)}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

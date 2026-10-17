import { formDefinitionSchema, type FormDefinition, type FormField } from '@amable/forms';
import { DashboardButton, PageBody, PageToolbar } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@amable/ui/ui/tabs';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Check, Copy, ExternalLink, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import type { TypedForm } from '../api/client';
import { formsKeys, useCrmReferences, useForm, useForms, useFormsMutation, usePermissions } from '../api/hooks';
import { Choice, ErrorNotice, FormField as Field, PageState, SectionCard } from '../components/common';
import { FieldList, FieldProperties } from '../components/field-editor';
import { useFormChrome } from '../components/form-chrome';
import { FormPreview, previewConfig } from '../components/preview';
import { useInstalledExtensions } from '../../apps/api';
import { TagPicker } from '../../crm/components/tag-picker';

type BuilderTab = 'fields' | 'crm' | 'settings' | 'style' | 'embed';

export function FormBuilderPage() {
  const { formId = '' } = useParams({ strict: false }) as { formId?: string };
  const form = useForm(formId);
  useFormChrome(formId, form.data, 'builder');
  return (
    <PageState isPending={form.isPending} error={form.error}>
      {() => (form.data ? <Builder key={form.data.id} form={form.data} /> : null)}
    </PageState>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? t('common.copied') : t('common.copy')}
    </Button>
  );
}

function Builder({ form }: { form: TypedForm }) {
  const { t } = useI18n();
  const { slug, api } = useForms();
  const { can } = usePermissions();
  const refs = useCrmReferences();
  const writable = can('forms:write');
  const [name, setName] = useState(form.name);
  const [active, setActive] = useState(form.status === 'active');
  const [definition, setDefinition] = useState<FormDefinition>(form.definition);
  const [selectedId, setSelectedId] = useState<string | null>(form.definition.fields[0]?.id ?? null);
  const [tab, setTab] = useState<BuilderTab>('fields');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const edit = (next: FormDefinition) => {
    setDefinition(next);
    setDirty(true);
  };
  const patchField = (id: string, patch: Partial<FormField>) =>
    edit({ ...definition, fields: definition.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  const settings = definition.settings;
  const setSettings = (patch: Partial<FormDefinition['settings']>) => edit({ ...definition, settings: { ...settings, ...patch } });
  const style = definition.style;
  const setStyle = (patch: Partial<FormDefinition['style']>) => edit({ ...definition, style: { ...style, ...patch } });
  const crm = definition.crm;
  const validators = (useInstalledExtensions().data?.data ?? [])
    .filter((app) => app.status === 'active' && app.extensions.contact_validate !== undefined)
    .map((app) => app.name);
  const setCrm = (patch: Partial<FormDefinition['crm']>) => edit({ ...definition, crm: { ...crm, ...patch } });

  const validation = useMemo(() => formDefinitionSchema.safeParse(definition), [definition]);
  const firstIssue = validation.success ? null : validation.error.issues[0];
  const save = useFormsMutation({
    mutationFn: () =>
      api.forms.update(form.id, { name: name.trim(), status: active ? 'active' : 'inactive', definition }),
    success: t('forms.builder.saved'),
    onSuccess: () => setDirty(false),
  });
  const config = useMemo(() => previewConfig(form.id, name, slug, definition), [form.id, name, slug, definition]);
  const selected = definition.fields.find((f) => f.id === selectedId) ?? null;

  return (
    <>
      <PageToolbar
        filters={
          <div className="flex flex-wrap items-center gap-3">
            <Input
              aria-label={t('forms.field.name')}
              value={name}
              disabled={!writable}
              maxLength={200}
              className="h-8 w-64"
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
            />
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={active}
                disabled={!writable}
                onCheckedChange={(value) => {
                  setActive(value);
                  setDirty(true);
                }}
              />
              {active ? t('forms.status.active') : t('forms.status.inactive')}
            </label>
          </div>
        }
        actions={
          writable ? (
            <DashboardButton
              variant="primary"
              disabled={!dirty || save.isPending || !validation.success || name.trim() === ''}
              onClick={() => save.mutate(undefined)}
            >
              <Save aria-hidden /> {dirty ? t('common.save') : t('forms.builder.saved')}
            </DashboardButton>
          ) : null
        }
      />
      <PageBody className="grid gap-4 pt-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
        <div className="grid min-w-0 content-start gap-4">
          {firstIssue ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {firstIssue.path.join('.')}: {firstIssue.message}
            </p>
          ) : null}
          <Tabs value={tab} onValueChange={(value) => setTab(value as BuilderTab)}>
            <TabsList>
              {(['fields', 'crm', 'settings', 'style', 'embed'] as const).map((value) => (
                <TabsTrigger key={value} value={value}>
                  {t(`forms.builder.tab.${value}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="fields" className="grid gap-4 pt-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <SectionCard title={t('forms.builder.fields')}>
                <FieldList
                  definition={definition}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onChange={(fields) => edit({ ...definition, fields })}
                  disabled={!writable}
                />
              </SectionCard>
              <SectionCard title={selected ? t(`forms.kind.${selected.kind}`) : t('forms.builder.properties')}>
                {selected ? (
                  <FieldProperties
                    field={selected}
                    fields={definition.fields}
                    customFields={refs.customFields}
                    onPatch={(patch) => patchField(selected.id, patch)}
                    disabled={!writable}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">{t('forms.builder.selectField')}</p>
                )}
              </SectionCard>
            </TabsContent>
            <TabsContent value="crm" className="pt-3">
              <SectionCard title={t('forms.builder.tab.crm')}>
                <div className="grid gap-4">
                  <p className="text-sm text-muted-foreground">{t('forms.crm.intro')}</p>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={crm.create_contacts} disabled={!writable} onCheckedChange={(create_contacts) => setCrm({ create_contacts })} />
                    {t('forms.crm.createContacts')}
                  </label>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label={t('forms.crm.updatePolicy')} hint={t(`forms.crm.policy.${crm.update_policy}.hint`)}>
                      {(id) => (
                        <Choice
                          id={id}
                          value={crm.update_policy}
                          options={(['fill_empty', 'overwrite'] as const).map((value) => ({ value, label: t(`forms.crm.policy.${value}`) }))}
                          disabled={!writable}
                          onChange={(value) => setCrm({ update_policy: value === 'overwrite' ? 'overwrite' : 'fill_empty' })}
                        />
                      )}
                    </Field>
                    {validators.length > 0 ? (
                      <Field
                        label={t('forms.crm.appValidation')}
                        hint={t(`forms.crm.appValidation.${crm.app_validation}.hint`, { apps: validators.join(', ') })}
                      >
                        {(id) => (
                          <Choice
                            id={id}
                            value={crm.app_validation}
                            options={(['advisory', 'blocking'] as const).map((value) => ({ value, label: t(`forms.crm.appValidation.${value}`) }))}
                            disabled={!writable}
                            onChange={(value) => setCrm({ app_validation: value === 'blocking' ? 'blocking' : 'advisory' })}
                          />
                        )}
                      </Field>
                    ) : null}
                    <Field label={t('forms.crm.leadSource')}>
                      {(id) => (
                        <Choice
                          id={id}
                          value={crm.lead_source_id}
                          noneLabel={t('forms.crm.none')}
                          options={refs.leadSources.map((s) => ({ value: s.id, label: s.name }))}
                          disabled={!writable}
                          onChange={(lead_source_id) => setCrm({ lead_source_id })}
                        />
                      )}
                    </Field>
                    <Field label={t('forms.crm.owner')}>
                      {(id) => (
                        <Choice
                          id={id}
                          value={crm.owner_id}
                          noneLabel={t('forms.crm.none')}
                          options={refs.members.map((m) => ({ value: m.id, label: m.name }))}
                          disabled={!writable}
                          onChange={(owner_id) => setCrm({ owner_id })}
                        />
                      )}
                    </Field>
                  </div>
                  <Field label={t('forms.crm.tags')} hint={t('forms.crm.tagsHint')}>
                    {(id) => (
                      <TagPicker
                        id={id}
                        value={crm.tag_ids}
                        onChange={(tag_ids) => setCrm({ tag_ids })}
                        disabled={!writable}
                        className="w-full"
                      />
                    )}
                  </Field>
                  <p className="text-xs text-muted-foreground">{t('forms.crm.attribution')}</p>
                </div>
              </SectionCard>
            </TabsContent>
            <TabsContent value="settings" className="pt-3">
              <SectionCard title={t('forms.builder.tab.settings')}>
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label={t('forms.settings.submitLabel')} hint={t('forms.settings.defaultHint')}>
                    {(id) => <Input id={id} value={settings.submit_label} disabled={!writable} onChange={(e) => setSettings({ submit_label: e.target.value })} />}
                  </Field>
                  <Field label={t('forms.settings.nextLabel')}>
                    {(id) => <Input id={id} value={settings.next_label} disabled={!writable} onChange={(e) => setSettings({ next_label: e.target.value })} />}
                  </Field>
                  <Field label={t('forms.settings.backLabel')}>
                    {(id) => <Input id={id} value={settings.back_label} disabled={!writable} onChange={(e) => setSettings({ back_label: e.target.value })} />}
                  </Field>
                  <Field label={t('forms.settings.afterSubmit')}>
                    {(id) => (
                      <Choice
                        id={id}
                        value={settings.success_mode}
                        options={[
                          { value: 'message', label: t('forms.settings.showMessage') },
                          { value: 'redirect', label: t('forms.settings.redirect') },
                        ]}
                        disabled={!writable}
                        onChange={(value) => setSettings({ success_mode: value === 'redirect' ? 'redirect' : 'message' })}
                      />
                    )}
                  </Field>
                  {settings.success_mode === 'redirect' ? (
                    <Field label={t('forms.settings.redirectUrl')} className="sm:col-span-2">
                      {(id) => <Input id={id} type="url" value={settings.redirect_url} disabled={!writable} onChange={(e) => setSettings({ redirect_url: e.target.value.trim() })} />}
                    </Field>
                  ) : (
                    <Field label={t('forms.settings.successMessage')} hint={t('forms.settings.defaultHint')} className="sm:col-span-2">
                      {(id) => <Textarea id={id} rows={2} value={settings.success_message} disabled={!writable} onChange={(e) => setSettings({ success_message: e.target.value })} />}
                    </Field>
                  )}
                  <Field label={t('forms.settings.locale')}>
                    {(id) => (
                      <Choice
                        id={id}
                        value={settings.locale}
                        options={(['auto', 'en', 'it'] as const).map((value) => ({ value, label: t(`forms.settings.locale.${value}`) }))}
                        disabled={!writable}
                        onChange={(value) => setSettings({ locale: value === 'en' || value === 'it' ? value : 'auto' })}
                      />
                    )}
                  </Field>
                  <Field label={t('forms.settings.allowedDomains')} hint={t('forms.settings.allowedDomainsHint')} className="sm:col-span-2">
                    {(id) => (
                      <Input
                        id={id}
                        value={settings.allowed_domains.join(', ')}
                        disabled={!writable}
                        onChange={(e) =>
                          setSettings({
                            allowed_domains: e.target.value
                              .split(/[\s,]+/)
                              .map((d) => d.trim().toLowerCase())
                              .filter((d) => d !== ''),
                          })
                        }
                      />
                    )}
                  </Field>
                  <label className="flex items-center gap-2 text-sm sm:col-span-3">
                    <Switch checked={settings.turnstile_enabled} disabled={!writable} onCheckedChange={(turnstile_enabled) => setSettings({ turnstile_enabled })} />
                    {t('forms.settings.turnstile')}
                  </label>
                  <label className="flex items-center gap-2 text-sm sm:col-span-3">
                    <Switch checked={settings.hosted_enabled} disabled={!writable} onCheckedChange={(hosted_enabled) => setSettings({ hosted_enabled })} />
                    {t('forms.settings.hosted')}
                  </label>
                </div>
              </SectionCard>
            </TabsContent>
            <TabsContent value="style" className="pt-3">
              <SectionCard title={t('forms.builder.tab.style')}>
                <div className="grid gap-3 sm:grid-cols-3">
                  {(['primary_color', 'text_color', 'background_color', 'input_background', 'border_color', 'button_text_color'] as const).map((key) => (
                    <Field key={key} label={t(`forms.style.${key}`)}>
                      {(id) => (
                        <div className="flex gap-2">
                          <input
                            type="color"
                            aria-label={t(`forms.style.${key}`)}
                            className="h-9 w-10 cursor-pointer rounded border bg-transparent"
                            disabled={!writable}
                            value={/^#[0-9a-f]{6}$/i.test(style[key]) ? style[key] : '#ffffff'}
                            onChange={(e) => setStyle({ [key]: e.target.value })}
                          />
                          <Input id={id} value={style[key]} disabled={!writable} onChange={(e) => setStyle({ [key]: e.target.value })} />
                        </div>
                      )}
                    </Field>
                  ))}
                  {(['radius', 'font_size', 'gap', 'max_width'] as const).map((key) => (
                    <Field key={key} label={t(`forms.style.${key}`)}>
                      {(id) => <Input id={id} value={style[key]} disabled={!writable} onChange={(e) => setStyle({ [key]: e.target.value })} />}
                    </Field>
                  ))}
                  <Field label={t('forms.style.font_family')} className="sm:col-span-2">
                    {(id) => <Input id={id} value={style.font_family} disabled={!writable} onChange={(e) => setStyle({ font_family: e.target.value })} />}
                  </Field>
                  <Field label={t('forms.style.custom_css')} hint={t('forms.style.customCssHint')} className="sm:col-span-3">
                    {(id) => <Textarea id={id} rows={6} className="font-mono text-xs" value={style.custom_css} disabled={!writable} onChange={(e) => setStyle({ custom_css: e.target.value })} />}
                  </Field>
                </div>
              </SectionCard>
            </TabsContent>
            <TabsContent value="embed" className="pt-3">
              <EmbedPanel formId={form.id} dirty={dirty} />
            </TabsContent>
          </Tabs>
        </div>
        <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
          <SectionCard title={t('forms.preview.title')}>
            <div className="rounded-lg border bg-white p-4 text-black">
              <FormPreview config={config} />
            </div>
          </SectionCard>
        </aside>
      </PageBody>
    </>
  );
}

function EmbedPanel({ formId, dirty }: { formId: string; dirty: boolean }) {
  const { t } = useI18n();
  const { slug, api } = useForms();
  const embed = useQuery({ queryKey: formsKeys.embed(slug, formId), queryFn: () => api.forms.embed(formId) });
  if (embed.error) return <ErrorNotice error={embed.error} />;
  const data = embed.data;
  return (
    <div className="grid gap-4">
      {dirty ? <p className="text-sm text-amber-700 dark:text-amber-300">{t('forms.embed.unsaved')}</p> : null}
      <SectionCard title={t('forms.embed.snippet')} actions={data ? <CopyButton text={data.snippet} /> : null}>
        <p className="mb-2 text-sm text-muted-foreground">{t('forms.embed.snippetHint')}</p>
        <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
          <code>{data?.snippet ?? '…'}</code>
        </pre>
      </SectionCard>
      <SectionCard
        title={t('forms.embed.hosted')}
        actions={
          data && data.hosted_enabled ? (
            <>
              <CopyButton text={data.hosted_url} />
              <Button asChild variant="outline" size="sm">
                <a href={data.hosted_url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden /> {t('forms.embed.open')}
                </a>
              </Button>
            </>
          ) : null
        }
      >
        {data && !data.hosted_enabled ? (
          <p className="text-sm text-muted-foreground">{t('forms.embed.hostedDisabled')}</p>
        ) : (
          <code className="block overflow-x-auto rounded-lg bg-muted p-3 text-xs">{data?.hosted_url ?? '…'}</code>
        )}
      </SectionCard>
      <p className="text-xs text-muted-foreground">{t('forms.embed.landingHint')}</p>
    </div>
  );
}

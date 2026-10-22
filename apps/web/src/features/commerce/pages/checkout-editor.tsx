import type { Checkout } from '@amable/api-types';
import {
  CHECKOUT_STATUSES,
  CONTACT_FIELD_MODES,
  checkoutDefinitionSchema,
  defaultCheckoutDefinition,
  type CheckoutDefinition,
  type CheckoutStatus,
  type ContactFieldMode,
} from '@amable/checkout';
import { formDefinitionSchema, type FormDefinition, type FormField as FormFieldDef } from '@amable/forms';
import { DashboardButton, PageBody, PageToolbar, toast, usePageChrome } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@amable/ui/ui/tabs';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Check, Copy, ExternalLink, Save } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { EditLockBanner } from '../../../lib/edit-lock/edit-lock-banner';
import { editLockPath, useEditLock } from '../../../lib/edit-lock/use-edit-lock';
import { TagPicker } from '../../crm/components/tag-picker';
import { useCrmReferences } from '../../forms/api/hooks';
import { FieldList, FieldProperties } from '../../forms/components/field-editor';
import {
  commerceKeys,
  useCatalog,
  useCommerce,
  useCommerceMutation,
  useCommerceSettings,
  usePermissions,
} from '../api/hooks';
import { CheckoutPreview, previewCheckoutConfig } from '../components/checkout-preview';
import { BumpsSection, ItemsSection, OffersSection } from '../components/checkout-sections';
import { ChoiceSelect, ErrorNotice, FormField, PageState, SectionCard } from '../components/common';

type EditorTab = 'products' | 'fields' | 'bumps' | 'offers' | 'design' | 'settings';
const TABS: readonly EditorTab[] = ['products', 'fields', 'bumps', 'offers', 'design', 'settings'];

const FIELD_HOST: FormDefinition = formDefinitionSchema.parse({});

function parseDefinition(raw: unknown): CheckoutDefinition {
  const parsed = checkoutDefinitionSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultCheckoutDefinition();
}

export function CheckoutEditorPage() {
  const { checkoutId = '' } = useParams({ strict: false }) as { checkoutId?: string };
  const { slug, api } = useCommerce();
  const { t } = useI18n();
  const checkout = useQuery({
    queryKey: commerceKeys.checkout(slug, checkoutId),
    queryFn: () => api.checkouts.get(checkoutId),
  });
  usePageChrome({ title: checkout.data?.name ?? t('nav.checkouts') });
  return (
    <PageState isPending={checkout.isPending} error={checkout.error}>
      {() => (checkout.data ? <Editor key={checkout.data.id} checkout={checkout.data} /> : null)}
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

function Editor({ checkout }: { checkout: Checkout }) {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const { can } = usePermissions();
  const catalog = useCatalog();
  const settingsQuery = useCommerceSettings();
  const refs = useCrmReferences();
  const queryClient = useQueryClient();
  const canWrite = can('checkouts:write');
  const reloadRef = useRef<() => Promise<void>>(async () => undefined);
  const lock = useEditLock(canWrite ? editLockPath(slug, 'checkouts', checkout.id) : null, {
    onLost: (holder) =>
      toast.warning(holder ? t('common.lock.takenOver', { name: holder.user_name }) : t('common.lock.takenOverSomeone')),
    onStale: () => void reloadRef.current(),
  });
  const writable = canWrite && lock.canEdit;
  const [name, setName] = useState(checkout.name);
  const [status, setStatus] = useState<CheckoutStatus>(checkout.status);
  const [revision, setRevision] = useState(checkout.revision);
  const [definition, setDefinition] = useState<CheckoutDefinition>(() => parseDefinition(checkout.definition));
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [tab, setTab] = useState<EditorTab>('products');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  reloadRef.current = async () => {
    try {
      const fresh = await api.checkouts.get(checkout.id);
      queryClient.setQueryData(commerceKeys.checkout(slug, checkout.id), fresh);
      setName(fresh.name);
      setStatus(fresh.status);
      setRevision(fresh.revision);
      setDefinition(parseDefinition(fresh.definition));
      setDirty(false);
    } catch {
      // next poll or lock change retries
    }
  };

  const edit = (next: CheckoutDefinition) => {
    setDefinition(next);
    setDirty(true);
  };
  const settings = definition.settings;
  const setSettings = (patch: Partial<CheckoutDefinition['settings']>) => edit({ ...definition, settings: { ...settings, ...patch } });
  const style = definition.style;
  const setStyle = (patch: Partial<CheckoutDefinition['style']>) => edit({ ...definition, style: { ...style, ...patch } });
  const contact = definition.contact;
  const setContact = (patch: Partial<CheckoutDefinition['contact']>) => edit({ ...definition, contact: { ...contact, ...patch } });
  const crm = definition.crm;
  const setCrm = (patch: Partial<CheckoutDefinition['crm']>) => edit({ ...definition, crm: { ...crm, ...patch } });

  const validation = useMemo(() => checkoutDefinitionSchema.safeParse(definition), [definition]);
  const firstIssue = validation.success ? null : validation.error.issues[0];
  const save = useCommerceMutation({
    mutationFn: () => api.checkouts.update(checkout.id, { name: name.trim(), status, definition, revision }),
    success: t('checkout.editor.saved'),
    onSuccess: (saved) => {
      setRevision(saved.revision);
      setDirty(false);
    },
  });

  const currency =
    catalog.products.find((p) => definition.items.some((i) => i.ref_id === p.id || p.plans.some((plan) => plan.id === i.ref_id)))?.currency ??
    settingsQuery.data?.default_currency ??
    'EUR';
  const config = useMemo(
    () => previewCheckoutConfig(checkout.id, name, slug, currency, definition, catalog.products),
    [checkout.id, name, slug, currency, definition, catalog.products],
  );
  const selected = definition.fields.find((f) => f.id === selectedField) ?? null;
  const patchField = (id: string, patch: Partial<FormFieldDef>) =>
    edit({ ...definition, fields: definition.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  const sectionProps = { definition, edit, products: catalog.products, currency, disabled: !writable };

  const modeChoice = (key: 'name' | 'phone' | 'company' | 'address') => (
    <FormField label={t(`checkout.contact.${key}`)}>
      {(id) => (
        <ChoiceSelect
          id={id}
          value={contact[key]}
          disabled={!writable}
          onChange={(value) => setContact({ [key]: (CONTACT_FIELD_MODES as readonly string[]).includes(value) ? (value as ContactFieldMode) : 'optional' })}
          choices={CONTACT_FIELD_MODES.map((value) => ({ value, label: t(`checkout.contact.mode.${value}`) }))}
          className="w-full"
        />
      )}
    </FormField>
  );

  const text = (key: 'heading' | 'button_label' | 'success_message' | 'terms_label', multiline = false) => (
    <FormField label={t(`checkout.settings.${key}`)} hint={t('checkout.settings.defaultHint')} className={multiline ? 'sm:col-span-2' : undefined}>
      {(id) =>
        multiline ? (
          <Textarea id={id} rows={2} value={settings[key]} disabled={!writable} onChange={(e) => setSettings({ [key]: e.target.value })} />
        ) : (
          <Input id={id} value={settings[key]} disabled={!writable} onChange={(e) => setSettings({ [key]: e.target.value })} />
        )
      }
    </FormField>
  );

  return (
    <>
      <PageToolbar
        filters={
          <div className="flex flex-wrap items-center gap-3">
            <Input
              aria-label={t('commerce.field.name')}
              value={name}
              disabled={!writable}
              maxLength={200}
              className="h-8 w-64"
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
            />
            <ChoiceSelect
              ariaLabel={t('commerce.field.status')}
              value={status}
              disabled={!writable}
              onChange={(value) => {
                setStatus((CHECKOUT_STATUSES as readonly string[]).includes(value) ? (value as CheckoutStatus) : 'draft');
                setDirty(true);
              }}
              choices={CHECKOUT_STATUSES.map((value) => ({ value, label: t(`checkout.status.${value}`) }))}
            />
          </div>
        }
        actions={
          canWrite ? (
            <DashboardButton
              variant="primary"
              disabled={!writable || !dirty || save.isPending || !validation.success || name.trim() === ''}
              onClick={() => save.mutate(undefined)}
            >
              <Save aria-hidden /> {dirty ? t('common.save') : t('checkout.editor.saved')}
            </DashboardButton>
          ) : null
        }
      />
      <EditLockBanner lock={lock} canTakeover={canWrite} />
      <PageBody className="grid gap-4 pt-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
        <div className="grid min-w-0 content-start gap-4">
          {firstIssue ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {firstIssue.path.join('.')}: {firstIssue.message}
            </p>
          ) : null}
          {status === 'active' && definition.items.length === 0 ? (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">{t('checkout.editor.noItems')}</p>
          ) : null}
          <Tabs value={tab} onValueChange={(value) => setTab(value as EditorTab)}>
            <TabsList className="flex-wrap">
              {TABS.map((value) => (
                <TabsTrigger key={value} value={value}>
                  {t(`checkout.tab.${value}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="products" className="pt-3">
              <ItemsSection {...sectionProps} />
            </TabsContent>
            <TabsContent value="fields" className="grid gap-4 pt-3">
              <SectionCard title={t('checkout.contact.title')}>
                <div className="grid gap-3 sm:grid-cols-4">
                  {modeChoice('name')}
                  {modeChoice('phone')}
                  {modeChoice('company')}
                  {modeChoice('address')}
                  <FormField label={t('checkout.contact.defaultCountry')}>
                    {(id) => (
                      <Input
                        id={id}
                        value={contact.default_country}
                        maxLength={2}
                        className="font-mono uppercase"
                        disabled={!writable}
                        onChange={(e) => setContact({ default_country: e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) })}
                      />
                    )}
                  </FormField>
                  <label className="flex items-center gap-2 self-end pb-2 text-sm sm:col-span-3">
                    <Switch
                      checked={contact.address_autocomplete}
                      disabled={!writable || contact.address === 'hidden'}
                      onCheckedChange={(address_autocomplete) => setContact({ address_autocomplete })}
                    />
                    {t('checkout.contact.autocomplete')}
                  </label>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{t('checkout.contact.emailAlways')}</p>
              </SectionCard>
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                <SectionCard title={t('checkout.fields.custom')}>
                  <p className="mb-3 text-sm text-muted-foreground">{t('checkout.fields.prefillHint')}</p>
                  <FieldList
                    definition={{ ...FIELD_HOST, fields: definition.fields }}
                    selectedId={selectedField}
                    onSelect={setSelectedField}
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
              </div>
            </TabsContent>
            <TabsContent value="bumps" className="pt-3">
              <BumpsSection {...sectionProps} />
            </TabsContent>
            <TabsContent value="offers" className="pt-3">
              <OffersSection {...sectionProps} />
            </TabsContent>
            <TabsContent value="design" className="pt-3">
              <SectionCard title={t('checkout.tab.design')}>
                <div className="grid gap-3 sm:grid-cols-3">
                  <FormField label={t('checkout.design.layout')}>
                    {(id) => (
                      <ChoiceSelect
                        id={id}
                        value={style.layout}
                        disabled={!writable}
                        onChange={(value) => setStyle({ layout: value === 'one_column' ? 'one_column' : 'two_columns' })}
                        choices={(['two_columns', 'one_column'] as const).map((value) => ({ value, label: t(`checkout.design.layout.${value}`) }))}
                        className="w-full"
                      />
                    )}
                  </FormField>
                  {text('heading')}
                  {text('button_label')}
                  {(
                    ['primary_color', 'text_color', 'background_color', 'input_background', 'border_color', 'button_text_color', 'summary_background'] as const
                  ).map((key) => (
                    <FormField key={key} label={key === 'summary_background' ? t('checkout.design.summaryBackground') : t(`forms.style.${key}`)}>
                      {(id) => (
                        <div className="flex gap-2">
                          <input
                            type="color"
                            aria-label={key}
                            className="h-9 w-10 cursor-pointer rounded border bg-transparent"
                            disabled={!writable}
                            value={/^#[0-9a-f]{6}$/i.test(style[key]) ? style[key] : '#ffffff'}
                            onChange={(e) => setStyle({ [key]: e.target.value })}
                          />
                          <Input id={id} value={style[key]} disabled={!writable} onChange={(e) => setStyle({ [key]: e.target.value })} />
                        </div>
                      )}
                    </FormField>
                  ))}
                  {(['radius', 'font_size', 'gap', 'max_width'] as const).map((key) => (
                    <FormField key={key} label={t(`forms.style.${key}`)}>
                      {(id) => <Input id={id} value={style[key]} disabled={!writable} onChange={(e) => setStyle({ [key]: e.target.value })} />}
                    </FormField>
                  ))}
                  <FormField label={t('forms.style.font_family')} className="sm:col-span-2">
                    {(id) => <Input id={id} value={style.font_family} disabled={!writable} onChange={(e) => setStyle({ font_family: e.target.value })} />}
                  </FormField>
                  <FormField label={t('forms.style.custom_css')} hint={t('forms.style.customCssHint')} className="sm:col-span-3">
                    {(id) => (
                      <Textarea id={id} rows={6} className="font-mono text-xs" value={style.custom_css} disabled={!writable} onChange={(e) => setStyle({ custom_css: e.target.value })} />
                    )}
                  </FormField>
                </div>
              </SectionCard>
            </TabsContent>
            <TabsContent value="settings" className="grid gap-4 pt-3">
              <SectionCard title={t('checkout.settings.purchase')}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <Switch checked={settings.promo_codes} disabled={!writable} onCheckedChange={(promo_codes) => setSettings({ promo_codes })} />
                    {t('checkout.settings.promoCodes')}
                  </label>
                  {settings.promo_codes ? (
                    <FormField label={t('checkout.settings.promoParam')} hint={t('checkout.settings.promoParamHint', { param: settings.promo_param || 'promo' })}>
                      {(id) => (
                        <Input
                          id={id}
                          className="font-mono"
                          value={settings.promo_param}
                          disabled={!writable}
                          onChange={(e) => setSettings({ promo_param: e.target.value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) })}
                        />
                      )}
                    </FormField>
                  ) : null}
                  <FormField label={t('checkout.settings.thankYouUrl')} hint={t('checkout.settings.thankYouHint')} className="sm:col-span-2">
                    {(id) => <Input id={id} type="url" value={settings.thank_you_url} disabled={!writable} onChange={(e) => setSettings({ thank_you_url: e.target.value.trim() })} />}
                  </FormField>
                  {text('success_message', true)}
                  <FormField label={t('checkout.settings.termsUrl')} hint={t('checkout.settings.termsHint')}>
                    {(id) => <Input id={id} type="url" value={settings.terms_url} disabled={!writable} onChange={(e) => setSettings({ terms_url: e.target.value.trim() })} />}
                  </FormField>
                  {text('terms_label')}
                  <FormField label={t('forms.settings.locale')}>
                    {(id) => (
                      <ChoiceSelect
                        id={id}
                        value={settings.locale}
                        disabled={!writable}
                        onChange={(value) => setSettings({ locale: value === 'en' || value === 'it' ? value : 'auto' })}
                        choices={(['auto', 'en', 'it'] as const).map((value) => ({ value, label: t(`forms.settings.locale.${value}`) }))}
                        className="w-full"
                      />
                    )}
                  </FormField>
                  <FormField label={t('forms.settings.allowedDomains')} hint={t('forms.settings.allowedDomainsHint')}>
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
                  </FormField>
                  <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <Switch checked={settings.hosted_enabled} disabled={!writable} onCheckedChange={(hosted_enabled) => setSettings({ hosted_enabled })} />
                    {t('checkout.settings.hosted')}
                  </label>
                </div>
              </SectionCard>
              <SectionCard title={t('forms.builder.tab.crm')}>
                <div className="grid gap-3 sm:grid-cols-3">
                  <FormField label={t('forms.crm.updatePolicy')} hint={t(`forms.crm.policy.${crm.update_policy}.hint`)}>
                    {(id) => (
                      <ChoiceSelect
                        id={id}
                        value={crm.update_policy}
                        disabled={!writable}
                        onChange={(value) => setCrm({ update_policy: value === 'overwrite' ? 'overwrite' : 'fill_empty' })}
                        choices={(['fill_empty', 'overwrite'] as const).map((value) => ({ value, label: t(`forms.crm.policy.${value}`) }))}
                        className="w-full"
                      />
                    )}
                  </FormField>
                  <FormField label={t('forms.crm.leadSource')}>
                    {(id) => (
                      <ChoiceSelect
                        id={id}
                        value={crm.lead_source_id ?? ''}
                        disabled={!writable}
                        emptyLabel={t('forms.crm.none')}
                        onChange={(value) => setCrm({ lead_source_id: value === '' ? null : value })}
                        choices={refs.leadSources.map((s) => ({ value: s.id, label: s.name }))}
                        className="w-full"
                      />
                    )}
                  </FormField>
                  <FormField label={t('forms.crm.owner')}>
                    {(id) => (
                      <ChoiceSelect
                        id={id}
                        value={crm.owner_id ?? ''}
                        disabled={!writable}
                        emptyLabel={t('forms.crm.none')}
                        onChange={(value) => setCrm({ owner_id: value === '' ? null : value })}
                        choices={refs.members.map((m) => ({ value: m.id, label: m.name }))}
                        className="w-full"
                      />
                    )}
                  </FormField>
                  <FormField label={t('forms.crm.tags')} hint={t('checkout.settings.tagsHint')} className="sm:col-span-3">
                    {(id) => <TagPicker id={id} value={crm.tag_ids} onChange={(tag_ids) => setCrm({ tag_ids })} disabled={!writable} className="w-full" />}
                  </FormField>
                  <p className="text-xs text-muted-foreground sm:col-span-3">{t('checkout.settings.attribution')}</p>
                </div>
              </SectionCard>
              <EmbedPanel checkoutId={checkout.id} dirty={dirty} />
            </TabsContent>
          </Tabs>
        </div>
        <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
          <SectionCard title={t('checkout.preview.title')}>
            <div className="rounded-lg border bg-white p-4 text-black">
              <CheckoutPreview config={config} />
            </div>
          </SectionCard>
        </aside>
      </PageBody>
    </>
  );
}

function EmbedPanel({ checkoutId, dirty }: { checkoutId: string; dirty: boolean }) {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const embed = useQuery({ queryKey: commerceKeys.checkoutEmbed(slug, checkoutId), queryFn: () => api.checkouts.embed(checkoutId) });
  if (embed.error) return <ErrorNotice error={embed.error} />;
  const data = embed.data;
  return (
    <SectionCard title={t('checkout.embed.title')}>
      <div className="grid gap-4">
        {dirty ? <p className="text-sm text-amber-700 dark:text-amber-300">{t('checkout.embed.unsaved')}</p> : null}
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{t('checkout.embed.snippet')}</span>
            {data ? <CopyButton text={data.snippet} /> : null}
          </div>
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
            <code>{data?.snippet ?? '…'}</code>
          </pre>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{t('checkout.embed.offerSnippet')}</span>
            {data ? <CopyButton text={data.offer_snippet} /> : null}
          </div>
          <p className="text-xs text-muted-foreground">{t('checkout.embed.offerHint')}</p>
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
            <code>{data?.offer_snippet ?? '…'}</code>
          </pre>
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{t('checkout.embed.hosted')}</span>
            {data ? (
              <span className="flex gap-2">
                <CopyButton text={data.hosted_url} />
                <Button asChild variant="outline" size="sm">
                  <a href={data.hosted_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink aria-hidden /> {t('checkout.embed.open')}
                  </a>
                </Button>
              </span>
            ) : null}
          </div>
          <code className="block overflow-x-auto rounded-lg bg-muted p-3 text-xs">{data?.hosted_url ?? '…'}</code>
        </div>
        <p className="text-xs text-muted-foreground">{t('checkout.embed.landingHint')}</p>
      </div>
    </SectionCard>
  );
}

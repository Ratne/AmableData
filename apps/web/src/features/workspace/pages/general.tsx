import {
  COMPANY_FIELDS,
  WORKSPACE_LOGO_MAX_BYTES,
  WORKSPACE_SLUG_RE,
  type CompanyField,
  type GeneralSettings,
  type UpdateGeneralSettingsInput,
} from '@amable/api-types';
import type { MessageKey } from '@amable/i18n';
import {
  DashboardButton,
  PageBody,
  PageToolbar,
  PRODUCT_LOGO_URL,
  toast,
  usePageChrome,
} from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@amable/ui/ui/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ImageUp, Info, Save, Trash2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { CountrySelect } from '../../../components/locale/country-select';
import { TimeZoneSelect } from '../../../components/locale/timezone-select';
import { useI18n } from '../../../i18n';
import { CurrencySelect } from '../../commerce/components/currency-select';
import { FormField, SectionCard } from '../../../components/feature-kit';
import { PageState } from '../../commerce/components/common';
import { errorMessage, usePermissions, useTenantSlug } from '../../crm/api/hooks';
import { workspaceApi, workspaceKeys } from '../api';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SDI_RE = /^[A-Z0-9]{6,7}$/;
const INVITER = 'inviter';
const LOGO_TYPES = 'image/png,image/jpeg,image/webp,image/gif,image/avif';

type Company = Record<CompanyField, string>;

interface Draft {
  name: string;
  slug: string;
  primary_color: string;
  timezone: string;
  language: string;
  country_code: string;
  currency: string;
  company: Company;
}

function toDraft(settings: GeneralSettings): Draft {
  return {
    name: settings.name,
    slug: settings.slug,
    primary_color: settings.primary_color ?? '',
    timezone: settings.timezone,
    language: settings.language ?? INVITER,
    country_code: settings.country_code ?? '',
    currency: settings.currency,
    company: Object.fromEntries(
      COMPANY_FIELDS.map((f) => [f, settings.company[f] ?? '']),
    ) as Company,
  };
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

function changes(initial: Draft, draft: Draft): UpdateGeneralSettingsInput {
  const body: UpdateGeneralSettingsInput = {};
  if (draft.name.trim() !== initial.name) body.name = draft.name.trim();
  if (draft.slug !== initial.slug) body.slug = draft.slug;
  if (draft.primary_color !== initial.primary_color)
    body.primary_color = orNull(draft.primary_color);
  if (draft.timezone !== initial.timezone) body.timezone = draft.timezone;
  if (draft.language !== initial.language)
    body.language = draft.language === 'it' || draft.language === 'en' ? draft.language : null;
  if (draft.country_code !== initial.country_code) body.country_code = orNull(draft.country_code);
  if (draft.currency !== initial.currency) body.currency = draft.currency;
  const company: Partial<Record<CompanyField, string | null>> = {};
  for (const field of COMPANY_FIELDS) {
    if (draft.company[field].trim() !== initial.company[field])
      company[field] = orNull(draft.company[field]);
  }
  if (Object.keys(company).length > 0)
    body.company = company as UpdateGeneralSettingsInput['company'];
  return body;
}

type Errors = Partial<Record<'name' | 'slug' | 'primary_color' | CompanyField, MessageKey>>;

function validate(draft: Draft): Errors {
  const errors: Errors = {};
  const c = draft.company;
  if (draft.name.trim() === '') errors.name = 'general.error.nameRequired';
  if (draft.slug.length < 2 || draft.slug.length > 64 || !WORKSPACE_SLUG_RE.test(draft.slug)) {
    errors.slug = 'general.error.slug';
  }
  if (draft.primary_color !== '' && !HEX_RE.test(draft.primary_color))
    errors.primary_color = 'general.error.color';
  if (c.email.trim() !== '' && !EMAIL_RE.test(c.email.trim())) errors.email = 'general.error.email';
  if (c.pec.trim() !== '' && !EMAIL_RE.test(c.pec.trim())) errors.pec = 'general.error.email';
  if (c.sdi_code.trim() !== '' && !SDI_RE.test(c.sdi_code.trim()))
    errors.sdi_code = 'general.error.sdi';
  if (c.website.trim() !== '' && !/^https?:\/\/\S+\.\S+/.test(c.website.trim()))
    errors.website = 'general.error.website';
  return errors;
}

export function GeneralSettingsPage() {
  const { t } = useI18n();
  const slug = useTenantSlug();
  usePageChrome({ title: t('nav.settingsGeneral') });
  const settings = useQuery({
    queryKey: workspaceKeys.general(slug),
    queryFn: () => workspaceApi.general(slug),
  });
  return (
    <PageState isPending={settings.isPending} error={settings.error}>
      {() =>
        settings.data ? (
          <GeneralForm key={JSON.stringify(settings.data)} settings={settings.data} />
        ) : null
      }
    </PageState>
  );
}

function GeneralForm({ settings }: { settings: GeneralSettings }) {
  const { t } = useI18n();
  const slug = useTenantSlug();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const editable = can('settings:manage');
  const initial = toDraft(settings);
  const [draft, setDraft] = useState<Draft>(initial);
  const [submitted, setSubmitted] = useState(false);
  const errors = validate(draft);
  const body = changes(initial, draft);
  const dirty = Object.keys(body).length > 0;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setCompany = (field: CompanyField, value: string) =>
    setDraft((d) => ({ ...d, company: { ...d.company, [field]: value } }));
  const showError = (key: keyof Errors) =>
    (submitted || key === 'slug' || key === 'primary_color') && errors[key] ? t(errors[key]) : null;

  const applied = (data: GeneralSettings) => {
    queryClient.setQueryData(workspaceKeys.general(data.slug), data);
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.profile(data.slug) });
    void queryClient.invalidateQueries({ queryKey: ['commerce', data.slug, 'settings'] });
    void queryClient.invalidateQueries({ queryKey: ['email', data.slug, 'settings'] });
  };

  const save = useMutation({
    mutationFn: (input: UpdateGeneralSettingsInput) => workspaceApi.update(slug, input),
    onSuccess: async (data) => {
      applied(data);
      toast.success(t('general.saved'));
      if (data.slug !== slug) {
        await queryClient.invalidateQueries({ queryKey: ['me'] });
        void navigate({ to: '/t/$tenant/settings', params: { tenant: data.slug } });
      }
    },
    onError: (error) => toast.error(errorMessage(t, error)),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (Object.keys(errors).length > 0 || !dirty) return;
    save.mutate(body);
  };

  const companyInput = (
    field: CompanyField,
    options: { type?: string; placeholder?: string; upper?: boolean } = {},
  ) => (
    <FormField
      label={t(`general.company.${field}` as MessageKey)}
      error={showError(field as keyof Errors)}
    >
      {(id) => (
        <Input
          id={id}
          type={options.type ?? 'text'}
          placeholder={options.placeholder}
          value={draft.company[field]}
          aria-invalid={Boolean(showError(field as keyof Errors))}
          onChange={(e) =>
            setCompany(field, options.upper ? e.target.value.toUpperCase() : e.target.value)
          }
        />
      )}
    </FormField>
  );

  return (
    <form onSubmit={submit} noValidate>
      <PageToolbar
        actions={
          editable ? (
            <DashboardButton variant="primary" type="submit" disabled={!dirty || save.isPending}>
              <Save aria-hidden /> {t('common.save')}
            </DashboardButton>
          ) : null
        }
      />
      <PageBody className="grid max-w-3xl gap-4">
        <fieldset disabled={!editable || save.isPending} className="grid gap-4">
          <SectionCard title={t('general.workspace.title')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('general.workspace.name')} error={showError('name')}>
                {(id) => (
                  <Input
                    id={id}
                    value={draft.name}
                    maxLength={120}
                    onChange={(e) => set('name', e.target.value)}
                  />
                )}
              </FormField>
              <FormField
                label={t('general.workspace.slug')}
                error={showError('slug')}
                hint={t('general.workspace.slugHint', {
                  url: `${window.location.origin}/t/${draft.slug || '…'}`,
                })}
              >
                {(id) => (
                  <Input
                    id={id}
                    value={draft.slug}
                    maxLength={64}
                    spellCheck={false}
                    autoCapitalize="none"
                    aria-invalid={Boolean(showError('slug'))}
                    onChange={(e) =>
                      set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                    }
                  />
                )}
              </FormField>
            </div>
            {draft.slug !== initial.slug ? (
              <p className="mt-3 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                {t('general.workspace.slugChange', { old: initial.slug })}
              </p>
            ) : null}
            {settings.previous_slugs.length > 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {t('general.workspace.previous', { slugs: settings.previous_slugs.join(', ') })}
              </p>
            ) : null}
          </SectionCard>

          <SectionCard title={t('general.branding.title')}>
            <p className="mb-4 text-sm text-muted-foreground">{t('general.branding.intro')}</p>
            <div className="grid gap-6 sm:grid-cols-2">
              <LogoField settings={settings} editable={editable} onApplied={applied} />
              <FormField
                label={t('general.branding.color')}
                error={showError('primary_color')}
                hint={t('general.branding.colorHint')}
              >
                {(id) => (
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label={t('general.branding.color')}
                      className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
                      value={HEX_RE.test(draft.primary_color) ? draft.primary_color : '#4f46e5'}
                      onChange={(e) => set('primary_color', e.target.value)}
                    />
                    <Input
                      id={id}
                      className="w-32 font-mono"
                      placeholder="#4f46e5"
                      maxLength={7}
                      value={draft.primary_color}
                      aria-invalid={Boolean(showError('primary_color'))}
                      onChange={(e) => set('primary_color', e.target.value.trim())}
                    />
                    {draft.primary_color !== '' ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => set('primary_color', '')}
                      >
                        {t('general.branding.resetColor')}
                      </Button>
                    ) : null}
                  </div>
                )}
              </FormField>
            </div>
          </SectionCard>

          <SectionCard title={t('general.regional.title')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label={t('general.regional.timezone')}
                hint={t('general.regional.timezoneHint')}
              >
                {(id) => (
                  <TimeZoneSelect
                    id={id}
                    value={draft.timezone}
                    allowEmpty={false}
                    onChange={(v) => set('timezone', v)}
                  />
                )}
              </FormField>
              <FormField
                label={t('general.regional.language')}
                hint={t('general.regional.languageHint')}
              >
                {(id) => (
                  <Select value={draft.language} onValueChange={(v) => set('language', v)}>
                    <SelectTrigger id={id} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={INVITER}>
                        {t('general.regional.languageInviter')}
                      </SelectItem>
                      <SelectItem value="it">Italiano</SelectItem>
                      <SelectItem value="en">English</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </FormField>
              <FormField
                label={t('general.regional.country')}
                hint={t('general.regional.countryHint')}
              >
                {() => (
                  <CountrySelect
                    ariaLabel={t('general.regional.country')}
                    value={draft.country_code}
                    onChange={(v) => set('country_code', v)}
                  />
                )}
              </FormField>
              <FormField
                label={t('general.regional.currency')}
                hint={t('general.regional.currencyHint')}
              >
                {(id) => (
                  <CurrencySelect
                    id={id}
                    value={draft.currency}
                    onChange={(v) => set('currency', v)}
                  />
                )}
              </FormField>
            </div>
          </SectionCard>

          <SectionCard title={t('general.company.title')}>
            <p className="mb-4 text-sm text-muted-foreground">{t('general.company.intro')}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">{companyInput('legal_name')}</div>
              {companyInput('vat_number', { placeholder: 'IT01234567890' })}
              {companyInput('tax_code')}
              {companyInput('sdi_code', { placeholder: '0000000', upper: true })}
              {companyInput('pec', { type: 'email' })}
              {companyInput('email', { type: 'email' })}
              {companyInput('phone', { type: 'tel' })}
              <div className="sm:col-span-2">
                {companyInput('website', { type: 'url', placeholder: 'https://' })}
              </div>
            </div>
            <h4 className="mb-3 mt-6 text-sm font-medium">{t('general.company.address')}</h4>
            <div className="grid gap-4 sm:grid-cols-6">
              <FormField label={t('general.company.country_code')} className="sm:col-span-6">
                {() => (
                  <CountrySelect
                    ariaLabel={t('general.company.country_code')}
                    value={draft.company.country_code}
                    onChange={(v) => setCompany('country_code', v)}
                  />
                )}
              </FormField>
              <div className="sm:col-span-4">{companyInput('street')}</div>
              <div className="sm:col-span-2">{companyInput('street_number')}</div>
              <div className="sm:col-span-2">{companyInput('postal_code')}</div>
              <div className="sm:col-span-2">{companyInput('city')}</div>
              <div className="sm:col-span-2">{companyInput('region')}</div>
            </div>
          </SectionCard>
        </fieldset>
      </PageBody>
    </form>
  );
}

function LogoField({
  settings,
  editable,
  onApplied,
}: {
  settings: GeneralSettings;
  editable: boolean;
  onApplied: (data: GeneralSettings) => void;
}) {
  const { t } = useI18n();
  const slug = useTenantSlug();
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => workspaceApi.uploadLogo(slug, file),
    onSuccess: (data) => {
      onApplied(data);
      toast.success(t('general.branding.logoSaved'));
    },
    onError: (error) => toast.error(errorMessage(t, error)),
  });
  const remove = useMutation({
    mutationFn: () => workspaceApi.removeLogo(slug),
    onSuccess: onApplied,
    onError: (error) => toast.error(errorMessage(t, error)),
  });
  const busy = upload.isPending || remove.isPending;

  const pick = (file: File | undefined) => {
    if (file === undefined) return;
    if (file.size > WORKSPACE_LOGO_MAX_BYTES) {
      toast.error(t('general.branding.logoTooLarge'));
      return;
    }
    upload.mutate(file);
  };

  return (
    <div className="grid content-start gap-1.5">
      <span className="text-sm font-medium">{t('general.branding.logo')}</span>
      <div className="flex items-center gap-3">
        <div className="flex size-16 items-center justify-center rounded-lg border bg-muted/40 p-1.5">
          <img
            src={settings.logo_url ?? PRODUCT_LOGO_URL}
            alt=""
            className="max-h-full max-w-full object-contain"
          />
        </div>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <ImageUp aria-hidden />{' '}
              {settings.logo_url
                ? t('general.branding.replaceLogo')
                : t('general.branding.uploadLogo')}
            </Button>
            {settings.logo_url ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => remove.mutate()}
              >
                <Trash2 aria-hidden /> {t('general.branding.removeLogo')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('general.branding.logoHint')}</p>
      <input
        ref={input}
        type="file"
        accept={LOGO_TYPES}
        className="hidden"
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
}

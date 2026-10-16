import { DashboardButton, PageBody, PageToolbar } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { Textarea } from '@amable/ui/ui/textarea';
import { useNavigate, useParams } from '@tanstack/react-router';
import { PenTool, Rocket, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useAnalyticsSites, useDates, useLanding, useLandingMutation, usePage, usePermissions } from '../api/hooks';
import type { LandingPage, LandingPageWithDraft } from '../api/types';

type Seo = LandingPage['seo'];
import { Choice, FormField, normalizePath, PageState, Pill, SectionCard } from '../components/common';
import { MediaInput } from '../components/media-library';
import { useLandingChrome } from '../components/page-chrome';
import { LiveLink, PublishDialog, UnpublishButton, VersionsPanel } from '../components/publish';

export function PageSettingsPage() {
  const { pageId = '' } = useParams({ strict: false }) as { pageId?: string };
  const page = usePage(pageId);
  useLandingChrome(pageId, page.data, 'settings');
  return (
    <PageState isPending={page.isPending} error={page.error}>
      {() => (page.data ? <SettingsForm key={`${page.data.id}:${page.data.updated_at}`} page={page.data} /> : null)}
    </PageState>
  );
}

interface FormState {
  title: string;
  path: string;
  host: string;
  seo: Seo;
  analyticsSiteId: string | null;
  favicon: string;
  lang: string;
}

function initialState(page: LandingPageWithDraft): FormState {
  return {
    title: page.title,
    path: page.path,
    host: page.host ?? '',
    seo: { ...page.seo },
    analyticsSiteId: page.settings.analytics_site_id ?? null,
    favicon: page.settings.favicon ?? '',
    lang: page.settings.lang ?? '',
  };
}

const nullable = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim());

function SettingsForm({ page }: { page: LandingPageWithDraft }) {
  const { t } = useI18n();
  const { slug, api } = useLanding();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const { dateTime } = useDates();
  const sites = useAnalyticsSites();
  const writable = can('pages:write');
  const [form, setForm] = useState<FormState>(() => initialState(page));
  const [dirty, setDirty] = useState(false);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const patch = (next: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...next }));
    setDirty(true);
  };
  const patchSeo = (next: Partial<Seo>) => patch({ seo: { ...form.seo, ...next } });

  const save = useLandingMutation({
    mutationFn: () =>
      api.pages.update(page.id, {
        title: form.title.trim(),
        path: normalizePath(form.path),
        host: nullable(form.host)?.toLowerCase() ?? null,
        seo: {
          title: nullable(form.seo.title),
          description: nullable(form.seo.description),
          og_image: nullable(form.seo.og_image),
          canonical: nullable(form.seo.canonical),
          noindex: form.seo.noindex,
        },
        settings: { analytics_site_id: form.analyticsSiteId, favicon: nullable(form.favicon), lang: nullable(form.lang) },
      }),
    success: t('landing.settings.saved'),
    onSuccess: () => setDirty(false),
  });

  const siteOptions = (sites.data ?? []).map((site) => ({ value: site.id, label: `${site.name} (${site.hostnames.join(', ')})` }));
  const valid = form.title.trim() !== '' && normalizePath(form.path).length > 0;

  return (
    <>
      <PageToolbar
        filters={
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <code className="text-xs">{page.path}</code>
            <LiveLink page={page} />
          </div>
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void navigate({ to: '/t/$tenant/landing-pages/$pageId/edit', params: { tenant: slug, pageId: page.id } })}
            >
              <PenTool aria-hidden /> {t('landing.action.edit')}
            </Button>
            {writable ? (
              <DashboardButton variant="primary" disabled={!dirty || !valid || save.isPending} onClick={() => save.mutate(undefined)}>
                <Save aria-hidden /> {dirty ? t('common.save') : t('landing.settings.saved')}
              </DashboardButton>
            ) : null}
          </>
        }
      />
      <PageBody className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div className="grid min-w-0 content-start gap-4">
          <SectionCard title={t('landing.settings.general')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t('landing.field.title')} className="sm:col-span-2">
                {(id) => <Input id={id} value={form.title} maxLength={200} disabled={!writable} onChange={(e) => patch({ title: e.target.value })} />}
              </FormField>
              <FormField label={t('landing.field.path')} hint={t('landing.settings.pathHint')}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.path}
                    maxLength={300}
                    className="font-mono"
                    disabled={!writable}
                    onChange={(e) => patch({ path: e.target.value })}
                    onBlur={() => setForm((current) => ({ ...current, path: normalizePath(current.path) }))}
                  />
                )}
              </FormField>
              <FormField label={t('landing.field.host')} hint={t('landing.settings.hostHint')}>
                {(id) => (
                  <Input
                    id={id}
                    value={form.host}
                    placeholder="www.example.com"
                    maxLength={253}
                    disabled={!writable}
                    onChange={(e) => patch({ host: e.target.value.trim() })}
                  />
                )}
              </FormField>
              <FormField label={t('landing.settings.lang')} hint={t('landing.settings.langHint')}>
                {(id) => (
                  <Input id={id} value={form.lang} placeholder="en" maxLength={35} disabled={!writable} onChange={(e) => patch({ lang: e.target.value.trim() })} />
                )}
              </FormField>
              <FormField label={t('landing.settings.favicon')} hint={t('landing.settings.faviconHint')}>
                {(id) => <MediaInput id={id} value={form.favicon} disabled={!writable} onChange={(favicon) => patch({ favicon })} />}
              </FormField>
            </div>
          </SectionCard>
          <SectionCard title={t('landing.settings.seo')}>
            <div className="grid gap-3">
              <FormField label={t('landing.seo.title')} hint={t('landing.seo.titleHint')}>
                {(id) => (
                  <Input id={id} value={form.seo.title ?? ''} maxLength={200} disabled={!writable} onChange={(e) => patchSeo({ title: e.target.value })} />
                )}
              </FormField>
              <FormField label={t('landing.seo.description')} hint={t('landing.seo.descriptionHint', { count: (form.seo.description ?? '').length })}>
                {(id) => (
                  <Textarea
                    id={id}
                    rows={3}
                    maxLength={500}
                    value={form.seo.description ?? ''}
                    disabled={!writable}
                    onChange={(e) => patchSeo({ description: e.target.value })}
                  />
                )}
              </FormField>
              <FormField label={t('landing.seo.ogImage')} hint={t('landing.seo.ogImageHint')}>
                {(id) => <MediaInput id={id} value={form.seo.og_image ?? ''} disabled={!writable} onChange={(og_image) => patchSeo({ og_image })} />}
              </FormField>
              <FormField label={t('landing.seo.canonical')} hint={t('landing.seo.canonicalHint')}>
                {(id) => (
                  <Input
                    id={id}
                    type="url"
                    value={form.seo.canonical ?? ''}
                    placeholder="https://"
                    disabled={!writable}
                    onChange={(e) => patchSeo({ canonical: e.target.value.trim() })}
                  />
                )}
              </FormField>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={form.seo.noindex} disabled={!writable} onCheckedChange={(noindex) => patchSeo({ noindex })} />
                {t('landing.seo.noindex')}
              </label>
            </div>
          </SectionCard>
          <SectionCard title={t('landing.settings.analytics')}>
            <FormField label={t('landing.settings.analyticsSite')} hint={t('landing.settings.analyticsHint')}>
              {(id) => (
                <Choice
                  id={id}
                  value={form.analyticsSiteId}
                  noneLabel={t('landing.settings.analyticsAuto')}
                  options={siteOptions}
                  disabled={!writable || sites.isError}
                  onChange={(analyticsSiteId) => patch({ analyticsSiteId })}
                />
              )}
            </FormField>
            {sites.isError ? <p className="mt-2 text-xs text-muted-foreground">{t('landing.settings.analyticsUnavailable')}</p> : null}
          </SectionCard>
        </div>
        <aside className="grid min-w-0 content-start gap-4">
          <SectionCard title={t('landing.publish.section')}>
            <div className="grid gap-3">
              <div className="flex items-center gap-2 text-sm">
                <Pill tone={page.status === 'published' ? 'success' : 'neutral'}>{t(`landing.status.${page.status}`)}</Pill>
                {page.published_at ? (
                  <span className="text-muted-foreground">{t('landing.publish.lastPublished', { date: dateTime(page.published_at) })}</span>
                ) : null}
              </div>
              {page.public_url ? <code className="block truncate rounded bg-muted px-2 py-1 text-xs">{page.public_url}</code> : null}
              {can('pages:publish') ? (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" disabled={dirty} onClick={() => setPublishing(true)}>
                    <Rocket aria-hidden /> {t('landing.publish.action')}
                  </Button>
                  {page.status === 'published' ? <UnpublishButton page={page} /> : null}
                </div>
              ) : null}
              {dirty ? <p className="text-xs text-amber-700 dark:text-amber-300">{t('landing.settings.saveFirst')}</p> : null}
            </div>
          </SectionCard>
          <SectionCard title={t('landing.versions.title')}>
            <VersionsPanel page={page} />
          </SectionCard>
        </aside>
      </PageBody>
      {publishing ? <PublishDialog page={page} onClose={() => setPublishing(false)} /> : null}
    </>
  );
}

import { toast } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink, Eye, Rocket, Save, Settings } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { EditLockBanner } from '../../../lib/edit-lock/edit-lock-banner';
import { editLockPath, useEditLock, type EditLockStatus } from '../../../lib/edit-lock/use-edit-lock';
import { LandingApiError } from '../api/client';
import { errorMessage, landingKeys, useLanding, usePermissions } from '../api/hooks';
import type { HtmlPageWithDraft, LandingPage } from '../api/types';
import { Pill } from '../components/common';
import { PublishDialog } from '../components/publish';
import { SaveIndicator } from '../components/save-indicator';
import { PreviewDialog } from '../editor/preview-dialog';
import type { SaveState } from '../hooks/use-builder-document';

const AUTOSAVE_MS = 1500;

/**
 * Source editor of a raw HTML page (`editorKind: "html"`): the whole document
 * as text, autosaved with `base_revision` under the same edit lock as the
 * canvas editor; preview and publish go through the regular endpoints.
 */
export function HtmlEditor({ initial, meta }: { initial: HtmlPageWithDraft; meta: LandingPage }) {
  const { t } = useI18n();
  const { slug, api } = useLanding();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lock = useEditLock(can('pages:write') ? editLockPath(slug, 'pages', initial.id) : null, {
    onLost: (holder) =>
      toast.warning(holder ? t('common.lock.takenOver', { name: holder.user_name }) : t('common.lock.takenOverSomeone')),
  });
  const editable = lock.canEdit && can('pages:write');

  const [source, setSource] = useState(initial.draft.html);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const [baseline, setBaseline] = useState(initial.draft.html);
  const baselineRef = useRef(baseline);
  const revision = useRef(initial.draft_revision);
  const blocked = useRef(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [showPreview, setShowPreview] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const dirty = source !== baseline;

  const reload = useCallback(async () => {
    try {
      const fresh = await api.pages.get(initial.id);
      queryClient.setQueryData(landingKeys.page(slug, initial.id), fresh);
      if (fresh.draft.editorKind !== 'html') return;
      revision.current = fresh.draft_revision;
      blocked.current = false;
      baselineRef.current = fresh.draft.html;
      setBaseline(fresh.draft.html);
      setSource(fresh.draft.html);
      setSaveState('idle');
    } catch (error) {
      toast.error(errorMessage(t, error));
    }
  }, [api, initial.id, queryClient, slug, t]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) await inFlight.current;
    const html = sourceRef.current;
    if (blocked.current) return false;
    if (html === baselineRef.current) return true;
    setSaveState('saving');
    const run = (async () => {
      try {
        const result = await api.pages.saveDraft(initial.id, { editorKind: 'html', html }, revision.current);
        revision.current = result.draft_revision;
        baselineRef.current = html;
        setBaseline(html);
        setSaveState(sourceRef.current === html ? 'saved' : 'pending');
        return true;
      } catch (error) {
        setSaveState('error');
        if (error instanceof LandingApiError && error.status === 409 && error.code === 'stale_draft') {
          blocked.current = true;
          toast.warning(t('landing.editor.staleReloaded'));
          void reload();
        } else if (error instanceof LandingApiError && error.status === 423) {
          blocked.current = true;
          toast.warning(t('common.lock.lost'));
        } else {
          toast.error(errorMessage(t, error));
        }
        return false;
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = run;
    return run;
  }, [api, initial.id, reload, t]);

  useEffect(() => {
    if (!editable || !dirty || blocked.current) return undefined;
    setSaveState((s) => (s === 'saving' ? s : 'pending'));
    const timer = window.setTimeout(() => void saveNow(), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [source, dirty, editable, saveNow]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (sourceRef.current !== baselineRef.current) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveNow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveNow]);

  const prevLock = useRef<EditLockStatus>(lock.status);
  useEffect(() => {
    const prev = prevLock.current;
    prevLock.current = lock.status;
    if (lock.status === 'holder' && prev !== 'holder' && !dirty) void reload();
  }, [lock.status, dirty, reload]);

  const canPublish = can('pages:publish');
  const publicUrl = meta.status === 'published' ? meta.public_url : null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="html-editor">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={t('landing.editor.backToList')}
          aria-label={t('landing.editor.backToList')}
          onClick={() => void navigate({ to: '/t/$tenant/landing-pages', params: { tenant: slug } })}
        >
          <ArrowLeft aria-hidden /> <span className="hidden lg:inline">{t('nav.landingPages')}</span>
        </Button>
        <div className="flex min-w-0 max-w-64 flex-col leading-tight">
          <span className="truncate text-sm font-medium">{meta.title || t('landing.untitled')}</span>
          <code className="truncate text-[11px] text-muted-foreground">{meta.path}</code>
        </div>
        <Pill tone={meta.status === 'published' ? 'success' : 'neutral'}>{t(`landing.status.${meta.status}`)}</Pill>
        <Pill tone="neutral">{t('landing.kind.html')}</Pill>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SaveIndicator state={saveState} dirty={dirty} editable={editable} />
          {editable ? (
            <Button type="button" variant="ghost" size="icon" aria-label={t('landing.editor.saveNow')} title={t('landing.editor.saveNow')} disabled={!dirty || saveState === 'saving'} onClick={() => void saveNow()}>
              <Save aria-hidden />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('landing.action.settings')}
            title={t('landing.action.settings')}
            onClick={() => void navigate({ to: '/t/$tenant/landing-pages/$pageId/settings', params: { tenant: slug, pageId: meta.id } })}
          >
            <Settings aria-hidden />
          </Button>
          {publicUrl ? (
            <Button asChild variant="ghost" size="icon" aria-label={t('landing.action.viewLive')} title={t('landing.action.viewLive')}>
              <a href={publicUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink aria-hidden />
              </a>
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => void saveNow().then(() => setShowPreview(true))}>
            <Eye aria-hidden /> {t('landing.preview.button')}
          </Button>
          {canPublish ? (
            <Button type="button" size="sm" disabled={!editable} onClick={() => setPublishing(true)}>
              <Rocket aria-hidden /> {t('landing.publish.action')}
            </Button>
          ) : null}
        </div>
      </div>

      <EditLockBanner lock={lock} canTakeover={canPublish} />

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
        <p className="text-xs text-muted-foreground">{t('landing.html.hint')}</p>
        <Textarea
          aria-label={t('landing.html.sourceLabel')}
          className="min-h-0 flex-1 resize-none font-mono text-xs"
          spellCheck={false}
          readOnly={!editable}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          data-testid="html-source"
        />
      </div>

      {showPreview ? <PreviewDialog pageId={meta.id} onClose={() => setShowPreview(false)} /> : null}
      {publishing ? <PublishDialog page={meta} beforePublish={saveNow} onClose={() => setPublishing(false)} /> : null}
    </div>
  );
}

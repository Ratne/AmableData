import type { Contact } from '@amable/api-types';
import { AmableEditor, type JSONContent } from '@amable/editor';
import { DashboardButton, PageBody, PageToolbar, toast, usePageChrome } from '@amable/ui';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, BookOpen, Save, Send } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { EditLockBanner } from '../../../lib/edit-lock/edit-lock-banner';
import { editLockPath, useEditLock } from '../../../lib/edit-lock/use-edit-lock';
import { editorLabels } from '../../../lib/labels';
import { emailKeys, useEmailApi, useEmailMutation, usePermissions } from '../api';
import { EmailPreviewPanel, TestSendDialog, useLiquidFields } from '../components';
import { GuideDialog } from '../liquid/guide';

export function TemplateEditorPage() {
  const { t, locale } = useI18n();
  const { templateId } = useParams({ strict: false });
  const id = templateId ?? '';
  const { slug, api } = useEmailApi();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const canWrite = can('templates:write');
  const reloadRef = useRef<() => Promise<void>>(async () => undefined);
  const lock = useEditLock(canWrite && id !== '' ? editLockPath(slug, 'emailTemplates', id) : null, {
    onLost: (holder) =>
      toast.warning(holder ? t('common.lock.takenOver', { name: holder.user_name }) : t('common.lock.takenOverSomeone')),
    onStale: () => void reloadRef.current(),
  });
  const template = useQuery({ queryKey: emailKeys.template(slug, id), queryFn: () => api.templates.get(id) });
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [doc, setDoc] = useState<JSONContent | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  /** Bumped when the template is reloaded from the server: remounts the (uncontrolled) editor. */
  const [reloads, setReloads] = useState(0);
  const fields = useLiquidFields();
  const labels = useMemo(() => editorLabels(t), [t]);

  useEffect(() => {
    if (template.data && doc === null) {
      setName(template.data.name);
      setSubject(template.data.subject);
      setDoc(template.data.body as JSONContent);
    }
  }, [template.data, doc]);

  /** Adopts the server version (someone else may have edited it). */
  const reload = useCallback(async () => {
    try {
      const fresh = await api.templates.get(id);
      queryClient.setQueryData(emailKeys.template(slug, id), fresh);
      setName(fresh.name);
      setSubject(fresh.subject);
      setDoc(fresh.body as JSONContent);
      setReloads((n) => n + 1);
    } catch {
      // next poll or lock change retries
    }
  }, [api, id, queryClient, slug]);
  reloadRef.current = reload;

  usePageChrome({
    title: name || t('email.templates.editorTitle'),
    ...(template.data
      ? {
          status: template.data.compiled ? t('email.templates.compiled') : t('email.templates.notCompiled'),
          statusTone: template.data.compiled ? 'success' : 'warning',
        }
      : {}),
  });

  const save = useEmailMutation({
    mutationFn: () => api.templates.update(id, { name, subject, body: (doc ?? { type: 'doc' }) as { type: 'doc' } }),
    invalidate: [emailKeys.template(slug, id), emailKeys.templates(slug)],
    success: t('email.common.saved'),
    errorText: (message) => (message === 'locked' ? t('common.lock.lost') : message),
  });
  const editable = canWrite && lock.canEdit;

  return (
    <>
      <PageToolbar
        filters={
          <Link to="/t/$tenant/templates" params={{ tenant: slug }} className="inline-flex items-center gap-1 text-sm">
            <ArrowLeft className="size-4" />
            {t('email.common.back')}
          </Link>
        }
        actions={
          canWrite ? (
            <>
              <DashboardButton onClick={() => setGuideOpen(true)}>
                <BookOpen className="size-4" />
                {t('email.liquid.howItWorks')}
              </DashboardButton>
              <DashboardButton
                onClick={() =>
                  editable ? void save.mutateAsync(undefined).then(() => setTestOpen(true)) : setTestOpen(true)
                }
              >
                <Send className="size-4" />
                {t('email.test.button')}
              </DashboardButton>
              <DashboardButton variant="primary" onClick={() => save.mutate(undefined)} disabled={!editable || save.isPending}>
                <Save className="size-4" />
                {t('email.common.save')}
              </DashboardButton>
            </>
          ) : null
        }
      />
      <EditLockBanner lock={lock} canTakeover={canWrite} />
      <PageBody className="grid gap-4 pt-4 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="tpl-name">{t('email.common.name')}</Label>
            <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!editable} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tpl-subject">{t('email.common.subject')}</Label>
            <Input id="tpl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!editable} />
          </div>
          {doc !== null ? (
            <AmableEditor
              key={`${id}-${locale}-${String(reloads)}`}
              mode="email"
              value={doc}
              onChange={setDoc}
              liquidFields={fields}
              labels={labels}
              unsubscribeLabel={t('editor.unsubscribeDefault')}
              placeholder={t('editor.placeholder')}
              editable={editable}
            />
          ) : null}
        </div>
        {doc !== null ? (
          <EmailPreviewPanel doc={doc} subject={subject} contact={contact} onContactChange={setContact} />
        ) : null}
      </PageBody>
      <TestSendDialog
        open={testOpen}
        onOpenChange={setTestOpen}
        contact={contact}
        send={(input) => api.templates.test(id, input)}
      />
      <GuideDialog open={guideOpen} onOpenChange={setGuideOpen} />
    </>
  );
}

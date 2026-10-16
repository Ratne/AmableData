import type {
  Broadcast,
  BroadcastEstimate,
  BroadcastSchedule,
  Contact,
  ScheduleBucket,
  UpdateBroadcastInput,
} from '@amable/api-types';
import { AmableEditor, type JSONContent } from '@amable/editor';
import type { MessageKey } from '@amable/i18n';
import { cn, DashboardButton, DashboardConfirmDialog, PageBody, PageToolbar, toast } from '@amable/ui';
import { Alert, AlertTitle } from '@amable/ui/ui/alert';
import { Button } from '@amable/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@amable/ui/ui/card';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { RadioGroup, RadioGroupItem } from '@amable/ui/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@amable/ui/ui/select';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  CircleX,
  Loader2,
  Send,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TimeZoneSelect } from '../../../components/locale/timezone-select';
import { useI18n } from '../../../i18n';
import { editorLabels } from '../../../lib/labels';
import { MultiChoice } from '../../crm/components/inputs';
import { TagPicker } from '../../crm/components/tag-picker';
import { SendingDomainBanner } from '../../developers/components';
import { emailKeys, errorMessage, useEmailApi, useEmailMutation, usePermissions } from '../../email/api';
import { blockText, EmailPreviewPanel, formatDateTime, TestSendDialog, useLiquidFields } from '../../email/components';
import {
  audienceFromSegment,
  buildChecklist,
  canOpenStep,
  checklistBlocks,
  getPreheader,
  segmentFromAudience,
  setPreheader,
  stepErrors,
  WIZARD_STEPS,
  zonedLocalToUtc,
  type AudienceDraft,
  type CheckItem,
  type EmailDoc,
  type StepError,
  type WizardState,
  type WizardStep,
} from '../lib/wizard';

const AUTOSAVE_MS = 700;

type Translate = ReturnType<typeof useI18n>['t'];
type WhenMode = BroadcastSchedule['mode'];

const STEP_LABEL: Record<WizardStep, MessageKey> = {
  recipients: 'broadcasts.wizard.step.recipients',
  email: 'broadcasts.wizard.step.email',
  review: 'broadcasts.wizard.step.review',
};

const ERROR_LABEL: Record<StepError, MessageKey> = {
  name_required: 'broadcasts.wizard.error.name_required',
  no_audience: 'broadcasts.wizard.error.no_audience',
  empty_audience: 'broadcasts.wizard.error.empty_audience',
  subject_required: 'broadcasts.wizard.error.subject_required',
  sender_missing: 'broadcasts.wizard.error.sender_missing',
  content_empty: 'broadcasts.wizard.error.content_empty',
  invalid_links: 'broadcasts.wizard.error.invalid_links',
};

function checkLabel(t: Translate, item: CheckItem): string {
  const key = `broadcasts.wizard.check.${item.id}.${item.status}` as MessageKey;
  return t(key, { detail: item.detail ?? '' });
}

function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

function stepStorageKey(id: string): string {
  return `amable:broadcast-wizard:${id}`;
}

interface Draft {
  readonly name: string;
  readonly subject: string;
  readonly fromName: string;
  readonly replyTo: string;
  readonly audience: AudienceDraft;
  readonly doc: EmailDoc;
  readonly throttle: string;
}

function draftPatch(draft: Draft, fallbackName: string): UpdateBroadcastInput {
  return {
    name: draft.name.trim() === '' ? fallbackName : draft.name.trim(),
    subject: draft.subject,
    from_name: draft.fromName.trim() || null,
    reply_to: draft.replyTo.trim() || null,
    segment: segmentFromAudience(draft.audience),
    body: draft.doc as { type: 'doc' },
    template_id: null,
    throttle_per_hour: draft.throttle === '' ? null : Math.max(10, Number(draft.throttle)),
  };
}

/** Draft broadcast editor: Recipients → Email → Review & schedule, autosaved between steps. */
export function BroadcastWizard({ broadcast }: { broadcast: Broadcast }) {
  const { t, locale } = useI18n();
  const { slug, api } = useEmailApi();
  const { can } = usePermissions();
  const editable = can('broadcasts:write');
  const [draft, setDraft] = useState<Draft>(() => ({
    name: broadcast.name,
    subject: broadcast.subject,
    fromName: broadcast.from_name ?? '',
    replyTo: broadcast.reply_to ?? '',
    audience: audienceFromSegment(broadcast.segment),
    doc: (broadcast.body ?? { type: 'doc', content: [] }) as EmailDoc,
    throttle: broadcast.throttle_per_hour === null ? '' : String(broadcast.throttle_per_hour),
  }));
  const [step, setStep] = useState<number>(() => {
    const stored = Number(window.sessionStorage.getItem(stepStorageKey(broadcast.id)) ?? 0);
    return Number.isInteger(stored) && stored >= 0 && stored < WIZARD_STEPS.length ? stored : 0;
  });
  const [showErrors, setShowErrors] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const lastSaved = useRef(JSON.stringify(draftPatch(draft, broadcast.name)));
  const saving = useRef<Promise<void>>(Promise.resolve());

  const settings = useQuery({ queryKey: emailKeys.settings(slug), queryFn: api.settings.get, staleTime: 30_000 });
  const estimate = useQuery({
    queryKey: emailKeys.estimate(slug, broadcast.id),
    queryFn: () => api.broadcasts.estimate(broadcast.id),
  });

  const refetchEstimate = estimate.refetch;
  const patch = useCallback(
    (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next })),
    [],
  );

  /** Saves the draft if it changed; resolves when the server has it. */
  const flush = useCallback(
    (current: Draft): Promise<void> => {
      const body = draftPatch(current, broadcast.name);
      const json = JSON.stringify(body);
      if (json === lastSaved.current || !editable) return saving.current;
      const previous = JSON.parse(lastSaved.current) as UpdateBroadcastInput;
      const segmentChanged = JSON.stringify(previous.segment) !== JSON.stringify(body.segment);
      setSaveState('saving');
      saving.current = saving.current
        .then(() => api.broadcasts.update(broadcast.id, body))
        .then(() => {
          lastSaved.current = json;
          setSaveState('saved');
          if (segmentChanged || JSON.stringify(previous.body) !== JSON.stringify(body.body)) {
            void refetchEstimate();
          }
        })
        .catch((error: unknown) => {
          setSaveState('error');
          toast.error(errorMessage(error));
        });
      return saving.current;
    },
    [api, broadcast.id, broadcast.name, editable, refetchEstimate],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void flush(draft), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, flush]);

  useEffect(() => {
    window.sessionStorage.setItem(stepStorageKey(broadcast.id), String(step));
  }, [broadcast.id, step]);

  const fromEmail = settings.data?.from_email ?? null;
  const wizardState: WizardState = {
    name: draft.name,
    audience: draft.audience,
    eligible: segmentFromAudience(draft.audience) === null ? 0 : (estimate.data?.eligible ?? null),
    subject: draft.subject,
    fromEmail,
    doc: draft.doc,
  };
  const current = WIZARD_STEPS[step] ?? 'recipients';
  const errors = stepErrors(current, wizardState);

  const go = async (target: number) => {
    if (target > step && errors.length > 0) {
      setShowErrors(true);
      return;
    }
    if (!canOpenStep(target, wizardState) && target > step) return;
    await flush(draft);
    setShowErrors(false);
    setStep(target);
    window.scrollTo({ top: 0 });
  };

  return (
    <>
      <PageToolbar
        filters={
          <Link to="/t/$tenant/broadcasts" params={{ tenant: slug }} className="inline-flex items-center gap-1 text-sm">
            <ArrowLeft className="size-4" />
            {t('email.common.back')}
          </Link>
        }
        actions={
          <span className="flex items-center gap-1.5 text-xs text-(--obsidian-dashboard-shell-text-subtle)" aria-live="polite">
            {saveState === 'saving' ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {saveState === 'error' ? <CircleAlert className="size-3.5 text-destructive" aria-hidden /> : null}
            {t(`broadcasts.wizard.save.${saveState}`)}
          </span>
        }
      />
      <PageBody className="grid gap-4 pt-4">
        <SendingDomainBanner slug={slug} />
        <Stepper step={step} state={wizardState} onOpen={(target) => void go(target)} />
        {current === 'recipients' ? (
          <RecipientsStep draft={draft} patch={patch} editable={editable} estimate={estimate.data ?? null} refreshing={estimate.isFetching} />
        ) : null}
        {current === 'email' ? (
          <EmailStep broadcast={broadcast} draft={draft} patch={patch} editable={editable} fromEmail={fromEmail} flush={() => flush(draft)} />
        ) : null}
        {current === 'review' ? (
          <ReviewStep
            broadcast={broadcast}
            draft={draft}
            patch={patch}
            editable={editable}
            flush={() => flush(draft)}
            checklist={buildChecklist({
              sendingState: settings.data?.sending.state ?? null,
              fromEmail,
              physicalAddress: settings.data?.physical_address ?? null,
              subject: draft.subject,
              doc: draft.doc,
              estimate: estimate.data ?? null,
            })}
            canSendNow={estimate.data?.can_send === true}
            blockReason={estimate.data?.block_reason ?? null}
            eligible={estimate.data?.eligible ?? 0}
            tenantZone={settings.data?.timezone ?? 'UTC'}
            locale={locale}
          />
        ) : null}
        {showErrors && errors.length > 0 ? (
          <Alert variant="destructive" data-testid="wizard-errors">
            <TriangleAlert className="size-4" />
            <AlertTitle>{errors.map((error) => t(ERROR_LABEL[error])).join(' · ')}</AlertTitle>
          </Alert>
        ) : null}
        <div className="flex items-center justify-between border-t pt-4">
          <Button variant="outline" onClick={() => void go(step - 1)} disabled={step === 0}>
            <ArrowLeft className="size-4" />
            {t('broadcasts.wizard.back')}
          </Button>
          {step < WIZARD_STEPS.length - 1 ? (
            <Button onClick={() => void go(step + 1)} aria-disabled={errors.length > 0} className={cn(errors.length > 0 && 'opacity-60')}>
              {t('broadcasts.wizard.next')}
              <ArrowRight className="size-4" />
            </Button>
          ) : null}
        </div>
      </PageBody>
    </>
  );
}

// ------------------------------------------------------------------ stepper

function Stepper({ step, state, onOpen }: { step: number; state: WizardState; onOpen: (step: number) => void }) {
  const { t } = useI18n();
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label={t('broadcasts.wizard.steps')}>
      {WIZARD_STEPS.map((id, index) => {
        const done = index < step && stepErrors(id, state).length === 0;
        const active = index === step;
        const reachable = canOpenStep(index, state) || index < step;
        return (
          <li key={id} className="flex items-center gap-2">
            {index > 0 ? <span className="h-px w-8 bg-border" aria-hidden /> : null}
            <button
              type="button"
              disabled={!reachable || active}
              onClick={() => onOpen(index)}
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors',
                active && 'border-primary bg-primary text-primary-foreground',
                !active && reachable && 'hover:bg-muted',
                !reachable && 'opacity-50',
              )}
            >
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-full text-xs font-semibold',
                  active ? 'bg-primary-foreground text-primary' : done ? 'bg-emerald-600 text-white' : 'bg-muted',
                )}
              >
                {done ? <Check className="size-3" aria-hidden /> : index + 1}
              </span>
              {t(STEP_LABEL[id])}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

// --------------------------------------------------------------- recipients

function RecipientsStep({
  draft,
  patch,
  editable,
  estimate,
  refreshing,
}: {
  draft: Draft;
  patch: (next: Partial<Draft>) => void;
  editable: boolean;
  estimate: BroadcastEstimate | null;
  refreshing: boolean;
}) {
  const { t } = useI18n();
  const { slug, api } = useEmailApi();
  const searches = useQuery({ queryKey: emailKeys.crm(slug, 'savedSearches'), queryFn: api.crm.savedSearches });
  const searchChoices = (searches.data?.data ?? [])
    .filter((s) => s.entity === 'contact')
    .map((s) => ({ value: s.id, label: s.name }));
  const audience = draft.audience;
  const setAudience = (next: Partial<AudienceDraft>) => patch({ audience: { ...audience, ...next } });
  const included = segmentFromAudience(audience) !== null;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid gap-4">
        <Card>
          <CardContent className="grid gap-1.5 pt-6">
            <Label htmlFor="bc-name">{t('email.common.name')}</Label>
            <Input id="bc-name" value={draft.name} onChange={(e) => patch({ name: e.target.value })} disabled={!editable} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('broadcasts.wizard.include')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="bc-include-tags">{t('broadcasts.wizard.includeTags')}</Label>
              <div className="flex flex-wrap items-start gap-2">
                <Select
                  value={audience.tagMatch}
                  onValueChange={(value) => setAudience({ tagMatch: value === 'all' ? 'all' : 'any' })}
                  disabled={!editable}
                >
                  <SelectTrigger className="w-44" aria-label={t('broadcasts.composer.match')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">{t('broadcasts.composer.match.any')}</SelectItem>
                    <SelectItem value="all">{t('broadcasts.composer.match.all')}</SelectItem>
                  </SelectContent>
                </Select>
                <TagPicker
                  id="bc-include-tags"
                  value={audience.includeTagIds}
                  onChange={(includeTagIds) => setAudience({ includeTagIds })}
                  allowCreate={false}
                  max={50}
                  disabled={!editable}
                  className="min-w-64 flex-1"
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>{t('broadcasts.wizard.includeSearches')}</Label>
              <MultiChoice
                values={audience.includeSavedSearchIds}
                onChange={(includeSavedSearchIds) => setAudience({ includeSavedSearchIds: includeSavedSearchIds.slice(0, 10) })}
                choices={searchChoices}
                placeholder={t('broadcasts.composer.pickSearch')}
                ariaLabel={t('broadcasts.wizard.includeSearches')}
                disabled={!editable}
              />
            </div>
            <p className="text-xs text-(--obsidian-dashboard-shell-text-subtle)">{t('broadcasts.wizard.includeHint')}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('broadcasts.wizard.exclude')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="bc-exclude-tags">{t('broadcasts.wizard.excludeTags')}</Label>
              <TagPicker
                id="bc-exclude-tags"
                value={audience.excludeTagIds}
                onChange={(excludeTagIds) => setAudience({ excludeTagIds })}
                allowCreate={false}
                max={50}
                disabled={!editable}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t('broadcasts.wizard.excludeSearches')}</Label>
              <MultiChoice
                values={audience.excludeSavedSearchIds}
                onChange={(excludeSavedSearchIds) => setAudience({ excludeSavedSearchIds: excludeSavedSearchIds.slice(0, 10) })}
                choices={searchChoices}
                placeholder={t('broadcasts.composer.pickSearch')}
                ariaLabel={t('broadcasts.wizard.excludeSearches')}
                disabled={!editable}
              />
            </div>
          </CardContent>
        </Card>
      </div>
      <Card className="h-fit lg:sticky lg:top-4" data-testid="recipient-estimate">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-4" aria-hidden />
            {t('broadcasts.wizard.estimate')}
            {refreshing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          {!included ? (
            <p className="text-(--obsidian-dashboard-shell-text-subtle)">{t('broadcasts.wizard.estimateEmpty')}</p>
          ) : estimate ? (
            <>
              <p className="text-2xl font-semibold tabular-nums">{t('broadcasts.composer.eligible', { count: estimate.eligible })}</p>
              <p>{t('broadcasts.composer.segmentSize', { count: estimate.segment_size })}</p>
              <p className="text-(--obsidian-dashboard-shell-text-subtle)">
                {t('broadcasts.composer.excluded', {
                  noEmail: estimate.excluded.no_email,
                  suppressed: estimate.excluded.suppressed,
                  unmarketable: estimate.excluded.unmarketable,
                })}
              </p>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// -------------------------------------------------------------------- email

function EmailStep({
  broadcast,
  draft,
  patch,
  editable,
  fromEmail,
  flush,
}: {
  broadcast: Broadcast;
  draft: Draft;
  patch: (next: Partial<Draft>) => void;
  editable: boolean;
  fromEmail: string | null;
  flush: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const { slug, api } = useEmailApi();
  const fields = useLiquidFields();
  const labels = useMemo(() => editorLabels(t), [t]);
  const templates = useQuery({ queryKey: emailKeys.templates(slug), queryFn: () => api.templates.list() });
  const [templateId, setTemplateId] = useState('');
  const [docVersion, setDocVersion] = useState(0);
  const [preheaderDraft, setPreheaderDraft] = useState<string | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [testOpen, setTestOpen] = useState(false);

  const commitPreheader = () => {
    if (preheaderDraft === null) return;
    if (preheaderDraft !== getPreheader(draft.doc)) {
      patch({ doc: setPreheader(draft.doc, preheaderDraft) });
      setDocVersion((v) => v + 1);
    }
    setPreheaderDraft(null);
  };
  const commitRef = useRef(commitPreheader);
  commitRef.current = commitPreheader;
  useEffect(() => {
    if (preheaderDraft === null) return;
    const timer = window.setTimeout(() => commitRef.current(), 600);
    return () => window.clearTimeout(timer);
  }, [preheaderDraft]);

  const loadTemplate = async () => {
    if (templateId === '') return;
    const tpl = await api.templates.get(templateId);
    patch({ doc: tpl.body as EmailDoc, ...(draft.subject === '' ? { subject: tpl.subject } : {}) });
    setDocVersion((v) => v + 1);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('broadcasts.wizard.sender')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>{t('broadcasts.wizard.fromEmail')}</Label>
              <p className="flex items-center gap-2 text-sm">
                {fromEmail ?? <span className="text-destructive">{t('broadcasts.wizard.error.sender_missing')}</span>}
                <Link to="/t/$tenant/settings/email" params={{ tenant: slug }} className="text-xs underline underline-offset-2">
                  {t('broadcasts.wizard.editSender')}
                </Link>
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bc-from">{t('email.common.fromName')}</Label>
              <Input id="bc-from" value={draft.fromName} onChange={(e) => patch({ fromName: e.target.value })} disabled={!editable} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bc-reply">{t('broadcasts.wizard.replyTo')}</Label>
              <Input id="bc-reply" type="email" value={draft.replyTo} onChange={(e) => patch({ replyTo: e.target.value })} disabled={!editable} />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('broadcasts.composer.content')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="bc-subject">{t('email.common.subject')}</Label>
              <Input id="bc-subject" value={draft.subject} onChange={(e) => patch({ subject: e.target.value })} disabled={!editable} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bc-preheader">{t('broadcasts.wizard.preheader')}</Label>
              <Input
                id="bc-preheader"
                value={preheaderDraft ?? getPreheader(draft.doc)}
                onChange={(e) => setPreheaderDraft(e.target.value)}
                onBlur={commitPreheader}
                placeholder={t('editor.preheaderPlaceholder')}
                disabled={!editable}
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="grid flex-1 gap-1.5">
                <Label>{t('broadcasts.composer.template')}</Label>
                <Select value={templateId} onValueChange={setTemplateId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('broadcasts.composer.noTemplate')} />
                  </SelectTrigger>
                  <SelectContent>
                    {(templates.data?.data ?? []).map((tpl) => (
                      <SelectItem key={tpl.id} value={tpl.id}>
                        {tpl.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button variant="outline" onClick={() => void loadTemplate()} disabled={templateId === '' || !editable}>
                {t('broadcasts.composer.loadTemplate')}
              </Button>
            </div>
            <AmableEditor
              key={`${broadcast.id}-${locale}-${String(docVersion)}`}
              mode="email"
              value={draft.doc as JSONContent}
              onChange={(doc) => patch({ doc: doc as EmailDoc })}
              liquidFields={fields}
              labels={labels}
              unsubscribeLabel={t('editor.unsubscribeDefault')}
              placeholder={t('editor.placeholder')}
              editable={editable}
            />
          </CardContent>
        </Card>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2">
              {t('broadcasts.wizard.preview')}
              {editable ? (
                <Button size="sm" variant="outline" onClick={() => void flush().then(() => setTestOpen(true))}>
                  <Send className="size-3.5" />
                  {t('email.test.button')}
                </Button>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <EmailPreviewPanel
              doc={draft.doc as JSONContent}
              subject={draft.subject}
              contact={contact}
              onContactChange={setContact}
              deviceToggle
            />
          </CardContent>
        </Card>
      </div>
      <TestSendDialog open={testOpen} onOpenChange={setTestOpen} contact={contact} send={(input) => api.broadcasts.test(broadcast.id, input)} />
    </div>
  );
}

// ------------------------------------------------------------------- review

function CheckIcon({ status }: { status: CheckItem['status'] }) {
  if (status === 'ok') return <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden />;
  if (status === 'warn') return <TriangleAlert className="size-4 shrink-0 text-amber-500" aria-hidden />;
  return <CircleX className="size-4 shrink-0 text-destructive" aria-hidden />;
}

function ReviewStep({
  broadcast,
  draft,
  patch,
  editable,
  flush,
  checklist,
  canSendNow,
  blockReason,
  eligible,
  tenantZone,
  locale,
}: {
  broadcast: Broadcast;
  draft: Draft;
  patch: (next: Partial<Draft>) => void;
  editable: boolean;
  flush: () => Promise<void>;
  checklist: CheckItem[];
  canSendNow: boolean;
  blockReason: string | null;
  eligible: number;
  tenantZone: string;
  locale: string;
}) {
  const { t } = useI18n();
  const { slug, api } = useEmailApi();
  const { can } = usePermissions();
  const [mode, setMode] = useState<WhenMode>('now');
  const [atDate, setAtDate] = useState(tomorrow());
  const [atTime, setAtTime] = useState('09:00');
  const [zone, setZone] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [buckets, setBuckets] = useState<ScheduleBucket[] | null>(null);
  const effectiveZone = zone || tenantZone;
  const blocked = checklistBlocks(checklist) || !canSendNow;
  const atMs = mode === 'at' ? zonedLocalToUtc(atDate, atTime, effectiveZone) : null;
  const atInPast = atMs !== null && atMs < Date.now();

  const scheduleInput = (): BroadcastSchedule =>
    mode === 'now'
      ? { mode: 'now' }
      : mode === 'at'
        ? { mode: 'at', at: new Date(atMs ?? Date.now()).toISOString() }
        : { mode: 'contact_tz', local_date: atDate, local_time: atTime };
  const schedule = useEmailMutation({
    mutationFn: async () => {
      await flush();
      return api.broadcasts.schedule(broadcast.id, scheduleInput());
    },
    invalidate: [emailKeys.broadcast(slug, broadcast.id), emailKeys.broadcasts(slug)],
    success: t('broadcasts.composer.scheduled'),
    onSuccess: (out) => {
      setBuckets(out.buckets);
      window.sessionStorage.removeItem(`amable:broadcast-wizard:${broadcast.id}`);
    },
    errorText: (code) => t('broadcasts.composer.blocked', { reason: blockText(t, code) }),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>{t('broadcasts.wizard.checklist')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 text-sm" data-testid="presend-checklist">
            {checklist.map((item) => (
              <li key={item.id} className="flex items-start gap-2" data-status={item.status}>
                <CheckIcon status={item.status} />
                <span className="min-w-0 break-words">{checkLabel(t, item)}</span>
              </li>
            ))}
          </ul>
          {!canSendNow && blockReason !== null ? (
            <Alert className="mt-3">
              <TriangleAlert className="size-4" />
              <AlertTitle>{t('broadcasts.composer.blocked', { reason: blockText(t, blockReason) })}</AlertTitle>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
      <div className="grid h-fit gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('broadcasts.wizard.summary')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <p>
              <span className="text-(--obsidian-dashboard-shell-text-subtle)">{t('email.common.name')}: </span>
              {draft.name}
            </p>
            <p>
              <span className="text-(--obsidian-dashboard-shell-text-subtle)">{t('email.common.subject')}: </span>
              {draft.subject}
            </p>
            <p>
              <span className="text-(--obsidian-dashboard-shell-text-subtle)">{t('broadcasts.recipients')}: </span>
              <span className="font-semibold tabular-nums">{eligible}</span>
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('broadcasts.composer.schedule')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <RadioGroup value={mode} onValueChange={(v) => setMode(v === 'at' ? 'at' : v === 'contact_tz' ? 'contact_tz' : 'now')}>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="now" />
                {t('broadcasts.composer.now')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="at" />
                {t('broadcasts.composer.at')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <RadioGroupItem value="contact_tz" />
                {t('broadcasts.composer.contactTz')}
              </label>
            </RadioGroup>
            {mode !== 'now' ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="bc-date">{t('broadcasts.composer.date')}</Label>
                  <Input id="bc-date" type="date" value={atDate} onChange={(ev) => setAtDate(ev.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="bc-time">{t('broadcasts.composer.time')}</Label>
                  <Input id="bc-time" type="time" value={atTime} onChange={(ev) => setAtTime(ev.target.value)} />
                </div>
                {mode === 'at' ? (
                  <div className="grid min-w-56 flex-1 gap-1.5">
                    <Label htmlFor="bc-zone">{t('broadcasts.wizard.timeZone')}</Label>
                    <TimeZoneSelect id="bc-zone" value={effectiveZone} onChange={setZone} allowEmpty={false} className="w-full" />
                  </div>
                ) : null}
              </div>
            ) : null}
            {mode === 'at' && atMs !== null ? (
              <p className={cn('text-xs', atInPast ? 'text-amber-600' : 'text-(--obsidian-dashboard-shell-text-subtle)')}>
                {atInPast ? t('broadcasts.wizard.atPast') : t('broadcasts.wizard.atLocal', { time: formatDateTime(locale, new Date(atMs).toISOString()) })}
              </p>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="bc-throttle">{t('broadcasts.composer.throttle')}</Label>
              <Input
                id="bc-throttle"
                type="number"
                min={10}
                value={draft.throttle}
                onChange={(ev) => patch({ throttle: ev.target.value })}
                disabled={!editable}
              />
            </div>
            {can('broadcasts:send') ? (
              <DashboardButton variant="primary" disabled={blocked || schedule.isPending} onClick={() => setConfirmOpen(true)}>
                <Send className="size-4" />
                {mode === 'now' ? t('broadcasts.wizard.sendNow') : t('broadcasts.wizard.schedule')}
              </DashboardButton>
            ) : null}
            {buckets !== null ? (
              <div className="grid gap-1 text-xs">
                <p className="font-medium">{t('broadcasts.composer.buckets')}</p>
                {buckets.map((b) => (
                  <p key={`${b.time_zone}${b.send_at}`}>
                    {formatDateTime(locale, b.send_at)} · {b.time_zone} · {b.count}
                  </p>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
      <DashboardConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('broadcasts.composer.confirmTitle')}
        description={t('broadcasts.composer.confirmBody', { count: eligible })}
        confirmLabel={mode === 'now' ? t('broadcasts.wizard.sendNow') : t('broadcasts.wizard.schedule')}
        cancelLabel={t('email.common.cancel')}
        onConfirm={() => schedule.mutate(undefined)}
      />
    </div>
  );
}

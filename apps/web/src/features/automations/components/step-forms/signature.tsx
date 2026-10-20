import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Textarea } from '@amable/ui/ui/textarea';
import { KeyRound, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../../../i18n';
import { ChoiceSelect } from '../../../crm/components/inputs';
import { useTemplates } from '../../../esign/api/hooks';
import { useAutomationApi, useAutomationMutation } from '../../api/hooks';
import { clean } from '../../lib/clean';
import { useStepUp } from '../../../developers/components';
import { CopyBlock } from '../api-snippet';
import { Field } from '../form-bits';
import type { StepFormContext, FormProps } from './shared';

export function SignatureRequestForm({
  step,
  onChange,
  disabled,
}: FormProps<'send_signature_request'>) {
  const { t } = useI18n();
  const templates = useTemplates();
  const list = (templates.data ?? []).filter(
    (tpl) => tpl.status !== 'archived' || tpl.id === step.template_id,
  );
  const template = list.find((tpl) => tpl.id === step.template_id);
  const contactParty = step.party_id ?? template?.parties[0]?.id;
  const others = template?.parties.filter((p) => p.id !== contactParty) ?? [];
  const otherOf = (partyId: string) => step.others?.find((o) => o.party_id === partyId);
  const setOther = (partyId: string, patch: { email?: string; name?: string }) => {
    const current = otherOf(partyId) ?? { party_id: partyId, email: '' };
    const next = { ...current, ...patch };
    const updated = [
      ...(step.others ?? []).filter((o) => o.party_id !== partyId),
      clean({ ...next, name: next.name?.trim() ? next.name : undefined }),
    ].filter((o) => others.some((p) => p.id === o.party_id));
    onChange(clean({ ...step, others: updated.length > 0 ? updated : undefined }));
  };
  return (
    <div className="grid gap-3">
      <p className="text-[11px] text-muted-foreground">{t('auto.step.signatureHint')}</p>
      <Field label={t('auto.step.signatureTemplate')}>
        <ChoiceSelect
          value={step.template_id}
          allowEmpty={false}
          placeholder={t('auto.step.pickSignatureTemplate')}
          disabled={disabled}
          className="w-full"
          choices={list.map((tpl) => ({ value: tpl.id, label: tpl.name }))}
          invalid={step.template_id === ''}
          onChange={(template_id) =>
            onChange(clean({ ...step, template_id, party_id: undefined, others: undefined }))
          }
        />
      </Field>
      {template !== undefined && !(template.status === 'active' && template.ready) ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          {t('auto.step.signatureInactive')}
        </p>
      ) : null}
      {template !== undefined && template.parties.length > 1 ? (
        <Field label={t('auto.step.signatureParty')}>
          <ChoiceSelect
            value={contactParty ?? ''}
            allowEmpty={false}
            disabled={disabled}
            className="w-full"
            choices={template.parties.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(party_id) =>
              onChange(
                clean({
                  ...step,
                  party_id,
                  others: step.others?.filter((o) => o.party_id !== party_id),
                }),
              )
            }
          />
        </Field>
      ) : null}
      {others.map((party) => {
        const other = otherOf(party.id);
        return (
          <Field key={party.id} label={t('auto.step.signatureOther', { party: party.name })}>
            <div className="grid gap-1.5">
              <Input
                type="email"
                value={other?.email ?? ''}
                placeholder={t('auto.step.signatureOtherEmail')}
                disabled={disabled}
                className="h-8"
                aria-invalid={other === undefined || other.email === ''}
                onChange={(e) => setOther(party.id, { email: e.target.value.trim() })}
              />
              <Input
                value={other?.name ?? ''}
                placeholder={t('auto.step.signatureOtherName')}
                disabled={disabled}
                className="h-8"
                onChange={(e) => setOther(party.id, { name: e.target.value })}
              />
            </div>
          </Field>
        );
      })}
      <Field label={t('auto.step.signatureMessage')}>
        <Textarea
          rows={3}
          value={step.message ?? ''}
          maxLength={5000}
          placeholder={t('auto.step.signatureMessageHint')}
          disabled={disabled}
          onChange={(e) => onChange(clean({ ...step, message: e.target.value || undefined }))}
        />
      </Field>
    </div>
  );
}

export function SigningInfo({ ctx }: { ctx: StepFormContext }) {
  const { t } = useI18n();
  const { api } = useAutomationApi();
  const [secret, setSecret] = useState<string | null>(null);
  const { guard, dialog: stepUpDialog } = useStepUp();
  const reveal = useAutomationMutation({
    mutationFn: () => api.signingSecret(ctx.automationId),
    invalidate: [],
    onSuccess: (result) => setSecret(result.secret),
    onError: (error) => guard(error, () => reveal.mutate(undefined)),
  });
  const rotate = useAutomationMutation({
    mutationFn: () => api.rotateSigningSecret(ctx.automationId),
    invalidate: [],
    success: t('auto.step.rotated'),
    onSuccess: (result) => setSecret((current) => (current === null ? null : result.secret)),
    onError: (error) => guard(error, () => rotate.mutate(undefined)),
  });
  return (
    <div className="grid gap-2 rounded-md border bg-muted/30 p-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <KeyRound className="size-3.5" aria-hidden /> {t('auto.step.signingTitle')}
      </p>
      <p className="text-[11px] leading-snug text-muted-foreground">{t('auto.step.signingBody')}</p>
      {ctx.canPublish ? (
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            disabled={reveal.isPending}
            onClick={() => (secret === null ? reveal.mutate(undefined) : setSecret(null))}
          >
            {t('auto.step.showSecret')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            disabled={rotate.isPending}
            onClick={() => rotate.mutate(undefined)}
          >
            <RefreshCw className="size-3.5" aria-hidden /> {t('auto.step.rotateSecret')}
          </Button>
        </div>
      ) : null}
      {secret !== null ? <CopyBlock text={secret} /> : null}
      {stepUpDialog}
    </div>
  );
}

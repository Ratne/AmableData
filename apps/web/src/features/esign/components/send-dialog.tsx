import type { EsignSignerInput, EsignTemplate } from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Textarea } from '@amable/ui/ui/textarea';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { ChoiceSelect, FormField } from '../../commerce/components/common';
import { useEsign, useEsignMutation, useTemplates } from '../api/hooks';
import { ContactPicker, type PickedContact } from './common';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SignerDraft {
  readonly mode: 'contact' | 'email';
  readonly contact: PickedContact | null;
  readonly email: string;
  readonly name: string;
}

const EMPTY_SIGNER: SignerDraft = { mode: 'contact', contact: null, email: '', name: '' };

function signerInput(partyId: string, draft: SignerDraft): EsignSignerInput | null {
  if (draft.mode === 'contact') return draft.contact === null ? null : { party_id: partyId, contact_id: draft.contact.id };
  const email = draft.email.trim();
  if (!EMAIL_RE.test(email)) return null;
  const name = draft.name.trim();
  return name === '' ? { party_id: partyId, email } : { party_id: partyId, email, name };
}

/** Sends a template for signature: one signer per party, from the CRM or by email; `contact` signs as the first party. */
export function SendDialog({
  template,
  contact,
  onClose,
}: {
  template?: EsignTemplate;
  contact?: PickedContact;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { slug, api } = useEsign();
  const navigate = useNavigate();
  const templates = useTemplates();
  const sendable = useMemo(() => (templates.data ?? []).filter((tpl) => tpl.status === 'active' && tpl.ready), [templates.data]);
  const [templateId, setTemplateId] = useState(template?.id ?? '');
  const selected = template?.id === templateId ? template : sendable.find((tpl) => tpl.id === templateId);
  const [signers, setSigners] = useState<Record<string, SignerDraft>>({});
  const [message, setMessage] = useState('');
  const [expireDays, setExpireDays] = useState<string | null>(null);

  const parties = selected?.parties ?? [];
  const initialOf = (partyId: string): SignerDraft =>
    contact !== undefined && partyId === parties[0]?.id ? { ...EMPTY_SIGNER, contact } : EMPTY_SIGNER;
  const draftOf = (partyId: string): SignerDraft => signers[partyId] ?? initialOf(partyId);
  const setDraft = (partyId: string, patch: Partial<SignerDraft>) =>
    setSigners((current) => ({ ...current, [partyId]: { ...(current[partyId] ?? initialOf(partyId)), ...patch } }));

  const inputs = parties.map((party) => signerInput(party.id, draftOf(party.id)));
  const complete = inputs.every((input) => input !== null);
  const defaultExpire = selected?.settings.expire_days ?? null;
  const expireText = expireDays ?? (defaultExpire === null ? '' : String(defaultExpire));
  const expireValue = expireText.trim() === '' ? null : Number(expireText);
  const expireValid = expireValue === null || (Number.isInteger(expireValue) && expireValue >= 1 && expireValue <= 365);

  const send = useEsignMutation({
    mutationFn: () =>
      api.requests.create({
        template_id: templateId,
        signers: inputs.filter((input): input is EsignSignerInput => input !== null),
        ...(message.trim() === '' ? {} : { message: message.trim() }),
        ...(expireDays === null ? {} : { expire_days: expireValue }),
      }),
    success: t('esign.send.sent'),
    onSuccess: (request) => {
      onClose();
      void navigate({ to: '/t/$tenant/signatures/$requestId', params: { tenant: slug, requestId: request.id } });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (selected !== undefined && complete && expireValid) send.mutate(undefined);
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('esign.send.title')}</DialogTitle>
            <DialogDescription>{t('esign.send.description')}</DialogDescription>
          </DialogHeader>
          {template === undefined ? (
            <FormField label={t('esign.field.template')} hint={sendable.length === 0 && !templates.isPending ? t('esign.send.noTemplates') : undefined}>
              {(id) => (
                <ChoiceSelect
                  id={id}
                  className="w-full"
                  value={templateId}
                  placeholder={t('esign.send.pickTemplate')}
                  onChange={(next) => {
                    setTemplateId(next);
                    setSigners({});
                    setExpireDays(null);
                  }}
                  choices={sendable.map((tpl) => ({ value: tpl.id, label: tpl.name }))}
                />
              )}
            </FormField>
          ) : null}
          {parties.map((party) => {
            const draft = draftOf(party.id);
            return (
              <fieldset key={party.id} className="grid gap-2 rounded-lg border p-3">
                <legend className="flex items-center gap-2 px-1 text-sm font-medium">
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: party.color ?? '#64748b' }} aria-hidden />
                  {party.name}
                </legend>
                <div className="flex gap-1 text-xs">
                  {(['contact', 'email'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={draft.mode === mode}
                      className={`rounded-md px-2 py-1 ${draft.mode === mode ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60'}`}
                      onClick={() => setDraft(party.id, { mode })}
                    >
                      {t(`esign.send.mode.${mode}`)}
                    </button>
                  ))}
                </div>
                {draft.mode === 'contact' ? (
                  <ContactPicker value={draft.contact} label={t('esign.send.contactFor', { party: party.name })} onChange={(next) => setDraft(party.id, { contact: next })} />
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input
                      type="email"
                      value={draft.email}
                      placeholder={t('esign.field.email')}
                      aria-label={t('esign.field.email')}
                      maxLength={320}
                      onChange={(e) => setDraft(party.id, { email: e.target.value })}
                    />
                    <Input
                      value={draft.name}
                      placeholder={t('esign.field.signerName')}
                      aria-label={t('esign.field.signerName')}
                      maxLength={200}
                      onChange={(e) => setDraft(party.id, { name: e.target.value })}
                    />
                  </div>
                )}
              </fieldset>
            );
          })}
          {selected !== undefined ? (
            <>
              <FormField label={t('esign.field.message')} hint={t('esign.send.messageHint')}>
                {(id) => (
                  <Textarea id={id} rows={3} maxLength={5000} value={message} placeholder={selected.settings.email_message} onChange={(e) => setMessage(e.target.value)} />
                )}
              </FormField>
              <FormField label={t('esign.field.expireDays')} hint={t('esign.send.expireHint')} error={expireValid ? null : t('esign.error.expireDays')}>
                {(id) => <Input id={id} type="number" min={1} max={365} className="w-32" value={expireText} onChange={(e) => setExpireDays(e.target.value)} />}
              </FormField>
            </>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={selected === undefined || !complete || !expireValid || send.isPending}>
              {t('esign.send.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import type { BankAccount } from '@amable/api-types';
import { DashboardConfirmDialog } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Textarea } from '@amable/ui/ui/textarea';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useI18n } from '../../../i18n';
import { commerceKeys, useCommerce, useCommerceMutation } from '../api/hooks';
import { ErrorNotice, FormField, SectionCard } from './common';

const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const BIC = /^([A-Z0-9]{8}|[A-Z0-9]{11})?$/;

const compact = (value: string) => value.replace(/\s+/g, '').toUpperCase();

/** Bank accounts the checkouts may offer for payment by bank transfer. */
export function BankAccountsCard() {
  const { t } = useI18n();
  const { slug, api } = useCommerce();
  const accounts = useQuery({ queryKey: commerceKeys.bankAccounts(slug), queryFn: () => api.bankAccounts.list() });
  const [editing, setEditing] = useState<BankAccount | 'new' | null>(null);
  const [removing, setRemoving] = useState<BankAccount | null>(null);
  const remove = useCommerceMutation({
    mutationFn: (account: BankAccount) => api.bankAccounts.remove(account.id),
    success: t('commerce.bank.deleted'),
  });
  return (
    <SectionCard
      title={t('commerce.bank.title')}
      actions={
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing('new')}>
          <Plus aria-hidden /> {t('commerce.bank.add')}
        </Button>
      }
    >
      <p className="mb-3 text-sm text-muted-foreground">{t('commerce.bank.intro')}</p>
      {accounts.error ? <ErrorNotice error={accounts.error} /> : null}
      {accounts.data && accounts.data.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('commerce.bank.empty')}</p>
      ) : null}
      <ul className="grid gap-2">
        {(accounts.data?.data ?? []).map((account) => (
          <li key={account.id} className="flex items-center gap-3 rounded-lg border p-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{account.label}</div>
              <div className="truncate text-muted-foreground">
                {account.holder} · <span className="font-mono">{account.iban}</span>
              </div>
            </div>
            <Button type="button" variant="ghost" size="sm" aria-label={t('commerce.common.edit')} onClick={() => setEditing(account)}>
              <Pencil aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive"
              aria-label={t('commerce.common.remove')}
              onClick={() => setRemoving(account)}
            >
              <Trash2 aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      {editing !== null ? <BankAccountDialog account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <DashboardConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={t('commerce.bank.deleteConfirm', { label: removing?.label ?? '' })}
        description={t('commerce.bank.deleteBody')}
        confirmLabel={t('commerce.common.remove')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => {
          if (removing !== null) remove.mutate(removing);
          setRemoving(null);
        }}
      />
    </SectionCard>
  );
}

function BankAccountDialog({ account, onClose }: { account: BankAccount | null; onClose: () => void }) {
  const { t } = useI18n();
  const { api } = useCommerce();
  const [label, setLabel] = useState(account?.label ?? '');
  const [holder, setHolder] = useState(account?.holder ?? '');
  const [iban, setIban] = useState(account?.iban ?? '');
  const [bic, setBic] = useState(account?.bic ?? '');
  const [bankName, setBankName] = useState(account?.bank_name ?? '');
  const [instructions, setInstructions] = useState(account?.instructions ?? '');
  const ibanValid = IBAN.test(compact(iban));
  const bicValid = BIC.test(compact(bic));
  const valid = label.trim() !== '' && holder.trim() !== '' && ibanValid && bicValid;
  const save = useCommerceMutation({
    mutationFn: () => {
      const input = {
        label: label.trim(),
        holder: holder.trim(),
        iban: compact(iban),
        bic: compact(bic),
        bank_name: bankName.trim(),
        instructions: instructions.trim(),
      };
      return account ? api.bankAccounts.update(account.id, input) : api.bankAccounts.create(input);
    },
    success: t('commerce.common.saved'),
    onSuccess: onClose,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate(undefined);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{account ? t('commerce.bank.edit') : t('commerce.bank.add')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label={t('commerce.bank.label')} hint={t('commerce.bank.labelHint')}>
              {(id) => <Input id={id} value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />}
            </FormField>
            <FormField label={t('commerce.bank.holder')}>
              {(id) => <Input id={id} value={holder} maxLength={200} onChange={(e) => setHolder(e.target.value)} />}
            </FormField>
            <FormField
              label={t('commerce.bank.iban')}
              className="sm:col-span-2"
              error={iban === '' || ibanValid ? null : t('commerce.bank.ibanInvalid')}
            >
              {(id) => <Input id={id} className="font-mono" value={iban} autoComplete="off" onChange={(e) => setIban(e.target.value)} />}
            </FormField>
            <FormField label={t('commerce.bank.bic')} error={bicValid ? null : t('commerce.bank.bicInvalid')}>
              {(id) => <Input id={id} className="font-mono" value={bic} autoComplete="off" onChange={(e) => setBic(e.target.value)} />}
            </FormField>
            <FormField label={t('commerce.bank.bankName')}>
              {(id) => <Input id={id} value={bankName} maxLength={200} onChange={(e) => setBankName(e.target.value)} />}
            </FormField>
            <FormField label={t('commerce.bank.instructions')} hint={t('commerce.bank.instructionsHint')} className="sm:col-span-2">
              {(id) => <Textarea id={id} rows={3} value={instructions} maxLength={2000} onChange={(e) => setInstructions(e.target.value)} />}
            </FormField>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

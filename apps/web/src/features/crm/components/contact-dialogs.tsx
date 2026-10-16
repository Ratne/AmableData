import type { Contact } from '@amable/api-types/crm';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import { RadioGroup, RadioGroupItem } from '@amable/ui/ui/radio-group';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { LanguageSelect } from '../../../components/locale/language-select';
import { isE164 } from '../../../components/locale/phone-countries';
import { PhoneInput } from '../../../components/locale/phone-input';
import { useWorkspaceCountry } from '../../workspace/api';
import { TimeZoneSelect } from '../../../components/locale/timezone-select';
import { useI18n } from '../../../i18n';
import { crmKeys, useCrm, useCrmMutation } from '../api/hooks';
import { TagMultiSelect } from './inputs';

export interface RecordRef {
  readonly id: string;
  readonly label: string;
}

export function contactName(
  contact: Pick<Contact, 'given_name' | 'family_name'> & { emails?: Contact['emails'] },
  fallback: string,
): string {
  const name = [contact.given_name, contact.family_name].filter(Boolean).join(' ').trim();
  return name || contact.emails?.[0]?.email || fallback;
}

export function CreateContactDialog({
  open,
  onOpenChange,
  onCreated,
  companyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (contact: Contact) => void;
  companyId?: string;
}) {
  const { t } = useI18n();
  const { api } = useCrm();
  const defaultCountry = useWorkspaceCountry();
  const [given, setGiven] = useState('');
  const [family, setFamily] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [timeZone, setTimeZone] = useState('');
  const [language, setLanguage] = useState('');
  const phoneInvalid = phone !== '' && !isE164(phone);
  const create = useCrmMutation({
    mutationFn: () =>
      api.contacts.create({
        ...(given.trim() ? { given_name: given.trim() } : {}),
        ...(family.trim() ? { family_name: family.trim() } : {}),
        ...(email.trim() ? { emails: [{ email: email.trim() }] } : {}),
        ...(phone ? { phones: [{ number: phone }] } : {}),
        ...(timeZone ? { time_zone: timeZone } : {}),
        ...(language ? { preferred_locale: language } : {}),
        ...(companyId ? { company_id: companyId } : {}),
      }),
    success: t('crm.contacts.created'),
    onSuccess: (contact) => {
      setGiven('');
      setFamily('');
      setEmail('');
      setPhone('');
      setTimeZone('');
      setLanguage('');
      onCreated(contact);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined);
  };
  const empty = !given.trim() && !family.trim() && !email.trim();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('crm.contacts.new')}</DialogTitle>
            <DialogDescription>{t('crm.contacts.newBody')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="new-given">{t('crm.field.given_name')}</Label>
              <Input
                id="new-given"
                value={given}
                autoFocus
                onChange={(e) => setGiven(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-family">{t('crm.field.family_name')}</Label>
              <Input id="new-family" value={family} onChange={(e) => setFamily(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-email">{t('crm.field.email')}</Label>
              <Input
                id="new-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="new-phone">{t('crm.field.phone')}</Label>
              <PhoneInput
                id="new-phone"
                value={phone}
                onChange={setPhone}
                invalid={phoneInvalid}
                defaultCountry={defaultCountry}
              />
              {phoneInvalid ? (
                <p role="alert" className="text-xs text-destructive">
                  {t('locale.phone.invalid')}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-time-zone">{t('crm.field.time_zone')}</Label>
              <TimeZoneSelect
                id="new-time-zone"
                value={timeZone}
                onChange={setTimeZone}
                className="w-full"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-language">{t('crm.field.preferred_locale')}</Label>
              <LanguageSelect
                id="new-language"
                value={language}
                onChange={setLanguage}
                className="w-full"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={empty || phoneInvalid || create.isPending}>
              {t('crm.common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Apply or remove tags on many contacts (`POST /tags/{id}/apply|remove`). */
export function BulkTagDialog({
  mode,
  contactIds,
  onOpenChange,
  onDone,
}: {
  mode: 'apply' | 'remove' | null;
  contactIds: readonly string[];
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const { api } = useCrm();
  const [tagIds, setTagIds] = useState<string[]>([]);
  const run = useCrmMutation({
    mutationFn: async () => {
      let changed = 0;
      for (const tagId of tagIds) {
        const result =
          mode === 'remove'
            ? await api.tags.unapply(tagId, [...contactIds])
            : await api.tags.apply(tagId, [...contactIds]);
        changed += result.changed;
      }
      return changed;
    },
    success: (changed) => t('crm.bulk.tagsDone', { count: changed }),
    onSuccess: () => {
      setTagIds([]);
      onDone();
    },
  });
  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === 'remove' ? t('crm.bulk.removeTags') : t('crm.bulk.applyTags')}
          </DialogTitle>
          <DialogDescription>
            {t('crm.bulk.tagsBody', { count: contactIds.length })}
          </DialogDescription>
        </DialogHeader>
        <TagMultiSelect
          values={tagIds}
          onChange={setTagIds}
          ariaLabel={t('crm.field.tags')}
          placeholder={t('search.chooseTags')}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={tagIds.length === 0 || run.isPending}
            onClick={() => run.mutate(undefined)}
          >
            {mode === 'remove' ? t('crm.bulk.remove') : t('crm.bulk.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Merge contacts: pick the surviving record; the others are folded into it
 * (empty fields filled, emails/phones/tags/notes/tasks/deals moved, then
 * soft-deleted). More contacts can be added by search.
 */
export function MergeDialog({
  open,
  onOpenChange,
  initial,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: readonly RecordRef[];
  onMerged: (survivor: Contact) => void;
}) {
  const { t } = useI18n();
  const { slug, api } = useCrm();
  const [records, setRecords] = useState<RecordRef[]>([...initial]);
  const [targetId, setTargetId] = useState(initial[0]?.id ?? '');
  const [q, setQ] = useState('');
  const search = useQuery({
    queryKey: [...crmKeys.contacts(slug), 'mergeSearch', q],
    queryFn: () => api.contacts.list({ q, limit: 8 }),
    enabled: open && q.trim().length >= 2,
  });
  const merge = useCrmMutation({
    mutationFn: () =>
      api.contacts.merge(
        targetId,
        records.map((r) => r.id).filter((id) => id !== targetId),
      ),
    success: t('crm.merge.done'),
    onSuccess: onMerged,
  });
  const add = (contact: Contact) => {
    if (records.some((r) => r.id === contact.id)) return;
    setRecords((current) => [
      ...current,
      { id: contact.id, label: contactName(contact, contact.id) },
    ]);
    setQ('');
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('crm.merge.title')}</DialogTitle>
          <DialogDescription>{t('crm.merge.body')}</DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={targetId}
          onValueChange={setTargetId}
          aria-label={t('crm.merge.survivor')}
        >
          {records.map((record) => (
            <div key={record.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
              <RadioGroupItem id={`merge-${record.id}`} value={record.id} />
              <Label htmlFor={`merge-${record.id}`} className="flex-1 font-normal">
                {record.label}
                {record.id === targetId ? (
                  <span className="ml-2 text-xs text-muted-foreground">{t('crm.merge.keeps')}</span>
                ) : null}
              </Label>
              {records.length > 1 ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('crm.merge.removeCandidate', { name: record.label })}
                  onClick={() => {
                    setRecords((current) => current.filter((r) => r.id !== record.id));
                    if (record.id === targetId)
                      setTargetId(records.find((r) => r.id !== record.id)?.id ?? '');
                  }}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>
          ))}
        </RadioGroup>
        <div className="grid gap-1.5">
          <Label htmlFor="merge-search">{t('crm.merge.add')}</Label>
          <Input
            id="merge-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('crm.merge.searchPlaceholder')}
          />
          {(search.data?.data ?? [])
            .filter((c) => !records.some((r) => r.id === c.id))
            .map((contact) => (
              <button
                key={contact.id}
                type="button"
                className="rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => add(contact)}
              >
                {contactName(contact, contact.id)}
                <span className="ml-2 text-xs text-muted-foreground">
                  {contact.emails[0]?.email ?? ''}
                </span>
              </button>
            ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={records.length < 2 || targetId === '' || merge.isPending}
            onClick={() => merge.mutate(undefined)}
          >
            {t('crm.merge.confirm', { count: records.length - 1 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

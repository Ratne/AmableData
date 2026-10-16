import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Check, Pencil, X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { ChoiceSelect, DatePicker, UserSelect, type Choice } from './inputs';

export interface InlineEditProps<V> {
  readonly label: string;
  readonly value: V;
  /** Read-only text when not editing. */
  readonly display: ReactNode;
  readonly editor: (draft: V, setDraft: (value: V) => void, invalid: boolean) => ReactNode;
  readonly onSave: (value: V) => Promise<unknown>;
  /** Returns an error message, or null when valid. */
  readonly validate?: (value: V) => string | null;
  readonly canEdit: boolean;
  readonly className?: string;
  /** Puts the label above the editor while editing, for editors that need the full row. */
  readonly stackWhileEditing?: boolean;
}

/** Label + value that turns into an editor in place; Enter saves, Escape cancels. */
export function InlineEdit<V>({
  label,
  value,
  display,
  editor,
  onSave,
  validate,
  canEdit,
  className,
  stackWhileEditing = false,
}: InlineEditProps<V>) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<{ value: V } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (draft === null) return;
    const problem = validate?.(draft.value) ?? null;
    if (problem !== null) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft.value);
      setDraft(null);
      setError(null);
    } catch {
      // the mutation toast reports it
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={cn(
        'grid gap-0.5 py-1.5 sm:grid-cols-[9rem_1fr] sm:items-start sm:gap-3',
        className,
        stackWhileEditing && draft !== null && 'sm:grid-cols-1 sm:gap-1.5',
      )}
    >
      <span className="pt-1.5 text-xs text-muted-foreground">{label}</span>
      {draft !== null ? (
        <form
          className="flex flex-col gap-1"
          onSubmit={(event) => void submit(event)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setDraft(null);
              setError(null);
            }
          }}
        >
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              {editor(draft.value, (next) => setDraft({ value: next }), error !== null)}
            </div>
            <Button
              type="submit"
              size="icon"
              className="size-8"
              disabled={saving}
              aria-label={t('common.save')}
            >
              <Check className="size-4" aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t('common.cancel')}
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="group flex min-h-8 items-center gap-1.5">
          <span className="min-w-0 text-sm break-words">{display}</span>
          {canEdit ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 opacity-50 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={t('crm.field.editNamed', { name: label })}
              onClick={() => setDraft({ value })}
            >
              <Pencil className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

const dash = <span className="text-muted-foreground">—</span>;

export function InlineText({
  label,
  value,
  onSave,
  canEdit,
  type = 'text',
  validate,
  maxLength,
  className,
}: {
  label: string;
  value: string | null;
  onSave: (value: string | null) => Promise<unknown>;
  canEdit: boolean;
  type?: 'text' | 'email' | 'url' | 'tel' | 'number';
  validate?: (value: string) => string | null;
  maxLength?: number;
  className?: string;
}) {
  return (
    <InlineEdit<string>
      label={label}
      value={value ?? ''}
      display={value ? value : dash}
      canEdit={canEdit}
      validate={validate}
      className={className}
      onSave={(next) => onSave(next.trim() === '' ? null : next.trim())}
      editor={(draft, setDraft, invalid) => (
        <Input
          autoFocus
          type={type}
          value={draft}
          maxLength={maxLength}
          aria-label={label}
          aria-invalid={invalid}
          onChange={(event) => setDraft(event.target.value)}
          className="h-8"
        />
      )}
    />
  );
}

export function InlineChoice({
  label,
  value,
  choices,
  onSave,
  canEdit,
  allowEmpty = true,
}: {
  label: string;
  value: string | null;
  choices: readonly Choice[];
  onSave: (value: string | null) => Promise<unknown>;
  canEdit: boolean;
  allowEmpty?: boolean;
}) {
  const shown = choices.find((choice) => choice.value === value)?.label ?? value;
  return (
    <InlineEdit<string>
      label={label}
      value={value ?? ''}
      display={shown ? shown : dash}
      canEdit={canEdit}
      onSave={(next) => onSave(next === '' ? null : next)}
      editor={(draft, setDraft) => (
        <ChoiceSelect
          value={draft}
          onChange={setDraft}
          choices={choices}
          allowEmpty={allowEmpty}
          ariaLabel={label}
        />
      )}
    />
  );
}

export function InlineUser({
  label,
  value,
  display,
  onSave,
  canEdit,
}: {
  label: string;
  value: string | null;
  display: string;
  onSave: (value: string | null) => Promise<unknown>;
  canEdit: boolean;
}) {
  return (
    <InlineEdit<string>
      label={label}
      value={value ?? ''}
      display={display || dash}
      canEdit={canEdit}
      onSave={(next) => onSave(next === '' ? null : next)}
      editor={(draft, setDraft) => (
        <UserSelect value={draft} onChange={setDraft} ariaLabel={label} />
      )}
    />
  );
}

export function InlineDate({
  label,
  value,
  display,
  onSave,
  canEdit,
  className,
}: {
  label: string;
  value: string | null;
  display: string;
  onSave: (value: string | null) => Promise<unknown>;
  canEdit: boolean;
  className?: string;
}) {
  return (
    <InlineEdit<string>
      label={label}
      value={value ?? ''}
      display={display || dash}
      canEdit={canEdit}
      className={className}
      onSave={(next) => onSave(next === '' ? null : next)}
      editor={(draft, setDraft) => (
        <DatePicker value={draft} onChange={setDraft} ariaLabel={label} />
      )}
    />
  );
}

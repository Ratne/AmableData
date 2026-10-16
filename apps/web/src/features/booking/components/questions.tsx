import { BOOKING_QUESTION_KINDS, BOOKING_QUESTION_MAP_TARGETS, type BookingEventType, type CustomField } from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Checkbox } from '@amable/ui/ui/checkbox';
import { Input } from '@amable/ui/ui/input';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { Choice, Field } from './common';

export type Question = BookingEventType['questions'][number];

const OPTION_KINDS = new Set(['select', 'multicheck']);

function keyFrom(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^[^a-z]+/, '')
      .slice(0, 50) || 'question';
  let key = base;
  for (let n = 2; taken.has(key) || ['given_name', 'family_name', 'email', 'phone'].includes(key); n += 1) key = `${base}_${String(n)}`;
  return key;
}

/** Custom questions of the booking form, each optionally written to a contact attribute or custom field. */
export function QuestionsEditor({
  questions,
  onChange,
  customFields,
}: {
  questions: readonly Question[];
  onChange: (questions: Question[]) => void;
  customFields: readonly CustomField[];
}) {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<Question>) => onChange(questions.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  const move = (index: number, delta: number) => {
    const next = [...questions];
    const [item] = next.splice(index, 1);
    if (item === undefined) return;
    next.splice(index + delta, 0, item);
    onChange(next);
  };
  const used = new Set(questions.map((q) => q.map_to).filter((m): m is string => m !== null));
  const mapOptions = (current: string | null) => [
    ...BOOKING_QUESTION_MAP_TARGETS.map((target) => ({ value: target, label: t(`booking.map.${target}`) })),
    ...customFields.map((f) => ({ value: `custom.${f.key}`, label: `${t('booking.map.custom')}: ${f.label}` })),
  ].filter((o) => o.value === current || !used.has(o.value));

  return (
    <div className="grid gap-3">
      {questions.length === 0 ? <p className="text-sm text-muted-foreground">{t('booking.questions.empty')}</p> : null}
      {questions.map((question, index) => (
        <div key={index} className="grid gap-3 rounded-lg border p-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto]">
            <Field label={t('booking.questions.label')}>
              {(id) => (
                <Input
                  id={id}
                  value={question.label}
                  maxLength={300}
                  onChange={(e) => update(index, { label: e.target.value })}
                  onBlur={() => {
                    if (question.key === '' && question.label.trim() !== '') {
                      update(index, { key: keyFrom(question.label, new Set(questions.map((q) => q.key))) });
                    }
                  }}
                />
              )}
            </Field>
            <Field label={t('booking.questions.kind')}>
              {(id) => (
                <Choice
                  id={id}
                  value={question.kind}
                  onChange={(kind) => update(index, { kind: (kind ?? 'text') as Question['kind'] })}
                  options={BOOKING_QUESTION_KINDS.map((kind) => ({ value: kind, label: t(`booking.questions.kinds.${kind}`) }))}
                />
              )}
            </Field>
            <div className="flex items-end gap-1">
              <Button type="button" size="icon" variant="ghost" aria-label={t('booking.questions.up')} disabled={index === 0} onClick={() => move(index, -1)}>
                <ArrowUp aria-hidden />
              </Button>
              <Button type="button" size="icon" variant="ghost" aria-label={t('booking.questions.down')} disabled={index === questions.length - 1} onClick={() => move(index, 1)}>
                <ArrowDown aria-hidden />
              </Button>
              <Button type="button" size="icon" variant="ghost" aria-label={t('booking.questions.remove')} onClick={() => onChange(questions.filter((_, i) => i !== index))}>
                <Trash2 aria-hidden />
              </Button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('booking.questions.key')} hint={t('booking.questions.keyHint')}>
              {(id) => <Input id={id} value={question.key} maxLength={63} onChange={(e) => update(index, { key: e.target.value.toLowerCase() })} />}
            </Field>
            <Field label={t('booking.questions.mapTo')}>
              {(id) => (
                <Choice id={id} value={question.map_to} onChange={(mapTo) => update(index, { map_to: mapTo })} noneLabel={t('booking.questions.noMapping')} options={mapOptions(question.map_to)} />
              )}
            </Field>
            <Field label={t('booking.questions.placeholder')}>
              {(id) => <Input id={id} value={question.placeholder} maxLength={200} onChange={(e) => update(index, { placeholder: e.target.value })} />}
            </Field>
          </div>
          {OPTION_KINDS.has(question.kind) ? (
            <Field label={t('booking.questions.options')} hint={t('booking.questions.optionsHint')}>
              {(id) => (
                <Input
                  id={id}
                  value={question.options.join(', ')}
                  onChange={(e) => update(index, { options: e.target.value.split(',').map((o) => o.trim()).filter((o) => o !== '') })}
                />
              )}
            </Field>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={question.required} onCheckedChange={(checked) => update(index, { required: checked === true })} />
            {t('booking.questions.required')}
          </label>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        className="w-fit"
        onClick={() => onChange([...questions, { key: '', label: '', kind: 'text', required: false, options: [], placeholder: '', map_to: null }])}
      >
        <Plus aria-hidden /> {t('booking.questions.add')}
      </Button>
    </div>
  );
}

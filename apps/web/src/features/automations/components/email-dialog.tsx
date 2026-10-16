import type { StepOf } from '@amable/api-types';
import { AmableEditor, defaultLiquidFields, EmailPreview, type JSONContent } from '@amable/editor';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@amable/ui/ui/tabs';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { editorLabels } from '../../../lib/labels';
import { useCustomFields } from '../../crm/api/hooks';
import { Field } from './form-bits';

type EmailStep = StepOf<'send_email'>;

const SAMPLE_CONTEXT = {
  contact: {
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    tags: ['VIP'],
  },
  owner: { name: 'Marco Rossi' },
  unsubscribe_url: 'https://example.com/unsubscribe',
};

/**
 * Inline email of a sequence step: the shared editor in email mode next to
 * the rendered preview (same pipeline as the sending worker).
 */
export function EmailDialog({
  step,
  open,
  onOpenChange,
  onSave,
  disabled,
}: {
  step: EmailStep;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (step: EmailStep) => void;
  disabled: boolean;
}) {
  const { t, locale } = useI18n();
  const [subject, setSubject] = useState(step.subject ?? '');
  const [preheader, setPreheader] = useState(step.preheader ?? '');
  const [doc, setDoc] = useState<JSONContent>(
    (step.body as JSONContent | undefined) ?? { type: 'doc', content: [{ type: 'paragraph' }] },
  );
  const [view, setView] = useState<'html' | 'text'>('html');
  const labels = useMemo(() => editorLabels(t), [t]);
  const custom = useCustomFields('contacts');
  const fields = useMemo(
    () => defaultLiquidFields(custom.fields.map((f) => ({ key: f.key, label: f.label }))),
    [custom.fields],
  );
  const options = useMemo(
    () => ({ subject, lang: locale, unsubscribeLabel: t('editor.unsubscribeDefault') }),
    [subject, locale, t],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[min(1200px,96vw)] max-w-none flex-col gap-3 sm:max-w-none">
        <DialogHeader>
          <DialogTitle>{t('auto.step.emailTitle')}</DialogTitle>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 gap-4 overflow-auto lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            <Field label={t('auto.step.subject')}>
              <Input
                value={subject}
                disabled={disabled}
                onChange={(e) => setSubject(e.target.value)}
              />
            </Field>
            <Field label={t('auto.step.preheader')}>
              <Input
                value={preheader}
                disabled={disabled}
                onChange={(e) => setPreheader(e.target.value)}
              />
            </Field>
            <AmableEditor
              key={`${step.id}-${locale}`}
              mode="email"
              value={doc}
              onChange={setDoc}
              editable={!disabled}
              liquidFields={fields}
              labels={labels}
              unsubscribeLabel={t('editor.unsubscribeDefault')}
              placeholder={t('editor.placeholder')}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <Tabs value={view} onValueChange={(v) => setView(v as 'html' | 'text')}>
              <TabsList>
                <TabsTrigger value="html">{t('auto.step.previewHtml')}</TabsTrigger>
                <TabsTrigger value="text">{t('auto.step.previewText')}</TabsTrigger>
              </TabsList>
            </Tabs>
            <EmailPreview doc={doc} context={SAMPLE_CONTEXT} options={options} view={view} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('auto.cancel')}
          </Button>
          {!disabled ? (
            <Button
              onClick={() => {
                const trimmed = subject.trim();
                const { template_id: _t, subject: _s, preheader: _p, ...rest } = step;
                onSave({
                  ...rest,
                  ...(trimmed === '' ? {} : { subject: trimmed }),
                  ...(preheader.trim() === '' ? {} : { preheader: preheader.trim() }),
                  body: { ...doc, type: 'doc' },
                });
                onOpenChange(false);
              }}
            >
              {t('auto.save')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

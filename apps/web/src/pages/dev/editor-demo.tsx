import { AmableEditor, defaultLiquidFields, EmailPreview, type JSONContent } from '@amable/editor';
import { PageBody, usePageChrome } from '@amable/ui';
import { Input } from '@amable/ui/ui/input';
import { Label } from '@amable/ui/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@amable/ui/ui/select';
import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { editorLabels } from '../../lib/labels';

const SAMPLE_DOC: JSONContent = {
  type: 'doc',
  content: [
    { type: 'emailPreheader', attrs: { text: 'What is new this month' } },
    {
      type: 'heading',
      attrs: { level: 1, textAlign: 'center' },
      content: [{ type: 'text', text: 'October news' }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hi ' },
        {
          type: 'liquidVariable',
          attrs: {
            path: 'contact.first_name',
            label: 'First name',
            fallback: 'there',
            filter: null,
          },
        },
        { type: 'text', text: ', thanks for being with us. Type ' },
        { type: 'text', marks: [{ type: 'code' }], text: '{{' },
        { type: 'text', text: ' to insert another field.' },
      ],
    },
    {
      type: 'emailButton',
      attrs: {
        label: 'Open your account',
        href: 'https://example.com/account',
        align: 'center',
        backgroundColor: '#2563eb',
        textColor: '#ffffff',
      },
    },
    {
      type: 'liquidCondition',
      attrs: {
        kind: 'tag',
        tag: 'VIP',
        field: null,
        operator: 'equals',
        value: null,
        expression: null,
        negate: false,
      },
      content: [
        {
          type: 'liquidBranch',
          attrs: { branch: 'then' },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'As a VIP you get early access.' }],
            },
          ],
        },
        {
          type: 'liquidBranch',
          attrs: { branch: 'else' },
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Become a VIP to get early access.' }],
            },
          ],
        },
      ],
    },
    {
      type: 'emailFooter',
      attrs: { unsubscribeLabel: 'Unsubscribe' },
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'You receive this email because you signed up on our site.' },
          ],
        },
      ],
    },
  ],
};

const RECIPIENTS = {
  ada: {
    contact: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', tags: ['VIP'] },
    owner: { name: 'Marco Rossi' },
  },
  anonymous: {
    contact: { first_name: '', email: 'someone@example.com', tags: [] },
    owner: { name: 'Marco Rossi' },
  },
} as const;

type RecipientId = keyof typeof RECIPIENTS;

/** Dev-only page: the shared editor in email mode next to the live rendered email. */
export function EditorDemoPage() {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<'html' | 'text' | 'json'>('html');
  usePageChrome({
    title: t('dev.editor.title'),
    tabs: [
      { value: 'html', label: t('dev.editor.html') },
      { value: 'text', label: t('dev.editor.text') },
      { value: 'json', label: t('dev.editor.json') },
    ],
    tab,
    onTabChange: (value) => setTab(value as typeof tab),
  });
  const [doc, setDoc] = useState<JSONContent>(SAMPLE_DOC);
  const [subject, setSubject] = useState('News for {{ contact.first_name | default: "you" }}');
  const [recipient, setRecipient] = useState<RecipientId>('ada');
  const labels = useMemo(() => editorLabels(t), [t]);
  const fields = useMemo(() => defaultLiquidFields([{ key: 'plan', label: 'Plan' }]), []);
  const options = useMemo(
    () => ({
      subject,
      lang: locale,
      unsubscribeLabel: t('editor.unsubscribeDefault'),
      footerAddress: 'Example Srl · Via Roma 1 · Milano',
    }),
    [locale, subject, t],
  );

  return (
    <PageBody className="grid gap-4 pt-4 xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="demo-subject">{t('dev.editor.subject')}</Label>
          <Input
            id="demo-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </div>
        <AmableEditor
          key={locale}
          mode="email"
          value={doc}
          onChange={setDoc}
          liquidFields={fields}
          labels={labels}
          unsubscribeLabel={t('editor.unsubscribeDefault')}
          placeholder={t('editor.placeholder')}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="grid gap-1.5">
          <Label>{t('dev.editor.recipient')}</Label>
          <Select value={recipient} onValueChange={(value) => setRecipient(value as RecipientId)}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ada">Ada Lovelace (VIP)</SelectItem>
              <SelectItem value="anonymous">someone@example.com</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {tab === 'json' ? (
          <pre className="max-h-[40rem] overflow-auto rounded-lg border p-3 text-xs">
            {JSON.stringify(doc, null, 2)}
          </pre>
        ) : (
          <EmailPreview doc={doc} context={RECIPIENTS[recipient]} options={options} view={tab} />
        )}
      </div>
    </PageBody>
  );
}

import { AmableEditor, type JSONContent } from '@amable/editor';
import { useI18n } from '../../../i18n';
import { editorLabels } from '../../../lib/labels';

/** Rich-text editor for notes (loaded in its own chunk: Tiptap is large). */
export function NoteEditor({
  value,
  onChange,
}: {
  value: JSONContent | null;
  onChange: (doc: JSONContent) => void;
}) {
  const { t } = useI18n();
  return (
    <AmableEditor
      mode="rich"
      value={value}
      onChange={onChange}
      toolbar="compact"
      liquidFields={null}
      labels={editorLabels(t)}
      placeholder={t('crm.notes.placeholder')}
      className="min-h-32 rounded-md border"
    />
  );
}

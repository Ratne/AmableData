import { Tabs, TabsContent, TabsList, TabsTrigger } from '@amable/ui/ui/tabs';
import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { Builders } from './builders';
import { FieldTree } from './field-tree';
import { GuideView } from './guide';
import { PreviewPane, type DocumentSource } from './preview-pane';
import { useLiquidSchema } from './schema';
import './liquid.css';

export type LiquidHelperTab = 'fields' | 'build' | 'preview' | 'guide';

/**
 * The Liquid helper: field picker, guided builders, live preview against a
 * real contact and the guide. Used inside the email editor drawer and next to
 * the snippet editor; `onInsert` puts code at the host's cursor.
 */
export function LiquidHelperPanel({
  onInsert,
  documentSource,
  initialTab = 'fields',
}: {
  onInsert: (code: string) => void;
  documentSource: DocumentSource | null;
  initialTab?: LiquidHelperTab;
}) {
  const { t } = useI18n();
  const { schema } = useLiquidSchema();
  const [tab, setTab] = useState<LiquidHelperTab>(initialTab);
  const [expression, setExpression] = useState('');
  const tryInPreview = (code: string) => {
    setExpression(code);
    setTab('preview');
  };
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as LiquidHelperTab)} className="flex min-h-0 flex-1 flex-col gap-3">
      <TabsList className="w-full">
        <TabsTrigger value="fields">{t('email.liquid.tab.fields')}</TabsTrigger>
        <TabsTrigger value="build">{t('email.liquid.tab.build')}</TabsTrigger>
        <TabsTrigger value="preview">{t('email.liquid.tab.preview')}</TabsTrigger>
        <TabsTrigger value="guide">{t('email.liquid.tab.guide')}</TabsTrigger>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <TabsContent value="fields">
          <FieldTree schema={schema} onPick={onInsert} />
        </TabsContent>
        <TabsContent value="build">
          <Builders schema={schema} onInsert={onInsert} onTry={tryInPreview} />
        </TabsContent>
        <TabsContent value="preview">
          <PreviewPane expression={expression} onExpressionChange={setExpression} documentSource={documentSource} />
        </TabsContent>
        <TabsContent value="guide">
          <GuideView compact />
        </TabsContent>
      </div>
    </Tabs>
  );
}

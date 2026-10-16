import type { LiquidHelperRenderProps } from '@amable/editor';
import { toast } from '@amable/ui';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@amable/ui/ui/sheet';
import { useMemo } from 'react';
import { useI18n } from '../../../i18n';
import { LiquidHelperPanel } from './panel';

/** Right drawer of the email editor (every email-mode AmableEditor under the provider). */
export function LiquidHelperDrawer({ open, onOpenChange, host }: LiquidHelperRenderProps) {
  const { t } = useI18n();
  const documentSource = useMemo(() => ({ label: t('email.liquid.preview.wholeEmail'), get: host.source }), [host, t]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        className="w-full gap-2 sm:max-w-xl"
        onInteractOutside={(event) => event.preventDefault()}
        data-testid="liquid-helper-drawer"
      >
        <SheetHeader className="pb-0">
          <SheetTitle>{t('email.liquid.title')}</SheetTitle>
          <SheetDescription>{t('email.liquid.subtitleEmail')}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
          <LiquidHelperPanel
            documentSource={documentSource}
            onInsert={(code) => {
              host.insert(code);
              toast.success(t('email.liquid.inserted'));
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

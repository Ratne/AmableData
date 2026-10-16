import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Spinner } from '@amable/ui/ui/spinner';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { useLanding } from '../api/hooks';
import { ErrorNotice } from '../components/common';
import { DEVICES, type DeviceKey } from '../lib/devices';
import { openHtmlInNewTab, withSpaNonce } from '../lib/preview-html';

/** Server-rendered preview of the saved draft (GET /pages/{id}/preview), per device. */
export function PreviewDialog({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const { t } = useI18n();
  const { api } = useLanding();
  const [device, setDevice] = useState<DeviceKey>('desktop');
  const preview = useQuery({
    queryKey: ['landing-preview', pageId],
    queryFn: () => api.pages.preview(pageId),
    gcTime: 0,
    staleTime: 0,
  });
  const html = useMemo(() => (preview.data ? withSpaNonce(preview.data.html) : ''), [preview.data]);
  const width = DEVICES.find((d) => d.key === device)?.width ?? 1440;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col sm:max-w-[95vw]">
        <DialogHeader>
          <DialogTitle>{t('landing.preview.title')}</DialogTitle>
          <DialogDescription>{t('landing.preview.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-1.5">
          {DEVICES.map((d) => (
            <Button key={d.key} type="button" size="sm" variant={d.key === device ? 'secondary' : 'ghost'} onClick={() => setDevice(d.key)}>
              {t(`landing.device.${d.key}`)} · {d.width}
            </Button>
          ))}
          <div className="ml-auto flex gap-1.5">
            <Button type="button" variant="outline" size="sm" disabled={preview.isFetching} onClick={() => void preview.refetch()}>
              <RefreshCw aria-hidden /> {t('landing.preview.reload')}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={!preview.data} onClick={() => preview.data && openHtmlInNewTab(preview.data.html)}>
              <ExternalLink aria-hidden /> {t('landing.preview.newTab')}
            </Button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 justify-center overflow-auto rounded-lg bg-muted/40 p-3">
          {preview.error ? (
            <ErrorNotice error={preview.error} />
          ) : preview.isPending ? (
            <Spinner className="mt-10" />
          ) : (
            <iframe
              title={t('landing.preview.title')}
              className="h-full shrink-0 rounded-md border bg-white shadow"
              style={{ width: Math.min(width, 1440) }}
              srcDoc={html}
              sandbox="allow-scripts allow-popups"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

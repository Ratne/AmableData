import type { Shortlink } from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@amable/ui/ui/dialog';
import { Download } from 'lucide-react';
import { useMemo } from 'react';
import { encode } from 'uqr';
import { useI18n } from '../../../i18n';
import { displayShortUrl } from '../lib/links';
import { downloadBlob, downloadHref } from '../../../lib/download';

const PNG_SIZE = 512;

/** Standalone SVG document of a QR code (black modules on white). */
export function qrSvg(value: string): string {
  const qr = encode(value, { ecc: 'M', border: 2 });
  let path = '';
  qr.data.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) path += `M${String(x)} ${String(y)}h1v1h-1z`;
    }),
  );
  const size = String(qr.size);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

function downloadSvg(svg: string, filename: string): void {
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), filename);
}

function downloadPng(svg: string, filename: string): void {
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  image.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = PNG_SIZE;
    canvas.height = PNG_SIZE;
    const ctx = canvas.getContext('2d');
    if (ctx !== null) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0, PNG_SIZE, PNG_SIZE);
      downloadHref(canvas.toDataURL('image/png'), filename);
    }
    URL.revokeObjectURL(url);
  };
  image.src = url;
}

export function QrDialog({ link, onClose }: { link: Shortlink; onClose: () => void }) {
  const { t } = useI18n();
  const value = link.short_url ?? '';
  const svg = useMemo(() => (value === '' ? '' : qrSvg(value)), [value]);
  const filename = `qr-${link.key}`;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('shortlinks.qr.title')}</DialogTitle>
          <DialogDescription className="break-all">{displayShortUrl(link)}</DialogDescription>
        </DialogHeader>
        {svg === '' ? (
          <p className="text-sm text-muted-foreground">{t('shortlinks.qr.noDomain')}</p>
        ) : (
          <img
            src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
            alt={t('shortlinks.qr.alt', { url: value })}
            className="mx-auto aspect-square w-64 rounded-md border bg-white p-2"
          />
        )}
        <DialogFooter className="gap-2 sm:justify-center">
          <Button type="button" variant="outline" disabled={svg === ''} onClick={() => downloadPng(svg, `${filename}.png`)}>
            <Download aria-hidden /> PNG
          </Button>
          <Button type="button" variant="outline" disabled={svg === ''} onClick={() => downloadSvg(svg, `${filename}.svg`)}>
            <Download aria-hidden /> SVG
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

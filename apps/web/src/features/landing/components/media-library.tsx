import { MEDIA_CONTENT_TYPES, MEDIA_MAX_BYTES } from '@amable/api-types';
import { cn, toast } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@amable/ui/ui/dialog';
import { Input } from '@amable/ui/ui/input';
import { Spinner } from '@amable/ui/ui/spinner';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ImageIcon, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useI18n } from '../../../i18n';
import { errorMessage, landingKeys, useLanding, usePermissions } from '../api/hooks';
import type { MediaFile } from '../api/types';

const ACCEPT = MEDIA_CONTENT_TYPES.join(',');

/** Upload shared by the library dialog and the inline "upload" buttons. */
export function useMediaUpload(): { upload: (file: File) => Promise<MediaFile | null>; uploading: boolean } {
  const { t } = useI18n();
  const { slug, api } = useLanding();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const upload = async (file: File): Promise<MediaFile | null> => {
    if (!(MEDIA_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      toast.error(t('landing.media.onlyImages'));
      return null;
    }
    if (file.size > MEDIA_MAX_BYTES) {
      toast.error(t('landing.media.tooLarge'));
      return null;
    }
    setUploading(true);
    try {
      const created = await api.media.upload(file);
      await queryClient.invalidateQueries({ queryKey: landingKeys.media(slug) });
      return created;
    } catch (error) {
      toast.error(errorMessage(t, error));
      return null;
    } finally {
      setUploading(false);
    }
  };
  return { upload, uploading };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Tenant media library: upload (PUT /media), pick, delete. */
export function MediaLibraryDialog({ onClose, onSelect }: { onClose: () => void; onSelect: (file: MediaFile) => void }) {
  const { t } = useI18n();
  const { slug, api } = useLanding();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const { upload, uploading } = useMediaUpload();
  const [filter, setFilter] = useState('');
  const media = useInfiniteQuery({
    queryKey: landingKeys.media(slug),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.media.list(pageParam),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const items = (media.data?.pages.flatMap((p) => p.data) ?? []).filter((m) =>
    filter.trim() === '' ? true : m.filename.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const writable = can('pages:write');

  const remove = async (file: MediaFile) => {
    try {
      await api.media.remove(file.id);
      await queryClient.invalidateQueries({ queryKey: landingKeys.media(slug) });
      toast.success(t('landing.media.deleted'));
    } catch (error) {
      toast.error(errorMessage(t, error));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('landing.media.title')}</DialogTitle>
          <DialogDescription>{t('landing.media.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="search"
            className="h-8 max-w-xs"
            placeholder={t('landing.media.filter')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {writable ? (
            <>
              <Button size="sm" className="ml-auto" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? <Spinner /> : <Upload aria-hidden />} {t('landing.media.upload')}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = '';
                  void (async () => {
                    let last: MediaFile | null = null;
                    for (const file of files) last = (await upload(file)) ?? last;
                    if (last !== null && files.length === 1) onSelect(last);
                  })();
                }}
              />
            </>
          ) : null}
        </div>
        <div className="max-h-[60vh] min-h-48 overflow-y-auto">
          {media.isPending ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : media.error ? (
            <p className="py-10 text-center text-sm text-destructive">{errorMessage(t, media.error)}</p>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
              <ImageIcon aria-hidden className="size-8" />
              {t('landing.media.empty')}
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {items.map((file) => (
                <li key={file.id} className="group relative overflow-hidden rounded-lg border">
                  <button
                    type="button"
                    className="block w-full text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => onSelect(file)}
                  >
                    <div className="flex aspect-[4/3] items-center justify-center bg-muted">
                      {file.content_type.startsWith('image/') ? (
                        <img src={file.preview_url ?? file.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <ImageIcon aria-hidden className="size-6 text-muted-foreground" />
                      )}
                    </div>
                    <div className="px-2 py-1.5">
                      <p className="truncate text-xs font-medium">{file.filename}</p>
                      <p className="text-[11px] text-muted-foreground">{formatSize(file.size)}</p>
                    </div>
                  </button>
                  {writable ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      aria-label={t('landing.media.delete')}
                      className={cn('absolute top-1.5 right-1.5 size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
                      onClick={() => void remove(file)}
                    >
                      <Trash2 aria-hidden className="size-3.5" />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {media.hasNextPage ? (
            <div className="flex justify-center pt-3">
              <Button variant="outline" size="sm" disabled={media.isFetchingNextPage} onClick={() => void media.fetchNextPage()}>
                {t('landing.common.loadMore')}
              </Button>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** URL input + upload + library picker, used by media controls and the OG image field. */
export function MediaInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (url: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { upload, uploading } = useMediaUpload();
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-1.5">
        <Input
          id={id}
          value={value}
          disabled={disabled}
          placeholder={t('landing.media.urlPlaceholder')}
          className="h-8 min-w-0 flex-1 text-xs"
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-8"
          aria-label={t('landing.media.upload')}
          disabled={disabled || uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? <Spinner /> : <Upload aria-hidden />}
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-8" disabled={disabled} onClick={() => setOpen(true)}>
          <ImageIcon aria-hidden /> {t('landing.media.library')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void upload(file).then((created) => created && onChange(created.url));
          }}
        />
      </div>
      {value ? <img src={value} alt="" className="h-16 w-full rounded border object-cover" /> : null}
      {open ? (
        <MediaLibraryDialog
          onClose={() => setOpen(false)}
          onSelect={(file) => {
            onChange(file.url);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

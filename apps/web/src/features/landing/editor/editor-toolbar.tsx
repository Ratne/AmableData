import type { Breakpoint } from '@amable/builder';
import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft,
  ClipboardCopy,
  ClipboardPaste,
  ExternalLink,
  Eye,
  Maximize2,
  Minimize2,
  Redo2,
  Rocket,
  Save,
  Settings,
  SquareStack,
  Undo2,
} from 'lucide-react';
import { useI18n } from '../../../i18n';
import type { LandingPage } from '../api/types';
import { Choice, Pill } from '../components/common';
import { SaveIndicator } from '../components/save-indicator';
import type { ClipEntry } from '../hooks/use-block-clipboard';
import type { BuilderDocumentState } from '../hooks/use-builder-document';
import type { ClipboardActions } from '../hooks/use-clipboard-actions';
import { DEVICES, ZOOMS, type CanvasZoom, type DeviceKey } from '../lib/devices';
import { ClipboardTray } from './clipboard-tray';

/** Top bar of the canvas editor: history, device/zoom, clipboard, popups, save/preview/publish. */
export function EditorToolbar({
  meta,
  slug,
  b,
  editable,
  canPublish,
  deviceKey,
  onDeviceChange,
  breakpoint,
  zoom,
  onZoomChange,
  fullView,
  onToggleFullView,
  clip,
  selectedId,
  onDragClip,
  popupCount,
  editingPopup,
  onOpenPopups,
  onPreview,
  onPublish,
}: {
  meta: LandingPage;
  slug: string;
  b: BuilderDocumentState;
  editable: boolean;
  canPublish: boolean;
  deviceKey: DeviceKey;
  onDeviceChange: (key: DeviceKey) => void;
  breakpoint: Breakpoint;
  zoom: CanvasZoom;
  onZoomChange: (zoom: CanvasZoom) => void;
  fullView: boolean;
  onToggleFullView: () => void;
  clip: ClipboardActions;
  selectedId: string | null;
  onDragClip: (entry: ClipEntry) => void;
  popupCount: number;
  editingPopup: boolean;
  onOpenPopups: () => void;
  onPreview: () => void;
  onPublish: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { latestClip, clipboard, tray } = clip;
  const publicUrl = meta.status === 'published' ? meta.public_url : null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        title={t('landing.editor.backToList')}
        aria-label={t('landing.editor.backToList')}
        onClick={() => void navigate({ to: '/t/$tenant/landing-pages', params: { tenant: slug } })}
        data-testid="editor-back"
      >
        <ArrowLeft aria-hidden /> <span className="hidden lg:inline">{t('nav.landingPages')}</span>
      </Button>
      <div className="flex min-w-0 max-w-64 flex-col leading-tight">
        <span className="truncate text-sm font-medium">{meta.title || t('landing.untitled')}</span>
        <code className="truncate text-[11px] text-muted-foreground">{meta.path}</code>
      </div>
      <Pill tone={meta.status === 'published' ? 'success' : 'neutral'}>
        {t(`landing.status.${meta.status}`)}
      </Pill>
      <div className="flex items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('landing.editor.undo')}
          title={t('landing.editor.undo')}
          disabled={!b.canUndo}
          onClick={b.undo}
        >
          <Undo2 aria-hidden />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('landing.editor.redo')}
          title={t('landing.editor.redo')}
          disabled={!b.canRedo}
          onClick={b.redo}
        >
          <Redo2 aria-hidden />
        </Button>
      </div>
      <Choice
        className="h-8 w-44 text-xs"
        value={deviceKey}
        options={DEVICES.map((d) => ({
          value: d.key,
          label: `${t(`landing.device.${d.key}`)} · ${String(d.width)}`,
        }))}
        onChange={(value) => onDeviceChange(DEVICES.find((d) => d.key === value)?.key ?? 'desktop')}
      />
      <span
        className={cn(
          'rounded-full px-2 py-0.5 text-xs font-medium',
          breakpoint === 'desktop'
            ? 'bg-muted text-muted-foreground'
            : 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
        )}
        title={t('landing.editor.breakpointHint')}
      >
        {t(`landing.device.${breakpoint}`)}
      </span>
      <Choice
        className="h-8 w-24 text-xs"
        value={zoom === 'fit' ? 'fit' : String(zoom * 100)}
        options={ZOOMS.map((z) => ({
          value: z.key,
          label: z.value === 'fit' ? t('landing.editor.zoomFit') : `${z.key}%`,
        }))}
        onChange={(value) => onZoomChange(ZOOMS.find((z) => z.key === value)?.value ?? 'fit')}
      />
      <Button
        type="button"
        variant={fullView ? 'secondary' : 'ghost'}
        size="icon"
        aria-label={fullView ? t('landing.editor.showPanels') : t('landing.editor.fullView')}
        title={fullView ? t('landing.editor.showPanels') : t('landing.editor.fullView')}
        onClick={onToggleFullView}
      >
        {fullView ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t('landing.editor.copyPage')}
        title={t('landing.editor.copyPage')}
        onClick={clip.copyPage}
      >
        <ClipboardCopy aria-hidden />
      </Button>
      {latestClip ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('landing.editor.pasteAtEnd', { count: latestClip.nodes.length })}
          title={`${t('landing.editor.pasteAtEnd', { count: latestClip.nodes.length })} — ${clip.describeClip(latestClip)}`}
          disabled={!editable}
          onClick={() => void clip.pasteBlock(null)}
        >
          <ClipboardPaste aria-hidden />
        </Button>
      ) : null}
      <ClipboardTray
        items={clipboard.items}
        open={tray.open}
        onOpenChange={(open) => {
          tray.setOpen(open);
          if (open) void clipboard.refresh();
        }}
        highlightId={tray.highlightId}
        disabled={!editable}
        onPaste={(entry) => {
          tray.setOpen(false);
          void clip.pasteBlock(selectedId, 'after', entry);
        }}
        onStartDrag={(entry) => {
          tray.setOpen(false);
          onDragClip(entry);
        }}
        onRemove={(id) => void clipboard.remove(id)}
        onClear={() => void clipboard.clear()}
      />
      <Button
        type="button"
        variant={editingPopup ? 'secondary' : 'outline'}
        size="sm"
        onClick={onOpenPopups}
      >
        <SquareStack aria-hidden /> {t('landing.popups.button', { count: popupCount })}
      </Button>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <SaveIndicator state={b.saveState} dirty={b.dirty} editable={editable} />
        {editable ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('landing.editor.saveNow')}
            title={t('landing.editor.saveNow')}
            disabled={!b.dirty || b.saveState === 'saving'}
            onClick={() => void b.saveNow()}
          >
            <Save aria-hidden />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('landing.action.settings')}
          title={t('landing.action.settings')}
          onClick={() =>
            void navigate({
              to: '/t/$tenant/landing-pages/$pageId/settings',
              params: { tenant: slug, pageId: meta.id },
            })
          }
        >
          <Settings aria-hidden />
        </Button>
        {publicUrl ? (
          <Button
            asChild
            variant="ghost"
            size="icon"
            aria-label={t('landing.action.viewLive')}
            title={t('landing.action.viewLive')}
          >
            <a href={publicUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden />
            </a>
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={onPreview}>
          <Eye aria-hidden /> {t('landing.preview.button')}
        </Button>
        {canPublish ? (
          <Button type="button" size="sm" disabled={!editable} onClick={onPublish}>
            <Rocket aria-hidden /> {t('landing.publish.action')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

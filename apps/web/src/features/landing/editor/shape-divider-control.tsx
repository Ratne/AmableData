import { sanitizeSvgShape, SHAPE_DIVIDERS } from '@amable/builder';
import { cn, toast } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Upload } from 'lucide-react';
import { useRef } from 'react';
import { useI18n } from '../../../i18n';
import { useBuilderLabel } from '../lib/builder-i18n';
import { ColorField } from './color-field';

/**
 * Shape divider of one side of a container. Manages the settings keys with
 * prefix `prefix`: Type, Color, Height, Flip, Invert, Front and Svg (custom
 * uploaded markup, sanitized). Every change is emitted as a settings patch.
 */
export function ShapeDividerControl({
  prefix,
  settings,
  disabled,
  onPatch,
}: {
  prefix: string;
  settings: Record<string, unknown>;
  disabled?: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const label = useBuilderLabel();
  const fileRef = useRef<HTMLInputElement>(null);
  const key = (suffix: string) => `${prefix}${suffix}`;
  const str = (suffix: string) => {
    const v = settings[key(suffix)];
    return typeof v === 'string' ? v : '';
  };
  const yes = (suffix: string) => settings[key(suffix)] === 'yes' || settings[key(suffix)] === true;
  const type = str('Type');
  // Stored documents can be written through the API: sanitize again before injecting.
  const customSvg = sanitizeSvgShape(str('Svg'))?.svg ?? '';
  const heightRaw = Number(settings[key('Height')]);
  const height = Number.isFinite(heightRaw) && heightRaw > 0 ? heightRaw : 80;

  const onUpload = (file: File) => {
    void file.text().then((raw) => {
      const clean = sanitizeSvgShape(raw);
      if (!clean) {
        toast.error(t('landing.editor.shapeInvalid'));
        return;
      }
      onPatch({ [key('Type')]: 'custom', [key('Svg')]: clean.svg });
    });
  };

  const tile = 'h-9 overflow-hidden rounded border bg-background text-foreground/70 [&>svg]:h-full [&>svg]:w-full';
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onPatch({ [key('Type')]: '' })}
          className={cn(
            'flex h-9 items-center justify-center rounded border text-[10px] text-muted-foreground',
            !type ? 'border-primary ring-1 ring-primary' : 'hover:border-foreground/30',
          )}
        >
          {t('landing.editor.none')}
        </button>
        {SHAPE_DIVIDERS.map((s) => (
          <button
            key={s.id}
            type="button"
            title={label(s.label)}
            aria-label={label(s.label)}
            disabled={disabled}
            onClick={() => onPatch({ [key('Type')]: s.id })}
            className={cn(tile, type === s.id ? 'border-primary ring-1 ring-primary' : 'hover:border-foreground/30')}
            dangerouslySetInnerHTML={{ __html: s.svg }}
          />
        ))}
        {customSvg ? (
          <button
            type="button"
            title={t('landing.editor.shapeCustom')}
            aria-label={t('landing.editor.shapeCustom')}
            disabled={disabled}
            onClick={() => onPatch({ [key('Type')]: 'custom' })}
            className={cn(tile, type === 'custom' ? 'border-primary ring-1 ring-primary' : 'hover:border-foreground/30')}
            dangerouslySetInnerHTML={{ __html: customSvg }}
          />
        ) : null}
      </div>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => fileRef.current?.click()}>
        <Upload aria-hidden /> {t('landing.editor.shapeUpload')}
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept=".svg,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onUpload(f);
        }}
      />
      {type ? (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('landing.editor.color')}</span>
            <ColorField value={str('Color')} disabled={disabled} onChange={(v) => onPatch({ [key('Color')]: v })} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t('landing.editor.heightPx')}</span>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={10}
                max={400}
                value={height}
                disabled={disabled}
                aria-label={t('landing.editor.heightPx')}
                className="flex-1 accent-primary"
                onChange={(e) => onPatch({ [key('Height')]: Number(e.target.value) })}
              />
              <Input
                type="number"
                className="h-8 w-20"
                value={height}
                disabled={disabled}
                onChange={(e) => onPatch({ [key('Height')]: e.target.value === '' ? '' : Number(e.target.value) })}
              />
            </div>
          </div>
          {(['Flip', 'Invert', 'Front'] as const).map((suffix) => (
            <label key={suffix} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={yes(suffix)}
                disabled={disabled}
                onChange={(e) => onPatch({ [key(suffix)]: e.target.checked ? 'yes' : 'no' })}
              />
              {t(`landing.editor.shape${suffix}`)}
            </label>
          ))}
        </>
      ) : null}
    </div>
  );
}

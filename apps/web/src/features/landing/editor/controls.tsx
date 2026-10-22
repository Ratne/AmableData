import { icon as iconSvg, ICON_NAMES, type ControlDef } from '@amable/builder';
import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Textarea } from '@amable/ui/ui/textarea';
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalDistributeCenter,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignHorizontalSpaceAround,
  AlignHorizontalSpaceBetween,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  ChevronDown,
  ChevronsDownUp,
  ChevronUp,
  Link2,
  MoveVertical,
  Plus,
  StretchHorizontal,
  Trash2,
  Unlink,
  WrapText,
} from 'lucide-react';
import { useState, type ComponentType, type ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import { Choice } from '../components/common';
import { MediaInput } from '../components/media-library';
import { useBuilderLabel } from '../lib/builder-i18n';
import { ColorField } from './color-field';
import { FontPicker } from './font-picker';
import { RichTextField } from './rich-text';
import { ShapeDividerControl } from './shape-divider-control';
import { CheckoutPicker, EventTypePicker, FormPicker } from './widget-pickers';

interface FieldProps {
  def: ControlDef;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  /** Popup nodes of the document, for `popup-select` controls. */
  popups?: readonly { id: string; name: string }[];
  /** Anchors of the document, for the "link to section" picker. */
  anchors?: readonly { id: string; label: string }[];
  /** Device being edited, shown next to responsive controls. */
  labelBadge?: string;
  /** Widget type owning the control (native form/booking pickers). */
  widgetType?: string;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const num = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** Icons of `choose` options in the catalog; unknown names fall back to the text label. */
const CHOOSE_ICONS: Readonly<Record<string, ComponentType<{ className?: string }>>> = {
  'align-center': AlignCenter,
  'align-center-horizontal': AlignCenterHorizontal,
  'align-end-horizontal': AlignEndHorizontal,
  'align-horizontal-distribute-center': AlignHorizontalDistributeCenter,
  'align-horizontal-justify-center': AlignHorizontalJustifyCenter,
  'align-horizontal-justify-end': AlignHorizontalJustifyEnd,
  'align-horizontal-justify-start': AlignHorizontalJustifyStart,
  'align-horizontal-space-around': AlignHorizontalSpaceAround,
  'align-horizontal-space-between': AlignHorizontalSpaceBetween,
  'align-left': AlignLeft,
  'align-right': AlignRight,
  'align-start-horizontal': AlignStartHorizontal,
  'arrow-down': ArrowDown,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-right-to-line': ArrowRightToLine,
  'arrow-up': ArrowUp,
  'chevrons-down-up': ChevronsDownUp,
  'move-vertical': MoveVertical,
  'stretch-horizontal': StretchHorizontal,
  'wrap-text': WrapText,
};

function Row({ label, badge, children }: { label: string; badge?: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {label}
        {badge ? (
          <span
            className="rounded bg-amber-500/15 px-1 py-px text-[9px] font-semibold text-amber-700 uppercase dark:text-amber-300"
            title={t('landing.editor.responsiveBadgeHint', { device: badge })}
          >
            {badge}
          </span>
        ) : null}
      </span>
      {children}
    </div>
  );
}

const unitSelect = (units: readonly string[], unit: string, disabled: boolean | undefined, onChange: (u: string) => void) =>
  units.length > 1 ? (
    <select
      className="h-8 rounded-md border bg-background px-1 text-xs"
      value={unit}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {units.map((u) => (
        <option key={u} value={u}>
          {u || '—'}
        </option>
      ))}
    </select>
  ) : null;

function SliderField({ def, value, onChange, disabled }: FieldProps) {
  const v = rec(value);
  const units = def.units ?? ['px'];
  const unit = typeof v['unit'] === 'string' ? v['unit'] : (units[0] ?? 'px');
  const size = num(v['size']);
  const set = (patch: Record<string, unknown>) => onChange({ size: v['size'] ?? '', unit, ...patch });
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        aria-label={def.label}
        min={def.min ?? 0}
        max={def.max ?? 100}
        step={def.step ?? 1}
        value={Number(size) || 0}
        disabled={disabled}
        onChange={(e) => set({ size: Number(e.target.value) })}
        className="min-w-0 flex-1 accent-primary"
      />
      <Input
        type="number"
        value={size}
        disabled={disabled}
        className="h-8 w-16 px-1.5"
        onChange={(e) => set({ size: e.target.value === '' ? '' : Number(e.target.value) })}
      />
      {unitSelect(units, unit, disabled, (u) => set({ unit: u }))}
    </div>
  );
}

function DimensionsField({ def, value, onChange, disabled }: FieldProps) {
  const { t } = useI18n();
  const v = rec(value);
  const units = def.units ?? ['px'];
  const unit = typeof v['unit'] === 'string' ? v['unit'] : (units[0] ?? 'px');
  const linked = v['linked'] !== false;
  const sides = ['top', 'right', 'bottom', 'left'] as const;
  const set = (side: string, val: string) => {
    if (linked) onChange({ top: val, right: val, bottom: val, left: val, unit, linked });
    else onChange({ ...v, [side]: val, unit, linked });
  };
  return (
    <div className="flex items-center gap-1">
      {sides.map((s) => (
        <Input
          key={s}
          type="number"
          aria-label={t(`landing.editor.side.${s}`)}
          value={num(v[s])}
          disabled={disabled}
          className="h-8 w-full px-1 text-center"
          placeholder={t(`landing.editor.side.${s}`).charAt(0)}
          onChange={(e) => set(s, e.target.value)}
        />
      ))}
      {unitSelect(units, unit, disabled, (u) => onChange({ ...v, unit: u, linked }))}
      <button
        type="button"
        aria-label={linked ? t('landing.editor.unlinkSides') : t('landing.editor.linkSides')}
        title={linked ? t('landing.editor.unlinkSides') : t('landing.editor.linkSides')}
        disabled={disabled}
        onClick={() => onChange({ ...v, unit, linked: !linked })}
        className="text-muted-foreground hover:text-foreground"
      >
        {linked ? <Link2 className="size-4" /> : <Unlink className="size-4" />}
      </button>
    </div>
  );
}

function UrlField({ value, onChange, disabled, anchors }: FieldProps) {
  const { t } = useI18n();
  const v = rec(value);
  const urlStr = typeof value === 'string' ? value : typeof v['url'] === 'string' ? v['url'] : '';
  const target = v['target'] === '_blank';
  const list = anchors ?? [];
  const selectedAnchor = urlStr.startsWith('#') && list.some((a) => `#${a.id}` === urlStr) ? urlStr : null;
  return (
    <div className="flex flex-col gap-1.5">
      <Input value={urlStr} disabled={disabled} className="h-8 text-xs" placeholder={t('landing.editor.urlPlaceholder')} onChange={(e) => onChange({ ...v, url: e.target.value })} />
      {list.length > 0 ? (
        <Choice
          className="h-8 text-xs"
          value={selectedAnchor}
          noneLabel={t('landing.editor.linkToSection')}
          options={list.map((a) => ({ value: `#${a.id}`, label: a.label }))}
          disabled={disabled}
          onChange={(next) => {
            if (next) onChange({ ...v, url: next, target: '' });
          }}
        />
      ) : null}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={target}
          disabled={disabled}
          onChange={(e) => onChange({ ...v, url: urlStr, target: e.target.checked ? '_blank' : '' })}
        />
        {t('landing.editor.newTab')}
      </label>
    </div>
  );
}

function IconField({ value, onChange, disabled }: FieldProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const cur = typeof value === 'string' ? value : '';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Input value={cur} disabled={disabled} className="h-8 text-xs" placeholder={t('landing.editor.iconName')} onChange={(e) => onChange(e.target.value)} />
        <Button type="button" variant="outline" size="sm" className="h-8" disabled={disabled} onClick={() => setOpen((o) => !o)}>
          {t('landing.editor.choose')}
        </Button>
      </div>
      {open ? (
        <div className="grid max-h-48 grid-cols-6 gap-1 overflow-auto rounded border p-2">
          <button
            type="button"
            title={t('landing.editor.noIcon')}
            aria-label={t('landing.editor.noIcon')}
            className={cn(
              'flex aspect-square items-center justify-center rounded border p-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted',
              cur === 'none' && 'border-primary bg-muted',
            )}
            onClick={() => {
              onChange('none');
              setOpen(false);
            }}
          >
            ∅
          </button>
          {ICON_NAMES.map((n) => (
            <button
              key={n}
              type="button"
              title={n}
              aria-label={n}
              className={cn(
                'flex aspect-square items-center justify-center rounded border p-1.5 hover:bg-muted [&_svg]:size-5',
                cur === n && 'border-primary bg-muted',
              )}
              onClick={() => {
                onChange(n);
                setOpen(false);
              }}
              dangerouslySetInnerHTML={{ __html: iconSvg(n) }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const FONT_WEIGHTS = ['300', '400', '500', '600', '700', '800'];

function TypographyField({ value, onChange, disabled }: FieldProps) {
  const { t } = useI18n();
  const v = rec(value);
  const set = (patch: Record<string, unknown>) => onChange({ ...v, ...patch });
  const size = rec(v['fontSize']);
  const lh = rec(v['lineHeight']);
  return (
    <div className="flex flex-col gap-2 rounded-md border p-2">
      <Row label={t('landing.editor.fontFamily')}>
        <FontPicker value={typeof v['fontFamily'] === 'string' ? v['fontFamily'] : ''} disabled={disabled} onChange={(fontFamily) => set({ fontFamily })} />
        <div className="mt-1 flex flex-wrap gap-1">
          {(
            [
              ['var(--b-font-heading)', 'landing.editor.themeHeadingFont'],
              ['var(--b-font-body)', 'landing.editor.themeBodyFont'],
            ] as const
          ).map(([fontFamily, key]) => (
            <button
              key={fontFamily}
              type="button"
              disabled={disabled}
              className="rounded border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
              onClick={() => set({ fontFamily })}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row label={t('landing.editor.fontSize')}>
          <Input
            type="number"
            className="h-8"
            value={num(size['size'])}
            disabled={disabled}
            onChange={(e) => set({ fontSize: { size: e.target.value === '' ? '' : Number(e.target.value), unit: 'px' } })}
          />
        </Row>
        <Row label={t('landing.editor.fontWeight')}>
          <Choice
            className="h-8"
            value={typeof v['fontWeight'] === 'string' && v['fontWeight'] !== '' ? v['fontWeight'] : null}
            noneLabel={t('landing.editor.auto')}
            options={FONT_WEIGHTS.map((w) => ({ value: w, label: w }))}
            disabled={disabled}
            onChange={(fontWeight) => set({ fontWeight: fontWeight ?? '' })}
          />
        </Row>
        <Row label={t('landing.editor.lineHeight')}>
          <Input
            type="number"
            step="0.1"
            className="h-8"
            value={num(lh['size'])}
            disabled={disabled}
            onChange={(e) => set({ lineHeight: { size: e.target.value === '' ? '' : Number(e.target.value), unit: 'em' } })}
          />
        </Row>
        <Row label={t('landing.editor.textTransform')}>
          <Choice
            className="h-8"
            value={typeof v['textTransform'] === 'string' && v['textTransform'] !== '' ? v['textTransform'] : null}
            noneLabel={t('landing.editor.auto')}
            options={(['none', 'uppercase', 'lowercase', 'capitalize'] as const).map((value) => ({
              value,
              label: t(`landing.editor.transform.${value}`),
            }))}
            disabled={disabled}
            onChange={(textTransform) => set({ textTransform: textTransform ?? '' })}
          />
        </Row>
      </div>
    </div>
  );
}

function BoxShadowField({ def, value, onChange, disabled }: FieldProps) {
  const { t } = useI18n();
  const v = rec(value);
  const set = (patch: Record<string, unknown>) => onChange({ ...v, ...patch });
  const isText = def.cssTemplate === 'text-shadow';
  const parts = isText ? (['x', 'y', 'blur'] as const) : (['x', 'y', 'blur', 'spread'] as const);
  return (
    <div className="flex flex-col gap-2 rounded-md border p-2">
      <div className={isText ? 'grid grid-cols-3 gap-1' : 'grid grid-cols-4 gap-1'}>
        {parts.map((k) => (
          <Row key={k} label={t(`landing.editor.shadow.${k}`)}>
            <Input type="number" value={num(v[k])} disabled={disabled} className="h-8 px-1" onChange={(e) => set({ [k]: e.target.value === '' ? '' : Number(e.target.value) })} />
          </Row>
        ))}
      </div>
      <ColorField value={v['color']} disabled={disabled} onChange={(color) => set({ color })} />
      {!isText ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" className="size-4 accent-primary" checked={!!v['inset']} disabled={disabled} onChange={(e) => set({ inset: e.target.checked })} />
          {t('landing.editor.shadow.inset')}
        </label>
      ) : null}
    </div>
  );
}

function GradientField({ value, onChange, disabled }: FieldProps) {
  const { t } = useI18n();
  const v = rec(value);
  const from = typeof v['from'] === 'string' ? v['from'] : '';
  const to = typeof v['to'] === 'string' ? v['to'] : '';
  const type = v['type'] === 'radial' ? 'radial' : 'linear';
  const angle = typeof v['angle'] === 'number' ? v['angle'] : 180;
  const fromStop = typeof v['fromStop'] === 'number' ? v['fromStop'] : 0;
  const toStop = typeof v['toStop'] === 'number' ? v['toStop'] : 100;
  const set = (patch: Record<string, unknown>) => onChange({ from, to, type, angle, fromStop, toStop, ...patch });

  if (!from || !to) {
    return (
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => set({ from: '#2563eb', to: '#7c3aed' })}>
        {t('landing.editor.gradient.add')}
      </Button>
    );
  }
  const preview =
    type === 'radial'
      ? `radial-gradient(circle, ${from} ${String(fromStop)}%, ${to} ${String(toStop)}%)`
      : `linear-gradient(${String(angle)}deg, ${from} ${String(fromStop)}%, ${to} ${String(toStop)}%)`;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-2">
      <div className="h-8 rounded" style={{ background: preview }} />
      {(
        [
          ['from', 'fromStop', 'landing.editor.gradient.color1', from, fromStop],
          ['to', 'toStop', 'landing.editor.gradient.color2', to, toStop],
        ] as const
      ).map(([colorKey, stopKey, labelKey, colorVal, stopVal]) => (
        <div key={colorKey} className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Row label={t(labelKey)}>
              <ColorField value={colorVal} disabled={disabled} onChange={(c) => set({ [colorKey]: c })} />
            </Row>
          </div>
          <Row label={t('landing.editor.gradient.stop')}>
            <Input
              type="number"
              min={0}
              max={100}
              value={String(stopVal)}
              disabled={disabled}
              className="h-8 w-16 px-1"
              onChange={(e) => set({ [stopKey]: e.target.value === '' ? 0 : Number(e.target.value) })}
            />
          </Row>
        </div>
      ))}
      <div className="grid grid-cols-2 items-end gap-2">
        <Row label={t('landing.editor.gradient.type')}>
          <Choice
            className="h-8 text-xs"
            value={type}
            options={[
              { value: 'linear', label: t('landing.editor.gradient.linear') },
              { value: 'radial', label: t('landing.editor.gradient.radial') },
            ]}
            disabled={disabled}
            onChange={(next) => set({ type: next ?? 'linear' })}
          />
        </Row>
        {type === 'linear' ? (
          <Row label={t('landing.editor.gradient.angle', { angle })}>
            <input
              type="range"
              min={0}
              max={360}
              step={5}
              value={angle}
              disabled={disabled}
              className="accent-primary"
              onChange={(e) => set({ angle: Number(e.target.value) })}
            />
          </Row>
        ) : null}
      </div>
      <Button type="button" variant="ghost" size="sm" className="self-start text-destructive" disabled={disabled} onClick={() => onChange(undefined)}>
        {t('landing.editor.gradient.remove')}
      </Button>
    </div>
  );
}

function RepeaterField(props: FieldProps) {
  const { def, value, onChange, disabled } = props;
  const { t } = useI18n();
  const label = useBuilderLabel();
  const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  const fields = def.fields ?? [];
  const update = (i: number, patch: Record<string, unknown>) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    const [item] = next.splice(i, 1);
    if (item) next.splice(j, 0, item);
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => {
        const titleValue = def.titleField ? row[def.titleField] : undefined;
        return (
          <div key={i} className="rounded-md border p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="truncate text-xs font-medium">
                {typeof titleValue === 'string' && titleValue ? titleValue : `#${String(i + 1)}`}
              </span>
              <div className="flex items-center gap-1">
                <button type="button" aria-label={t('landing.editor.moveUp')} disabled={disabled} onClick={() => move(i, -1)} className="text-muted-foreground hover:text-foreground">
                  <ChevronUp className="size-3.5" />
                </button>
                <button type="button" aria-label={t('landing.editor.moveDown')} disabled={disabled} onClick={() => move(i, 1)} className="text-muted-foreground hover:text-foreground">
                  <ChevronDown className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={t('landing.editor.removeRow')}
                  disabled={disabled}
                  onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                  className="text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              {fields.map((f) => (
                <ControlField key={f.key} {...props} def={f} value={row[f.key]} labelBadge={undefined} onChange={(val) => update(i, { [f.key]: val })} />
              ))}
            </div>
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange([...rows, {}])}>
        <Plus className="size-3.5" /> {t('landing.editor.addRow', { label: label(def.label) })}
      </Button>
    </div>
  );
}

/** Editor UI of one control, by control type. */
export function ControlField(props: FieldProps) {
  const { def, value, onChange, disabled, popups, labelBadge, widgetType } = props;
  const { t } = useI18n();
  const label = useBuilderLabel();
  const str = typeof value === 'string' || typeof value === 'number' ? String(value) : '';

  const body = (() => {
    if (widgetType === 'form' && def.key === 'formId') return <FormPicker value={str} disabled={disabled} onChange={onChange} />;
    if (widgetType === 'booking' && def.key === 'eventSlug') return <EventTypePicker value={str} disabled={disabled} onChange={onChange} />;
    if (widgetType === 'checkout' && def.key === 'checkoutId') return <CheckoutPicker value={str} disabled={disabled} onChange={onChange} />;
    switch (def.type) {
      case 'text':
      case 'number':
        return (
          <Input
            type={def.type === 'number' ? 'number' : 'text'}
            value={str}
            disabled={disabled}
            className="h-8 text-sm"
            placeholder={label(def.placeholder)}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case 'richtext':
        return <RichTextField value={typeof value === 'string' ? value : ''} onChange={onChange} disabled={disabled} />;
      case 'textarea':
      case 'code':
        return (
          <Textarea
            className={cn('min-h-20 text-xs', def.type === 'code' && 'font-mono')}
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            placeholder={label(def.placeholder)}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case 'select':
        return (
          <Choice
            className="h-8 text-sm"
            value={typeof value === 'string' && value !== '' ? value : null}
            noneLabel={label(def.options?.find((o) => o.value === '')?.label) || t('landing.editor.default')}
            options={(def.options ?? []).filter((o) => o.value !== '').map((o) => ({ value: o.value, label: label(o.label) }))}
            disabled={disabled}
            onChange={(next) => onChange(next ?? '')}
          />
        );
      case 'choose':
        return (
          <div className="inline-flex w-fit flex-wrap rounded-md border p-0.5">
            {def.options?.map((o) => {
              const OptIcon = o.icon ? CHOOSE_ICONS[o.icon] : undefined;
              return (
                <button
                  key={o.value}
                  type="button"
                  title={label(o.label)}
                  aria-label={label(o.label)}
                  aria-pressed={value === o.value}
                  disabled={disabled}
                  onClick={() => onChange(value === o.value ? '' : o.value)}
                  className={cn('rounded px-2 py-1 text-xs', value === o.value ? 'bg-muted font-medium' : 'text-muted-foreground')}
                >
                  {OptIcon ? <OptIcon className="size-4" /> : label(o.label)}
                </button>
              );
            })}
          </div>
        );
      case 'switcher':
        return (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              // Untouched value shows the control default (what the renderer applies).
              checked={value === undefined || value === null ? def.default === 'yes' : value === 'yes' || value === true}
              disabled={disabled}
              onChange={(e) => onChange(e.target.checked ? 'yes' : 'no')}
            />
            <span className="text-xs">{label(def.label)}</span>
          </label>
        );
      case 'color':
        return <ColorField value={value} onChange={onChange} disabled={disabled} />;
      case 'slider':
        return <SliderField {...props} />;
      case 'dimensions':
        return <DimensionsField {...props} />;
      case 'media': {
        const url = typeof value === 'string' ? value : typeof rec(value)['url'] === 'string' ? String(rec(value)['url']) : '';
        return <MediaInput value={url} disabled={disabled} onChange={onChange} />;
      }
      case 'url':
        return <UrlField {...props} />;
      case 'icon':
        return <IconField {...props} />;
      case 'typography':
        return <TypographyField {...props} />;
      case 'boxShadow':
        return <BoxShadowField {...props} />;
      case 'gradient':
        return <GradientField {...props} />;
      case 'repeater':
        return <RepeaterField {...props} />;
      case 'popup-select': {
        const list = popups ?? [];
        if (list.length === 0) return <p className="text-[11px] text-muted-foreground italic">{t('landing.editor.noPopups')}</p>;
        return (
          <Choice
            className="h-8 text-sm"
            value={typeof value === 'string' && value !== '' ? value : null}
            noneLabel={t('landing.editor.choosePopup')}
            options={list.map((p) => ({ value: p.id, label: p.name }))}
            disabled={disabled}
            onChange={(next) => onChange(next ?? '')}
          />
        );
      }
      case 'shape':
        // value = the node settings; onChange receives a settings patch.
        return <ShapeDividerControl prefix={def.key} settings={rec(value)} disabled={disabled} onPatch={onChange} />;
      default:
        return null;
    }
  })();

  if (body === null) return null;
  if (def.type === 'switcher') return <div className="flex flex-col gap-1">{body}</div>;
  return (
    <Row label={label(def.label)} badge={labelBadge}>
      {body}
      {def.description ? <span className="text-[11px] leading-snug text-muted-foreground italic">{label(def.description)}</span> : null}
    </Row>
  );
}

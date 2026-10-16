import { COLOR_TOKEN_KEYS, colorVar } from '@amable/builder';
import { Input } from '@amable/ui/ui/input';
import { useI18n } from '../../../i18n';

/** Splits a hex color (#rgb, #rgba, #rrggbb, #rrggbbaa) into a 6-digit base + alpha 0..100. */
function parseHexAlpha(str: string): { base: string; alpha: number } | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(str.trim());
  if (!m || m[1] === undefined) return null;
  let h = m[1];
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const base = `#${h.slice(0, 6).toLowerCase()}`;
  const alpha = h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 100) : 100;
  return { base, alpha };
}

function composeHex(base: string, alpha: number): string {
  const a = Math.max(0, Math.min(100, alpha));
  if (a >= 100) return base;
  return `${base}${Math.round((a / 100) * 255)
    .toString(16)
    .padStart(2, '0')}`;
}

/** Color with opacity slider and the document's color tokens as swatches. */
export function ColorField({ value, onChange, disabled }: { value: unknown; onChange: (value: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const str = typeof value === 'string' ? value : '';
  const parsed = parseHexAlpha(str);
  const hex = parsed?.base ?? '#000000';
  const alpha = parsed?.alpha ?? 100;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={t('landing.editor.pickColor')}
          value={hex}
          disabled={disabled}
          onChange={(e) => onChange(composeHex(e.target.value, parsed ? alpha : 100))}
          className="h-8 w-8 shrink-0 cursor-pointer rounded-md border p-0.5 disabled:opacity-50"
        />
        <Input
          value={str}
          disabled={disabled}
          className="h-8 text-xs"
          placeholder="#… / rgba(…) / var(--b-color-*)"
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {parsed || str === '' ? (
        <div className="flex items-center gap-2">
          <span className="w-14 shrink-0 text-[11px] text-muted-foreground">{t('landing.editor.opacity')}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={alpha}
            disabled={disabled || !parsed}
            aria-label={t('landing.editor.opacity')}
            onChange={(e) => {
              if (parsed) onChange(composeHex(hex, Number(e.target.value)));
            }}
            className="flex-1 accent-primary"
          />
          <span className="w-9 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{parsed ? `${String(alpha)}%` : '—'}</span>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        {COLOR_TOKEN_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            title={t(`landing.tokens.${k}`)}
            aria-label={t(`landing.tokens.${k}`)}
            disabled={disabled}
            onClick={() => onChange(colorVar(k))}
            className="h-5 w-5 rounded border"
            style={{ background: colorVar(k) }}
          />
        ))}
        {str ? (
          <button type="button" className="text-[11px] text-muted-foreground underline" disabled={disabled} onClick={() => onChange('')}>
            {t('landing.editor.reset')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

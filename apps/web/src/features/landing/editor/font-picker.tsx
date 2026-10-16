import { canonicalFontFamily, GOOGLE_FONTS } from '@amable/builder';
import { Input } from '@amable/ui/ui/input';
import { useEffect, useId } from 'react';
import { useI18n } from '../../../i18n';
import { loadGoogleFont } from '../lib/google-fonts';

/**
 * Free-text font family input backed by a datalist of Google Fonts: any
 * Google family works by typing its name; the chosen one is loaded so the
 * input previews it. Theme token values (`var(--b-font-*)`) pass through.
 */
export function FontPicker({
  id,
  value,
  disabled,
  onChange,
}: {
  id?: string;
  value: string | undefined;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const listId = useId();
  useEffect(() => loadGoogleFont(value), [value]);
  return (
    <>
      <Input
        id={id}
        list={listId}
        value={value ?? ''}
        disabled={disabled}
        className="h-8 text-sm"
        placeholder={t('landing.editor.fontPlaceholder')}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          if (!raw || raw.startsWith('var(')) return;
          const canon = canonicalFontFamily(raw);
          if (canon !== raw) onChange(canon);
        }}
        style={value && !value.startsWith('var(') ? { fontFamily: `${value}, sans-serif` } : undefined}
      />
      <datalist id={listId}>
        {GOOGLE_FONTS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </>
  );
}

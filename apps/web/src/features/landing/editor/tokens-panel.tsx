import { COLOR_TOKEN_KEYS, type BuilderTokens } from '@amable/builder';
import { Input } from '@amable/ui/ui/input';
import { useI18n } from '../../../i18n';
import { FormField } from '../components/common';
import { FontPicker } from './font-picker';

/** Document-wide design tokens: colors, fonts, radius, content width. */
export function TokensPanel({
  tokens,
  disabled,
  onChange,
}: {
  tokens: BuilderTokens;
  disabled?: boolean;
  onChange: (patch: Partial<BuilderTokens>) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-3">
      <div>
        <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase">{t('landing.tokens.colors')}</p>
        <div className="grid grid-cols-2 gap-2">
          {COLOR_TOKEN_KEYS.map((key) => {
            const val = String(tokens[key] ?? '');
            const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(val) ? val : '#000000';
            return (
              <FormField key={key} label={<span className="text-xs text-muted-foreground">{t(`landing.tokens.${key}`)}</span>}>
                {(id) => (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="color"
                      aria-label={t(`landing.tokens.${key}`)}
                      value={hex}
                      disabled={disabled}
                      onChange={(e) => onChange({ [key]: e.target.value })}
                      className="h-8 w-8 shrink-0 cursor-pointer rounded border p-0.5"
                    />
                    <Input id={id} value={val} disabled={disabled} className="h-8 text-xs" onChange={(e) => onChange({ [key]: e.target.value })} />
                  </div>
                )}
              </FormField>
            );
          })}
        </div>
      </div>
      <div className="grid gap-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase">{t('landing.tokens.fonts')}</p>
        <FormField label={<span className="text-xs text-muted-foreground">{t('landing.tokens.fontHeading')}</span>}>
          {(id) => <FontPicker id={id} value={tokens.fontHeading} disabled={disabled} onChange={(fontHeading) => onChange({ fontHeading })} />}
        </FormField>
        <FormField label={<span className="text-xs text-muted-foreground">{t('landing.tokens.fontBody')}</span>}>
          {(id) => <FontPicker id={id} value={tokens.fontBody} disabled={disabled} onChange={(fontBody) => onChange({ fontBody })} />}
        </FormField>
      </div>
      <div>
        <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase">{t('landing.tokens.layout')}</p>
        <div className="grid grid-cols-2 gap-2">
          {(['radius', 'radiusLg', 'containerWidth'] as const).map((key) => (
            <FormField
              key={key}
              className={key === 'containerWidth' ? 'col-span-2' : undefined}
              label={<span className="text-xs text-muted-foreground">{t(`landing.tokens.${key}`)}</span>}
            >
              {(id) => <Input id={id} value={tokens[key]} disabled={disabled} className="h-8 text-xs" onChange={(e) => onChange({ [key]: e.target.value })} />}
            </FormField>
          ))}
        </div>
      </div>
    </div>
  );
}

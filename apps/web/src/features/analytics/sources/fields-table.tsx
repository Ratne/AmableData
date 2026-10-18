import { MAX_CUSTOM_TRACKING_FIELDS } from '@amable/api-types';
import { cn } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Switch } from '@amable/ui/ui/switch';
import { Lock, Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../../i18n';
import {
  addField,
  fieldToken,
  isRemovable,
  removeField,
  RESERVED_FIELD_KEYS,
  updateField,
  updateReserved,
  type SourceDraft,
} from './tracking-fields';

const cell = 'px-1.5 py-1 align-top';

function ErrorText({ children }: { children: ReactNode }) {
  return <span className="mt-0.5 block text-[11px] leading-snug text-destructive">{children}</span>;
}

function TextCell({
  value,
  onChange,
  error,
  label,
  placeholder,
  mono,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  label: string;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <>
      <Input
        className={cn('h-7 text-xs', mono && 'font-mono', error && 'border-destructive')}
        value={value}
        aria-label={label}
        aria-invalid={error !== undefined}
        placeholder={placeholder}
        maxLength={200}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
    </>
  );
}

/**
 * Tracking fields of a source: the two locked reserved rows, then the custom
 * slots. Errors are keyed by API path (`fields.0.url_param`, …).
 */
export function TrackingFieldsTable({
  draft,
  onChange,
  errors,
}: {
  draft: SourceDraft;
  onChange: (draft: SourceDraft) => void;
  errors: ReadonlyMap<string, string>;
}) {
  const { t } = useI18n();
  const full = draft.fields.length >= MAX_CUSTOM_TRACKING_FIELDS;
  const head = 'px-1.5 pb-1 text-left text-[11px] font-medium text-muted-foreground';
  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th className={cn(head, 'w-14')}>{t('analytics.sources.fields.slot')}</th>
              <th className={head}>{t('analytics.sources.fields.name')}</th>
              <th className={head}>{t('analytics.sources.fields.urlParam')}</th>
              <th className={head}>{t('analytics.sources.fields.sourceToken')}</th>
              <th className={head}>{t('analytics.sources.fields.token')}</th>
              <th className={cn(head, 'w-16')}>{t('analytics.sources.fields.append')}</th>
              <th className={cn(head, 'w-9')} />
            </tr>
          </thead>
          <tbody>
            {RESERVED_FIELD_KEYS.map((key) => {
              const field = draft.reserved_fields[key];
              const path = `reserved_fields.${key}`;
              return (
                <tr key={key} className="bg-foreground/[0.02]" data-testid={`tracking-field-${key}`}>
                  <td className={cell}>
                    <span
                      className="flex h-7 items-center gap-1 text-muted-foreground"
                      title={t('analytics.sources.fields.locked')}
                    >
                      <Lock className="size-3" aria-hidden />
                      <span className="sr-only">{t('analytics.sources.fields.locked')}</span>
                    </span>
                  </td>
                  <td className={cell}>
                    <span className="flex h-7 items-center font-medium">
                      {t(`analytics.sources.fields.reserved.${key}`)}
                    </span>
                  </td>
                  <td className={cell}>
                    <TextCell
                      mono
                      label={t('analytics.sources.fields.urlParam')}
                      value={field.url_param}
                      error={errors.get(`${path}.url_param`)}
                      onChange={(url_param) => onChange(updateReserved(draft, key, { url_param }))}
                    />
                  </td>
                  <td className={cell}>
                    <TextCell
                      mono
                      label={t('analytics.sources.fields.sourceToken')}
                      value={field.source_token}
                      placeholder={t('analytics.sources.fields.sourceTokenEmpty')}
                      error={errors.get(`${path}.source_token`)}
                      onChange={(source_token) =>
                        onChange(updateReserved(draft, key, { source_token }))
                      }
                    />
                  </td>
                  <td className={cell}>
                    <code className="flex h-7 items-center font-mono text-[11px] text-muted-foreground">
                      {fieldToken(key)}
                    </code>
                  </td>
                  <td className={cell}>
                    <span className="flex h-7 items-center">
                      <Switch
                        aria-label={t('analytics.sources.fields.append')}
                        checked={field.append}
                        onCheckedChange={(append) => onChange(updateReserved(draft, key, { append }))}
                      />
                    </span>
                  </td>
                  <td className={cell} />
                </tr>
              );
            })}
            {draft.fields.map((field, i) => {
              const path = `fields.${String(i)}`;
              const set = (patch: Parameters<typeof updateField>[2]) =>
                onChange({ ...draft, fields: updateField(draft.fields, field.slot, patch) });
              return (
                <tr key={field.slot} data-testid={`tracking-field-${field.slot}`}>
                  <td className={cell}>
                    <code className="flex h-7 items-center font-mono text-[11px] text-muted-foreground">
                      {field.slot}
                    </code>
                  </td>
                  <td className={cell}>
                    <TextCell
                      label={t('analytics.sources.fields.name')}
                      value={field.name}
                      error={errors.get(`${path}.name`)}
                      onChange={(name) => set({ name })}
                    />
                    {field.previous_name && field.previous_name !== field.name ? (
                      <span className="mt-0.5 block text-[10px] text-muted-foreground">
                        {t('analytics.sources.fields.previousName', { name: field.previous_name })}
                      </span>
                    ) : null}
                  </td>
                  <td className={cell}>
                    <TextCell
                      mono
                      label={t('analytics.sources.fields.urlParam')}
                      value={field.url_param}
                      error={errors.get(`${path}.url_param`)}
                      onChange={(url_param) => set({ url_param })}
                    />
                  </td>
                  <td className={cell}>
                    <TextCell
                      mono
                      label={t('analytics.sources.fields.sourceToken')}
                      value={field.source_token}
                      placeholder={t('analytics.sources.fields.sourceTokenEmpty')}
                      error={errors.get(`${path}.source_token`)}
                      onChange={(source_token) => set({ source_token })}
                    />
                  </td>
                  <td className={cell}>
                    <code className="flex h-7 items-center truncate font-mono text-[11px] text-muted-foreground">
                      {fieldToken(field)}
                    </code>
                  </td>
                  <td className={cell}>
                    <span className="flex h-7 items-center">
                      <Switch
                        aria-label={t('analytics.sources.fields.append')}
                        checked={field.append}
                        onCheckedChange={(append) => set({ append })}
                      />
                    </span>
                  </td>
                  <td className={cell}>
                    {isRemovable(field.slot) ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={t('analytics.sources.fields.remove')}
                        onClick={() =>
                          onChange({ ...draft, fields: removeField(draft.fields, field.slot) })
                        }
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {errors.get('fields') ? <ErrorText>{errors.get('fields')}</ErrorText> : null}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={full}
          onClick={() => onChange({ ...draft, fields: addField(draft.fields) })}
        >
          <Plus className="size-3.5" aria-hidden />
          {t('analytics.sources.fields.add')}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {t('analytics.sources.fields.count', {
            count: draft.fields.length,
            max: MAX_CUSTOM_TRACKING_FIELDS,
          })}
        </span>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">
        {t('analytics.sources.fields.hint')}
      </p>
    </div>
  );
}

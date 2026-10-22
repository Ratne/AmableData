import { renderTemplateText } from '@amable/api-types';
import { Input } from '@amable/ui/ui/input';
import { useI18n } from '../../i18n';
import { ChoiceSelect } from '../crm/components/inputs';
import { useChannelTemplateList, type ConversationChannel, type MessageTemplateRef } from './api';

export interface TemplateDraft {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
}

/** The template to send and the text shown in the thread, or null while parameters are missing. */
export function templateMessage(
  templates: readonly { id: string; text: string; params: ReadonlyArray<{ key: string }> }[] | undefined,
  draft: TemplateDraft,
): { template: MessageTemplateRef; text: string } | null {
  const template = templates?.find((tpl) => tpl.id === draft.id);
  if (template === undefined) return null;
  if (template.params.some((p) => (draft.params[p.key] ?? '').trim() === '')) return null;
  const params = Object.fromEntries(template.params.map((p) => [p.key, draft.params[p.key]!.trim()]));
  return { template: { id: template.id, params }, text: renderTemplateText(template.text, params) };
}

/** Approved template of a channel, its parameters and a preview of what the contact receives. */
export function TemplatePicker({
  channel,
  draft,
  onChange,
  disabled = false,
}: {
  channel: ConversationChannel;
  draft: TemplateDraft;
  onChange: (draft: TemplateDraft) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const templates = useChannelTemplateList(channel);
  const list = templates.data?.templates ?? [];
  const selected = list.find((tpl) => tpl.id === draft.id);

  if (templates.isPending) return <p className="text-xs text-muted-foreground">{t('common.loading')}</p>;
  if (templates.isError) return <p className="text-xs text-destructive">{t('conversations.templates.unavailable')}</p>;
  if (list.length === 0) {
    return <p className="text-xs text-muted-foreground">{templates.data?.notice ?? t('conversations.templates.none')}</p>;
  }
  return (
    <div className="grid gap-2">
      <ChoiceSelect
        value={draft.id}
        allowEmpty={false}
        placeholder={t('conversations.templates.pick')}
        ariaLabel={t('conversations.templates.label')}
        disabled={disabled}
        className="w-full"
        choices={list.map((tpl) => ({
          value: tpl.id,
          label: [tpl.name, tpl.language, tpl.category?.toLowerCase()].filter(Boolean).join(' · '),
        }))}
        onChange={(id) => onChange({ id, params: {} })}
      />
      {selected !== undefined ? (
        <>
          {selected.params.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {selected.params.map((param) => (
                <Input
                  key={param.key}
                  className="h-8"
                  disabled={disabled}
                  maxLength={1000}
                  aria-label={param.key}
                  placeholder={param.example === null ? param.key : `${param.key} · ${param.example}`}
                  value={draft.params[param.key] ?? ''}
                  onChange={(event) => onChange({ id: draft.id, params: { ...draft.params, [param.key]: event.target.value } })}
                />
              ))}
            </div>
          ) : null}
          <div className="rounded-lg bg-(--obsidian-dashboard-shell-hover) px-3 py-2 text-sm whitespace-pre-wrap" aria-label={t('conversations.templates.preview')}>
            {renderTemplateText(selected.text, draft.params)}
          </div>
        </>
      ) : null}
    </div>
  );
}

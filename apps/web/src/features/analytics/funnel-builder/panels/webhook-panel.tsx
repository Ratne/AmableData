import type { FunnelNodeOf } from '@amable/api-types';
import { Input } from '@amable/ui/ui/input';
import { Textarea } from '@amable/ui/ui/textarea';
import { useI18n } from '../../../../i18n';
import { Segmented } from '../../components/ui';
import { Field, KeyValueEditor } from './form-bits';

type Node = FunnelNodeOf<'webhook'>;

export function WebhookPanel({ node, onChange }: { node: Node; onChange: (node: Node) => void }) {
  const { t } = useI18n();
  const config = node.config;
  const set = (next: Node['config']) => onChange({ ...node, config: next });
  return (
    <>
      <Field label={t('analytics.funnelBuilder.panel.method')}>
        <Segmented
          label={t('analytics.funnelBuilder.panel.method')}
          options={[
            { value: 'POST', label: 'POST' },
            { value: 'GET', label: 'GET' },
          ]}
          value={config.method}
          onChange={(method) => set({ ...config, method })}
        />
      </Field>
      <Field label={t('analytics.funnelBuilder.panel.url')}>
        <Input
          className="h-8"
          placeholder="https://"
          value={config.url}
          onChange={(e) => set({ ...config, url: e.target.value })}
        />
      </Field>
      <Field label={t('analytics.funnelBuilder.panel.headers')}>
        <KeyValueEditor
          value={config.headers}
          addLabel={t('analytics.funnelBuilder.panel.addHeader')}
          onChange={(headers) => {
            const { headers: _drop, ...rest } = config;
            set(headers ? { ...rest, headers } : rest);
          }}
        />
      </Field>
      {config.method === 'POST' ? (
        <Field
          label={t('analytics.funnelBuilder.panel.body')}
          hint={t('analytics.funnelBuilder.panel.bodyHint')}
        >
          <Textarea
            className="min-h-24 font-mono text-xs"
            value={config.body ?? ''}
            onChange={(e) => {
              const { body: _drop, ...rest } = config;
              set(e.target.value ? { ...rest, body: e.target.value } : rest);
            }}
          />
        </Field>
      ) : null}
    </>
  );
}

import type { FunnelNodeOf } from '@amable/api-types';
import { Input } from '@amable/ui/ui/input';
import { useI18n } from '../../../../i18n';
import { Field, KeyValueEditor, SwitchRow } from './form-bits';

type Node = FunnelNodeOf<'external_url'>;

export function ExternalUrlPanel({
  node,
  onChange,
}: {
  node: Node;
  onChange: (node: Node) => void;
}) {
  const { t } = useI18n();
  const config = node.config;
  return (
    <>
      <Field label={t('analytics.funnelBuilder.panel.url')}>
        <Input
          className="h-8"
          placeholder="https://"
          value={config.url}
          onChange={(e) => onChange({ ...node, config: { ...config, url: e.target.value } })}
        />
      </Field>
      <SwitchRow
        label={t('analytics.funnelBuilder.panel.appendData')}
        checked={config.append_data}
        onChange={(append_data) => onChange({ ...node, config: { ...config, append_data } })}
      />
      <Field label={t('analytics.funnelBuilder.panel.dataParams')}>
        <KeyValueEditor
          value={config.data_params}
          addLabel={t('analytics.funnelBuilder.panel.addParam')}
          onChange={(data_params) => {
            const { data_params: _drop, ...rest } = config;
            onChange({ ...node, config: data_params ? { ...rest, data_params } : rest });
          }}
        />
      </Field>
    </>
  );
}

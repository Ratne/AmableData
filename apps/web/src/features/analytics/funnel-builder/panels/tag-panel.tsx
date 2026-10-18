import type { FunnelNodeOf } from '@amable/api-types';
import { useI18n } from '../../../../i18n';
import { Field, ListInput } from './form-bits';

type Node = FunnelNodeOf<'tag'>;

export function TagPanel({ node, onChange }: { node: Node; onChange: (node: Node) => void }) {
  const { t } = useI18n();
  const hint = t('analytics.funnelBuilder.panel.commaHint');
  return (
    <>
      <Field label={t('analytics.funnelBuilder.panel.tagsAdd')} hint={hint}>
        <ListInput
          value={node.config.add}
          onChange={(add) => onChange({ ...node, config: { ...node.config, add } })}
        />
      </Field>
      <Field label={t('analytics.funnelBuilder.panel.tagsRemove')} hint={hint}>
        <ListInput
          value={node.config.remove}
          onChange={(remove) => onChange({ ...node, config: { ...node.config, remove } })}
        />
      </Field>
    </>
  );
}

import type { FunnelNodeOf } from '@amable/api-types';
import { useMemo } from 'react';
import { useI18n } from '../../../../i18n';
import { useConditionValues } from '../../api-funnels';
import { useBuilderResources } from '../resources';
import { Field } from './form-bits';
import { ValueSelect } from './value-select';

type Node = FunnelNodeOf<'tag'>;

/** At most 20 tags per list (`tag` node schema). */
const MAX_TAGS = 20;

export function TagPanel({
  node,
  draftTags,
  onChange,
}: {
  node: Node;
  /** Tags of the draft's tag nodes, offered before they reach the backend. */
  draftTags: readonly string[];
  onChange: (node: Node) => void;
}) {
  const { t } = useI18n();
  const { tenant, siteId } = useBuilderResources();
  const known = useConditionValues(tenant, siteId, 'tag');
  const options = useMemo(
    () =>
      [...new Set([...draftTags, ...(known.data ?? [])])]
        .sort((a, b) => a.localeCompare(b))
        .map((tag) => ({ value: tag, label: tag })),
    [draftTags, known.data],
  );
  const hint = t('analytics.funnelBuilder.panel.tagsHint');
  const picker = (key: 'add' | 'remove', label: string) => (
    <Field label={label} hint={hint}>
      <ValueSelect
        ariaLabel={label}
        value={node.config[key]}
        onChange={(tags) => onChange({ ...node, config: { ...node.config, [key]: tags } })}
        options={options}
        loading={known.isPending && options.length === 0}
        placeholder={t('analytics.funnelBuilder.panel.tagsPick')}
        max={MAX_TAGS}
        maxLength={64}
        custom
      />
    </Field>
  );
  return (
    <>
      {picker('add', t('analytics.funnelBuilder.panel.tagsAdd'))}
      {picker('remove', t('analytics.funnelBuilder.panel.tagsRemove'))}
    </>
  );
}

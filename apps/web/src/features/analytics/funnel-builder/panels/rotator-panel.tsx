import {
  ROTATOR_STICKINESS,
  type FunnelGraph,
  type FunnelNodeOf,
  type RotatorStickiness,
} from '@amable/api-types';
import { useI18n } from '../../../../i18n';
import { liveEdges, weightShare, type BuilderAction } from '../state';
import { Field, NumberInput, selectClass } from './form-bits';

/** Weights of the weighted exits of a traffic or rotator node. */
export function WeightList({
  graph,
  nodeId,
  dispatch,
}: {
  graph: FunnelGraph;
  nodeId: string;
  dispatch: (action: BuilderAction) => void;
}) {
  const { t, locale } = useI18n();
  const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const exits = liveEdges(graph).filter((e) => e.from === nodeId && e.via.type === 'weight');
  const labelOf = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    return n?.label || (n ? t(`analytics.funnelBuilder.kind.${n.kind}`) : id);
  };
  return (
    <Field label={t('analytics.funnelBuilder.panel.weights')}>
      {exits.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('analytics.funnelBuilder.panel.noWeights')}
        </p>
      ) : (
        <ul className="grid gap-1.5">
          {exits.map((edge) => (
            <li key={edge.id} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">{labelOf(edge.to)}</span>
              <span className="w-12 text-right text-muted-foreground tabular-nums">
                {pct.format(weightShare(graph, edge))}
              </span>
              <NumberInput
                className="w-20"
                ariaLabel={t('analytics.funnelBuilder.panel.weight')}
                value={edge.via.type === 'weight' ? edge.via.weight : 0}
                min={0.01}
                max={10_000}
                onChange={(weight) =>
                  dispatch({ type: 'update_edge', id: edge.id, via: { type: 'weight', weight } })
                }
              />
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}

export function RotatorPanel({
  node,
  onChange,
  graph,
  dispatch,
}: {
  node: FunnelNodeOf<'rotator'>;
  onChange: (node: FunnelNodeOf<'rotator'>) => void;
  graph: FunnelGraph;
  dispatch: (action: BuilderAction) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t('analytics.funnelBuilder.panel.stickiness')}>
        <select
          className={selectClass}
          value={node.config.stickiness}
          onChange={(e) =>
            onChange({
              ...node,
              config: { ...node.config, stickiness: e.target.value as RotatorStickiness },
            })
          }
        >
          {ROTATOR_STICKINESS.map((s) => (
            <option key={s} value={s}>
              {t(`analytics.funnelBuilder.panel.stickiness.${s}`)}
            </option>
          ))}
        </select>
      </Field>
      <WeightList graph={graph} nodeId={node.id} dispatch={dispatch} />
    </>
  );
}

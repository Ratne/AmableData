import type { FunnelEdge, FunnelEdgeVia, FunnelGraph } from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Trash2 } from 'lucide-react';
import { useI18n } from '../../../../i18n';
import { ALLOWED_VIA, type BuilderAction } from '../state';
import { Field, ListInput, NumberInput, selectClass } from './form-bits';

/** Weight / route / action numbers / default of one connection. */
export function EdgePanel({
  graph,
  edge,
  dispatch,
  issues,
}: {
  graph: FunnelGraph;
  edge: FunnelEdge;
  dispatch: (action: BuilderAction) => void;
  issues: readonly string[];
}) {
  const { t } = useI18n();
  const from = graph.nodes.find((n) => n.id === edge.from);
  const to = graph.nodes.find((n) => n.id === edge.to);
  const name = (n: typeof from) =>
    n ? n.label || t(`analytics.funnelBuilder.kind.${n.kind}`) : '—';
  const allowed = from ? ALLOWED_VIA[from.kind] : [];
  const routes = from?.kind === 'condition' ? from.config.routes : [];
  const update = (via: FunnelEdgeVia) => dispatch({ type: 'update_edge', id: edge.id, via });

  const switchType = (type: FunnelEdgeVia['type']) => {
    switch (type) {
      case 'weight':
        return update({ type, weight: 100 });
      case 'route':
        return routes[0] ? update({ type, route_id: routes[0].id }) : undefined;
      case 'action':
        return update({ type, actions: [1] });
      case 'default':
        return update({ type });
    }
  };

  return (
    <div className="grid gap-4">
      {issues.length > 0 ? (
        <ul className="grid gap-1 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          {issues.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t('analytics.funnelBuilder.panel.from')}</dt>
        <dd className="truncate">{name(from)}</dd>
        <dt className="text-muted-foreground">{t('analytics.funnelBuilder.panel.to')}</dt>
        <dd className="truncate">{name(to)}</dd>
      </dl>
      <Field label={t('analytics.funnelBuilder.panel.via')}>
        <select
          className={selectClass}
          value={edge.via.type}
          onChange={(e) => switchType(e.target.value as FunnelEdgeVia['type'])}
        >
          {allowed.map((type) => (
            <option key={type} value={type} disabled={type === 'route' && routes.length === 0}>
              {t(`analytics.funnelBuilder.panel.via.${type}`)}
            </option>
          ))}
        </select>
      </Field>
      {edge.via.type === 'weight' ? (
        <Field label={t('analytics.funnelBuilder.panel.weight')}>
          <NumberInput
            value={edge.via.weight}
            min={0.01}
            max={10_000}
            onChange={(weight) => update({ type: 'weight', weight })}
          />
        </Field>
      ) : null}
      {edge.via.type === 'route' ? (
        <Field label={t('analytics.funnelBuilder.panel.via.route')}>
          <select
            className={selectClass}
            value={edge.via.route_id}
            onChange={(e) => update({ type: 'route', route_id: e.target.value })}
          >
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {edge.via.type === 'action' ? (
        <Field label={t('analytics.funnelBuilder.panel.actions')}>
          <ListInput
            value={edge.via.actions.map(String)}
            onChange={(values) => {
              const actions = [...new Set(values.map(Number))].filter(
                (n) => Number.isInteger(n) && n >= 1 && n <= 255,
              );
              if (actions.length > 0) update({ type: 'action', actions });
            }}
          />
        </Field>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        className="h-8 justify-self-start text-destructive"
        onClick={() => dispatch({ type: 'remove_edge', id: edge.id })}
      >
        <Trash2 className="size-3.5" aria-hidden />
        {t('analytics.funnelBuilder.panel.removeEdge')}
      </Button>
    </div>
  );
}

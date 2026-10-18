import type { FunnelGraph, FunnelNode } from '@amable/api-types';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Link2, Trash2 } from 'lucide-react';
import { useI18n } from '../../../../i18n';
import type { BuilderAction } from '../state';
import { ConditionPanel } from './condition-panel';
import { ExternalUrlPanel } from './external-url-panel';
import { Field } from './form-bits';
import { PageGroupPanel } from './page-group-panel';
import { RotatorPanel } from './rotator-panel';
import { TagPanel } from './tag-panel';
import { WebhookPanel } from './webhook-panel';

/** Side panel of the selected node: label, kind-specific form and soft-delete. */
export function NodePanel({
  graph,
  node,
  dispatch,
  issues,
  onLinks,
}: {
  graph: FunnelGraph;
  node: FunnelNode;
  dispatch: (action: BuilderAction) => void;
  issues: readonly string[];
  /** Opens the link builder on this node. */
  onLinks?: () => void;
}) {
  const { t } = useI18n();
  const onChange = (next: FunnelNode) => dispatch({ type: 'update_node', node: next });

  const body = () => {
    switch (node.kind) {
      case 'traffic':
        return (
          <p className="text-xs text-muted-foreground">
            {t('analytics.funnelBuilder.panel.trafficEntryInfo')}
          </p>
        );
      case 'rotator':
        return <RotatorPanel node={node} onChange={onChange} graph={graph} dispatch={dispatch} />;
      case 'page_group':
        return <PageGroupPanel node={node} onChange={onChange} />;
      case 'condition':
        return <ConditionPanel node={node} onChange={onChange} />;
      case 'external_url':
        return <ExternalUrlPanel node={node} onChange={onChange} />;
      case 'action_proxy':
        return (
          <p className="text-xs text-muted-foreground">
            {t('analytics.funnelBuilder.panel.proxyInfo')}
          </p>
        );
      case 'tag':
        return <TagPanel node={node} onChange={onChange} />;
      case 'webhook':
        return <WebhookPanel node={node} onChange={onChange} />;
    }
  };

  return (
    <div className="grid gap-4">
      {issues.length > 0 ? (
        <ul
          className="grid gap-1 rounded-md bg-destructive/10 p-2 text-xs text-destructive"
          data-testid="funnel-node-issues"
        >
          {issues.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      ) : null}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
        <Field label={t('analytics.funnelBuilder.panel.label')}>
          <Input
            className="h-8"
            value={node.label ?? ''}
            maxLength={100}
            onChange={(e) => {
              const { label: _drop, ...rest } = node;
              onChange((e.target.value ? { ...rest, label: e.target.value } : rest) as FunnelNode);
            }}
          />
        </Field>
        <Field label={t('analytics.funnelBuilder.panel.id')}>
          <code className="flex h-8 items-center rounded-md bg-foreground/[0.05] px-2 text-xs">
            {node.id}
          </code>
        </Field>
      </div>
      {body()}
      {onLinks && (node.kind === 'traffic' || node.kind === 'page_group') ? (
        <Button variant="outline" size="sm" className="h-8 justify-self-start" onClick={onLinks}>
          <Link2 className="size-3.5" aria-hidden />
          {t('analytics.funnelBuilder.links.open')}
        </Button>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        className="h-8 justify-self-start text-destructive"
        onClick={() => dispatch({ type: 'delete_node', id: node.id, at: Date.now() })}
      >
        <Trash2 className="size-3.5" aria-hidden />
        {t('analytics.funnelBuilder.panel.delete')}
      </Button>
    </div>
  );
}

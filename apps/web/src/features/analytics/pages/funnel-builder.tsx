import type { HeatmapMetric } from '@amable/api-types';
import {
  cn,
  DashboardButton,
  DashboardPopover,
  DashboardPopoverContent,
  DashboardPopoverTrigger,
  toast,
  usePageChrome,
} from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ArchiveRestore,
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  Route as RouteIcon,
  Save,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useI18n } from '../../../i18n';
import { FunnelCanvas, type BuilderSelection } from '../funnel-builder/canvas';
import { HeatmapControls, heatCells } from '../funnel-builder/heatmap';
import { mockFunnelGraph, mockHeatmap, resourcePage } from '../funnel-builder/mock';
import { KIND_META } from '../funnel-builder/nodes/kind-meta';
import { FunnelPalette, type PaletteItem } from '../funnel-builder/palette';
import { EdgePanel } from '../funnel-builder/panels/edge-panel';
import { NodePanel } from '../funnel-builder/panels/node-panel';
import {
  builderReducer,
  createNode,
  deletedNodes,
  draftIssues,
  initBuilder,
  isDirty,
  issuesByTarget,
  liveNodes,
  toGraph,
  tracePath,
  type BuilderIssue,
  type Position,
} from '../funnel-builder/state';
import { analyticsFunnelBuilderRoute, type FunnelBuilderSearch } from '../routes';

function Builder({ tenant, funnelId }: { tenant: string; funnelId: string }) {
  const { t, locale } = useI18n();
  const search = useSearch({ from: analyticsFunnelBuilderRoute.id });
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(builderReducer, funnelId, (id) =>
    initBuilder(mockFunnelGraph(id)),
  );
  const [selection, setSelection] = useState<BuilderSelection>(null);
  const draft = state.draft;
  const metric = search.heatmap ?? null;
  const tracing = search.trace === '1';

  const setSearch = (patch: Partial<FunnelBuilderSearch>) =>
    void navigate({
      to: '/t/$tenant/analytics/funnels/$funnelId/builder',
      params: { tenant, funnelId },
      search: (previous: FunnelBuilderSearch) => ({ ...previous, ...patch }),
      replace: true,
    });

  const issues = useMemo(() => draftIssues(state), [state]);
  const dirty = isDirty(state);
  const saveable = dirty && issues.length === 0;
  const message = useCallback(
    (issue: BuilderIssue) => t(`analytics.funnelBuilder.error.${issue.code}`),
    [t],
  );
  const grouped = useMemo(() => {
    const { nodes, edges, graph } = issuesByTarget(issues);
    const texts = (map: Map<string, BuilderIssue[]>) =>
      new Map([...map].map(([id, list]) => [id, [...new Set(list.map(message))]]));
    return { nodes: texts(nodes), edges: texts(edges), graph: [...new Set(graph.map(message))] };
  }, [issues, message]);

  const heat = useMemo(
    () => (metric ? heatCells(mockHeatmap(draft, metric), locale) : null),
    [draft, metric, locale],
  );
  const trace = useMemo(
    () => (tracing && selection?.kind === 'node' ? tracePath(draft, selection.id) : null),
    [draft, selection, tracing],
  );

  const add = useCallback(
    (item: PaletteItem, at?: Position) => {
      const live = liveNodes(draft);
      const position = at ?? {
        x: Math.max(0, ...live.map((n) => n.position.x)) + 300,
        y: live.find((n) => selection?.kind === 'node' && n.id === selection.id)?.position.y ?? 0,
      };
      const node = createNode(
        item.kind,
        position,
        draft.nodes.map((n) => n.id),
        'resource' in item ? [resourcePage(item.resource, 'p1')] : [],
      );
      if (node.kind === 'page_group' && 'resource' in item) {
        node.label = item.resource.name;
        node.config.page_type = item.resource.type;
      }
      dispatch({ type: 'add_node', node });
      setSelection({ kind: 'node', id: node.id });
    },
    [draft, selection],
  );

  const save = () => {
    if (!saveable) return;
    const graph = toGraph(state);
    dispatch({
      type: 'saved',
      graph: { ...graph, version: state.saved.version + 1, updated_at: Date.now() },
    });
    toast.success(t('analytics.funnelBuilder.saved'));
  };
  const discard = () => {
    dispatch({ type: 'discard' });
    setSelection(null);
    toast(t('analytics.funnelBuilder.discarded'), {
      action: {
        label: t('analytics.funnelBuilder.undo'),
        onClick: () => dispatch({ type: 'undo_discard' }),
      },
    });
  };

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  const selectedNode =
    selection?.kind === 'node' ? liveNodes(draft).find((n) => n.id === selection.id) : undefined;
  const selectedEdge =
    selection?.kind === 'edge' ? draft.edges.find((e) => e.id === selection.id) : undefined;
  const removed = deletedNodes(draft);
  const kindLabel = (kind: keyof typeof KIND_META) => t(`analytics.funnelBuilder.kind.${kind}`);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="funnel-builder">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <Button asChild variant="ghost" size="sm" className="h-8 px-2">
          <Link
            to="/t/$tenant/analytics/funnels"
            params={{ tenant }}
            aria-label={t('analytics.funnelBuilder.back')}
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Link>
        </Button>
        <Input
          className="h-8 w-56"
          aria-label={t('analytics.funnelBuilder.name')}
          value={draft.name}
          maxLength={200}
          onChange={(e) => dispatch({ type: 'rename', name: e.target.value })}
        />
        <span
          className={cn(
            'flex items-center gap-1 text-xs',
            dirty ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
          )}
          data-testid="funnel-builder-status"
        >
          {dirty ? t('analytics.funnelBuilder.unsaved') : t('analytics.funnelBuilder.upToDate')}
        </span>
        <span
          className={cn(
            'flex items-center gap-1 text-xs',
            issues.length > 0 ? 'text-destructive' : 'text-muted-foreground',
          )}
          title={issues.map(message).join('\n') || undefined}
        >
          {issues.length > 0 ? (
            <CircleAlert className="size-3.5" aria-hidden />
          ) : (
            <CircleCheck className="size-3.5" aria-hidden />
          )}
          {issues.length > 0
            ? t('analytics.funnelBuilder.issues', { count: issues.length })
            : t('analytics.funnelBuilder.noIssues')}
        </span>
        <span className="flex-1" />
        <HeatmapControls
          metric={metric}
          onChange={(m: HeatmapMetric | null) => setSearch({ heatmap: m ?? undefined })}
        />
        <DashboardButton
          variant={tracing ? 'primary' : 'ghost'}
          size="sm"
          aria-pressed={tracing}
          title={t('analytics.funnelBuilder.pathTraceHint')}
          onClick={() => setSearch({ trace: tracing ? undefined : '1' })}
        >
          <RouteIcon aria-hidden />
          {t('analytics.funnelBuilder.pathTrace')}
        </DashboardButton>
        <DashboardPopover>
          <DashboardPopoverTrigger asChild>
            <DashboardButton variant="ghost" size="sm" disabled={removed.length === 0}>
              <ArchiveRestore aria-hidden />
              {t('analytics.funnelBuilder.deleted', { count: removed.length })}
            </DashboardButton>
          </DashboardPopoverTrigger>
          <DashboardPopoverContent align="end" className="w-64 p-2">
            {removed.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">
                {t('analytics.funnelBuilder.deletedEmpty')}
              </p>
            ) : (
              <ul className="grid gap-0.5">
                {removed.map((n) => (
                  <li key={n.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs">
                    <span className="min-w-0 flex-1 truncate">
                      {n.label || kindLabel(n.kind)}
                      <span className="ml-1 text-muted-foreground">{n.id}</span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => dispatch({ type: 'restore_node', id: n.id })}
                    >
                      {t('analytics.funnelBuilder.restore')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </DashboardPopoverContent>
        </DashboardPopover>
        <DashboardButton variant="ghost" size="sm" disabled={!dirty} onClick={discard}>
          <Undo2 aria-hidden />
          {t('analytics.funnelBuilder.discard')}
        </DashboardButton>
        <DashboardButton
          variant="primary"
          size="sm"
          disabled={!saveable}
          onClick={save}
          data-testid="funnel-builder-save"
        >
          <Save aria-hidden />
          {t('analytics.funnelBuilder.save')}
        </DashboardButton>
      </div>
      <p className="shrink-0 border-b bg-muted/30 px-4 py-1 text-[11px] text-muted-foreground">
        {t('analytics.funnelBuilder.mockNotice')}
      </p>

      <div className="flex min-h-0 flex-1">
        <FunnelPalette
          hasTraffic={liveNodes(draft).some((n) => n.kind === 'traffic')}
          onAdd={(item) => add(item)}
        />
        <div className="relative flex min-w-0 flex-1">
          <FunnelCanvas
            graph={draft}
            dispatch={dispatch}
            selection={selection}
            onSelect={setSelection}
            onAdd={add}
            nodeIssues={grouped.nodes}
            edgeIssues={grouped.edges}
            heat={heat}
            trace={trace}
          />
          {grouped.graph.length > 0 ? (
            <ul className="absolute bottom-3 left-1/2 grid w-[min(28rem,90%)] -translate-x-1/2 gap-1 rounded-lg bg-background/95 p-2 text-xs text-destructive shadow">
              {grouped.graph.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}
        </div>
        {selectedNode || selectedEdge ? (
          <aside
            className="flex w-[24rem] shrink-0 flex-col border-l bg-background"
            data-testid="funnel-side-panel"
          >
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
                {selectedNode
                  ? selectedNode.label || kindLabel(selectedNode.kind)
                  : t('analytics.funnelBuilder.panel.edgeTitle')}
              </h2>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t('analytics.funnelBuilder.panel.close')}
                onClick={() => setSelection(null)}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-3">
              {selectedNode ? (
                <NodePanel
                  key={selectedNode.id}
                  graph={draft}
                  node={selectedNode}
                  dispatch={dispatch}
                  issues={grouped.nodes.get(selectedNode.id) ?? []}
                />
              ) : selectedEdge ? (
                <EdgePanel
                  key={selectedEdge.id}
                  graph={draft}
                  edge={selectedEdge}
                  dispatch={dispatch}
                  issues={grouped.edges.get(selectedEdge.id) ?? []}
                />
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** `/t/$tenant/analytics/funnels/$funnelId/builder` — visual funnel builder (sample data). */
export function AnalyticsFunnelBuilderPage() {
  const { t } = useI18n();
  const { tenant, funnelId } = useParams({ from: analyticsFunnelBuilderRoute.id });
  usePageChrome({ title: t('analytics.funnelBuilder.title') });
  return (
    <ReactFlowProvider>
      <Builder key={funnelId} tenant={tenant} funnelId={funnelId} />
    </ReactFlowProvider>
  );
}

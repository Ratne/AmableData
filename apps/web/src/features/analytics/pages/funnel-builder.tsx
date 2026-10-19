import type {
  FunnelGraph,
  FunnelGraphUpdate,
  HeatmapMetric,
  Site,
  TrafficSource,
} from '@amable/api-types';
import {
  cn,
  DashboardButton,
  DashboardFilterMenu,
  DashboardPopover,
  DashboardPopoverContent,
  DashboardPopoverTrigger,
  toast,
  usePageChrome,
} from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Input } from '@amable/ui/ui/input';
import { Skeleton } from '@amable/ui/ui/skeleton';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ReactFlowProvider } from '@xyflow/react';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  GitMerge,
  Link2,
  Route as RouteIcon,
  Save,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useI18n } from '../../../i18n';
import { analyticsErrorMessage } from '../api';
import {
  ApiBodyError,
  funnelKeys,
  funnelsApi,
  useAmablePages,
  useFunnelGraph,
  useFunnelHeatmap,
  useTrafficSources,
} from '../api-funnels';
import { RangeControls } from '../components/controls';
import { EmptyNote, ErrorState } from '../components/ui';
import { FunnelCanvas, type BuilderSelection } from '../funnel-builder/canvas';
import { HeatmapControls, heatCells } from '../funnel-builder/heatmap';
import { LinkBuilderDialog } from '../funnel-builder/link-builder';
import { KIND_META } from '../funnel-builder/nodes/kind-meta';
import { FunnelPalette, type PaletteItem } from '../funnel-builder/palette';
import { EdgePanel } from '../funnel-builder/panels/edge-panel';
import { NodePanel } from '../funnel-builder/panels/node-panel';
import {
  BuilderResourcesProvider,
  pageResources,
  resourcePage,
} from '../funnel-builder/resources';
import {
  builderReducer,
  canSave,
  createNode,
  deletedNodes,
  draftIssues,
  initBuilder,
  isDirty,
  issuesByTarget,
  liveNodes,
  parseSaveFailure,
  toGraphUpdate,
  tracePath,
  type BuilderIssue,
  type Position,
} from '../funnel-builder/state';
import { useAnalyticsQueryState, type AnalyticsState } from '../lib/query-state';
import { analyticsFunnelBuilderRoute, type FunnelBuilderSearch } from '../routes';

const ALL_SOURCES = 'all';
const NO_SOURCES: readonly TrafficSource[] = [];

function Builder({
  tenant,
  site,
  initial,
  controls,
}: {
  tenant: string;
  site: Site;
  initial: FunnelGraph;
  controls: AnalyticsState;
}) {
  const { t, locale } = useI18n();
  const search = useSearch({ from: analyticsFunnelBuilderRoute.id });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const funnelId = initial.id;
  const [state, dispatch] = useReducer(builderReducer, initial, initBuilder);
  const [selection, setSelection] = useState<BuilderSelection>(null);
  const [linksFor, setLinksFor] = useState<{ nodeId?: string } | null>(null);
  const [heatSource, setHeatSource] = useState(ALL_SOURCES);
  const sources = useTrafficSources(tenant, site.id);
  const draft = state.draft;
  const metric = search.heatmap ?? null;
  const tracing = search.trace === '1';
  const conflict = state.conflict ?? null;

  const setSearch = (patch: Partial<FunnelBuilderSearch>) =>
    void navigate({
      to: '/t/$tenant/analytics/funnels/$funnelId/builder',
      params: { tenant, funnelId },
      search: (previous: FunnelBuilderSearch) => ({ ...previous, ...patch }),
      replace: true,
    });

  const issues = useMemo(() => draftIssues(state), [state]);
  const dirty = isDirty(state);
  const message = useCallback(
    (issue: BuilderIssue) =>
      issue.code === 'invalid_config' && issue.message
        ? `${t('analytics.funnelBuilder.error.invalid_config')} (${issue.message})`
        : t(`analytics.funnelBuilder.error.${issue.code}`),
    [t],
  );
  const grouped = useMemo(() => {
    const { nodes, edges, graph } = issuesByTarget(issues);
    const texts = (map: Map<string, BuilderIssue[]>) =>
      new Map([...map].map(([id, list]) => [id, [...new Set(list.map(message))]]));
    return { nodes: texts(nodes), edges: texts(edges), graph: [...new Set(graph.map(message))] };
  }, [issues, message]);

  const heatmap = useFunnelHeatmap(
    tenant,
    site.id,
    funnelId,
    state.saved.version,
    metric
      ? {
          metric,
          from: controls.range.from,
          to: controls.range.to,
          ...(heatSource !== ALL_SOURCES ? { source: heatSource } : {}),
        }
      : null,
  );
  const heat = useMemo(
    () => (metric && heatmap.data ? heatCells(heatmap.data, locale) : null),
    [heatmap.data, metric, locale],
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
        node.config.page_type = item.pageType;
      }
      dispatch({ type: 'add_node', node });
      setSelection({ kind: 'node', id: node.id });
    },
    [draft, selection],
  );

  const api = funnelsApi(tenant);
  const saveMutation = useMutation({
    mutationFn: (update: FunnelGraphUpdate) => api.funnels.save(site.id, funnelId, update),
    onSuccess: (graph) => {
      dispatch({ type: 'saved', graph });
      queryClient.setQueryData(funnelKeys.graph(tenant, site.id, funnelId), graph);
      void queryClient.invalidateQueries({ queryKey: [...funnelKeys.graphs(tenant, site.id), 'list'] });
      toast.success(t('analytics.funnelBuilder.saved'));
    },
    onError: async (error) => {
      if (!(error instanceof ApiBodyError)) {
        toast.error(analyticsErrorMessage(t, error));
        return;
      }
      const failure = parseSaveFailure(draft, error.status, error.body);
      if (failure.kind === 'invalid') {
        dispatch({ type: 'rejected', issues: failure.issues });
        toast.error(t('analytics.funnelBuilder.saveInvalid'));
      } else if (failure.kind === 'conflict') {
        try {
          dispatch({ type: 'conflict', remote: await api.funnels.get(site.id, funnelId) });
          toast.error(t('analytics.funnelBuilder.conflict.toast'));
        } catch (reload) {
          toast.error(analyticsErrorMessage(t, reload));
        }
      } else {
        toast.error(analyticsErrorMessage(t, error));
      }
    },
  });
  const statusMutation = useMutation({
    mutationFn: (action: 'archive' | 'restore') =>
      action === 'archive'
        ? api.funnels.archive(site.id, funnelId)
        : api.funnels.restore(site.id, funnelId),
    onSuccess: (graph) => {
      if (!isDirty(state)) dispatch({ type: 'saved', graph });
      queryClient.setQueryData(funnelKeys.graph(tenant, site.id, funnelId), graph);
      void queryClient.invalidateQueries({ queryKey: [...funnelKeys.graphs(tenant, site.id), 'list'] });
    },
    onError: (error) => toast.error(analyticsErrorMessage(t, error)),
  });

  const saveable = canSave(state) && !saveMutation.isPending;
  const save = () => {
    if (saveable) saveMutation.mutate(toGraphUpdate(state));
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
  const archived = state.saved.status === 'archived';

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="funnel-builder">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <Button asChild variant="ghost" size="sm" className="h-8 px-2">
          <Link
            to="/t/$tenant/analytics/funnels-v2"
            params={{ tenant }}
            search={{ site: site.id }}
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
          {dirty
            ? t('analytics.funnelBuilder.unsaved')
            : t('analytics.funnelBuilder.savedVersion', { version: state.saved.version })}
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
        {metric ? (
          <>
            <RangeControls controls={controls} showInterval={false} />
            <DashboardFilterMenu
              label={t('analytics.funnelBuilder.heatmap.source')}
              value={heatSource}
              options={[
                { value: ALL_SOURCES, label: t('analytics.funnelBuilder.heatmap.allSources') },
                ...(sources.data ?? []).map((s) => ({ value: s.id, label: s.name })),
              ]}
              onValueChange={setHeatSource}
            />
          </>
        ) : null}
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
        <DashboardButton variant="ghost" size="sm" onClick={() => setLinksFor({})}>
          <Link2 aria-hidden />
          {t('analytics.funnelBuilder.links.button')}
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
          {saveMutation.isPending ? t('analytics.funnelBuilder.saving') : t('analytics.funnelBuilder.save')}
        </DashboardButton>
      </div>
      {conflict ? (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-warning/10 px-4 py-1.5 text-xs"
          data-testid="funnel-builder-conflict"
        >
          <GitMerge className="size-3.5 text-warning" aria-hidden />
          <span className="min-w-0 flex-1">
            {t('analytics.funnelBuilder.conflict.body', { version: conflict.version })}
          </span>
          <DashboardButton
            variant="secondary"
            size="sm"
            onClick={() => {
              dispatch({ type: 'resolve_conflict', keep: 'theirs' });
              setSelection(null);
            }}
          >
            {t('analytics.funnelBuilder.conflict.reload')}
          </DashboardButton>
          <DashboardButton
            variant="primary"
            size="sm"
            onClick={() => dispatch({ type: 'resolve_conflict', keep: 'mine' })}
          >
            {t('analytics.funnelBuilder.conflict.keepMine')}
          </DashboardButton>
        </div>
      ) : null}
      {archived ? (
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/30 px-4 py-1 text-[11px] text-muted-foreground">
          <Archive className="size-3.5" aria-hidden />
          <span className="flex-1">{t('analytics.funnelBuilder.archivedNotice')}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={statusMutation.isPending}
            onClick={() => statusMutation.mutate('restore')}
          >
            {t('analytics.funnelsV2.restore')}
          </Button>
        </div>
      ) : null}
      {metric && heatmap.error ? (
        <div className="shrink-0 border-b px-4">
          <ErrorState error={heatmap.error} compact />
        </div>
      ) : null}
      {metric && heatmap.data?.truncated ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b bg-warning/10 px-4 py-1 text-[11px]"
          data-testid="funnel-heatmap-truncated"
        >
          <CircleAlert className="size-3.5 text-warning" aria-hidden />
          <span className="flex-1">{t('analytics.funnelBuilder.heatmap.truncated')}</span>
        </div>
      ) : null}

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
                  onLinks={() => setLinksFor({ nodeId: selectedNode.id })}
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
      {linksFor ? (
        <LinkBuilderDialog
          tenant={tenant}
          site={site}
          graph={state.saved}
          dirty={dirty}
          {...(linksFor.nodeId !== undefined ? { initialNodeId: linksFor.nodeId } : {})}
          onClose={() => setLinksFor(null)}
        />
      ) : null}
    </div>
  );
}

/** `/t/$tenant/analytics/funnels/$funnelId/builder` — visual funnel builder of a site's funnel graph. */
export function AnalyticsFunnelBuilderPage() {
  const { t } = useI18n();
  const { tenant, funnelId } = useParams({ from: analyticsFunnelBuilderRoute.id });
  usePageChrome({ title: t('analytics.funnelBuilder.title') });
  const controls = useAnalyticsQueryState(tenant);
  const site = controls.site;
  const graph = useFunnelGraph(tenant, site?.id ?? null, funnelId);
  const pages = useAmablePages(tenant);
  const resources = useMemo(() => pageResources(pages.data ?? []), [pages.data]);
  const sources = useTrafficSources(tenant, site?.id ?? null);

  const error = controls.sites.error ?? graph.error;
  if (error)
    return (
      <div className="p-4">
        <ErrorState error={error} />
      </div>
    );
  if (controls.sites.isPending || (site && graph.isPending))
    return (
      <div className="grid gap-3 p-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  if (!site || !graph.data)
    return <EmptyNote>{t('analytics.funnelsV2.noSite')}</EmptyNote>;
  return (
    <ReactFlowProvider>
      <BuilderResourcesProvider
        tenant={tenant}
        siteId={site.id}
        pages={resources}
        sources={sources.data ?? NO_SOURCES}
      >
        <Builder
          key={`${site.id}:${funnelId}`}
          tenant={tenant}
          site={site}
          initial={graph.data}
          controls={controls}
        />
      </BuilderResourcesProvider>
    </ReactFlowProvider>
  );
}

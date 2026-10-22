import type { AutomationDetail, GraphNode, NodeStats, ValidationResult } from '@amable/api-types';
import { DashboardConfirmDialog, toast, useTheme } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import {
  ArrowLeft,
  BarChart3,
  History,
  Keyboard,
  LayoutGrid,
  Loader2,
  Pause,
  Play,
  Redo2,
  Settings2,
  ShieldCheck,
  Undo2,
  UserPlus,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '../../../../i18n';
import { EditLockBanner } from '../../../../lib/edit-lock/edit-lock-banner';
import { editLockPath, useEditLock } from '../../../../lib/edit-lock/use-edit-lock';
import { CrmApiError } from '../../../crm/api/client';
import { errorMessage } from '../../../crm/api/hooks';
import { automationKeys, useAutomationApi, useAutomationPermissions } from '../../api/hooks';
import { CanvasContext, statsKey, type CanvasContextValue } from '../../components/canvas-context';
import { nodeTypes } from '../../components/canvas-nodes';
import { DecisionPanel } from '../../components/decision-panel';
import {
  ConflictDialog,
  EnrollDialog,
  SettingsDialog,
  ShortcutsDialog,
  VersionsDialog,
} from '../../components/dialogs';
import { EnrollmentsPanel } from '../../components/enrollments-panel';
import { GoalPanel } from '../../components/goal-panel';
import { IssueList } from '../../components/issue-list';
import { Palette, PALETTE_MIME } from '../../components/palette';
import { SequencePanel } from '../../components/sequence-panel';
import { createNode, duplicateNode, type PaletteItem } from '../../lib/defaults';
import {
  canConnect,
  connectionToEdge,
  flowToGraph,
  graphToFlow,
  takenIds,
  type AutomationFlowEdge,
  type AutomationFlowNode,
} from '../../lib/flow-mapping';
import { groupIssues, localIssues, serverIssues, type CanvasIssue } from '../../lib/issues';
import { tidyLayout } from '../../lib/layout';
import { NoteColorPicker } from './note-color-picker';
import { SaveIndicator, ToolButton } from './toolbar';
import { useDraftAutosave, useFlushOnLeave } from './use-draft-autosave';
import { useEditorShortcuts } from './use-editor-shortcuts';
import { useGraphHistory } from './use-graph-history';
import { usePublishActions } from './use-publish-actions';

function nodeTitle(node: GraphNode | undefined, t: ReturnType<typeof useI18n>['t']): string {
  if (node === undefined) return '';
  if (node.type === 'note') return t('auto.node.note');
  return node.label ?? t(`auto.node.${node.type}`);
}

export function Editor({ detail }: { detail: AutomationDetail }) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const { slug, api } = useAutomationApi();
  const perms = useAutomationPermissions();
  const queryClient = useQueryClient();
  const automationId = detail.id;
  const reloadRef = useRef<() => void>(() => undefined);
  const lock = useEditLock(perms.canWrite ? editLockPath(slug, 'automations', automationId) : null, {
    onLost: (holder) =>
      toast.warning(holder ? t('common.lock.takenOver', { name: holder.user_name }) : t('common.lock.takenOverSomeone')),
    onStale: () => reloadRef.current(),
  });
  const readOnly = !perms.canWrite || !lock.canEdit;
  const flow = useReactFlow<AutomationFlowNode, AutomationFlowEdge>();
  const wrapper = useRef<HTMLDivElement>(null);

  const initial = useMemo(() => graphToFlow(detail.draft_graph), [detail.draft_graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<AutomationFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<AutomationFlowEdge>(initial.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [drillNode, setDrillNode] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [dialog, setDialog] = useState<
    'settings' | 'versions' | 'enroll' | 'shortcuts' | 'unpublish' | null
  >(null);
  const [resolving, setResolving] = useState(false);
  const dragging = useRef(false);

  const graph = useMemo(() => flowToGraph(nodes, edges), [nodes, edges]);
  const graphJson = useMemo(() => JSON.stringify(graph), [graph]);
  const { sync, snapshot } = useDraftAutosave(detail, graphJson, readOnly);

  // Publish validation of every saved revision: inline issues on the nodes.
  const liveValidation = useQuery({
    queryKey: [...automationKeys.detail(slug, automationId), 'validate', snapshot.revision],
    queryFn: () => api.validate(automationId),
    enabled: perms.canRead,
    staleTime: Infinity,
  });
  const currentValidation = validation ?? liveValidation.data ?? null;
  useEffect(() => setValidation(null), [snapshot.revision]);

  const issues: CanvasIssue[] = useMemo(() => {
    const local = localIssues(graph);
    const server =
      snapshot.status === 'saved' && currentValidation
        ? serverIssues(graph, currentValidation.issues)
        : [];
    return [...local, ...server];
  }, [graph, currentValidation, snapshot.status]);
  const issuesByNode = useMemo(() => groupIssues(issues), [issues]);

  const { applyGraph, undo, redo, canUndo, canRedo } = useGraphHistory({
    graphJson,
    dragging,
    setNodes,
    setEdges,
  });

  // ---------------------------------------------------------------- edits
  const updateNode = useCallback(
    (node: GraphNode) => {
      setNodes((current) => current.map((n) => (n.id === node.id ? { ...n, data: { node } } : n)));
    },
    [setNodes],
  );

  const addNode = useCallback(
    (item: PaletteItem, at?: { x: number; y: number }) => {
      if (readOnly) return;
      let position = at;
      if (position === undefined) {
        // Next column to the right of the flow, level with the selected node.
        const flowNodes = graph.nodes.filter((n) => n.type !== 'note');
        const anchor =
          graph.nodes.find((n) => n.id === selectedId) ?? flowNodes[flowNodes.length - 1];
        if (anchor === undefined) {
          const box = wrapper.current?.getBoundingClientRect();
          const center = box
            ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
            : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
          const p = flow.screenToFlowPosition(center);
          position = { x: p.x - 120, y: p.y - 40 };
        } else {
          const right = Math.max(...flowNodes.map((n) => n.position.x), anchor.position.x);
          position =
            item.kind === 'note'
              ? { x: anchor.position.x, y: anchor.position.y + 220 }
              : { x: right + 320, y: anchor.position.y };
        }
        requestAnimationFrame(() => void flow.fitView({ padding: 0.2, duration: 200, maxZoom: 1 }));
      }
      const node = createNode(item, position, takenIds(graph.nodes));
      setNodes((current) => [
        ...current.map((n) => ({ ...n, selected: false })),
        {
          ...graphToFlow({ schema_version: 1, nodes: [node], edges: [] }).nodes[0]!,
          selected: true,
        },
      ]);
      setSelectedId(node.id);
      setSelectedStepId(null);
    },
    [flow, graph.nodes, readOnly, selectedId, setNodes],
  );

  const duplicateSelected = useCallback(() => {
    if (readOnly || selectedId === null) return;
    const source = graph.nodes.find((n) => n.id === selectedId);
    if (source === undefined) return;
    const copy = duplicateNode(source, takenIds(graph.nodes));
    setNodes((current) => [
      ...current.map((n) => ({ ...n, selected: false })),
      { ...graphToFlow({ schema_version: 1, nodes: [copy], edges: [] }).nodes[0]!, selected: true },
    ]);
    setSelectedId(copy.id);
  }, [graph.nodes, readOnly, selectedId, setNodes]);

  const tidy = useCallback(() => {
    if (readOnly) return;
    applyGraph(tidyLayout(graph), false);
    requestAnimationFrame(() => void flow.fitView({ padding: 0.2, duration: 300, maxZoom: 1 }));
  }, [applyGraph, flow, graph, readOnly]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) =>
        canConnect(connection, nodes, current)
          ? [...current, connectionToEdge(connection, nodes, current)]
          : current,
      );
    },
    [nodes, setEdges],
  );

  const onSelectionChange = useCallback(({ nodes: picked }: OnSelectionChangeParams) => {
    const id = picked.length === 1 ? (picked[0]?.id ?? null) : null;
    setSelectedId((prev) => {
      if (prev !== id) setSelectedStepId(null);
      return id;
    });
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const raw = event.dataTransfer.getData(PALETTE_MIME);
      if (raw === '') return;
      event.preventDefault();
      const item = JSON.parse(raw) as PaletteItem;
      addNode(item, flow.screenToFlowPosition({ x: event.clientX - 100, y: event.clientY - 20 }));
    },
    [addNode, flow],
  );

  // -------------------------------------------------------------- reporting
  const stats = useQuery({
    queryKey: automationKeys.stats(slug, automationId),
    queryFn: () => api.stats(automationId),
    enabled: reporting,
    refetchInterval: reporting ? 10_000 : false,
  });
  const statsMap = useMemo(() => {
    if (!reporting) return null;
    const map = new Map<string, NodeStats>();
    for (const row of stats.data?.nodes ?? []) map.set(statsKey(row.node_id, row.step_id), row);
    return map;
  }, [reporting, stats.data]);

  const canvas: CanvasContextValue = useMemo(
    () => ({
      readOnly,
      stats: statsMap,
      issues: issuesByNode,
      updateNode,
      openCounters: (nodeId: string) => setDrillNode(nodeId),
    }),
    [readOnly, statsMap, issuesByNode, updateNode],
  );

  const { publishing, publish, unpublish, check } = usePublishActions(
    automationId,
    sync,
    setValidation,
  );

  // ------------------------------------------------------------ edit lock
  // Behind another editor, or right after getting the lock from them: adopt the server draft.
  reloadRef.current = () => {
    void sync
      .resolveWithServer()
      .then((server) => applyGraph(server.graph, false))
      .catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: automationKeys.detail(slug, automationId), exact: true });
  };

  useEffect(() => {
    if (snapshot.status === 'error' && snapshot.error instanceof CrmApiError && snapshot.error.status === 423) {
      toast.warning(t('common.lock.lost'));
    }
  }, [snapshot.status, snapshot.error, t]);

  // ------------------------------------------------------------- keyboard
  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setDrillNode(null);
    setNodes((current) => current.map((n) => (n.selected ? { ...n, selected: false } : n)));
  }, [setNodes]);
  const toggleReporting = useCallback(() => setReporting((v) => !v), []);
  const fitView = useCallback(() => void flow.fitView({ padding: 0.2, duration: 300 }), [flow]);
  const showShortcuts = useCallback(() => setDialog('shortcuts'), []);
  useEditorShortcuts({
    sync,
    readOnly,
    undo,
    redo,
    duplicateSelected,
    clearSelection,
    toggleReporting,
    fitView,
    tidy,
    showShortcuts,
    addNode,
  });
  useFlushOnLeave(sync);

  const selectedNode = graph.nodes.find((n) => n.id === selectedId);
  const nodeIssues = (id: string) => issuesByNode.get(id)?.messages ?? [];
  const sequences = graph.nodes
    .filter((n) => n.type === 'sequence')
    .map((n) => ({ id: n.id, label: n.label ?? n.id }));
  const taken = takenIds(graph.nodes);
  const labelOf = (id: string | null) =>
    id === null
      ? ''
      : nodeTitle(
          graph.nodes.find((n) => n.id === id),
          t,
        ) || id;
  const graphLevel = issues.filter((issue) => issue.nodeId === null);
  const totals = {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
  };

  const panel: { title: string; body: ReactNode } | null =
    reporting && drillNode !== null
      ? {
          title: t('auto.report.drill', { name: labelOf(drillNode) }),
          body: (
            <EnrollmentsPanel
              key={drillNode}
              automationId={automationId}
              nodeId={drillNode}
              nodeLabel={labelOf}
              canWrite={perms.canWrite}
            />
          ),
        }
      : !reporting && selectedNode !== undefined
        ? {
            title: nodeTitle(selectedNode, t),
            body:
              selectedNode.type === 'goal' ? (
                <GoalPanel
                  node={selectedNode}
                  onChange={updateNode}
                  disabled={readOnly}
                  slug={slug}
                  issues={nodeIssues(selectedNode.id)}
                />
              ) : selectedNode.type === 'sequence' ? (
                <SequencePanel
                  node={selectedNode}
                  onChange={updateNode}
                  disabled={readOnly}
                  takenIds={taken}
                  issues={nodeIssues(selectedNode.id)}
                  stepIssues={issuesByNode.get(selectedNode.id)?.byStep ?? new Map()}
                  selectedStepId={selectedStepId}
                  onSelectStep={setSelectedStepId}
                  ctx={{ slug, automationId, sequences, canPublish: perms.canPublish }}
                />
              ) : selectedNode.type === 'decision' ? (
                <DecisionPanel
                  key={selectedNode.id}
                  node={selectedNode}
                  onChange={updateNode}
                  disabled={readOnly}
                  takenIds={taken}
                  issues={nodeIssues(selectedNode.id)}
                />
              ) : (
                <NoteColorPicker node={selectedNode} disabled={readOnly} onChange={updateNode} />
              ),
          }
        : null;

  return (
    <CanvasContext.Provider value={canvas}>
      <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="automation-editor">
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-1.5">
          <Button asChild variant="ghost" size="sm" className="h-8 px-2">
            <Link
              to="/t/$tenant/automations"
              params={{ tenant: slug }}
              aria-label={t('auto.title')}
            >
              <ArrowLeft className="size-4" aria-hidden />
            </Link>
          </Button>
          <div className="mx-1 flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm font-medium" data-testid="automation-title">
              {detail.name}
            </span>
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {t(`auto.status.${detail.status}`)}
            </span>
            {readOnly ? (
              <span className="text-xs text-muted-foreground">{t('auto.editor.readOnly')}</span>
            ) : (
              <SaveIndicator status={snapshot.status} />
            )}
          </div>
          {totals.errors + totals.warnings > 0 ? (
            <span className="mr-1 text-xs text-muted-foreground" data-testid="issue-totals">
              {t('auto.issues.count', { errors: totals.errors, warnings: totals.warnings })}
            </span>
          ) : null}
          {!readOnly ? (
            <>
              <ToolButton label={t('auto.editor.undo')} onClick={undo} disabled={!canUndo}>
                <Undo2 className="size-4" aria-hidden />
              </ToolButton>
              <ToolButton label={t('auto.editor.redo')} onClick={redo} disabled={!canRedo}>
                <Redo2 className="size-4" aria-hidden />
              </ToolButton>
              <ToolButton label={t('auto.editor.tidy')} onClick={tidy} testId="tidy">
                <LayoutGrid className="size-4" aria-hidden />
              </ToolButton>
            </>
          ) : null}
          <ToolButton
            label={t('auto.editor.validate')}
            onClick={() => void check()}
            testId="validate"
          >
            <ShieldCheck className="size-4" aria-hidden />
          </ToolButton>
          <ToolButton
            label={t('auto.editor.reporting')}
            active={reporting}
            onClick={() => setReporting((v) => !v)}
            testId="toggle-reporting"
          >
            <BarChart3 className="size-4" aria-hidden />
            <span className="hidden text-xs xl:inline">{t('auto.editor.reporting')}</span>
          </ToolButton>
          <ToolButton label={t('auto.editor.versions')} onClick={() => setDialog('versions')}>
            <History className="size-4" aria-hidden />
          </ToolButton>
          <ToolButton label={t('auto.editor.settings')} onClick={() => setDialog('settings')}>
            <Settings2 className="size-4" aria-hidden />
          </ToolButton>
          {perms.canWrite ? (
            <ToolButton
              label={t('auto.editor.enroll')}
              onClick={() => setDialog('enroll')}
              disabled={detail.status !== 'active'}
            >
              <UserPlus className="size-4" aria-hidden />
            </ToolButton>
          ) : null}
          <ToolButton label={t('auto.editor.shortcuts')} onClick={() => setDialog('shortcuts')}>
            <Keyboard className="size-4" aria-hidden />
          </ToolButton>
          {perms.canPublish ? (
            <>
              {detail.status === 'active' ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-1 h-8"
                  onClick={() => setDialog('unpublish')}
                  disabled={readOnly}
                  data-testid="unpublish"
                >
                  <Pause className="size-3.5" aria-hidden /> {t('auto.editor.unpublish')}
                </Button>
              ) : null}
              <Button
                size="sm"
                className="ml-1 h-8"
                disabled={
                  readOnly ||
                  publishing ||
                  (detail.status === 'active' &&
                    !detail.has_unpublished_changes &&
                    snapshot.status === 'saved')
                }
                onClick={() => void publish()}
                data-testid="publish"
              >
                {publishing ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Play className="size-3.5" aria-hidden />
                )}
                {t('auto.editor.publish')}
              </Button>
            </>
          ) : null}
        </div>

        <EditLockBanner lock={lock} canTakeover={perms.canPublish} />

        {reporting && stats.data ? (
          <div
            className="shrink-0 border-b bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground"
            data-testid="report-summary"
          >
            {t('auto.report.summary', {
              active: stats.data.enrollments.active,
              completed: stats.data.enrollments.completed,
              failed: stats.data.enrollments.failed,
            })}
            <span className="ml-2 opacity-70">{t('auto.report.hint')}</span>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1">
          {!readOnly && !reporting ? <Palette onAdd={(item) => addNode(item)} /> : null}
          <div
            ref={wrapper}
            className="relative min-w-0 flex-1"
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes(PALETTE_MIME)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }
            }}
            onDrop={onDrop}
          >
            <ReactFlow<AutomationFlowNode, AutomationFlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={(connection) =>
                canConnect(
                  {
                    source: connection.source,
                    target: connection.target,
                    sourceHandle: connection.sourceHandle ?? null,
                  },
                  nodes,
                  edges,
                )
              }
              onSelectionChange={onSelectionChange}
              onNodeDragStart={() => {
                dragging.current = true;
              }}
              onNodeDragStop={() => {
                dragging.current = false;
                setNodes((current) => [...current]);
              }}
              onNodeClick={(_, node) => {
                if (reporting && node.type !== 'note') setDrillNode(node.id);
              }}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
              snapToGrid
              snapGrid={[16, 16]}
              defaultEdgeOptions={{ type: 'smoothstep', animated: reporting }}
              colorMode={resolvedTheme}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
              minZoom={0.2}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={16} size={1} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable className="!bg-background" />
            </ReactFlow>
            {graphLevel.length > 0 ? (
              <div className="absolute bottom-3 left-1/2 w-[min(32rem,90%)] -translate-x-1/2">
                <IssueList issues={graphLevel} className="rounded-lg bg-background/95 p-1 shadow" />
              </div>
            ) : null}
          </div>
          {panel !== null ? (
            <aside
              className="flex w-[26rem] shrink-0 flex-col border-l bg-background"
              data-testid="side-panel"
            >
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{panel.title}</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t('auto.close')}
                  onClick={() => {
                    if (reporting && drillNode !== null) setDrillNode(null);
                    else {
                      setSelectedId(null);
                      setNodes((current) =>
                        current.map((n) => (n.selected ? { ...n, selected: false } : n)),
                      );
                    }
                  }}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
              <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-3 [&_.grid:not([class*=grid-cols])]:grid-cols-[minmax(0,1fr)]">
                {panel.body}
              </div>
            </aside>
          ) : null}
        </div>
      </div>

      <ConflictDialog
        open={snapshot.status === 'conflict'}
        busy={resolving}
        onReload={() => {
          setResolving(true);
          void sync
            .resolveWithServer()
            .then((server) => applyGraph(server.graph, false))
            .catch((error: unknown) => toast.error(errorMessage(t, error)))
            .finally(() => setResolving(false));
        }}
        onKeep={() => {
          setResolving(true);
          void sync
            .resolveKeepMine()
            .catch((error: unknown) => toast.error(errorMessage(t, error)))
            .finally(() => setResolving(false));
        }}
      />
      {dialog === 'settings' ? (
        <SettingsDialog
          automation={detail}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          disabled={readOnly}
        />
      ) : null}
      <VersionsDialog
        automation={detail}
        open={dialog === 'versions'}
        onOpenChange={(open) => !open && setDialog(null)}
        canRestore={!readOnly}
        onRestored={(restored) => {
          sync.reset({ revision: restored.draft_revision, graph: restored.draft_graph });
          applyGraph(restored.draft_graph, false);
        }}
      />
      {dialog === 'enroll' ? (
        <EnrollDialog
          automationId={automationId}
          nodes={graph.nodes}
          open
          onOpenChange={(open) => !open && setDialog(null)}
        />
      ) : null}
      <ShortcutsDialog
        open={dialog === 'shortcuts'}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      <DashboardConfirmDialog
        open={dialog === 'unpublish'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('auto.editor.unpublish')}
        description={t('auto.unpublish.confirm')}
        confirmLabel={t('auto.editor.unpublish')}
        cancelLabel={t('auto.cancel')}
        tone="danger"
        onConfirm={() => {
          setDialog(null);
          void unpublish();
        }}
      />
    </CanvasContext.Provider>
  );
}

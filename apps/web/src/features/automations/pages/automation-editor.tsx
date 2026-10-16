import '@xyflow/react/dist/style.css';
import type {
  AutomationDetail,
  AutomationGraph,
  GraphNode,
  NodeStats,
  ValidationResult,
} from '@amable/api-types';
import { cn, DashboardConfirmDialog, toast, usePageChrome, useTheme } from '@amable/ui';
import { Button } from '@amable/ui/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@amable/ui/ui/tooltip';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import {
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  CircleAlert,
  CloudOff,
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
  useSyncExternalStore,
  type DragEvent,
  type ReactNode,
} from 'react';
import { useI18n } from '../../../i18n';
import { CrmApiError } from '../../crm/api/client';
import { errorMessage } from '../../crm/api/hooks';
import {
  automationKeys,
  isConflict,
  useAutomationApi,
  useAutomationPermissions,
} from '../api/hooks';
import { CanvasContext, statsKey, type CanvasContextValue } from '../components/canvas-context';
import { NOTE_COLOR_NAMES, nodeTypes } from '../components/canvas-nodes';
import { DecisionPanel } from '../components/decision-panel';
import {
  ConflictDialog,
  EnrollDialog,
  SettingsDialog,
  ShortcutsDialog,
  VersionsDialog,
} from '../components/dialogs';
import { EnrollmentsPanel } from '../components/enrollments-panel';
import { GoalPanel } from '../components/goal-panel';
import { IssueList } from '../components/issue-list';
import { Palette, PALETTE_MIME } from '../components/palette';
import { SequencePanel } from '../components/sequence-panel';
import { createNode, duplicateNode, type PaletteItem } from '../lib/defaults';
import { DraftSync, type DraftStatus } from '../lib/draft-sync';
import {
  canConnect,
  connectionToEdge,
  flowToGraph,
  graphToFlow,
  takenIds,
  type AutomationFlowEdge,
  type AutomationFlowNode,
} from '../lib/flow-mapping';
import { groupIssues, localIssues, serverIssues, type CanvasIssue } from '../lib/issues';
import { tidyLayout } from '../lib/layout';

const HISTORY_LIMIT = 50;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.closest('[role="dialog"]') !== null
  );
}

function SaveIndicator({ status }: { status: DraftStatus }) {
  const { t } = useI18n();
  const map: Record<DraftStatus, { icon: ReactNode; text: string; tone: string }> = {
    saved: {
      icon: <CheckCircle2 className="size-3.5" />,
      text: t('auto.save.saved'),
      tone: 'text-muted-foreground',
    },
    dirty: {
      icon: <Loader2 className="size-3.5" />,
      text: t('auto.save.dirty'),
      tone: 'text-muted-foreground',
    },
    saving: {
      icon: <Loader2 className="size-3.5 animate-spin" />,
      text: t('auto.save.saving'),
      tone: 'text-muted-foreground',
    },
    invalid: {
      icon: <CircleAlert className="size-3.5" />,
      text: t('auto.save.invalid'),
      tone: 'text-amber-600 dark:text-amber-400',
    },
    error: {
      icon: <CloudOff className="size-3.5" />,
      text: t('auto.save.error'),
      tone: 'text-destructive',
    },
    conflict: {
      icon: <CircleAlert className="size-3.5" />,
      text: t('auto.save.conflict'),
      tone: 'text-destructive',
    },
  };
  const item = map[status];
  return (
    <span
      className={cn('flex min-w-0 items-center gap-1 text-xs', item.tone)}
      data-testid="save-status"
      data-status={status}
    >
      {item.icon}
      <span className="truncate">{item.text}</span>
    </span>
  );
}

function ToolButton({
  label,
  onClick,
  children,
  active,
  disabled,
  testId,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={active ? 'secondary' : 'ghost'}
          size="sm"
          className="h-8 gap-1.5 px-2"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          data-testid={testId}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function nodeTitle(node: GraphNode | undefined, t: ReturnType<typeof useI18n>['t']): string {
  if (node === undefined) return '';
  if (node.type === 'note') return t('auto.node.note');
  return node.label ?? t(`auto.node.${node.type}`);
}

function Editor({ detail }: { detail: AutomationDetail }) {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const { slug, api } = useAutomationApi();
  const queryClient = useQueryClient();
  const perms = useAutomationPermissions();
  const readOnly = !perms.canWrite;
  const automationId = detail.id;
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
  const [publishing, setPublishing] = useState(false);
  const dragging = useRef(false);

  // ------------------------------------------------------------ autosave
  const syncRef = useRef<DraftSync | null>(null);
  if (syncRef.current === null) {
    syncRef.current = new DraftSync({
      revision: detail.draft_revision,
      graph: detail.draft_graph,
      save: async (graph, revision) => {
        const saved = await api.saveDraft(automationId, graph, revision);
        return { revision: saved.draft_revision, graph: saved.draft_graph };
      },
      load: async () => {
        const fresh = await api.get(automationId);
        return { revision: fresh.draft_revision, graph: fresh.draft_graph };
      },
      check: localIssues,
      isConflict,
    });
  }
  const sync = syncRef.current;
  useEffect(() => () => sync.dispose(), [sync]);
  const snapshot = useSyncExternalStore(sync.subscribe, sync.getSnapshot);

  const graph = useMemo(() => flowToGraph(nodes, edges), [nodes, edges]);
  const graphJson = useMemo(() => JSON.stringify(graph), [graph]);
  useEffect(() => {
    if (!readOnly) sync.update(JSON.parse(graphJson) as AutomationGraph);
  }, [graphJson, readOnly, sync]);

  // Refresh list/detail metadata (unpublished changes badge) after saves.
  useEffect(() => {
    if (snapshot.status === 'saved' && snapshot.savedAt !== null) {
      void queryClient.invalidateQueries({
        queryKey: automationKeys.detail(slug, automationId),
        exact: true,
      });
    }
  }, [snapshot.savedAt, snapshot.status, queryClient, slug, automationId]);

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

  // ------------------------------------------------------------- history
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const stable = useRef(graphJson);
  const restoring = useRef(false);
  const [, bumpHistory] = useState(0);
  useEffect(() => {
    if (restoring.current) {
      restoring.current = false;
      stable.current = graphJson;
      return;
    }
    if (dragging.current || graphJson === stable.current) return;
    const timer = setTimeout(() => {
      past.current = [...past.current, stable.current].slice(-HISTORY_LIMIT);
      future.current = [];
      stable.current = graphJson;
      bumpHistory((n) => n + 1);
    }, 350);
    return () => clearTimeout(timer);
  }, [graphJson]);

  const applyGraph = useCallback(
    (next: AutomationGraph, asHistory = true) => {
      const mapped = graphToFlow(next);
      if (asHistory) restoring.current = true;
      setNodes(mapped.nodes);
      setEdges(mapped.edges);
    },
    [setNodes, setEdges],
  );
  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (previous === undefined) return;
    future.current.push(stable.current);
    stable.current = previous;
    applyGraph(JSON.parse(previous) as AutomationGraph);
    bumpHistory((n) => n + 1);
  }, [applyGraph]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(stable.current);
    stable.current = next;
    applyGraph(JSON.parse(next) as AutomationGraph);
    bumpHistory((n) => n + 1);
  }, [applyGraph]);

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

  // --------------------------------------------------------------- publish
  const publish = async () => {
    setPublishing(true);
    try {
      await sync.flush();
      const state = sync.getSnapshot().status;
      if (state !== 'saved') {
        toast.error(state === 'invalid' ? t('auto.save.invalid') : t('auto.save.error'));
        return;
      }
      const result = await api.validate(automationId);
      setValidation(result);
      const errors = result.issues.filter((i) => i.severity === 'error').length;
      if (!result.valid) {
        toast.error(t('auto.publish.invalid', { n: errors }));
        return;
      }
      const published = await api.publish(automationId);
      toast.success(t('auto.publish.done', { n: published.version.number }));
      await queryClient.invalidateQueries({ queryKey: automationKeys.root(slug) });
    } catch (error) {
      toast.error(errorMessage(t, error));
    } finally {
      setPublishing(false);
    }
  };
  const unpublish = async () => {
    try {
      await api.unpublish(automationId);
      toast.success(t('auto.unpublish.done'));
      await queryClient.invalidateQueries({ queryKey: automationKeys.root(slug) });
    } catch (error) {
      toast.error(errorMessage(t, error));
    }
  };
  const check = async () => {
    try {
      await sync.flush();
      const result = await api.validate(automationId);
      setValidation(result);
      const errors = result.issues.filter((i) => i.severity === 'error').length;
      const warnings = result.issues.length - errors;
      if (errors > 0) toast.error(t('auto.publish.invalid', { n: errors }));
      else if (warnings > 0) toast.message(t('auto.publish.warnings', { n: warnings }));
      else toast.success(t('auto.publish.valid'));
    } catch (error) {
      toast.error(errorMessage(t, error));
    }
  };

  // ------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === 's') {
        event.preventDefault();
        void sync.flush();
        return;
      }
      if (isTyping(event.target)) return;
      if (mod && key === 'z') {
        event.preventDefault();
        if (readOnly) return;
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && key === 'y') {
        event.preventDefault();
        if (!readOnly) redo();
        return;
      }
      if (mod && key === 'd') {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      if (mod || event.altKey) return;
      if (key === 'escape') {
        setSelectedId(null);
        setDrillNode(null);
        setNodes((current) => current.map((n) => (n.selected ? { ...n, selected: false } : n)));
      } else if (key === 'r') setReporting((v) => !v);
      else if (key === 'f') void flow.fitView({ padding: 0.2, duration: 300 });
      else if (key === 'l') tidy();
      else if (key === '?') setDialog('shortcuts');
      else if (key === '1') addNode({ kind: 'sequence' });
      else if (key === '2') addNode({ kind: 'decision' });
      else if (key === '3') addNode({ kind: 'note' });
      else if (key === '4') addNode({ kind: 'goal', trigger: 'tag_applied' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addNode, duplicateSelected, flow, readOnly, redo, setNodes, sync, tidy, undo]);

  // Flush pending edits when leaving the page.
  useEffect(() => {
    const onUnload = (event: BeforeUnloadEvent) => {
      const status = sync.getSnapshot().status;
      if (status === 'dirty' || status === 'saving' || status === 'invalid') event.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      void sync.flush();
    };
  }, [sync]);

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
                <div className="grid gap-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('auto.note.color')}
                  </p>
                  <div className="flex gap-1.5">
                    {NOTE_COLOR_NAMES.map((color) => (
                      <button
                        key={color}
                        type="button"
                        disabled={readOnly}
                        aria-label={color}
                        onClick={() => updateNode({ ...selectedNode, color })}
                        className={cn(
                          'size-7 rounded-full border-2',
                          {
                            yellow: 'bg-yellow-200',
                            blue: 'bg-sky-200',
                            green: 'bg-emerald-200',
                            pink: 'bg-pink-200',
                          }[color],
                          (selectedNode.color ?? 'yellow') === color
                            ? 'border-primary'
                            : 'border-transparent',
                        )}
                      />
                    ))}
                  </div>
                </div>
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
              <ToolButton
                label={t('auto.editor.undo')}
                onClick={undo}
                disabled={past.current.length === 0}
              >
                <Undo2 className="size-4" aria-hidden />
              </ToolButton>
              <ToolButton
                label={t('auto.editor.redo')}
                onClick={redo}
                disabled={future.current.length === 0}
              >
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
                  data-testid="unpublish"
                >
                  <Pause className="size-3.5" aria-hidden /> {t('auto.editor.unpublish')}
                </Button>
              ) : null}
              <Button
                size="sm"
                className="ml-1 h-8"
                disabled={
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
        canRestore={perms.canWrite}
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

/** `/t/$tenant/automations/$automationId` — the canvas editor. */
export function AutomationEditorPage() {
  const { t } = useI18n();
  const params = useParams({ strict: false });
  const automationId = (params as { automationId?: string }).automationId ?? '';
  const { slug, api } = useAutomationApi();
  const detail = useQuery({
    queryKey: automationKeys.detail(slug, automationId),
    queryFn: () => api.get(automationId),
    retry: false,
  });
  // The canvas keeps its own state: only the first load seeds it.
  const [seed, setSeed] = useState<AutomationDetail | null>(null);
  useEffect(() => {
    if (seed === null && detail.data !== undefined) setSeed(detail.data);
  }, [detail.data, seed]);

  const data = detail.data;
  usePageChrome({
    title: data?.name ?? t('auto.title'),
    ...(data === undefined
      ? {}
      : {
          status:
            data.status === 'active' && data.has_unpublished_changes
              ? `${t('auto.status.active')} · ${t('auto.status.unpublished')}`
              : t(`auto.status.${data.status}`),
          statusTone:
            data.status === 'active'
              ? 'success'
              : data.status === 'inactive'
                ? 'warning'
                : 'neutral',
        }),
  });
  if (detail.isError) {
    const notFound = detail.error instanceof CrmApiError && detail.error.status === 404;
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {notFound ? t('crm.error.notFound') : errorMessage(t, detail.error)}
      </div>
    );
  }
  if (seed === null || detail.data === undefined) {
    return <div className="p-6 text-sm text-muted-foreground">{t('auto.loading')}</div>;
  }
  return (
    <ReactFlowProvider>
      <EditorFrame seed={seed} current={detail.data} />
    </ReactFlowProvider>
  );
}

/** The editor gets the live metadata (status, versions) but the seed graph only once. */
function EditorFrame({ seed, current }: { seed: AutomationDetail; current: AutomationDetail }) {
  const merged = useMemo(
    () => ({ ...current, draft_graph: seed.draft_graph, draft_revision: seed.draft_revision }),
    [current, seed],
  );
  return <Editor detail={merged} />;
}

import {
  automationGraphSchema,
  type AutomationGraph,
  type ValidationIssue,
} from '@amable/api-types';

/**
 * Problems shown on the canvas: the local shape check (what the server would
 * reject on save, e.g. a tag goal without tags) and the publish validation
 * returned by `POST /automations/{id}/validate`, both keyed by node and step.
 */

export interface CanvasIssue {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly path: string;
  readonly nodeId: string | null;
  readonly stepId: string | null;
}

export interface NodeIssues {
  readonly errors: number;
  readonly warnings: number;
  readonly messages: readonly CanvasIssue[];
  readonly byStep: ReadonlyMap<string, readonly CanvasIssue[]>;
}

function pathText(path: readonly PropertyKey[]): string {
  return path
    .map((part, i) =>
      typeof part === 'number' ? `[${String(part)}]` : `${i === 0 ? '' : '.'}${String(part)}`,
    )
    .join('');
}

function locate(
  graph: AutomationGraph,
  path: string,
): { nodeId: string | null; stepId: string | null } {
  const nodeMatch = /^nodes\[(\d+)\]/.exec(path);
  if (nodeMatch === null) {
    const edgeMatch = /^edges\[(\d+)\]/.exec(path);
    const edge = edgeMatch === null ? undefined : graph.edges[Number(edgeMatch[1])];
    return { nodeId: edge?.source ?? null, stepId: null };
  }
  const node = graph.nodes[Number(nodeMatch[1])];
  if (node === undefined) return { nodeId: null, stepId: null };
  const stepMatch = /^nodes\[\d+\]\.steps\[(\d+)\]/.exec(path);
  const step =
    stepMatch !== null && node.type === 'sequence' ? node.steps[Number(stepMatch[1])] : undefined;
  return { nodeId: node.id, stepId: step?.id ?? null };
}

/** Schema problems of the draft (blocks autosave until fixed). */
export function localIssues(graph: AutomationGraph): CanvasIssue[] {
  const result = automationGraphSchema.safeParse(graph);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = pathText(issue.path);
    return { severity: 'error', message: issue.message, path, ...locate(graph, path) };
  });
}

/** Publish validation issues, located on the canvas. */
export function serverIssues(
  graph: AutomationGraph,
  issues: readonly ValidationIssue[],
): CanvasIssue[] {
  return issues.map((issue) => {
    const located = locate(graph, issue.path);
    return {
      severity: issue.severity,
      message: issue.message,
      path: issue.path,
      nodeId: issue.node_id ?? located.nodeId,
      stepId: located.stepId,
    };
  });
}

export function groupIssues(issues: readonly CanvasIssue[]): Map<string, NodeIssues> {
  const out = new Map<string, NodeIssues>();
  for (const issue of issues) {
    if (issue.nodeId === null) continue;
    const prev = out.get(issue.nodeId) ?? {
      errors: 0,
      warnings: 0,
      messages: [],
      byStep: new Map(),
    };
    const byStep = new Map(prev.byStep);
    if (issue.stepId !== null)
      byStep.set(issue.stepId, [...(byStep.get(issue.stepId) ?? []), issue]);
    out.set(issue.nodeId, {
      errors: prev.errors + (issue.severity === 'error' ? 1 : 0),
      warnings: prev.warnings + (issue.severity === 'warning' ? 1 : 0),
      messages: [...prev.messages, issue],
      byStep,
    });
  }
  return out;
}

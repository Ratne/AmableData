import { SsrfBlockedError, assertSafeUrl } from '@amable/auth/security';
import {
  DEFAULT_HANDLE,
  type AutomationGraph,
  type AutomationSettings,
  type GraphNode,
  type Step,
  type ValidationIssue,
  type ValidationResult,
} from '@amable/api-types';
import { validateAppInput, type AppInputSchema } from '@amable/core/apps';
import { compileGraph } from './graph';
import { isValidTimeZone, parseDate } from './time';

/** Looks up another automation's graph (for add/remove-from-sequence targets). */
export type AutomationLookup = (automationId: string) => { graph: AutomationGraph } | null;

/** Input schema of every action of the installed apps (active or paused), by app id then action key. */
export type AppActionCatalog = Readonly<Record<string, Readonly<Record<string, AppInputSchema>>>>;

interface ValidationContext {
  automationId: string;
  lookup: AutomationLookup;
  /** Without it (internal callers) `app_action` steps are not checked against the apps. */
  apps?: AppActionCatalog;
}

/**
 * Publish validation: the shape is already guaranteed by the Zod schema, this
 * checks semantics. Errors block publishing, warnings are reported only.
 */
export function validateGraph(
  graph: AutomationGraph,
  settings: AutomationSettings,
  context: ValidationContext,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (
    severity: ValidationIssue['severity'],
    code: string,
    message: string,
    path: string,
    nodeId: string | null = null,
  ): void => {
    issues.push({ severity, code, message, path, node_id: nodeId });
  };

  // ---- ids
  const nodeIds = new Set<string>();
  graph.nodes.forEach((node, i) => {
    if (nodeIds.has(node.id))
      add('error', 'duplicate_node_id', `duplicate node id ${node.id}`, `nodes[${i}].id`, node.id);
    nodeIds.add(node.id);
  });
  const stepIds = new Set<string>();
  graph.nodes.forEach((node, i) => {
    if (node.type === 'sequence') {
      node.steps.forEach((step, j) => {
        if (stepIds.has(step.id) || nodeIds.has(step.id)) {
          add(
            'error',
            'duplicate_step_id',
            `duplicate step id ${step.id}`,
            `nodes[${i}].steps[${j}].id`,
            node.id,
          );
        }
        stepIds.add(step.id);
      });
    }
    if (node.type === 'decision') {
      const branchIds = new Set<string>();
      node.branches.forEach((b, j) => {
        if (branchIds.has(b.id) || b.id === DEFAULT_HANDLE) {
          add(
            'error',
            'duplicate_branch_id',
            `invalid or duplicate branch id ${b.id}`,
            `nodes[${i}].branches[${j}].id`,
            node.id,
          );
        }
        branchIds.add(b.id);
      });
    }
  });

  // ---- edges
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  graph.edges.forEach((edge, i) => {
    const path = `edges[${i}]`;
    if (edgeIds.has(edge.id))
      add('error', 'duplicate_edge_id', `duplicate edge id ${edge.id}`, `${path}.id`);
    edgeIds.add(edge.id);
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined)
      add('error', 'unknown_node', `edge source ${edge.source} does not exist`, `${path}.source`);
    if (target === undefined)
      add('error', 'unknown_node', `edge target ${edge.target} does not exist`, `${path}.target`);
    if (source === undefined || target === undefined) return;
    if (source.type === 'note' || target.type === 'note') {
      add(
        'error',
        'note_connected',
        'notes cannot be connected',
        path,
        source.type === 'note' ? source.id : target.id,
      );
    }
    if (edge.source === edge.target)
      add('error', 'self_loop', 'a node cannot connect to itself', path, source.id);
    if (source.type === 'decision') {
      const handle = edge.source_handle ?? DEFAULT_HANDLE;
      if (handle !== DEFAULT_HANDLE && !source.branches.some((b) => b.id === handle)) {
        add(
          'error',
          'unknown_branch',
          `decision ${source.id} has no branch ${handle}`,
          `${path}.source_handle`,
          source.id,
        );
      }
    } else if (edge.source_handle !== undefined) {
      add(
        'warning',
        'ignored_handle',
        'source_handle is only meaningful on decisions',
        `${path}.source_handle`,
        source.id,
      );
    }
    const pair = `${edge.source}>${edge.target}>${edge.source_handle ?? ''}`;
    if (pairs.has(pair)) add('warning', 'duplicate_edge', 'duplicate connection', path, source.id);
    pairs.add(pair);
  });

  const compiled = compileGraph(graph);

  // ---- entry points + reachability
  if (compiled.entryGoals.length === 0) {
    add(
      'error',
      'no_entry_goal',
      'the automation needs at least one goal without incoming connections',
      'nodes',
    );
  }
  const reachable = new Set<string>();
  const queue = compiled.entryGoals.map((g) => g.id);
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of compiled.outgoing.get(id) ?? []) queue.push(edge.target);
  }
  graph.nodes.forEach((node, i) => {
    if (node.type === 'note' || node.type === 'goal') return;
    if (!reachable.has(node.id)) {
      add(
        'error',
        'unreachable',
        `${node.type} ${node.id} cannot be reached from any entry goal`,
        `nodes[${i}]`,
        node.id,
      );
    }
  });

  // ---- cycles that never wait for a goal would loop forever
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    state.set(id, 1);
    for (const edge of compiled.outgoing.get(id) ?? []) {
      const target = byId.get(edge.target);
      if (target === undefined || target.type === 'goal') continue;
      const s = state.get(target.id);
      if (s === 1) return true;
      if (s === undefined && visit(target.id)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const node of graph.nodes) {
    if (
      (node.type === 'sequence' || node.type === 'decision') &&
      !state.has(node.id) &&
      visit(node.id)
    ) {
      add(
        'error',
        'cycle',
        `connections starting at ${node.id} form a loop without a goal`,
        'edges',
        node.id,
      );
      break;
    }
  }

  // ---- node contents
  graph.nodes.forEach((node, i) => validateNode(node, `nodes[${i}]`, add, context));
  if (settings.time_zone !== undefined && !isValidTimeZone(settings.time_zone)) {
    add(
      'error',
      'invalid_time_zone',
      `unknown time zone ${settings.time_zone}`,
      'settings.time_zone',
    );
  }

  return { valid: !issues.some((issue) => issue.severity === 'error'), issues };
}

type Add = (
  severity: ValidationIssue['severity'],
  code: string,
  message: string,
  path: string,
  nodeId?: string | null,
) => void;

function checkZone(zone: string | undefined, path: string, add: Add, nodeId: string): void {
  if (zone !== undefined && zone !== 'tenant' && !isValidTimeZone(zone)) {
    add('error', 'invalid_time_zone', `unknown time zone ${zone}`, path, nodeId);
  }
}

function validateNode(
  node: GraphNode,
  path: string,
  add: Add,
  context: ValidationContext,
): void {
  if (node.type === 'goal') {
    node.triggers.forEach((trigger, j) => {
      if (trigger.type === 'date_anniversary') {
        checkZone(trigger.time_zone, `${path}.triggers[${j}].time_zone`, add, node.id);
      }
    });
    return;
  }
  if (node.type === 'decision' || node.type === 'note') return;
  if (node.steps.length === 0)
    add('warning', 'empty_sequence', `sequence ${node.id} has no steps`, `${path}.steps`, node.id);
  node.steps.forEach((step, j) => validateStep(step, `${path}.steps[${j}]`, add, node.id, context));
}

function validateStep(
  step: Step,
  path: string,
  add: Add,
  nodeId: string,
  context: ValidationContext,
): void {
  switch (step.type) {
    case 'wait_until':
      if (parseDate(step.date) === null)
        add('error', 'invalid_date', 'invalid date', `${path}.date`, nodeId);
      checkZone(step.time_zone, `${path}.time_zone`, add, nodeId);
      return;
    case 'field_timer':
      checkZone(step.time_zone, `${path}.time_zone`, add, nodeId);
      return;
    case 'send_email':
      if (
        step.template_id === undefined &&
        (step.subject === undefined || step.body === undefined)
      ) {
        add(
          'error',
          'email_content_missing',
          'an email step needs a template or a subject and a body',
          path,
          nodeId,
        );
      }
      return;
    case 'set_field':
      if (step.mode === 'increment' && typeof step.value !== 'number') {
        add(
          'error',
          'increment_not_number',
          'increment needs a numeric value',
          `${path}.value`,
          nodeId,
        );
      }
      return;
    case 'http_request':
      try {
        assertSafeUrl(step.url);
      } catch (error) {
        const reason = error instanceof SsrfBlockedError ? error.message : 'invalid URL';
        add('error', 'url_blocked', `URL not allowed: ${reason}`, `${path}.url`, nodeId);
      }
      return;
    case 'add_to_sequence':
    case 'remove_from_sequence': {
      const target = context.lookup(step.automation_id);
      if (target === null) {
        add(
          'error',
          'unknown_automation',
          `automation ${step.automation_id} does not exist`,
          `${path}.automation_id`,
          nodeId,
        );
        return;
      }
      if (step.node_id !== undefined) {
        const targetNode = target.graph.nodes.find((n) => n.id === step.node_id);
        if (targetNode?.type !== 'sequence') {
          add(
            'error',
            'unknown_sequence',
            `sequence ${step.node_id} not found in automation ${step.automation_id}`,
            `${path}.node_id`,
            nodeId,
          );
        }
      }
      return;
    }
    case 'app_action': {
      if (context.apps === undefined) return;
      const actions = context.apps[step.app_id];
      if (actions === undefined) {
        add('error', 'app_not_installed', `app ${step.app_id} is not installed`, `${path}.app_id`, nodeId);
        return;
      }
      const schema = actions[step.action_key];
      if (schema === undefined) {
        add('error', 'unknown_app_action', `${step.app_id} has no action ${step.action_key}`, `${path}.action_key`, nodeId);
        return;
      }
      for (const issue of validateAppInput(schema, step.input)) {
        add('error', `app_input_${issue.code}`, `${issue.key}: ${issue.code}`, `${path}.input.${issue.key}`, nodeId);
      }
      return;
    }
    default:
      return;
  }
}

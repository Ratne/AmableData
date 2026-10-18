import {
  DEFAULT_HANDLE,
  type AutomationGraph,
  type DecisionNode,
  type GoalNode,
  type GoalTrigger,
  type GraphEdge,
  type GraphNode,
  type SequenceNode,
} from '@amable/api-types';

/** Event type(s) each goal trigger listens to. */
export const TRIGGER_EVENTS: Record<GoalTrigger['type'], readonly string[]> = {
  tag_applied: ['contact.tag_applied'],
  tag_removed: ['contact.tag_removed'],
  contact_created: ['contact.created'],
  form_submitted: ['form.submitted'],
  product_purchased: ['order.paid'],
  order_paid: ['order.paid'],
  email_opened: ['email.opened'],
  email_clicked: ['email.link_clicked'],
  lead_score: ['contact.score_changed'],
  api: ['automation.api_goal'],
  web_goal: ['analytics.goal'],
  appointment_booked: ['appointment.booked', 'appointment.created'],
  opportunity_stage_changed: ['opportunity.stage_changed'],
  date_anniversary: ['automation.date_anniversary'],
  app_event: ['app.event'],
};

export interface GoalRef {
  node: GoalNode;
  trigger: GoalTrigger;
  triggerIndex: number;
}

/** Graph with adjacency, upstream sets and a goal index, built once per version. */
export interface CompiledGraph {
  readonly graph: AutomationGraph;
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly outgoing: ReadonlyMap<string, readonly GraphEdge[]>;
  readonly incoming: ReadonlyMap<string, readonly GraphEdge[]>;
  /** Goal nodes without incoming edges. */
  readonly entryGoals: readonly GoalNode[];
  readonly goalsByEvent: ReadonlyMap<string, readonly GoalRef[]>;
  /** Every node from which `nodeId` is reachable (excluding itself). */
  upstreamOf(nodeId: string): ReadonlySet<string>;
  /** Goal ids directly reachable from a node's outgoing edges. */
  goalTargetsOf(nodeId: string): string[];
}

export function compileGraph(graph: AutomationGraph): CompiledGraph {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
  }
  const goals = graph.nodes.filter((n): n is GoalNode => n.type === 'goal');
  const entryGoals = goals.filter((g) => (incoming.get(g.id) ?? []).length === 0);
  const goalsByEvent = new Map<string, GoalRef[]>();
  for (const node of goals) {
    node.triggers.forEach((trigger, triggerIndex) => {
      for (const eventType of TRIGGER_EVENTS[trigger.type]) {
        goalsByEvent.set(eventType, [
          ...(goalsByEvent.get(eventType) ?? []),
          { node, trigger, triggerIndex },
        ]);
      }
    });
  }
  const upstreamCache = new Map<string, ReadonlySet<string>>();
  return {
    graph,
    nodes,
    outgoing,
    incoming,
    entryGoals,
    goalsByEvent,
    upstreamOf(nodeId) {
      const cached = upstreamCache.get(nodeId);
      if (cached !== undefined) return cached;
      const seen = new Set<string>();
      const queue = [nodeId];
      while (queue.length > 0) {
        const current = queue.pop() as string;
        for (const edge of incoming.get(current) ?? []) {
          if (!seen.has(edge.source) && edge.source !== nodeId) {
            seen.add(edge.source);
            queue.push(edge.source);
          }
        }
      }
      upstreamCache.set(nodeId, seen);
      return seen;
    },
    goalTargetsOf(nodeId) {
      return (outgoing.get(nodeId) ?? [])
        .filter((e) => nodes.get(e.target)?.type === 'goal')
        .map((e) => e.target);
    },
  };
}

/** Outgoing edges followed when leaving a node (decisions: only the chosen handle). */
export function edgesFrom(
  compiled: CompiledGraph,
  nodeId: string,
  handle: string | null,
): GraphEdge[] {
  const node = compiled.nodes.get(nodeId);
  return (compiled.outgoing.get(nodeId) ?? []).filter((edge) =>
    node?.type === 'decision' ? (edge.source_handle ?? DEFAULT_HANDLE) === handle : true,
  );
}

export function isSequence(node: GraphNode | undefined): node is SequenceNode {
  return node?.type === 'sequence';
}

export function isDecision(node: GraphNode | undefined): node is DecisionNode {
  return node?.type === 'decision';
}

/** Every step id of the graph mapped to its sequence (step ids are unique per graph). */
export function stepIndex(graph: AutomationGraph): Map<string, { nodeId: string; index: number }> {
  const out = new Map<string, { nodeId: string; index: number }>();
  for (const node of graph.nodes) {
    if (node.type !== 'sequence') continue;
    node.steps.forEach((step, index) => out.set(step.id, { nodeId: node.id, index }));
  }
  return out;
}

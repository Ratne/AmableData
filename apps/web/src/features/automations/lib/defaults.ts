import type { GoalTrigger, GoalTriggerType, GraphNode, Step, StepType } from '@amable/api-types';
import { uniqueId } from './ids';

/**
 * Starting values for new canvas items. Required lists start empty: the local
 * check flags them inline until the user picks something.
 */

export const GOAL_TYPES: readonly GoalTriggerType[] = [
  'tag_applied',
  'tag_removed',
  'contact_created',
  'form_submitted',
  'product_purchased',
  'order_paid',
  'email_opened',
  'email_clicked',
  'lead_score',
  'api',
  'web_goal',
  'appointment_booked',
  'opportunity_stage_changed',
  'date_anniversary',
];

export function defaultTrigger(type: GoalTriggerType): GoalTrigger {
  switch (type) {
    case 'tag_applied':
    case 'tag_removed':
      return { type, tag_ids: [] };
    case 'contact_created':
      return { type };
    case 'form_submitted':
      return { type };
    case 'product_purchased':
      return { type };
    case 'order_paid':
      return { type };
    case 'email_opened':
      return { type };
    case 'email_clicked':
      return { type };
    case 'lead_score':
      return { type, threshold: 50, direction: 'reaches' };
    case 'api':
      return { type, call_name: 'my.goal' };
    case 'web_goal':
      return { type, goal_name: '' };
    case 'appointment_booked':
      return { type };
    case 'opportunity_stage_changed':
      return { type };
    case 'date_anniversary':
      return { type, field: 'birthday', offset_days: 0, time: '09:00' };
  }
}

/** Step palette, grouped as in the sequence editor. */
export const STEP_GROUPS: ReadonlyArray<{
  id: 'timers' | 'messages' | 'crm' | 'commerce' | 'flow';
  types: readonly StepType[];
}> = [
  { id: 'timers', types: ['delay', 'wait_until', 'field_timer'] },
  { id: 'messages', types: ['send_email', 'http_request'] },
  {
    id: 'crm',
    types: [
      'apply_tag',
      'remove_tag',
      'add_note',
      'create_task',
      'create_appointment',
      'set_field',
      'assign_owner',
      'create_opportunity',
      'move_opportunity_stage',
    ],
  },
  { id: 'commerce', types: ['create_order', 'cancel_subscription'] },
  { id: 'flow', types: ['add_to_sequence', 'remove_from_sequence', 'end'] },
];

const EMPTY_DOC = { type: 'doc' as const, content: [{ type: 'paragraph' }] };

function tomorrow(): string {
  const date = new Date(Date.now() + 86_400_000);
  return date.toISOString().slice(0, 10);
}

export function defaultStep(type: StepType, id: string): Step {
  switch (type) {
    case 'delay':
      return { id, type, duration: { amount: 1, unit: 'days' } };
    case 'wait_until':
      return { id, type, date: tomorrow(), time: '09:00' };
    case 'field_timer':
      return { id, type, field: 'birthday', time: '09:00', yearly: true };
    case 'send_email':
      return { id, type, subject: 'Hello {{ contact.first_name }}', body: EMPTY_DOC };
    case 'apply_tag':
    case 'remove_tag':
      return { id, type, tag_ids: [] };
    case 'add_note':
      return { id, type, body: EMPTY_DOC };
    case 'create_task':
      return {
        id,
        type,
        title: 'Follow up',
        due_in: { amount: 1, unit: 'days' },
        assign_to: 'contact_owner',
      };
    case 'create_appointment':
      return {
        id,
        type,
        title: 'Call',
        start_in: { amount: 1, unit: 'days' },
        duration_minutes: 30,
      };
    case 'set_field':
      return { id, type, field: 'score_value', value: 10, mode: 'increment' };
    case 'assign_owner':
      return { id, type, user_ids: [], strategy: 'round_robin' };
    case 'create_opportunity':
      return { id, type, title: 'New deal' };
    case 'move_opportunity_stage':
      return { id, type, pipeline_id: '', stage_id: '', if_missing: 'skip' };
    case 'create_order':
      return { id, type, items: [] };
    case 'cancel_subscription':
      return { id, type, at_period_end: true };
    case 'http_request':
      return { id, type, method: 'POST', url: 'https://example.com/webhook', payload: 'contact' };
    case 'add_to_sequence':
      return { id, type, automation_id: '', node_id: '' };
    case 'remove_from_sequence':
      return { id, type, automation_id: '' };
    case 'end':
      return { id, type };
  }
}

export type PaletteItem =
  | { kind: 'goal'; trigger: GoalTriggerType }
  | { kind: 'sequence' }
  | { kind: 'decision' }
  | { kind: 'note' };

/** A new graph node for a palette item at a canvas position. */
export function createNode(
  item: PaletteItem,
  position: { x: number; y: number },
  taken: ReadonlySet<string>,
): GraphNode {
  const at = { x: Math.round(position.x), y: Math.round(position.y) };
  switch (item.kind) {
    case 'goal':
      return {
        id: uniqueId('goal', taken),
        type: 'goal',
        position: at,
        triggers: [defaultTrigger(item.trigger)],
      };
    case 'sequence':
      return { id: uniqueId('seq', taken), type: 'sequence', position: at, steps: [] };
    case 'decision': {
      const ids = new Set(taken);
      const id = uniqueId('dec', ids);
      ids.add(id);
      return {
        id,
        type: 'decision',
        position: at,
        branches: [
          {
            id: uniqueId('b', ids),
            label: 'Yes',
            filter: { type: 'group', op: 'and', conditions: [] },
          },
        ],
      };
    }
    case 'note':
      return {
        id: uniqueId('note', taken),
        type: 'note',
        position: at,
        text: '',
        width: 220,
        height: 120,
      };
  }
}

/** Copy of a node with fresh ids (node, steps, branches), offset on the canvas. */
export function duplicateNode(node: GraphNode, taken: ReadonlySet<string>): GraphNode {
  const ids = new Set(taken);
  const fresh = (prefix: string): string => {
    const id = uniqueId(prefix, ids);
    ids.add(id);
    return id;
  };
  const position = { x: node.position.x + 40, y: node.position.y + 40 };
  switch (node.type) {
    case 'goal':
      return { ...node, id: fresh('goal'), position };
    case 'sequence':
      return {
        ...node,
        id: fresh('seq'),
        position,
        steps: node.steps.map((step) => ({ ...step, id: fresh('st') })),
      };
    case 'decision':
      return {
        ...node,
        id: fresh('dec'),
        position,
        branches: node.branches.map((branch) => ({ ...branch, id: fresh('b') })),
      };
    case 'note':
      return { ...node, id: fresh('note'), position };
  }
}

import type { AutomationGraph } from '@amable/api-types';
import type { SqlDb } from '../crm/db/sql';
import type { AutomationEngine } from './engine';
import { crmCall } from './ports';
import { getMeta, setMeta } from './store';

export interface AutomationSeedSummary {
  seeded: boolean;
  automations: Array<{ id: string; name: string; status: string }>;
}

const doc = (text: string): { type: 'doc'; content: unknown[] } => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function tagId(engine: AutomationEngine, name: string): Promise<string> {
  const crm = engine.ports.crm;
  const existing = await crmCall(crm, 'tags.list', { limit: 200, name });
  const found = existing.data.find((tag) => tag.name === name);
  if (found !== undefined) return found.id;
  return (await crmCall(crm, 'tags.create', { name })).id;
}

/** Dev seed: a welcome series (goal → email → delay → decision) and a birthday + API goal flow. Idempotent. */
export async function seedAutomations(
  db: SqlDb,
  engine: AutomationEngine,
): Promise<AutomationSeedSummary> {
  if (getMeta(db, 'seeded_at') !== null) {
    const list = engine.listAutomations({ limit: 50 });
    return {
      seeded: false,
      automations: list.data.map((a) => ({ id: a.id, name: a.name, status: a.status })),
    };
  }
  const newLead = await tagId(engine, 'New lead');
  const webinar = await tagId(engine, 'Webinar attendee');

  const welcome: AutomationGraph = {
    schema_version: 1,
    nodes: [
      {
        id: 'goal_new_lead',
        type: 'goal',
        position: { x: 0, y: 0 },
        label: 'Tagged as new lead',
        triggers: [{ type: 'tag_applied', tag_ids: [newLead] }],
      },
      {
        id: 'seq_welcome',
        type: 'sequence',
        position: { x: 300, y: 0 },
        label: 'Welcome',
        steps: [
          {
            id: 'st_welcome_email',
            type: 'send_email',
            subject: 'Welcome, {{ contact.given_name | default: "friend" }}!',
            body: doc('Thanks for your interest.'),
            window: { start: '09:00', end: '18:00' },
          },
          { id: 'st_wait_2d', type: 'delay', duration: { amount: 2, unit: 'days' } },
        ],
      },
      {
        id: 'dec_score',
        type: 'decision',
        position: { x: 600, y: 0 },
        label: 'Engaged?',
        branches: [
          {
            id: 'hot',
            label: 'Score ≥ 50',
            filter: {
              type: 'group',
              op: 'and',
              conditions: [{ type: 'field', field: 'score_value', operator: 'gte', value: 50 }],
            },
          },
        ],
      },
      {
        id: 'seq_sales',
        type: 'sequence',
        position: { x: 900, y: -120 },
        label: 'Hand over to sales',
        steps: [
          {
            id: 'st_task_call',
            type: 'create_task',
            title: 'Call the new lead',
            assign_to: 'contact_owner',
            due_in: { amount: 1, unit: 'days' },
            task_type: 'call',
          },
          {
            id: 'st_note',
            type: 'add_note',
            title: 'Automation',
            body: doc('Hot lead from the welcome series.'),
          },
        ],
      },
      {
        id: 'seq_nurture',
        type: 'sequence',
        position: { x: 900, y: 120 },
        label: 'Nurture',
        steps: [
          {
            id: 'st_nurture_email',
            type: 'send_email',
            subject: 'A few resources for you',
            body: doc('Here is what other customers found useful.'),
          },
          { id: 'st_score', type: 'set_field', field: 'score_value', value: 10, mode: 'increment' },
        ],
      },
      {
        id: 'goal_replied',
        type: 'goal',
        position: { x: 600, y: 240 },
        label: 'Became a webinar attendee',
        triggers: [{ type: 'tag_applied', tag_ids: [webinar] }],
        accept: 'enrolled_only',
      },
      {
        id: 'seq_webinar',
        type: 'sequence',
        position: { x: 900, y: 300 },
        label: 'Webinar follow-up',
        steps: [
          {
            id: 'st_webinar_email',
            type: 'send_email',
            subject: 'Thanks for joining',
            body: doc('Here is the recording.'),
          },
        ],
      },
      {
        id: 'note_1',
        type: 'note',
        position: { x: 0, y: 200 },
        text: 'Demo automation created by the local seed.',
      },
    ],
    edges: [
      { id: 'e1', source: 'goal_new_lead', target: 'seq_welcome' },
      { id: 'e2', source: 'seq_welcome', target: 'dec_score' },
      { id: 'e3', source: 'dec_score', source_handle: 'hot', target: 'seq_sales' },
      { id: 'e4', source: 'dec_score', source_handle: 'default', target: 'seq_nurture' },
      { id: 'e5', source: 'seq_nurture', target: 'goal_replied' },
      { id: 'e6', source: 'goal_replied', target: 'seq_webinar' },
    ],
  };

  const birthday: AutomationGraph = {
    schema_version: 1,
    nodes: [
      {
        id: 'goal_birthday',
        type: 'goal',
        position: { x: 0, y: 0 },
        label: 'Birthday',
        triggers: [{ type: 'date_anniversary', field: 'birthday', time: '09:00' }],
      },
      {
        id: 'goal_api',
        type: 'goal',
        position: { x: 0, y: 200 },
        label: 'Registered via API',
        triggers: [{ type: 'api', call_name: 'webinar.registered' }],
      },
      {
        id: 'seq_birthday',
        type: 'sequence',
        position: { x: 300, y: 0 },
        label: 'Greetings',
        steps: [
          {
            id: 'st_bday_email',
            type: 'send_email',
            subject: 'Happy birthday!',
            body: doc('All the best from the team.'),
          },
        ],
      },
      {
        id: 'seq_webinar_reg',
        type: 'sequence',
        position: { x: 300, y: 200 },
        label: 'Webinar registration',
        steps: [
          { id: 'st_tag_webinar', type: 'apply_tag', tag_ids: [webinar] },
          {
            id: 'st_reminder',
            type: 'wait_until',
            date: '2026-12-01',
            time: '10:00',
            time_zone: 'tenant',
          },
          {
            id: 'st_reminder_email',
            type: 'send_email',
            subject: 'Starting soon',
            body: doc('The webinar starts in one hour.'),
          },
        ],
      },
    ],
    edges: [
      { id: 'e1', source: 'goal_birthday', target: 'seq_birthday' },
      { id: 'e2', source: 'goal_api', target: 'seq_webinar_reg' },
    ],
  };

  const actor = { userId: null };
  return db.transaction(() => {
    const created = [
      engine.createAutomation(actor, {
        name: 'Welcome series',
        description: 'Demo: welcome email, decision on lead score, sales hand-over.',
        graph: welcome,
        settings: { reentry: 'once' },
      }),
      engine.createAutomation(actor, {
        name: 'Birthday & webinar',
        description: 'Demo: yearly birthday goal and an API goal.',
        graph: birthday,
        settings: { reentry: 'multiple' },
      }),
    ];
    const automations = created.map((a) => {
      const published = engine.publish(actor, { id: a.id });
      return { id: a.id, name: a.name, status: published.automation.status };
    });
    setMeta(db, 'seeded_at', String(engine.ports.now()));
    return { seeded: true, automations };
  });
}

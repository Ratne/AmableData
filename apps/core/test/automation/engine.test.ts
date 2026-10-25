import { verifyWebhook } from '@amable/auth';
import { describe, expect, it } from 'vitest';
import { backoffMs, LOG_RETENTION_MS, MAX_ATTEMPTS } from '../../src/automation/engine';
import {
  DAY,
  HOUR,
  createEngineHarness,
  doc,
  edge,
  goal,
  graph,
  seq,
  tagStep,
  type EngineHarness,
} from './helpers';

function enrollments(
  h: EngineHarness,
  automationId: string,
): Array<{ contact_id: string; status: string }> {
  return h.db.all(
    `SELECT contact_id, status FROM eng_enrollments WHERE automation_id = ? ORDER BY id`,
    automationId,
  );
}

async function nodeStat(
  h: EngineHarness,
  id: string,
  nodeId: string,
  stepId: string | null = null,
) {
  const stats = await h.op('automations.stats', { id });
  const stat = stats.nodes.find((s) => s.node_id === nodeId && s.step_id === stepId);
  if (stat === undefined) throw new Error(`no stats for ${nodeId}/${stepId ?? ''}`);
  return stat;
}

describe('goal matching from the outbox', () => {
  it('enrolls contacts whose tag matches and runs the sequence', async () => {
    const h = createEngineHarness();
    const trigger = h.tag('Lead');
    const other = h.tag('Other');
    const done = h.tag('Welcomed');
    const id = await h.publish(
      graph(
        [goal('g', [{ type: 'tag_applied', tag_ids: [trigger] }]), seq('s', [tagStep('t1', done)])],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact('Ada');
    const bob = h.contact('Bob');
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [trigger] } });
    h.tenant.op('contacts.applyTags', { id: bob, data: { tag_ids: [other] } });
    await h.flush();

    expect(enrollments(h, id)).toEqual([{ contact_id: ada, status: 'completed' }]);
    expect(h.tagsOf(ada)).toContain(done);
    expect(h.tagsOf(bob)).not.toContain(done);
    // Every outbox event was acked.
    expect(h.tenant.db.all(`SELECT id FROM crm_outbox WHERE dispatched_at IS NULL`)).toHaveLength(
      0,
    );
  });

  it('dedupes redelivered events by id (at-least-once outbox)', async () => {
    const h = createEngineHarness();
    const trigger = h.tag('Lead');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [trigger] }]),
          seq('s', [{ id: 'd', type: 'delay', duration: { amount: 1, unit: 'days' } }]),
        ],
        [edge('g', 's')],
      ),
      { reentry: 'multiple' },
    );
    const ada = h.contact();
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [trigger] } });
    await h.flush();
    // Simulate a crash before the ack: the same events come back.
    h.tenant.db.run(`UPDATE crm_outbox SET dispatched_at = NULL`);
    await h.flush();
    expect(enrollments(h, id)).toHaveLength(1);
    expect((await nodeStat(h, id, 'g')).entered).toBe(1);
  });

  it('matches events pushed by other modules and API goals', async () => {
    const h = createEngineHarness();
    const tagged = h.tag('Form filled');
    const vip = h.tag('VIP');
    const id = await h.publish(
      graph(
        [
          goal('form', [{ type: 'form_submitted', form_ids: ['form_1'] }]),
          goal('api', [{ type: 'api', call_name: 'webinar.registered' }]),
          seq('s1', [tagStep('t1', tagged)]),
          seq('s2', [tagStep('t2', vip)]),
        ],
        [edge('form', 's1'), edge('api', 's2')],
      ),
      { reentry: 'multiple' },
    );
    const ada = h.contact();
    const result = await h.engine.ingest([
      {
        id: 'evt_1',
        type: 'form.submitted',
        occurredAt: new Date(h.clock.now).toISOString(),
        payload: { contactId: ada, formId: 'form_1', submissionId: 'sub_1' },
      },
      {
        id: 'evt_2',
        type: 'form.submitted',
        occurredAt: new Date(h.clock.now).toISOString(),
        payload: { contactId: ada, formId: 'form_other', submissionId: 'sub_2' },
      },
    ]);
    expect(result.matched).toBe(1);
    const api = await h.op('goals.triggerApi', {
      callName: 'webinar.registered',
      data: { contact_id: ada, event_id: 'call-1' },
    });
    expect(api.matched).toEqual([{ automation_id: id, node_id: 'api' }]);
    const again = await h.op('goals.triggerApi', {
      callName: 'webinar.registered',
      data: { contact_id: ada, event_id: 'call-1' },
    });
    expect(again.duplicate).toBe(true);
    await h.flush();
    expect(h.tagsOf(ada)).toEqual(expect.arrayContaining([tagged, vip]));
  });

  it('matches lead score thresholds and opportunity stage changes', async () => {
    const h = createEngineHarness();
    const hot = h.tag('Hot');
    const won = h.tag('Proposal');
    const pipeline = h.tenant.op('pipelines.create', {
      name: 'Deals',
      stages: [{ name: 'New' }, { name: 'Proposal' }],
    });
    const proposal = pipeline.stages[1]?.id ?? '';
    await h.publish(
      graph(
        [
          goal('score', [{ type: 'lead_score', threshold: 50 }]),
          goal('stage', [{ type: 'opportunity_stage_changed', to_stage_ids: [proposal] }]),
          seq('s1', [tagStep('t1', hot)]),
          seq('s2', [tagStep('t2', won)]),
        ],
        [edge('score', 's1'), edge('stage', 's2')],
      ),
      { reentry: 'multiple' },
    );
    const ada = h.contact();
    h.tenant.op('contacts.update', { id: ada, data: { score_value: 40 } });
    await h.flush();
    expect(h.tagsOf(ada)).not.toContain(hot);
    h.tenant.op('contacts.update', { id: ada, data: { score_value: 60 } });
    const opp = h.tenant.op('opportunities.create', {
      title: 'Deal',
      pipeline_id: pipeline.id,
      contact_id: ada,
    });
    h.tenant.op('opportunities.update', { id: opp.id, data: { stage_id: proposal } });
    await h.flush();
    expect(h.tagsOf(ada)).toEqual(expect.arrayContaining([hot, won]));
  });

  it('drains a large backlog in batches that fit the Durable Object parameter limit', async () => {
    const h = createEngineHarness();
    const trigger = h.tag('Lead');
    const id = await h.publish(
      graph([goal('g', [{ type: 'contact_created' }]), seq('s', [])], [edge('g', 's')]),
    );
    const ids = Array.from({ length: 150 }, (_, i) => h.contact(`C${i}`));
    h.tenant.op('tags.apply', { tagId: trigger, contactIds: ids });
    await h.flush();
    expect(enrollments(h, id)).toHaveLength(150);
    expect(h.tenant.db.all(`SELECT id FROM crm_outbox WHERE dispatched_at IS NULL`)).toHaveLength(
      0,
    );
  });

  it('removes contacts from automations when they are deleted', async () => {
    const h = createEngineHarness();
    const trigger = h.tag('Lead');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [trigger] }]),
          seq('s', [{ id: 'd', type: 'delay', duration: { amount: 3, unit: 'days' } }]),
        ],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact();
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [trigger] } });
    await h.flush();
    h.tenant.op('contacts.delete', { id: ada });
    await h.flush();
    expect(enrollments(h, id)).toEqual([{ contact_id: ada, status: 'removed' }]);
    expect(h.db.all(`SELECT * FROM eng_jobs WHERE kind = 'token'`)).toHaveLength(0);
  });
});

describe('scheduler', () => {
  it('keeps the alarm on the earliest job and runs timers in due order', async () => {
    const h = createEngineHarness();
    const t1 = h.tag('Short');
    const t2 = h.tag('Long');
    const done = h.tag('Done');
    await h.publish(
      graph(
        [
          goal('g1', [{ type: 'tag_applied', tag_ids: [t1] }]),
          goal('g2', [{ type: 'tag_applied', tag_ids: [t2] }]),
          seq('short', [
            { id: 'd1', type: 'delay', duration: { amount: 1, unit: 'hours' } },
            tagStep('x1', done),
          ]),
          seq('long', [
            { id: 'd2', type: 'delay', duration: { amount: 2, unit: 'hours' } },
            tagStep('x2', done),
          ]),
        ],
        [edge('g1', 'short'), edge('g2', 'long')],
      ),
    );
    const slow = h.contact('Slow');
    const fast = h.contact('Fast');
    h.tenant.op('contacts.applyTags', { id: slow, data: { tag_ids: [t2] } });
    h.tenant.op('contacts.applyTags', { id: fast, data: { tag_ids: [t1] } });
    await h.flush();
    const start = h.clock.now;
    const tokenJobs = h.db.all<{ due_at: number }>(
      `SELECT due_at FROM eng_jobs WHERE kind = 'token' ORDER BY due_at`,
    );
    expect(tokenJobs.map((j) => j.due_at - start)).toEqual(
      [HOUR, 2 * HOUR].map((d) => expect.closeTo(d, -2)),
    );
    // The alarm points at the earliest job of the heap (the outbox fallback poll is later).
    expect(h.alarm.at).toBe(
      Math.min(...h.db.all<{ due_at: number }>(`SELECT due_at FROM eng_jobs`).map((j) => j.due_at)),
    );

    await h.advance(HOUR + 10);
    expect(h.tagsOf(fast)).toContain(done);
    expect(h.tagsOf(slow)).not.toContain(done);
    await h.advance(HOUR);
    expect(h.tagsOf(slow)).toContain(done);
  });

  it('waits for a wall-clock date in the contact time zone, falling back to the tenant zone', async () => {
    const h = createEngineHarness();
    await h.op('settings.update', { time_zone: 'America/New_York' });
    const t = h.tag('Go');
    const done = h.tag('Done');
    await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            { id: 'w', type: 'wait_until', date: '2026-10-20', time: '09:00' },
            tagStep('x', done),
          ]),
        ],
        [edge('g', 's')],
      ),
    );
    const rome = h.tenant.op('contacts.create', {
      given_name: 'Rome',
      time_zone: 'Europe/Rome',
    }).id;
    const ny = h.contact('Ny');
    h.tenant.op('contacts.applyTags', { id: rome, data: { tag_ids: [t] } });
    h.tenant.op('contacts.applyTags', { id: ny, data: { tag_ids: [t] } });
    await h.flush();
    const due = h.db
      .all<{ due_at: number }>(`SELECT due_at FROM eng_jobs WHERE kind = 'token' ORDER BY due_at`)
      .map((j) => j.due_at);
    expect(due).toEqual([Date.UTC(2026, 9, 20, 7, 0), Date.UTC(2026, 9, 20, 13, 0)]);
  });

  it('holds email steps until the send window opens', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            {
              id: 'e',
              type: 'send_email',
              subject: 'Hi',
              body: doc,
              window: { days: [1, 2, 3, 4, 5], start: '09:00', end: '10:00' },
            },
          ]),
        ],
        [edge('g', 's')],
      ),
    );
    // Thursday 2026-10-15 12:00 UTC: today's window is over, next one is Friday 09:00 UTC.
    const ada = h.contact();
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    expect(h.emails).toHaveLength(0);
    h.clock.now = Date.UTC(2026, 9, 16, 9, 0, 5);
    await h.flush();
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]?.content.subject).toBe('Hi');
  });

  it('suspends positions on unpublish and resumes them on publish', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const done = h.tag('Done');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            { id: 'd', type: 'delay', duration: { amount: 1, unit: 'hours' } },
            tagStep('x', done),
          ]),
        ],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact();
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    await h.op('automations.unpublish', { id });
    await h.advance(2 * HOUR);
    expect(h.tagsOf(ada)).not.toContain(done);
    expect(h.db.all(`SELECT status FROM eng_tokens WHERE automation_id = ?`, id)).toEqual([
      { status: 'suspended' },
    ]);
    await h.op('automations.publish', { id });
    await h.flush();
    expect(h.tagsOf(ada)).toContain(done);
  });
});

describe('decisions', () => {
  it('follows the first matching branch, otherwise the default handle', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const hot = h.tag('Hot');
    const cold = h.tag('Cold');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          {
            id: 'dec',
            type: 'decision',
            position: { x: 0, y: 0 },
            branches: [
              {
                id: 'hot',
                filter: {
                  type: 'group',
                  op: 'and',
                  conditions: [{ type: 'field', field: 'score_value', operator: 'gte', value: 50 }],
                },
              },
            ],
          },
          seq('a', [tagStep('ta', hot)]),
          seq('b', [tagStep('tb', cold)]),
        ],
        [edge('g', 'dec'), edge('dec', 'a', 'hot'), edge('dec', 'b', 'default')],
      ),
    );
    const high = h.tenant.op('contacts.create', { given_name: 'High', score_value: 80 }).id;
    const low = h.tenant.op('contacts.create', { given_name: 'Low', score_value: 10 }).id;
    h.tenant.op('contacts.applyTags', { id: high, data: { tag_ids: [t] } });
    h.tenant.op('contacts.applyTags', { id: low, data: { tag_ids: [t] } });
    await h.flush();
    expect(h.tagsOf(high)).toContain(hot);
    expect(h.tagsOf(high)).not.toContain(cold);
    expect(h.tagsOf(low)).toContain(cold);
    expect(await nodeStat(h, id, 'dec')).toMatchObject({ entered: 2, completed: 2, active: 0 });
  });
});

describe('goal behaviour', () => {
  it('pulls contacts forward out of upstream sequences when a later goal is reached', async () => {
    const h = createEngineHarness();
    const start = h.tag('Start');
    const bought = h.tag('Bought');
    const thanks = h.tag('Thanked');
    const id = await h.publish(
      graph(
        [
          goal('g1', [{ type: 'tag_applied', tag_ids: [start] }]),
          seq('nurture', [
            { id: 'wait', type: 'delay', duration: { amount: 30, unit: 'days' } },
            { id: 'mail', type: 'send_email', subject: 'Still there?', body: doc },
          ]),
          goal('g2', [{ type: 'tag_applied', tag_ids: [bought] }], { accept: 'enrolled_only' }),
          seq('after', [tagStep('t', thanks)]),
        ],
        [edge('g1', 'nurture'), edge('nurture', 'g2'), edge('g2', 'after')],
      ),
    );
    const ada = h.contact('Ada');
    const outsider = h.contact('Out');
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [start] } });
    await h.flush();
    expect(await nodeStat(h, id, 'nurture')).toMatchObject({ entered: 1, active: 1 });

    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [bought] } });
    h.tenant.op('contacts.applyTags', { id: outsider, data: { tag_ids: [bought] } });
    await h.flush();
    expect(h.tagsOf(ada)).toContain(thanks);
    // enrolled_only: the outsider does not enter at the intermediate goal.
    expect(h.tagsOf(outsider)).not.toContain(thanks);
    await h.advance(31 * DAY);
    expect(h.emails).toHaveLength(0);
    expect(enrollments(h, id)).toEqual([{ contact_id: ada, status: 'completed' }]);
    expect(await nodeStat(h, id, 'nurture')).toMatchObject({ entered: 1, active: 0, completed: 0 });
    expect(await nodeStat(h, id, 'g2')).toMatchObject({ entered: 1, completed: 1 });
  });

  it('counts contacts waiting for a goal as active on that goal', async () => {
    const h = createEngineHarness();
    const start = h.tag('Start');
    const next = h.tag('Next');
    const id = await h.publish(
      graph(
        [
          goal('g1', [{ type: 'tag_applied', tag_ids: [start] }]),
          seq('s', []),
          goal('g2', [{ type: 'tag_applied', tag_ids: [next] }]),
        ],
        [edge('g1', 's'), edge('s', 'g2')],
      ),
    );
    const ada = h.contact();
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [start] } });
    await h.flush();
    expect(await nodeStat(h, id, 'g2')).toMatchObject({ active: 1, entered: 0 });
    expect(enrollments(h, id)).toEqual([{ contact_id: ada, status: 'active' }]);
  });

  it('enrolls a contact only once by default, again after leaving with reentry=multiple', async () => {
    for (const reentry of ['once', 'multiple'] as const) {
      const h = createEngineHarness();
      const t = h.tag('Go');
      const id = await h.publish(
        graph([goal('g', [{ type: 'tag_applied', tag_ids: [t] }]), seq('s', [])], [edge('g', 's')]),
        { reentry },
      );
      const ada = h.contact();
      h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
      await h.flush();
      h.tenant.op('contacts.removeTag', { id: ada, tagId: t });
      h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
      await h.flush();
      expect(enrollments(h, id)).toHaveLength(reentry === 'once' ? 1 : 2);
    }
  });

  it('supports manual enrollment and removal', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [{ id: 'd', type: 'delay', duration: { amount: 1, unit: 'days' } }]),
        ],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact();
    const enrollment = await h.op('automations.enroll', { id, data: { contact_id: ada } });
    expect(enrollment.status).toBe('active');
    expect(enrollment.positions).toEqual([
      expect.objectContaining({ node_id: 's', status: 'scheduled' }),
    ]);
    await expect(h.op('automations.enroll', { id, data: { contact_id: ada } })).rejects.toThrow(
      /conflict/,
    );
    await expect(
      h.op('automations.enroll', { id, data: { contact_id: 'missing' } }),
    ).rejects.toThrow(/not_found/);
    expect(await h.op('automations.removeContact', { id, contactId: ada })).toEqual({
      contact_id: ada,
      removed: true,
    });
    const detail = await h.op('automations.enrollment', { id, enrollmentId: enrollment.id });
    expect(detail.status).toBe('removed');
    expect(detail.log.map((l) => l.kind)).toEqual(
      expect.arrayContaining(['enrolled', 'goal_achieved', 'node_entered', 'removed']),
    );
  });

  it('adds contacts to sequences of other automations and ends flows', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const marker = h.tag('Marker');
    const never = h.tag('Never');
    const target = await h.publish(
      graph(
        [goal('tg', [{ type: 'api', call_name: 'noop' }]), seq('ts', [tagStep('m', marker)])],
        [edge('tg', 'ts')],
      ),
    );
    const source = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            { id: 'add', type: 'add_to_sequence', automation_id: target, node_id: 'ts' },
            { id: 'end', type: 'end' },
            tagStep('after', never),
          ]),
        ],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact();
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    expect(h.tagsOf(ada)).toContain(marker);
    expect(h.tagsOf(ada)).not.toContain(never);
    expect(enrollments(h, source)).toEqual([{ contact_id: ada, status: 'completed' }]);
    expect(enrollments(h, target)).toEqual([{ contact_id: ada, status: 'completed' }]);
  });

  it('fires date anniversary goals once a day at the configured local time', async () => {
    const h = createEngineHarness();
    const greeted = h.tag('Greeted');
    const id = await h.publish(
      graph(
        [
          goal('bd', [
            {
              type: 'date_anniversary',
              field: 'birthday',
              offset_days: -1,
              time: '08:00',
              time_zone: 'Europe/Rome',
            },
          ]),
          seq('s', [tagStep('t', greeted)]),
        ],
        [edge('bd', 's')],
      ),
      { reentry: 'multiple' },
    );
    // Now: 2026-10-15 12:00 UTC = 14:00 in Rome; birthday tomorrow -> fires today.
    const ada = h.tenant.op('contacts.create', { given_name: 'Ada', birthday: '1990-10-16' }).id;
    const bob = h.tenant.op('contacts.create', { given_name: 'Bob', birthday: '1990-10-17' }).id;
    await h.engine.anniversaryScan();
    await h.engine.anniversaryScan();
    await h.flush();
    expect(h.tagsOf(ada)).toContain(greeted);
    expect(h.tagsOf(bob)).not.toContain(greeted);
    expect(enrollments(h, id)).toHaveLength(1);
  });
});

describe('steps', () => {
  it('runs CRM action steps (note, task, field, owner, opportunity)', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const pipeline = h.tenant.op('pipelines.create', {
      name: 'Deals',
      stages: [{ name: 'New' }, { name: 'Won', kind: 'won' }],
    });
    const won = pipeline.stages[1]?.id ?? '';
    await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            {
              id: 'owner',
              type: 'assign_owner',
              user_ids: ['user_a', 'user_b'],
              strategy: 'round_robin',
            },
            { id: 'note', type: 'add_note', title: 'Auto', body: doc },
            {
              id: 'task',
              type: 'create_task',
              title: 'Call',
              assign_to: 'contact_owner',
              due_in: { amount: 1, unit: 'days' },
            },
            { id: 'field', type: 'set_field', field: 'score_value', value: 5, mode: 'increment' },
            { id: 'title', type: 'set_field', field: 'job_title', value: 'CTO' },
            { id: 'opp', type: 'create_opportunity', title: 'Deal', pipeline_id: pipeline.id },
            { id: 'move', type: 'move_opportunity_stage', pipeline_id: pipeline.id, stage_id: won },
          ]),
        ],
        [edge('g', 's')],
      ),
      { reentry: 'multiple' },
    );
    const ada = h.tenant.op('contacts.create', { given_name: 'Ada', score_value: 10 }).id;
    const bob = h.contact('Bob');
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    h.tenant.op('contacts.applyTags', { id: bob, data: { tag_ids: [t] } });
    await h.flush();
    const contact = h.tenant.op('contacts.get', { id: ada });
    expect(contact).toMatchObject({ score_value: 15, job_title: 'CTO' });
    const owners = [contact.owner_id, h.tenant.op('contacts.get', { id: bob }).owner_id].sort();
    expect(owners).toEqual(['user_a', 'user_b']);
    expect(h.tenant.op('notes.list', { limit: 50, contact_id: ada }).data).toHaveLength(1);
    const tasks = h.tenant.op('tasks.list', { limit: 50, contact_id: ada }).data;
    expect(tasks).toEqual([
      expect.objectContaining({ title: 'Call', assigned_to: contact.owner_id }),
    ]);
    const opps = h.tenant.op('opportunities.list', { limit: 50, contact_id: ada }).data;
    expect(opps).toEqual([expect.objectContaining({ stage_id: won })]);
  });

  it('retries transient failures with backoff and never duplicates side effects', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [{ id: 'note', type: 'add_note', body: doc }]),
        ],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact();
    // Attempt 1: the CRM is unreachable. Attempt 2: the note is written but the response is lost.
    h.failCrm('automation.once', 1);
    h.loseResponse('automation.once', 1);
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    const token = h.db.all<{ attempts: number; status: string }>(
      `SELECT attempts, status FROM eng_tokens`,
    )[0];
    expect(token).toMatchObject({ attempts: 1, status: 'scheduled' });
    const job = h.db.all<{ due_at: number }>(`SELECT due_at FROM eng_jobs WHERE kind = 'token'`)[0];
    expect((job?.due_at ?? 0) - h.clock.now).toBe(backoffMs(1));
    await h.advance(backoffMs(1));
    expect(h.db.all(`SELECT attempts FROM eng_tokens`)).toEqual([{ attempts: 2 }]);
    // Attempt 3 replays the stored result instead of creating a second note.
    await h.advance(backoffMs(2));
    expect(enrollments(h, id)).toEqual([{ contact_id: ada, status: 'completed' }]);
    expect(h.tenant.op('notes.list', { limit: 50, contact_id: ada }).data).toHaveLength(1);
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1));
  });

  it('marks positions failed after the last attempt and counts errors', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    h.setFetch(() => Promise.resolve(new Response('down', { status: 503 })));
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            {
              id: 'hook',
              type: 'http_request',
              method: 'POST',
              url: 'https://hooks.example.com/x',
            },
          ]),
        ],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact();
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) await h.advance(backoffMs(attempt));
    expect(h.fetchCalls).toHaveLength(MAX_ATTEMPTS);
    expect(enrollments(h, id)).toEqual([{ contact_id: ada, status: 'failed' }]);
    expect(await nodeStat(h, id, 's')).toMatchObject({ errors: 1, entered: 1, active: 0 });
    expect(await nodeStat(h, id, 's', 'hook')).toMatchObject({ errors: 1, entered: 1 });
  });

  it('signs HTTP requests and blocks SSRF redirects to private networks', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    h.setFetch((url) =>
      Promise.resolve(
        url.startsWith('https://hooks.example.com/redirect')
          ? new Response(null, {
              status: 302,
              headers: { location: 'http://169.254.169.254/latest/meta-data' },
            })
          : new Response('ok', { status: 200 }),
      ),
    );
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            {
              id: 'ok',
              type: 'http_request',
              method: 'POST',
              url: 'https://hooks.example.com/ok',
              headers: { 'X-Custom': '1', Host: 'evil' },
            },
            {
              id: 'bad',
              type: 'http_request',
              method: 'GET',
              url: 'https://hooks.example.com/redirect',
            },
          ]),
        ],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact();
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();

    const [signed, redirected] = h.fetchCalls;
    const headers = new Headers(signed?.init?.headers);
    expect(headers.get('x-custom')).toBe('1');
    expect(headers.get('host')).toBeNull();
    const { secret } = await h.op('automations.signingSecret', { id });
    const body = String(signed?.init?.body);
    expect(JSON.parse(body)).toMatchObject({ contact_id: ada, contact: { id: ada } });
    expect(
      await verifyWebhook({
        secrets: [secret],
        header: headers.get('amable-signature'),
        rawBody: body,
        nowMs: h.clock.now,
      }),
    ).toEqual({ ok: true });
    // The redirect target is never fetched; the failure is permanent (no retries).
    expect(redirected?.url).toBe('https://hooks.example.com/redirect');
    expect(h.fetchCalls).toHaveLength(2);
    const detail = await h.op('automations.enrollments', { id, query: { limit: 10 } });
    expect(detail.data[0]?.status).toBe('failed');
    expect(detail.data[0]?.positions[0]?.last_error).toMatch(/blocked URL/);
  });

  it('sends a custom JSON body: merge tags render inside values and cannot break the structure', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            {
              id: 'hook',
              type: 'http_request',
              method: 'POST',
              url: 'https://hooks.example.com/custom',
              payload: 'custom',
              body: JSON.stringify({
                email: '{{ contact.email }}',
                name: '{{ contact.name }}',
                plan: { code: 'pro', active: true },
                tags: ['{{ contact.first_name }}', 'fixed'],
              }),
            },
          ]),
        ],
        [edge('g', 's')],
      ),
    );
    const email = `ada${h.clock.now}@example.com`;
    const ada = h.tenant.op('contacts.create', {
      given_name: 'Ada "the Countess"',
      family_name: 'Lovelace',
      emails: [{ email }],
    }).id;
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    const call = h.fetchCalls[0];
    const headers = new Headers(call?.init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    const body = String(call?.init?.body);
    expect(JSON.parse(body)).toEqual({
      email,
      name: 'Ada "the Countess" Lovelace',
      plan: { code: 'pro', active: true },
      tags: ['Ada "the Countess"', 'fixed'],
    });
    const { secret } = await h.op('automations.signingSecret', { id });
    expect(
      await verifyWebhook({
        secrets: [secret],
        header: headers.get('amable-signature'),
        rawBody: body,
        nowMs: h.clock.now,
      }),
    ).toEqual({ ok: true });
    expect(enrollments(h, id)).toEqual([{ contact_id: ada, status: 'completed' }]);
  });

  it('fails custom bodies permanently when a merge tag cannot render', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            {
              id: 'hook',
              type: 'http_request',
              method: 'POST',
              url: 'https://hooks.example.com/custom',
              payload: 'custom',
              body: '{"x": "{{ contact.email | nope }}"}',
            },
          ]),
        ],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact();
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    expect(h.fetchCalls).toHaveLength(0);
    const detail = await h.op('automations.enrollments', { id, query: { limit: 10 } });
    expect(detail.data[0]?.status).toBe('failed');
    expect(detail.data[0]?.positions[0]?.last_error).toMatch(/body:/);
  });

  it('pauses email steps when the quota guard says so and resumes them later', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const after = h.tag('After');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [{ id: 'mail', type: 'send_email', template_id: 'tpl_1' }, tagStep('x', after)]),
        ],
        [edge('g', 's')],
      ),
    );
    h.quota.decision = { action: 'pause', reason: 'wallet balance is zero', retryAfterMs: DAY };
    const ada = h.contact();
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    expect(h.emails).toHaveLength(0);
    expect(h.db.all(`SELECT status FROM eng_tokens`)).toEqual([{ status: 'paused' }]);
    // Still paused at the next check.
    await h.advance(DAY);
    expect(h.emails).toHaveLength(0);
    // Top-up: the guard allows again and the control plane asks to resume.
    h.quota.decision = { action: 'allow' };
    expect(await h.engine.resumePaused()).toBe(1);
    await h.flush();
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]).toMatchObject({
      kind: 'email.send',
      version: 1,
      contactId: ada,
      content: { templateId: 'tpl_1' },
      source: { type: 'automation', automationId: id, stepId: 'mail' },
    });
    expect(h.tagsOf(ada)).toContain(after);
    const enrollment = (await h.op('automations.enrollments', { id, query: { limit: 1 } })).data[0];
    const log = await h.op('automations.enrollment', { id, enrollmentId: enrollment?.id ?? '' });
    expect(log.log.filter((l) => l.kind === 'paused')).toHaveLength(1);
    expect(log.log.map((l) => l.kind)).toContain('resumed');
  });

  it('skips denied emails and continues the flow', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const after = h.tag('After');
    await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [{ id: 'mail', type: 'send_email', template_id: 'tpl_1' }, tagStep('x', after)]),
        ],
        [edge('g', 's')],
      ),
    );
    h.quota.decision = { action: 'deny', reason: 'sending domain not verified' };
    const ada = h.contact();
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    expect(h.emails).toHaveLength(0);
    expect(h.tagsOf(ada)).toContain(after);
  });

  it('skips cancel_subscription when the contact has no live subscription', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [{ id: 'cancel', type: 'cancel_subscription' }]),
        ],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact();
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    expect(enrollments(h, id)).toEqual([{ contact_id: ada, status: 'completed' }]);
    expect(await nodeStat(h, id, 's', 'cancel')).toMatchObject({ errors: 0, completed: 1 });
  });
});

describe('e-commerce steps', () => {
  function catalog(h: EngineHarness) {
    const course = h.tenant.op('products.create', {
      name: 'Course',
      price_minor: 10_000,
      currency: 'EUR',
      tax_rate_bps: 2200,
    }).id;
    const software = h.tenant.op('products.create', {
      name: 'Software',
      price_minor: 4_900,
      currency: 'EUR',
      plans: [{ name: 'Monthly', interval: 'month', price_minor: 4_900 }],
    });
    const other = h.tenant.op('products.create', {
      name: 'Other',
      price_minor: 900,
      currency: 'EUR',
      plans: [{ name: 'Monthly', interval: 'month', price_minor: 900 }],
    });
    return {
      course,
      software: software.id,
      softwarePlan: software.plans[0]?.id ?? '',
      otherPlan: other.plans[0]?.id ?? '',
    };
  }

  it('creates a finalized order once, even when the response is lost', async () => {
    const h = createEngineHarness();
    const { course } = catalog(h);
    const t = h.tag('Buy');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            {
              id: 'order',
              type: 'create_order',
              items: [{ product_id: course, quantity: 2 }],
              currency: 'EUR',
            },
          ]),
        ],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact();
    h.loseResponse('automation.once', 1);
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    await h.advance(HOUR);

    const orders = h.tenant.op('orders.list', { limit: 10, contact_id: ada });
    expect(orders.data).toHaveLength(1);
    expect(orders.data[0]).toMatchObject({
      status: 'unpaid',
      currency: 'EUR',
      subtotal_minor: 20_000,
      tax_minor: 4_400,
      total_minor: 24_400,
    });
    expect(orders.data[0]?.notes).toContain(id);
    expect(enrollments(h, id)).toEqual([{ contact_id: ada, status: 'completed' }]);
    const run = h.db.all<{ result: string }>(`SELECT result FROM eng_step_runs`)[0];
    expect(JSON.parse(run?.result ?? '{}')).toMatchObject({
      result: { order_id: orders.data[0]?.id, total_minor: 24_400 },
    });
    // The order flows back through the outbox like a manual one.
    expect(
      h.tenant.db.all(`SELECT type FROM crm_outbox WHERE type = 'order.created'`),
    ).toHaveLength(1);
  });

  it('fails create_order permanently for an unknown product', async () => {
    const h = createEngineHarness();
    const t = h.tag('Buy');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            {
              id: 'order',
              type: 'create_order',
              items: [{ product_id: '01JABCDEFGHJKMNPQRSTVWXYZ0', quantity: 1 }],
            },
          ]),
        ],
        [edge('g', 's')],
      ),
    );
    const ada = h.contact();
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    expect(enrollments(h, id)).toEqual([{ contact_id: ada, status: 'failed' }]);
    expect(await nodeStat(h, id, 's', 'order')).toMatchObject({ errors: 1 });
  });

  it('cancels the live subscriptions of the chosen products', async () => {
    const h = createEngineHarness();
    const { software, softwarePlan, otherPlan } = catalog(h);
    const t = h.tag('Churn');
    const ada = h.contact();
    const sub = h.tenant.op('subscriptions.create', { contact_id: ada, plan_id: softwarePlan });
    const keep = h.tenant.op('subscriptions.create', { contact_id: ada, plan_id: otherPlan });
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            {
              id: 'cancel',
              type: 'cancel_subscription',
              product_ids: [software],
              at_period_end: false,
            },
          ]),
        ],
        [edge('g', 's')],
      ),
    );
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    expect(h.tenant.op('subscriptions.get', { id: sub.id }).status).toBe('cancelled');
    expect(h.tenant.op('subscriptions.get', { id: keep.id }).status).toBe('active');
    expect(enrollments(h, id)).toEqual([{ contact_id: ada, status: 'completed' }]);
    expect(
      h.tenant.db.all(`SELECT type FROM crm_outbox WHERE type = 'subscription.ended'`),
    ).toHaveLength(1);
  });

  it('schedules the cancellation at period end by default', async () => {
    const h = createEngineHarness();
    const { softwarePlan } = catalog(h);
    const t = h.tag('Churn');
    const ada = h.contact();
    const sub = h.tenant.op('subscriptions.create', { contact_id: ada, plan_id: softwarePlan });
    await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [{ id: 'cancel', type: 'cancel_subscription' }]),
        ],
        [edge('g', 's')],
      ),
    );
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    const after = h.tenant.op('subscriptions.get', { id: sub.id });
    expect(after.status).toBe('active');
    expect(after.cancel_at_period_end).toBe(true);
  });
});

describe('signing secret and log retention', () => {
  it('stores the HTTP signing secret encrypted and seals legacy plaintext secrets', async () => {
    const h = createEngineHarness();
    const created = await h.op('automations.create', { name: 'Hooks' });
    const stored = () =>
      h.db.all<{ signing_secret: string }>(
        `SELECT signing_secret FROM eng_automations WHERE id = ?`,
        created.id,
      )[0]?.signing_secret ?? '';
    expect(stored()).toBe('');
    const { secret } = await h.op('automations.signingSecret', { id: created.id });
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(stored()).toMatch(/^v1\./);
    expect(stored()).not.toContain(secret);
    // Stable across reads.
    expect((await h.op('automations.signingSecret', { id: created.id })).secret).toBe(secret);
    // Rotation.
    const rotated = await h.op('automations.rotateSigningSecret', { id: created.id });
    expect(rotated.secret).not.toBe(secret);
    expect((await h.op('automations.signingSecret', { id: created.id })).secret).toBe(
      rotated.secret,
    );
    // A secret saved before encryption existed is sealed on first read.
    const legacy = 'ab'.repeat(32);
    h.db.run(`UPDATE eng_automations SET signing_secret = ? WHERE id = ?`, legacy, created.id);
    expect((await h.op('automations.signingSecret', { id: created.id })).secret).toBe(legacy);
    expect(stored()).toMatch(/^v1\./);
    // Ciphertext is bound to the automation: copied to another row it does not decrypt.
    const other = await h.op('automations.create', { name: 'Other' });
    h.db.run(`UPDATE eng_automations SET signing_secret = ? WHERE id = ?`, stored(), other.id);
    await expect(h.op('automations.signingSecret', { id: other.id })).rejects.toThrow(
      /decryption failed/,
    );
  });

  it('deletes execution logs older than the retention window', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const done = h.tag('Done');
    const id = await h.publish(
      graph(
        [goal('g', [{ type: 'tag_applied', tag_ids: [t] }]), seq('s', [tagStep('x', done)])],
        [edge('g', 's')],
      ),
      { reentry: 'multiple' },
    );
    const ada = h.contact('Ada');
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    const oldLogs = h.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM eng_logs`)[0]?.n ?? 0;
    expect(oldLogs).toBeGreaterThan(0);

    await h.advance(LOG_RETENTION_MS - DAY);
    const bob = h.contact('Bob');
    h.tenant.op('contacts.applyTags', { id: bob, data: { tag_ids: [t] } });
    await h.flush();
    const total = h.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM eng_logs`)[0]?.n ?? 0;
    expect(total).toBeGreaterThan(oldLogs);

    // Past the window for Ada's logs only: the daily prune job removes them.
    await h.advance(2 * DAY);
    const left = h.db.all<{ contact_id: string }>(`SELECT DISTINCT contact_id FROM eng_logs`);
    expect(left).toEqual([{ contact_id: bob }]);
    // Enrollments and counters are kept.
    expect(enrollments(h, id)).toHaveLength(2);
    expect(await nodeStat(h, id, 's', 'x')).toMatchObject({ completed: 2 });
  });
});

describe('versions and counters', () => {
  it('pins running enrollments to their version and tracks counters per node', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const v1 = h.tag('V1');
    const v2 = h.tag('V2');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('s', [
            { id: 'd', type: 'delay', duration: { amount: 1, unit: 'hours' } },
            tagStep('x', v1),
          ]),
        ],
        [edge('g', 's')],
      ),
      { reentry: 'multiple' },
    );
    const ada = h.contact('Ada');
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    const detail = await h.op('automations.get', { id });
    await h.op('automations.saveDraft', {
      id,
      data: {
        revision: detail.draft_revision,
        graph: graph(
          [
            goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
            seq('s', [
              { id: 'd', type: 'delay', duration: { amount: 1, unit: 'hours' } },
              tagStep('x', v2),
            ]),
          ],
          [edge('g', 's')],
        ),
      },
    });
    await expect(
      h.op('automations.saveDraft', {
        id,
        data: { revision: detail.draft_revision, graph: detail.draft_graph },
      }),
    ).rejects.toThrow(/conflict/);
    const published = await h.op('automations.publish', { id });
    expect(published.version.number).toBe(2);
    const bob = h.contact('Bob');
    h.tenant.op('contacts.applyTags', { id: bob, data: { tag_ids: [t] } });
    await h.flush();
    await h.advance(2 * HOUR);
    expect(h.tagsOf(ada)).toContain(v1);
    expect(h.tagsOf(bob)).toContain(v2);
    expect((await h.op('automations.versions', { id })).map((v) => v.number)).toEqual([2, 1]);
    const stats = await h.op('automations.stats', { id });
    expect(stats.enrollments).toMatchObject({ completed: 2, active: 0 });
    expect(stats.nodes.find((s) => s.node_id === 'g' && s.step_id === null)).toMatchObject({
      entered: 2,
      completed: 2,
    });
    expect(stats.nodes.find((s) => s.node_id === 's' && s.step_id === 'x')).toMatchObject({
      entered: 2,
      completed: 2,
      errors: 0,
    });
    // Republishing an unchanged draft does not create a version.
    expect((await h.op('automations.publish', { id })).version.number).toBe(2);
  });
});

describe('reporting drill-down', () => {
  it('lists enrollments currently at a node or that visited it', async () => {
    const h = createEngineHarness();
    const t = h.tag('Go');
    const done = h.tag('Done');
    const id = await h.publish(
      graph(
        [
          goal('g', [{ type: 'tag_applied', tag_ids: [t] }]),
          seq('a', [tagStep('x', done)]),
          seq('b', [{ id: 'wait', type: 'delay', duration: { amount: 1, unit: 'days' } }]),
        ],
        [edge('g', 'a'), edge('a', 'b')],
      ),
    );
    const ada = h.contact('Ada');
    h.tenant.op('contacts.applyTags', { id: ada, data: { tag_ids: [t] } });
    await h.flush();
    const at = async (nodeId: string, scope?: 'current' | 'visited') =>
      (
        await h.op('automations.enrollments', {
          id,
          query: { limit: 10, node_id: nodeId, ...(scope ? { scope } : {}) },
        })
      ).data.map((e) => e.contact_id);
    expect(await at('a')).toEqual([]);
    expect(await at('a', 'visited')).toEqual([ada]);
    expect(await at('g', 'visited')).toEqual([ada]);
    expect(await at('b')).toEqual([ada]);
    expect(await at('b', 'visited')).toEqual([ada]);
  });
});

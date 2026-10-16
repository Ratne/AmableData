import { automationGraphSchema } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { validateGraph } from '../../src/automation/validate';
import { nextWindowOpening, zonedToUtc } from '../../src/automation/time';
import { createEngineHarness, doc, edge, goal, graph, seq } from './helpers';

const lookup = () => null;
const codes = (g: ReturnType<typeof graph>) =>
  validateGraph(g, {}, { automationId: 'a1', lookup })
    .issues.filter((i) => i.severity === 'error')
    .map((i) => i.code);

describe('publish validation', () => {
  const entry = goal('g', [{ type: 'tag_applied', tag_ids: ['t1'] }]);

  it('accepts a well-formed graph', () => {
    const result = validateGraph(
      graph([entry, seq('s', [])], [edge('g', 's')]),
      {},
      { automationId: 'a1', lookup },
    );
    expect(result.valid).toBe(true);
    expect(result.issues.map((i) => i.code)).toEqual(['empty_sequence']);
  });

  it('requires an entry goal and reachable nodes', () => {
    expect(codes(graph([seq('s', [])], []))).toEqual(
      expect.arrayContaining(['no_entry_goal', 'unreachable']),
    );
    expect(codes(graph([entry, seq('s', []), seq('orphan', [])], [edge('g', 's')]))).toEqual([
      'unreachable',
    ]);
  });

  it('rejects loops that never wait for a goal', () => {
    const g = graph(
      [entry, seq('a', []), seq('b', [])],
      [edge('g', 'a'), edge('a', 'b'), edge('b', 'a')],
    );
    expect(codes(g)).toContain('cycle');
    const throughGoal = graph(
      [entry, seq('a', []), goal('g2', [{ type: 'api', call_name: 'x' }]), seq('b', [])],
      [edge('g', 'a'), edge('a', 'g2'), edge('g2', 'b'), edge('b', 'g2')],
    );
    expect(codes(throughGoal)).not.toContain('cycle');
  });

  it('checks edges, decision handles, notes and ids', () => {
    const g = graph(
      [
        entry,
        {
          id: 'd',
          type: 'decision',
          position: { x: 0, y: 0 },
          branches: [{ id: 'b1', filter: { type: 'group', op: 'and', conditions: [] } }],
        },
        { id: 'n', type: 'note', position: { x: 0, y: 0 }, text: 'hi' },
        seq('s', [
          { id: 'x', type: 'end' },
          { id: 'x', type: 'end' },
        ]),
      ],
      [edge('g', 'd'), edge('d', 's', 'nope'), edge('d', 'n'), edge('g', 'missing')],
    );
    expect(codes(g)).toEqual(
      expect.arrayContaining([
        'duplicate_step_id',
        'unknown_branch',
        'note_connected',
        'unknown_node',
      ]),
    );
  });

  it('checks step configuration (email content, time zones, URLs, targets)', () => {
    const g = graph(
      [
        entry,
        seq('s', [
          { id: 'e', type: 'send_email', subject: 'No body' },
          {
            id: 'w',
            type: 'wait_until',
            date: '2026-01-01',
            time: '09:00',
            time_zone: 'Mars/Olympus',
          },
          { id: 'h', type: 'http_request', method: 'POST', url: 'http://10.0.0.1/hook' },
          { id: 'm', type: 'http_request', method: 'GET', url: 'http://localhost:8080/x' },
          { id: 'a', type: 'add_to_sequence', automation_id: 'other', node_id: 'seq' },
          { id: 'f', type: 'set_field', field: 'score_value', value: 'x', mode: 'increment' },
        ]),
      ],
      [edge('g', 's')],
    );
    expect(codes(g)).toEqual([
      'email_content_missing',
      'invalid_time_zone',
      'url_blocked',
      'url_blocked',
      'unknown_automation',
      'increment_not_number',
    ]);
  });

  it('rejects unknown fields in the graph JSON (strict schema)', () => {
    const parsed = automationGraphSchema.safeParse({
      schema_version: 1,
      nodes: [
        {
          id: 'g',
          type: 'goal',
          position: { x: 0, y: 0 },
          triggers: [{ type: 'tag_applied', tag_ids: ['t'] }],
          extra: true,
        },
      ],
      edges: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('blocks publishing an invalid draft with the issues as details', async () => {
    const h = createEngineHarness();
    const created = await h.op('automations.create', {
      name: 'Broken',
      graph: graph([seq('s', [{ id: 'e', type: 'send_email', subject: 'x', body: doc }])], []),
    });
    const validation = await h.op('automations.validate', { id: created.id });
    expect(validation.valid).toBe(false);
    await expect(h.op('automations.publish', { id: created.id })).rejects.toMatchObject({
      shape: {
        code: 'validation_failed',
        details: expect.arrayContaining([
          expect.objectContaining({ message: expect.stringMatching(/^no_entry_goal/) }),
        ]),
      },
    });
    expect((await h.op('automations.get', { id: created.id })).status).toBe('draft');
  });
});

describe('time zones', () => {
  it('converts wall-clock times across DST', () => {
    expect(zonedToUtc(2026, 3, 29, 3, 30, 'Europe/Rome')).toBe(Date.UTC(2026, 2, 29, 1, 30));
    expect(zonedToUtc(2026, 7, 1, 9, 0, 'America/New_York')).toBe(Date.UTC(2026, 6, 1, 13, 0));
  });

  it('finds the next send window opening', () => {
    const window = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };
    // Saturday 2026-10-17 10:00 Rome -> Monday 09:00 Rome (07:00 UTC).
    expect(nextWindowOpening(Date.UTC(2026, 9, 17, 8, 0), window, 'Europe/Rome')).toBe(
      Date.UTC(2026, 9, 19, 7, 0),
    );
    const inside = Date.UTC(2026, 9, 15, 10, 0);
    expect(nextWindowOpening(inside, window, 'Europe/Rome')).toBe(inside);
    // Overnight window 22:00-06:00, at 03:00 -> inside.
    const night = Date.UTC(2026, 9, 15, 3, 0);
    expect(nextWindowOpening(night, { start: '22:00', end: '06:00' }, 'UTC')).toBe(night);
  });
});

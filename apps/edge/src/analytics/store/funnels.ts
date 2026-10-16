import type { Funnel, FunnelResult, FunnelStep } from '@amable/api-types';
import type { SqlDb, SqlValue } from '../db/sql';
import { median } from './insights';
import { filterSql, type ResolvedRange } from './query';

export type StoredFunnelStep = Required<Pick<FunnelStep, 'type' | 'value' | 'match'>> & {
  label?: string | undefined;
};

export interface FunnelEvent {
  visitor: string;
  ts: number;
  /** Pageview path or goal name. */
  kind: 'pageview' | 'goal';
  value: string;
}

export function stepMatches(step: StoredFunnelStep, e: FunnelEvent): boolean {
  if (step.type !== e.kind) return false;
  if (step.type === 'goal') return e.value === step.value;
  return step.match === 'contains' ? e.value.includes(step.value) : e.value === step.value;
}

export function stepLabel(step: StoredFunnelStep): string {
  if (step.label !== undefined && step.label !== '') return step.label;
  return step.type === 'goal' ? `Goal: ${step.value}` : step.match === 'contains' ? `Page contains ${step.value}` : step.value;
}

/**
 * Ordered funnel over each visitor's events (sorted by time): a visitor enters
 * with the first event matching step 1 inside the range, then each next step
 * must happen after the previous one (until the end of the range). Returns,
 * per step, the visitors who reached it and the elapsed times from the
 * previous step.
 */
export function computeFunnel(
  steps: readonly StoredFunnelStep[],
  events: readonly FunnelEvent[],
  range: { from: number; to: number },
): Array<{ visitors: number; elapsed: number[] }> {
  const byVisitor = new Map<string, FunnelEvent[]>();
  for (const e of events) {
    if (e.ts >= range.to) continue;
    const list = byVisitor.get(e.visitor) ?? [];
    list.push(e);
    byVisitor.set(e.visitor, list);
  }
  const out = steps.map(() => ({ visitors: 0, elapsed: [] as number[] }));
  for (const list of byVisitor.values()) {
    list.sort((a, b) => a.ts - b.ts);
    const firstStep = steps[0];
    if (firstStep === undefined) break;
    let i = list.findIndex((e) => e.ts >= range.from && stepMatches(firstStep, e));
    if (i === -1) continue;
    let prevTs = list[i]?.ts ?? 0;
    const head = out[0];
    if (head !== undefined) head.visitors += 1;
    for (let s = 1; s < steps.length; s += 1) {
      const step = steps[s];
      if (step === undefined) break;
      const j = list.findIndex((e, k) => k > i && e.ts >= prevTs && stepMatches(step, e));
      if (j === -1) break;
      const e = list[j];
      const slot = out[s];
      if (e === undefined || slot === undefined) break;
      slot.visitors += 1;
      slot.elapsed.push(e.ts - prevTs);
      prevTs = e.ts;
      i = j;
    }
  }
  return out;
}

/** Loads the candidate events of a funnel and computes its result. */
export function funnelResult(db: SqlDb, funnel: Funnel, r: ResolvedRange): FunnelResult {
  const steps: StoredFunnelStep[] = funnel.steps;
  const pageSteps = steps.filter((s) => s.type === 'pageview');
  const goalNames = [...new Set(steps.filter((s) => s.type === 'goal').map((s) => s.value))];
  const events: FunnelEvent[] = [];
  const jp: SqlValue[] = [];
  const join = r.filters.length === 0 ? '' : `JOIN sessions s ON s.id = t.session_id AND ${filterSql(r.filters, 's', jp)}`;
  if (pageSteps.length > 0) {
    const conds: string[] = [];
    const cp: SqlValue[] = [];
    for (const s of pageSteps) {
      if (s.match === 'contains') {
        conds.push(`instr(t.path, ?) > 0`);
      } else {
        conds.push(`t.path = ?`);
      }
      cp.push(s.value);
    }
    for (const row of db.all<{ visitor_id: string; ts: number; path: string }>(
      `SELECT t.visitor_id AS visitor_id, t.ts AS ts, t.path AS path FROM pageviews t ${join}
       WHERE t.ts >= ? AND t.ts < ? AND (${conds.join(' OR ')})`,
      ...jp,
      r.from,
      r.to,
      ...cp,
    )) {
      events.push({ visitor: row.visitor_id, ts: row.ts, kind: 'pageview', value: row.path });
    }
  }
  if (goalNames.length > 0) {
    for (const row of db.all<{ visitor_id: string; ts: number; name: string }>(
      `SELECT t.visitor_id AS visitor_id, t.ts AS ts, t.name AS name FROM goals t ${join}
       WHERE t.ts >= ? AND t.ts < ? AND t.name IN (SELECT value FROM json_each(?))`,
      ...jp,
      r.from,
      r.to,
      JSON.stringify(goalNames),
    )) {
      events.push({ visitor: row.visitor_id, ts: row.ts, kind: 'goal', value: row.name });
    }
  }
  const computed = computeFunnel(steps, events, r);
  const entered = computed[0]?.visitors ?? 0;
  const ratio = (a: number, b: number): number => (b === 0 ? 0 : Math.round((a / b) * 10_000) / 10_000);
  const result = computed.map((c, index) => {
    const prev = index === 0 ? c.visitors : (computed[index - 1]?.visitors ?? 0);
    return {
      index,
      label: stepLabel(steps[index] ?? { type: 'pageview', value: '?', match: 'exact' }),
      visitors: c.visitors,
      conversion_rate: ratio(c.visitors, entered),
      step_conversion_rate: index === 0 ? (entered === 0 ? 0 : 1) : ratio(c.visitors, prev),
      dropoff: index === 0 ? 0 : prev - c.visitors,
      median_ms_from_previous: index === 0 ? null : median(c.elapsed),
    };
  });
  const completed = computed.at(-1)?.visitors ?? 0;
  return {
    funnel_id: funnel.id,
    from: new Date(r.from).toISOString(),
    to: new Date(r.to).toISOString(),
    entered,
    completed,
    conversion_rate: ratio(completed, entered),
    steps: result,
  };
}

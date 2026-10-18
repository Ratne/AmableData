import type {
  CreateOpportunityInput,
  CreatePipelineInput,
  CreateStageInput,
  ListOpportunitiesQuery,
  Opportunity,
  Page,
  Pipeline,
  Stage,
  UpdateOpportunityInput,
  UpdatePipelineInput,
  UpdateStageInput,
} from '@amable/api-types';
import type { CrmContext } from './context';
import { placeholders } from './db/sql';
import { CrmError, invalid, notFound } from './errors';
import { emit } from './events';
import { prepareValues, readValues, writeValues } from './custom-fields/repo';
import { assertRef } from './refs';
import { decodeCursor, encodeCursor, parseIsoMs, toIso } from './util';

// ---------------------------------------------------------------- pipelines

interface PipelineRow {
  id: string;
  name: string;
  is_default: number;
  created_at: number;
  updated_at: number;
}
type StageRow = Stage;

const DEFAULT_STAGES: CreateStageInput[] = [
  { name: 'New', probability: 10 },
  { name: 'Qualified', probability: 30 },
  { name: 'Proposal', probability: 60 },
  { name: 'Won', probability: 100, kind: 'won' },
  { name: 'Lost', probability: 0, kind: 'lost' },
];

function stagesOf(ctx: CrmContext, pipelineIds: string[]): Map<string, Stage[]> {
  const result = new Map<string, Stage[]>(pipelineIds.map((id) => [id, []]));
  if (pipelineIds.length === 0) return result;
  for (const stage of ctx.db.all<StageRow>(
    `SELECT id, pipeline_id, name, probability, kind, position FROM crm_pipeline_stages
     WHERE deleted_at IS NULL AND pipeline_id IN (${placeholders(pipelineIds.length)}) ORDER BY position, id`,
    ...pipelineIds,
  )) {
    result.get(stage.pipeline_id)?.push(stage);
  }
  return result;
}

function pipelineToApi(row: PipelineRow, stages: Stage[]): Pipeline {
  return {
    id: row.id,
    name: row.name,
    is_default: row.is_default === 1,
    stages,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function getPipelineRow(ctx: CrmContext, id: string): PipelineRow {
  const row = ctx.db.all<PipelineRow>(
    `SELECT id, name, is_default, created_at, updated_at FROM crm_pipelines WHERE id = ? AND deleted_at IS NULL`,
    id,
  )[0];
  if (row === undefined) throw notFound('pipeline', id);
  return row;
}

export function getPipeline(ctx: CrmContext, input: { id: string }): Pipeline {
  const row = getPipelineRow(ctx, input.id);
  return pipelineToApi(row, stagesOf(ctx, [row.id]).get(row.id) ?? []);
}

export function listPipelines(ctx: CrmContext, _input: Record<string, never>): Pipeline[] {
  const rows = ctx.db.all<PipelineRow>(
    `SELECT id, name, is_default, created_at, updated_at FROM crm_pipelines
     WHERE deleted_at IS NULL ORDER BY is_default DESC, position, name`,
  );
  const stages = stagesOf(
    ctx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => pipelineToApi(r, stages.get(r.id) ?? []));
}

function setDefault(ctx: CrmContext, id: string): void {
  ctx.db.run(`UPDATE crm_pipelines SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END`, id);
}

function insertStage(
  ctx: CrmContext,
  pipelineId: string,
  stage: CreateStageInput,
  position: number,
): string {
  const id = ctx.newId();
  const now = ctx.now();
  const kind = stage.kind ?? 'open';
  ctx.db.run(
    `INSERT INTO crm_pipeline_stages (id, pipeline_id, name, probability, kind, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    pipelineId,
    stage.name,
    stage.probability ?? (kind === 'won' ? 100 : 0),
    kind,
    stage.position ?? position,
    now,
    now,
  );
  return id;
}

export function createPipeline(ctx: CrmContext, input: CreatePipelineInput): Pipeline {
  const id = ctx.newId();
  const now = ctx.now();
  const isFirst =
    ctx.db.all(`SELECT 1 FROM crm_pipelines WHERE deleted_at IS NULL LIMIT 1`).length === 0;
  ctx.db.run(
    `INSERT INTO crm_pipelines (id, name, is_default, created_at, updated_at) VALUES (?, ?, 0, ?, ?)`,
    id,
    input.name,
    now,
    now,
  );
  (input.stages ?? DEFAULT_STAGES).forEach((stage, i) => insertStage(ctx, id, stage, i));
  if (input.is_default === true || isFirst) setDefault(ctx, id);
  return getPipeline(ctx, { id });
}

export function updatePipeline(
  ctx: CrmContext,
  input: { id: string; data: UpdatePipelineInput },
): Pipeline {
  const row = getPipelineRow(ctx, input.id);
  ctx.db.run(
    `UPDATE crm_pipelines SET name = ?, updated_at = ? WHERE id = ?`,
    input.data.name ?? row.name,
    ctx.now(),
    row.id,
  );
  if (input.data.is_default === true) setDefault(ctx, row.id);
  return getPipeline(ctx, { id: row.id });
}

export function deletePipeline(
  ctx: CrmContext,
  input: { id: string },
): { id: string; deleted: true } {
  const row = getPipelineRow(ctx, input.id);
  const open = ctx.db.all(
    `SELECT 1 FROM crm_opportunities WHERE pipeline_id = ? AND deleted_at IS NULL LIMIT 1`,
    row.id,
  );
  if (open.length > 0)
    throw new CrmError('conflict', 'pipeline still has opportunities; move or delete them first');
  ctx.db.run(
    `UPDATE crm_pipelines SET deleted_at = ?, is_default = 0 WHERE id = ?`,
    ctx.now(),
    row.id,
  );
  if (row.is_default === 1) {
    const next = ctx.db.all<{ id: string }>(
      `SELECT id FROM crm_pipelines WHERE deleted_at IS NULL ORDER BY position, created_at LIMIT 1`,
    )[0];
    if (next !== undefined) setDefault(ctx, next.id);
  }
  return { id: row.id, deleted: true };
}

function getStage(ctx: CrmContext, pipelineId: string, stageId: string): StageRow {
  const row = ctx.db.all<StageRow>(
    `SELECT id, pipeline_id, name, probability, kind, position FROM crm_pipeline_stages
     WHERE id = ? AND pipeline_id = ? AND deleted_at IS NULL`,
    stageId,
    pipelineId,
  )[0];
  if (row === undefined) throw notFound('stage', stageId);
  return row;
}

export function createStage(
  ctx: CrmContext,
  input: { pipelineId: string; data: CreateStageInput },
): Pipeline {
  getPipelineRow(ctx, input.pipelineId);
  const count =
    ctx.db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM crm_pipeline_stages WHERE pipeline_id = ? AND deleted_at IS NULL`,
      input.pipelineId,
    )[0]?.n ?? 0;
  insertStage(ctx, input.pipelineId, input.data, count);
  return getPipeline(ctx, { id: input.pipelineId });
}

export function updateStage(
  ctx: CrmContext,
  input: { pipelineId: string; stageId: string; data: UpdateStageInput },
): Pipeline {
  const stage = getStage(ctx, input.pipelineId, input.stageId);
  ctx.db.run(
    `UPDATE crm_pipeline_stages SET name = ?, probability = ?, kind = ?, position = ?, updated_at = ? WHERE id = ?`,
    input.data.name ?? stage.name,
    input.data.probability ?? stage.probability,
    input.data.kind ?? stage.kind,
    input.data.position ?? stage.position,
    ctx.now(),
    stage.id,
  );
  if (input.data.kind !== undefined && input.data.kind !== stage.kind) {
    ctx.db.run(
      `UPDATE crm_opportunities SET status = ? WHERE stage_id = ? AND deleted_at IS NULL`,
      input.data.kind,
      stage.id,
    );
  }
  return getPipeline(ctx, { id: input.pipelineId });
}

export function deleteStage(
  ctx: CrmContext,
  input: { pipelineId: string; stageId: string },
): Pipeline {
  getStage(ctx, input.pipelineId, input.stageId);
  const used = ctx.db.all(
    `SELECT 1 FROM crm_opportunities WHERE stage_id = ? AND deleted_at IS NULL LIMIT 1`,
    input.stageId,
  );
  if (used.length > 0) throw new CrmError('conflict', 'stage still has opportunities');
  const remaining = ctx.db.all(
    `SELECT 1 FROM crm_pipeline_stages WHERE pipeline_id = ? AND deleted_at IS NULL AND id <> ?`,
    input.pipelineId,
    input.stageId,
  );
  if (remaining.length === 0) throw new CrmError('conflict', 'a pipeline needs at least one stage');
  ctx.db.run(
    `UPDATE crm_pipeline_stages SET deleted_at = ? WHERE id = ?`,
    ctx.now(),
    input.stageId,
  );
  return getPipeline(ctx, { id: input.pipelineId });
}

// ------------------------------------------------------------ opportunities

interface OpportunityRow {
  id: string;
  title: string;
  pipeline_id: string;
  stage_id: string;
  status: Opportunity['status'];
  contact_id: string | null;
  company_id: string | null;
  owner_id: string | null;
  value_minor: number;
  currency: string;
  expected_close_date: string | null;
  lost_reason: string | null;
  next_action: string | null;
  next_action_at: number | null;
  stage_changed_at: number;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
}

function serializeOpportunities(ctx: CrmContext, rows: OpportunityRow[]): Opportunity[] {
  const custom = readValues(
    ctx,
    'opportunity',
    rows.map((r) => r.id),
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    pipeline_id: row.pipeline_id,
    stage_id: row.stage_id,
    status: row.status,
    contact_id: row.contact_id,
    company_id: row.company_id,
    owner_id: row.owner_id,
    value_minor: row.value_minor,
    currency: row.currency,
    expected_close_date: row.expected_close_date,
    lost_reason: row.lost_reason,
    next_action: row.next_action,
    next_action_at: toIso(row.next_action_at),
    stage_changed_at: toIso(row.stage_changed_at),
    closed_at: toIso(row.closed_at),
    custom_fields: custom.get(row.id) ?? {},
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  }));
}

function getOpportunityRow(ctx: CrmContext, id: string, includeDeleted = false): OpportunityRow {
  const row = ctx.db.all<OpportunityRow>(
    `SELECT * FROM crm_opportunities WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    id,
  )[0];
  if (row === undefined) throw notFound('opportunity', id);
  return row;
}

const oppRefs = (
  row: OpportunityRow,
): { opportunityId: string; pipelineId: string; stageId: string; contactId: string | null } => ({
  opportunityId: row.id,
  pipelineId: row.pipeline_id,
  stageId: row.stage_id,
  contactId: row.contact_id,
});

export function getOpportunity(ctx: CrmContext, input: { id: string }): Opportunity {
  const [opp] = serializeOpportunities(ctx, [getOpportunityRow(ctx, input.id)]);
  if (opp === undefined) throw notFound('opportunity', input.id);
  return opp;
}

export function listOpportunities(
  ctx: CrmContext,
  input: ListOpportunitiesQuery,
): Page<Opportunity> {
  const before = input.cursor === undefined ? null : decodeCursor(input.cursor).id;
  const rows = ctx.db.all<OpportunityRow>(
    `SELECT * FROM crm_opportunities WHERE deleted_at IS NULL
       AND (? IS NULL OR pipeline_id = ?) AND (? IS NULL OR stage_id = ?) AND (? IS NULL OR owner_id = ?)
       AND (? IS NULL OR contact_id = ?) AND (? IS NULL OR status = ?) AND (? IS NULL OR id < ?)
     ORDER BY id DESC LIMIT ?`,
    input.pipeline_id ?? null,
    input.pipeline_id ?? null,
    input.stage_id ?? null,
    input.stage_id ?? null,
    input.owner_id ?? null,
    input.owner_id ?? null,
    input.contact_id ?? null,
    input.contact_id ?? null,
    input.status ?? null,
    input.status ?? null,
    before,
    before,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: serializeOpportunities(ctx, page),
    next_cursor:
      rows.length > input.limit && last !== undefined
        ? encodeCursor({ v: null, id: last.id })
        : null,
  };
}

function resolveStage(
  ctx: CrmContext,
  pipelineId: string | undefined,
  stageId: string | undefined,
): StageRow {
  let pipeline = pipelineId;
  if (pipeline === undefined) {
    const def = ctx.db.all<{ id: string }>(
      `SELECT id FROM crm_pipelines WHERE deleted_at IS NULL ORDER BY is_default DESC, position LIMIT 1`,
    )[0];
    if (def === undefined) throw invalid('pipeline_id', 'no pipeline exists yet; create one first');
    pipeline = def.id;
  } else {
    assertRef(ctx, 'pipeline', pipeline, 'pipeline_id');
  }
  if (stageId !== undefined) {
    const stage = ctx.db.all<StageRow>(
      `SELECT id, pipeline_id, name, probability, kind, position FROM crm_pipeline_stages
       WHERE id = ? AND pipeline_id = ? AND deleted_at IS NULL`,
      stageId,
      pipeline,
    )[0];
    if (stage === undefined)
      throw invalid('stage_id', `stage ${stageId} not found in pipeline ${pipeline}`);
    return stage;
  }
  const first = stagesOf(ctx, [pipeline])
    .get(pipeline)
    ?.find((s) => s.kind === 'open');
  if (first === undefined) throw invalid('stage_id', 'pipeline has no open stage');
  return first;
}

export function createOpportunity(ctx: CrmContext, input: CreateOpportunityInput): Opportunity {
  assertRef(ctx, 'contact', input.contact_id, 'contact_id');
  assertRef(ctx, 'company', input.company_id, 'company_id');
  const stage = resolveStage(ctx, input.pipeline_id, input.stage_id);
  const custom = prepareValues(ctx, 'opportunity', input.custom_fields, { requireAll: true });
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_opportunities (id, title, pipeline_id, stage_id, status, contact_id, company_id, owner_id,
       value_minor, currency, expected_close_date, lost_reason, next_action, next_action_at, stage_changed_at,
       closed_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.title,
    stage.pipeline_id,
    stage.id,
    stage.kind,
    input.contact_id ?? null,
    input.company_id ?? null,
    input.owner_id ?? ctx.actor.id,
    input.value_minor ?? 0,
    input.currency ?? 'EUR',
    input.expected_close_date ?? null,
    input.lost_reason ?? null,
    input.next_action ?? null,
    input.next_action_at === undefined || input.next_action_at === null
      ? null
      : parseIsoMs(input.next_action_at, 'next_action_at'),
    now,
    stage.kind === 'open' ? null : now,
    ctx.actor.id,
    now,
    now,
  );
  writeValues(ctx, id, custom);
  const row = getOpportunityRow(ctx, id);
  emit(ctx, 'opportunity.created', oppRefs(row), { title: row.title, stageName: stage.name });
  return getOpportunity(ctx, { id });
}

export function updateOpportunity(
  ctx: CrmContext,
  input: { id: string; data: UpdateOpportunityInput },
): Opportunity {
  const current = getOpportunityRow(ctx, input.id);
  const data = input.data;
  assertRef(ctx, 'contact', data.contact_id, 'contact_id');
  assertRef(ctx, 'company', data.company_id, 'company_id');
  const custom = prepareValues(ctx, 'opportunity', data.custom_fields);
  const newStage =
    data.stage_id !== undefined && data.stage_id !== current.stage_id
      ? resolveStage(ctx, current.pipeline_id, data.stage_id)
      : null;
  const now = ctx.now();
  const pick = <T>(value: T | undefined, fallback: T): T =>
    value === undefined ? fallback : value;

  const changed: string[] = [];
  const track = <K extends keyof OpportunityRow>(
    key: K,
    next: OpportunityRow[K],
  ): OpportunityRow[K] => {
    if (next !== current[key]) changed.push(key);
    return next;
  };
  const values = {
    title: track('title', data.title ?? current.title),
    contact_id: track('contact_id', pick(data.contact_id, current.contact_id)),
    company_id: track('company_id', pick(data.company_id, current.company_id)),
    owner_id: track('owner_id', pick(data.owner_id, current.owner_id)),
    value_minor: track('value_minor', data.value_minor ?? current.value_minor),
    currency: track('currency', data.currency ?? current.currency),
    expected_close_date: track(
      'expected_close_date',
      pick(data.expected_close_date, current.expected_close_date),
    ),
    lost_reason: track('lost_reason', pick(data.lost_reason, current.lost_reason)),
    next_action: track('next_action', pick(data.next_action, current.next_action)),
    next_action_at: track(
      'next_action_at',
      data.next_action_at === undefined
        ? current.next_action_at
        : data.next_action_at === null
          ? null
          : parseIsoMs(data.next_action_at, 'next_action_at'),
    ),
  };
  if (newStage !== null) changed.push('stage_id');
  changed.push(...writeValues(ctx, input.id, custom).map((k) => `custom.${k}`));
  if (changed.length === 0) return getOpportunity(ctx, { id: input.id });

  const stage = newStage ?? { id: current.stage_id, kind: current.status };
  ctx.db.run(
    `UPDATE crm_opportunities SET title = ?, contact_id = ?, company_id = ?, owner_id = ?, value_minor = ?,
       currency = ?, expected_close_date = ?, lost_reason = ?, next_action = ?, next_action_at = ?,
       stage_id = ?, status = ?, stage_changed_at = ?, closed_at = ?, updated_at = ? WHERE id = ?`,
    values.title,
    values.contact_id,
    values.company_id,
    values.owner_id,
    values.value_minor,
    values.currency,
    values.expected_close_date,
    values.lost_reason,
    values.next_action,
    values.next_action_at,
    stage.id,
    stage.kind,
    newStage === null ? current.stage_changed_at : now,
    newStage === null ? current.closed_at : newStage.kind === 'open' ? null : now,
    now,
    input.id,
  );
  const row = getOpportunityRow(ctx, input.id);
  if (newStage !== null) {
    ctx.db.run(
      `INSERT INTO crm_opportunity_stage_history (id, opportunity_id, from_stage_id, to_stage_id, changed_by, changed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ctx.newId(),
      row.id,
      current.stage_id,
      newStage.id,
      ctx.actor.id,
      now,
    );
    emit(
      ctx,
      'opportunity.stage_changed',
      { ...oppRefs(row), fromStageId: current.stage_id, toStageId: newStage.id },
      { title: row.title, stageName: newStage.name },
    );
    if (newStage.kind === 'won' && current.status !== 'won')
      emit(ctx, 'opportunity.won', oppRefs(row));
    if (newStage.kind === 'lost' && current.status !== 'lost')
      emit(ctx, 'opportunity.lost', oppRefs(row));
  }
  const nonStage = changed.filter((c) => c !== 'stage_id');
  if (nonStage.length > 0)
    emit(ctx, 'opportunity.updated', { ...oppRefs(row), changedFields: nonStage });
  return getOpportunity(ctx, { id: input.id });
}

export function deleteOpportunity(
  ctx: CrmContext,
  input: { id: string },
): { id: string; deleted: true } {
  const row = getOpportunityRow(ctx, input.id);
  ctx.db.run(`UPDATE crm_opportunities SET deleted_at = ? WHERE id = ?`, ctx.now(), input.id);
  emit(ctx, 'opportunity.deleted', oppRefs(row));
  return { id: input.id, deleted: true };
}

/** Undo of a delete; refused once the deal's pipeline or stage is gone. */
export function restoreOpportunity(ctx: CrmContext, input: { id: string }): Opportunity {
  const row = getOpportunityRow(ctx, input.id, true);
  const stage = ctx.db.all(
    `SELECT 1 FROM crm_pipeline_stages s JOIN crm_pipelines p ON p.id = s.pipeline_id
     WHERE s.id = ? AND s.deleted_at IS NULL AND p.deleted_at IS NULL`,
    row.stage_id,
  );
  if (stage.length === 0) {
    throw new CrmError('conflict', 'the pipeline stage of this opportunity no longer exists');
  }
  ctx.db.run(
    `UPDATE crm_opportunities SET deleted_at = NULL, updated_at = ? WHERE id = ?`,
    ctx.now(),
    input.id,
  );
  return getOpportunity(ctx, { id: input.id });
}

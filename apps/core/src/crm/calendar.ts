import type {
  Appointment,
  CalendarQuery,
  CalendarResponse,
  CreateAppointmentInput,
  CreateTaskInput,
  ListAppointmentsQuery,
  ListTasksQuery,
  Page,
  RichText,
  Task,
  UpdateAppointmentInput,
  UpdateTaskInput,
} from '@amable/api-types';
import type { CrmContext } from './context';
import type { SqlValue } from './db/sql';
import { invalid, notFound } from './errors';
import { emit } from './events';
import { assertRef } from './refs';
import {
  decodeCursor,
  encodeCursor,
  parseIsoMs,
  parseJson,
  serializeRichText,
  toIso,
} from './util';

// -------------------------------------------------------------------- tasks

interface TaskRow {
  id: string;
  title: string;
  description_json: string | null;
  contact_id: string | null;
  company_id: string | null;
  opportunity_id: string | null;
  assigned_to: string | null;
  due_at: number | null;
  priority: Task['priority'];
  type: Task['type'];
  status: Task['status'];
  completed_at: number | null;
  completed_by: string | null;
  created_at: number;
  updated_at: number;
}

function taskToApi(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description:
      row.description_json === null ? null : parseJson<RichText | null>(row.description_json, null),
    contact_id: row.contact_id,
    company_id: row.company_id,
    opportunity_id: row.opportunity_id,
    assigned_to: row.assigned_to,
    due_at: toIso(row.due_at),
    priority: row.priority,
    type: row.type,
    status: row.status,
    completed_at: toIso(row.completed_at),
    completed_by: row.completed_by,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function getTaskRow(ctx: CrmContext, id: string, includeDeleted = false): TaskRow {
  const row = ctx.db.all<TaskRow>(
    `SELECT * FROM crm_tasks WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    id,
  )[0];
  if (row === undefined) throw notFound('task', id);
  return row;
}

const taskRefs = (
  row: TaskRow,
): { taskId: string; contactId: string | null; assignedTo: string | null } => ({
  taskId: row.id,
  contactId: row.contact_id,
  assignedTo: row.assigned_to,
});

function assertLinks(
  ctx: CrmContext,
  input: { contact_id?: string | null; company_id?: string | null; opportunity_id?: string | null },
): void {
  assertRef(ctx, 'contact', input.contact_id, 'contact_id');
  assertRef(ctx, 'company', input.company_id, 'company_id');
  assertRef(ctx, 'opportunity', input.opportunity_id, 'opportunity_id');
}

export function getTask(ctx: CrmContext, input: { id: string }): Task {
  return taskToApi(getTaskRow(ctx, input.id));
}

export function listTasks(ctx: CrmContext, input: ListTasksQuery): Page<Task> {
  const before = input.cursor === undefined ? null : decodeCursor(input.cursor).id;
  const dueBefore =
    input.due_before === undefined ? null : parseIsoMs(input.due_before, 'due_before');
  const dueAfter = input.due_after === undefined ? null : parseIsoMs(input.due_after, 'due_after');
  const rows = ctx.db.all<TaskRow>(
    `SELECT * FROM crm_tasks WHERE deleted_at IS NULL
       AND (? IS NULL OR status = ?) AND (? IS NULL OR assigned_to = ?)
       AND (? IS NULL OR contact_id = ?) AND (? IS NULL OR opportunity_id = ?)
       AND (? IS NULL OR due_at < ?) AND (? IS NULL OR due_at >= ?)
       AND (? IS NULL OR id < ?)
     ORDER BY id DESC LIMIT ?`,
    input.status ?? null,
    input.status ?? null,
    input.assigned_to ?? null,
    input.assigned_to ?? null,
    input.contact_id ?? null,
    input.contact_id ?? null,
    input.opportunity_id ?? null,
    input.opportunity_id ?? null,
    dueBefore,
    dueBefore,
    dueAfter,
    dueAfter,
    before,
    before,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(taskToApi),
    next_cursor:
      rows.length > input.limit && last !== undefined
        ? encodeCursor({ v: null, id: last.id })
        : null,
  };
}

export function createTask(ctx: CrmContext, input: CreateTaskInput): Task {
  assertLinks(ctx, input);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_tasks (id, title, description_json, contact_id, company_id, opportunity_id, assigned_to,
       due_at, priority, type, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.title,
    input.description === undefined || input.description === null
      ? null
      : serializeRichText(input.description, 'description'),
    input.contact_id ?? null,
    input.company_id ?? null,
    input.opportunity_id ?? null,
    input.assigned_to ?? null,
    input.due_at === undefined || input.due_at === null ? null : parseIsoMs(input.due_at, 'due_at'),
    input.priority ?? 'normal',
    input.type ?? 'todo',
    ctx.actor.id,
    now,
    now,
  );
  const row = getTaskRow(ctx, id);
  emit(ctx, 'task.created', taskRefs(row), { title: row.title });
  return taskToApi(row);
}

export function updateTask(ctx: CrmContext, input: { id: string; data: UpdateTaskInput }): Task {
  const current = getTaskRow(ctx, input.id);
  const data = input.data;
  assertLinks(ctx, data);
  const pick = <T>(value: T | undefined, fallback: T): T =>
    value === undefined ? fallback : value;
  ctx.db.run(
    `UPDATE crm_tasks SET title = ?, description_json = ?, contact_id = ?, company_id = ?, opportunity_id = ?,
       assigned_to = ?, due_at = ?, priority = ?, type = ?, updated_at = ? WHERE id = ?`,
    data.title ?? current.title,
    data.description === undefined
      ? current.description_json
      : data.description === null
        ? null
        : serializeRichText(data.description, 'description'),
    pick(data.contact_id, current.contact_id),
    pick(data.company_id, current.company_id),
    pick(data.opportunity_id, current.opportunity_id),
    pick(data.assigned_to, current.assigned_to),
    data.due_at === undefined
      ? current.due_at
      : data.due_at === null
        ? null
        : parseIsoMs(data.due_at, 'due_at'),
    data.priority ?? current.priority,
    data.type ?? current.type,
    ctx.now(),
    input.id,
  );
  const row = getTaskRow(ctx, input.id);
  emit(ctx, 'task.updated', taskRefs(row), { title: row.title });
  return taskToApi(row);
}

export function completeTask(ctx: CrmContext, input: { id: string }): Task {
  const current = getTaskRow(ctx, input.id);
  if (current.status === 'completed') return taskToApi(current);
  const now = ctx.now();
  ctx.db.run(
    `UPDATE crm_tasks SET status = 'completed', completed_at = ?, completed_by = ?, updated_at = ? WHERE id = ?`,
    now,
    ctx.actor.id,
    now,
    input.id,
  );
  const row = getTaskRow(ctx, input.id);
  emit(ctx, 'task.completed', taskRefs(row), { title: row.title });
  return taskToApi(row);
}

export function reopenTask(ctx: CrmContext, input: { id: string }): Task {
  const current = getTaskRow(ctx, input.id);
  if (current.status === 'open') return taskToApi(current);
  ctx.db.run(
    `UPDATE crm_tasks SET status = 'open', completed_at = NULL, completed_by = NULL, updated_at = ? WHERE id = ?`,
    ctx.now(),
    input.id,
  );
  const row = getTaskRow(ctx, input.id);
  emit(ctx, 'task.reopened', taskRefs(row), { title: row.title });
  return taskToApi(row);
}

export function deleteTask(ctx: CrmContext, input: { id: string }): { id: string; deleted: true } {
  const row = getTaskRow(ctx, input.id);
  ctx.db.run(`UPDATE crm_tasks SET deleted_at = ? WHERE id = ?`, ctx.now(), input.id);
  emit(ctx, 'task.deleted', taskRefs(row));
  return { id: input.id, deleted: true };
}

export function restoreTask(ctx: CrmContext, input: { id: string }): Task {
  getTaskRow(ctx, input.id, true);
  ctx.db.run(`UPDATE crm_tasks SET deleted_at = NULL, updated_at = ? WHERE id = ?`, ctx.now(), input.id);
  return getTask(ctx, { id: input.id });
}

// ------------------------------------------------------------- appointments

interface AppointmentRow {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_at: number;
  end_at: number;
  all_day: number;
  time_zone: string | null;
  contact_id: string | null;
  company_id: string | null;
  opportunity_id: string | null;
  owner_id: string | null;
  attendees: string;
  reminder_minutes: string;
  status: Appointment['status'];
  source: Appointment['source'];
  created_at: number;
  updated_at: number;
}

function appointmentToApi(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    start_at: toIso(row.start_at),
    end_at: toIso(row.end_at),
    all_day: row.all_day === 1,
    time_zone: row.time_zone,
    contact_id: row.contact_id,
    company_id: row.company_id,
    opportunity_id: row.opportunity_id,
    owner_id: row.owner_id,
    attendees: parseJson<Appointment['attendees']>(row.attendees, []),
    reminder_minutes: parseJson<number[]>(row.reminder_minutes, []),
    status: row.status,
    source: row.source,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function getAppointmentRow(ctx: CrmContext, id: string): AppointmentRow {
  const row = ctx.db.all<AppointmentRow>(
    `SELECT * FROM crm_appointments WHERE id = ? AND deleted_at IS NULL`,
    id,
  )[0];
  if (row === undefined) throw notFound('appointment', id);
  return row;
}

const appointmentRefs = (
  row: AppointmentRow,
): { appointmentId: string; contactId: string | null; ownerId: string | null } => ({
  appointmentId: row.id,
  contactId: row.contact_id,
  ownerId: row.owner_id,
});

function checkRange(start: number, end: number): void {
  if (end < start) throw invalid('end_at', 'end_at must not be before start_at');
  if (end - start > 31 * 86_400_000) throw invalid('end_at', 'appointments cannot exceed 31 days');
}

export function getAppointment(ctx: CrmContext, input: { id: string }): Appointment {
  return appointmentToApi(getAppointmentRow(ctx, input.id));
}

export function listAppointments(ctx: CrmContext, input: ListAppointmentsQuery): Page<Appointment> {
  const from = input.from === undefined ? null : parseIsoMs(input.from, 'from');
  const to = input.to === undefined ? null : parseIsoMs(input.to, 'to');
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const afterStart = typeof after?.v === 'number' ? after.v : null;
  const rows = ctx.db.all<AppointmentRow>(
    `SELECT * FROM crm_appointments WHERE deleted_at IS NULL
       AND (? IS NULL OR end_at >= ?) AND (? IS NULL OR start_at < ?)
       AND (? IS NULL OR owner_id = ?) AND (? IS NULL OR contact_id = ?)
       AND (? IS NULL OR start_at > ? OR (start_at = ? AND id > ?))
     ORDER BY start_at, id LIMIT ?`,
    from,
    from,
    to,
    to,
    input.owner_id ?? null,
    input.owner_id ?? null,
    input.contact_id ?? null,
    input.contact_id ?? null,
    afterStart,
    afterStart,
    afterStart,
    after?.id ?? '',
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(appointmentToApi),
    next_cursor:
      rows.length > input.limit && last !== undefined
        ? encodeCursor({ v: last.start_at, id: last.id })
        : null,
  };
}

export function createAppointment(
  ctx: CrmContext,
  input: CreateAppointmentInput & { source?: Appointment['source'] },
): Appointment {
  assertLinks(ctx, input);
  const start = parseIsoMs(input.start_at, 'start_at');
  const end = parseIsoMs(input.end_at, 'end_at');
  checkRange(start, end);
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_appointments (id, title, description, location, start_at, end_at, all_day, time_zone,
       contact_id, company_id, opportunity_id, owner_id, attendees, reminder_minutes, status, source,
       created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.title,
    input.description ?? null,
    input.location ?? null,
    start,
    end,
    input.all_day === true ? 1 : 0,
    input.time_zone ?? null,
    input.contact_id ?? null,
    input.company_id ?? null,
    input.opportunity_id ?? null,
    input.owner_id ?? ctx.actor.id,
    JSON.stringify(input.attendees ?? []),
    JSON.stringify(input.reminder_minutes ?? []),
    input.status ?? 'scheduled',
    input.source ?? (ctx.actor.type === 'api_key' ? 'api' : 'manual'),
    ctx.actor.id,
    now,
    now,
  );
  const row = getAppointmentRow(ctx, id);
  emit(ctx, 'appointment.created', appointmentRefs(row), {
    title: row.title,
    startAt: toIso(row.start_at),
  });
  return appointmentToApi(row);
}

export function updateAppointment(
  ctx: CrmContext,
  input: { id: string; data: UpdateAppointmentInput },
): Appointment {
  const current = getAppointmentRow(ctx, input.id);
  const data = input.data;
  assertLinks(ctx, data);
  const start =
    data.start_at === undefined ? current.start_at : parseIsoMs(data.start_at, 'start_at');
  const end = data.end_at === undefined ? current.end_at : parseIsoMs(data.end_at, 'end_at');
  checkRange(start, end);
  const pick = <T extends SqlValue>(value: T | undefined, fallback: T): T =>
    value === undefined ? fallback : value;
  ctx.db.run(
    `UPDATE crm_appointments SET title = ?, description = ?, location = ?, start_at = ?, end_at = ?, all_day = ?,
       time_zone = ?, contact_id = ?, company_id = ?, opportunity_id = ?, owner_id = ?, attendees = ?,
       reminder_minutes = ?, status = ?, updated_at = ? WHERE id = ?`,
    data.title ?? current.title,
    pick(data.description, current.description),
    pick(data.location, current.location),
    start,
    end,
    data.all_day === undefined ? current.all_day : data.all_day ? 1 : 0,
    pick(data.time_zone, current.time_zone),
    pick(data.contact_id, current.contact_id),
    pick(data.company_id, current.company_id),
    pick(data.opportunity_id, current.opportunity_id),
    pick(data.owner_id, current.owner_id),
    data.attendees === undefined ? current.attendees : JSON.stringify(data.attendees),
    data.reminder_minutes === undefined
      ? current.reminder_minutes
      : JSON.stringify(data.reminder_minutes),
    data.status ?? current.status,
    ctx.now(),
    input.id,
  );
  const row = getAppointmentRow(ctx, input.id);
  const cancelled = current.status !== 'cancelled' && row.status === 'cancelled';
  emit(ctx, cancelled ? 'appointment.cancelled' : 'appointment.updated', appointmentRefs(row), {
    title: row.title,
    startAt: toIso(row.start_at),
  });
  return appointmentToApi(row);
}

export function deleteAppointment(
  ctx: CrmContext,
  input: { id: string },
): { id: string; deleted: true } {
  const row = getAppointmentRow(ctx, input.id);
  ctx.db.run(`UPDATE crm_appointments SET deleted_at = ? WHERE id = ?`, ctx.now(), input.id);
  emit(ctx, 'appointment.deleted', appointmentRefs(row));
  return { id: input.id, deleted: true };
}

/** Appointments overlapping [from, to) plus open/completed tasks due in it. */
export function calendar(ctx: CrmContext, input: CalendarQuery): CalendarResponse {
  const from = parseIsoMs(input.from, 'from');
  const to = parseIsoMs(input.to, 'to');
  if (to <= from) throw invalid('to', 'to must be after from');
  if (to - from > 92 * 86_400_000) throw invalid('to', 'calendar range is limited to 92 days');
  const owner = input.owner_id ?? null;
  const appointments = ctx.db.all<AppointmentRow>(
    `SELECT * FROM crm_appointments WHERE deleted_at IS NULL AND end_at >= ? AND start_at < ?
       AND (? IS NULL OR owner_id = ?) ORDER BY start_at, id LIMIT 2000`,
    from,
    to,
    owner,
    owner,
  );
  const tasks = ctx.db.all<TaskRow>(
    `SELECT * FROM crm_tasks WHERE deleted_at IS NULL AND due_at >= ? AND due_at < ?
       AND (? IS NULL OR assigned_to = ?) ORDER BY due_at, id LIMIT 2000`,
    from,
    to,
    owner,
    owner,
  );
  return { appointments: appointments.map(appointmentToApi), tasks: tasks.map(taskToApi) };
}

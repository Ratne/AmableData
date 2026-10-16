import type {
  CreateNoteInput,
  ListNotesQuery,
  Note,
  Page,
  RichText,
  UpdateNoteInput,
} from '@amable/api-types';
import type { CrmContext } from './context';
import { invalid, notFound } from './errors';
import { emit } from './events';
import { assertRef } from './refs';
import { indexDocument, removeDocument } from './search/index-store';
import {
  decodeCursor,
  encodeCursor,
  parseJson,
  richTextToPlain,
  serializeRichText,
  toIso,
} from './util';

interface NoteRow {
  id: string;
  contact_id: string | null;
  company_id: string | null;
  opportunity_id: string | null;
  title: string | null;
  type: Note['type'];
  body_json: string;
  body_text: string;
  pinned: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function toApi(row: NoteRow): Note {
  return {
    id: row.id,
    contact_id: row.contact_id,
    company_id: row.company_id,
    opportunity_id: row.opportunity_id,
    title: row.title,
    type: row.type,
    body: parseJson<RichText>(row.body_json, { type: 'doc', content: [] }),
    body_text: row.body_text,
    pinned: row.pinned === 1,
    created_by: row.created_by,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function getRow(ctx: CrmContext, id: string): NoteRow {
  const row = ctx.db.all<NoteRow>(
    `SELECT * FROM crm_notes WHERE id = ? AND deleted_at IS NULL`,
    id,
  )[0];
  if (row === undefined) throw notFound('note', id);
  return row;
}

function refs(row: NoteRow): {
  noteId: string;
  contactId: string | null;
  companyId: string | null;
  opportunityId: string | null;
} {
  return {
    noteId: row.id,
    contactId: row.contact_id,
    companyId: row.company_id,
    opportunityId: row.opportunity_id,
  };
}

function index(ctx: CrmContext, row: NoteRow): void {
  const title = row.title ?? (row.body_text.slice(0, 80) || '(note)');
  indexDocument(ctx, 'note', row.id, title, [row.body_text]);
}

export function getNote(ctx: CrmContext, input: { id: string }): Note {
  return toApi(getRow(ctx, input.id));
}

export function listNotes(ctx: CrmContext, input: ListNotesQuery): Page<Note> {
  const before = input.cursor === undefined ? null : decodeCursor(input.cursor).id;
  const rows = ctx.db.all<NoteRow>(
    `SELECT * FROM crm_notes WHERE deleted_at IS NULL
       AND (? IS NULL OR contact_id = ?) AND (? IS NULL OR company_id = ?) AND (? IS NULL OR opportunity_id = ?)
       AND (? IS NULL OR id < ?)
     ORDER BY id DESC LIMIT ?`,
    input.contact_id ?? null,
    input.contact_id ?? null,
    input.company_id ?? null,
    input.company_id ?? null,
    input.opportunity_id ?? null,
    input.opportunity_id ?? null,
    before,
    before,
    input.limit + 1,
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    data: page.map(toApi),
    next_cursor:
      rows.length > input.limit && last !== undefined
        ? encodeCursor({ v: null, id: last.id })
        : null,
  };
}

export function createNote(ctx: CrmContext, input: CreateNoteInput): Note {
  if (!input.contact_id && !input.company_id && !input.opportunity_id) {
    throw invalid('contact_id', 'a note must belong to a contact, a company or an opportunity');
  }
  assertRef(ctx, 'contact', input.contact_id, 'contact_id');
  assertRef(ctx, 'company', input.company_id, 'company_id');
  assertRef(ctx, 'opportunity', input.opportunity_id, 'opportunity_id');
  const bodyJson = serializeRichText(input.body, 'body');
  const id = ctx.newId();
  const now = ctx.now();
  ctx.db.run(
    `INSERT INTO crm_notes (id, contact_id, company_id, opportunity_id, title, type, body_json, body_text,
       pinned, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.contact_id ?? null,
    input.company_id ?? null,
    input.opportunity_id ?? null,
    input.title ?? null,
    input.type ?? 'note',
    bodyJson,
    richTextToPlain(input.body),
    input.pinned === true ? 1 : 0,
    ctx.actor.id,
    now,
    now,
  );
  const row = getRow(ctx, id);
  index(ctx, row);
  emit(ctx, 'note.added', refs(row), { title: row.title, excerpt: row.body_text.slice(0, 140) });
  return toApi(row);
}

export function updateNote(ctx: CrmContext, input: { id: string; data: UpdateNoteInput }): Note {
  const current = getRow(ctx, input.id);
  const data = input.data;
  const bodyJson =
    data.body === undefined ? current.body_json : serializeRichText(data.body, 'body');
  ctx.db.run(
    `UPDATE crm_notes SET title = ?, type = ?, body_json = ?, body_text = ?, pinned = ?, updated_at = ? WHERE id = ?`,
    data.title === undefined ? current.title : data.title,
    data.type ?? current.type,
    bodyJson,
    data.body === undefined ? current.body_text : richTextToPlain(data.body),
    data.pinned === undefined ? current.pinned : data.pinned ? 1 : 0,
    ctx.now(),
    input.id,
  );
  const row = getRow(ctx, input.id);
  index(ctx, row);
  emit(ctx, 'note.updated', refs(row), { title: row.title });
  return toApi(row);
}

export function deleteNote(ctx: CrmContext, input: { id: string }): { id: string; deleted: true } {
  const row = getRow(ctx, input.id);
  ctx.db.run(`UPDATE crm_notes SET deleted_at = ? WHERE id = ?`, ctx.now(), input.id);
  removeDocument(ctx, 'note', input.id);
  emit(ctx, 'note.deleted', refs(row));
  return { id: input.id, deleted: true };
}

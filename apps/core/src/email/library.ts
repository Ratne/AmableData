import type {
  CreateEmailTemplateInput,
  CreateSnippetInput,
  EmailTemplate,
  EmailTemplateSummary,
  Page,
  Snippet,
  UpdateEmailTemplateInput,
  UpdateSnippetInput,
} from '@amable/api-types';
import type { CompiledEmail } from '@amable/email-render';
import {
  decodeCursor,
  encodeCursor,
  MailError,
  notFound,
  parseJson,
  isoOf,
  type MailDeps,
} from './context';
import { compileDocument, rendererFor, sha256Hex, type CompiledContent } from './render';
import { getSetting, tenantTimeZone } from './settings';

/** Templates (Tiptap JSON + compiled HTML cache) and Dynamic Content snippets. */

const MAX_BODY_BYTES = 512 * 1024;

interface TemplateRow {
  id: string;
  name: string;
  subject: string;
  body: string;
  from_name: string | null;
  reply_to: string | null;
  body_hash: string;
  compiled_hash: string | null;
  compiled_html: string | null;
  compiled_text: string | null;
  compiled_subject: string | null;
  compiled_preheader: string | null;
  created_at: number;
  updated_at: number;
}

function assertBodySize(body: unknown): string {
  const json = JSON.stringify(body);
  if (json.length > MAX_BODY_BYTES) {
    throw new MailError('payload_too_large', 413, 'email body exceeds 512 KB');
  }
  return json;
}

function summary(row: TemplateRow): EmailTemplateSummary {
  const preheader = row.compiled_preheader ?? '';
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    preheader,
    from_name: row.from_name,
    reply_to: row.reply_to,
    compiled: row.compiled_hash !== null && row.compiled_hash === row.body_hash,
    created_at: isoOf(row.created_at),
    updated_at: isoOf(row.updated_at),
  };
}

function full(row: TemplateRow): EmailTemplate {
  return { ...summary(row), body: parseJson(row.body, { type: 'doc' as const }) };
}

function getTemplateRow(deps: MailDeps, id: string): TemplateRow {
  const row = deps.db.all<TemplateRow>(
    `SELECT * FROM mail_templates WHERE id = ? AND deleted_at IS NULL`,
    id,
  )[0];
  if (row === undefined) throw notFound('template', id);
  return row;
}

/** Hash of everything the compiled output depends on. */
async function templateHash(deps: MailDeps, body: string, subject: string): Promise<string> {
  return sha256Hex(JSON.stringify([body, subject, getSetting(deps, 'physical_address') ?? '']));
}

/** Compiles and stores the HTML cache; invalid content is reported, the draft is still saved. */
async function refreshCompiled(deps: MailDeps, id: string): Promise<void> {
  const row = getTemplateRow(deps, id);
  const hash = await templateHash(deps, row.body, row.subject);
  if (row.body_hash !== hash) {
    deps.db.run(`UPDATE mail_templates SET body_hash = ? WHERE id = ?`, hash, id);
  }
  let compiled: CompiledEmail;
  try {
    compiled = compileDocument({
      body: parseJson<Record<string, unknown>>(row.body, {}),
      subject: row.subject,
      footerAddress: getSetting(deps, 'physical_address'),
    });
  } catch {
    deps.db.run(`UPDATE mail_templates SET compiled_hash = NULL WHERE id = ?`, id);
    return;
  }
  deps.db.run(
    `UPDATE mail_templates SET compiled_hash = ?, compiled_html = ?, compiled_text = ?,
            compiled_subject = ?, compiled_preheader = ? WHERE id = ?`,
    hash,
    compiled.htmlTemplate,
    compiled.textTemplate,
    compiled.subjectTemplate,
    compiled.preheader,
    id,
  );
}

export function listTemplates(
  deps: MailDeps,
  input: { limit?: number; cursor?: string },
): Page<EmailTemplateSummary> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const cursor = decodeCursor(input.cursor);
  const rows =
    cursor === null
      ? deps.db.all<TemplateRow>(
          `SELECT * FROM mail_templates WHERE deleted_at IS NULL
            ORDER BY updated_at DESC, id DESC LIMIT ?`,
          limit + 1,
        )
      : deps.db.all<TemplateRow>(
          `SELECT * FROM mail_templates WHERE deleted_at IS NULL
              AND (updated_at < ? OR (updated_at = ? AND id < ?))
            ORDER BY updated_at DESC, id DESC LIMIT ?`,
          Number(cursor[0]),
          Number(cursor[0]),
          String(cursor[1]),
          limit + 1,
        );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page.map(summary),
    next_cursor: rows.length > limit && last !== undefined ? encodeCursor([last.updated_at, last.id]) : null,
  };
}

export function getTemplate(deps: MailDeps, input: { id: string }): EmailTemplate {
  return full(getTemplateRow(deps, input.id));
}

export async function createTemplate(
  deps: MailDeps,
  input: CreateEmailTemplateInput & { createdBy: string | null },
): Promise<EmailTemplate> {
  const body = assertBodySize(input.body);
  const id = deps.newId();
  const now = deps.now();
  deps.db.run(
    `INSERT INTO mail_templates (id, name, subject, body, from_name, reply_to, body_hash, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
    id,
    input.name,
    input.subject,
    body,
    input.from_name ?? null,
    input.reply_to ?? null,
    input.createdBy,
    now,
    now,
  );
  await refreshCompiled(deps, id);
  return getTemplate(deps, { id });
}

export async function updateTemplate(
  deps: MailDeps,
  input: { id: string; data: UpdateEmailTemplateInput },
): Promise<EmailTemplate> {
  const row = getTemplateRow(deps, input.id);
  const d = input.data;
  deps.db.run(
    `UPDATE mail_templates SET name = ?, subject = ?, body = ?, from_name = ?, reply_to = ?, updated_at = ?
      WHERE id = ?`,
    d.name ?? row.name,
    d.subject ?? row.subject,
    d.body === undefined ? row.body : assertBodySize(d.body),
    d.from_name === undefined ? row.from_name : d.from_name,
    d.reply_to === undefined ? row.reply_to : d.reply_to,
    deps.now(),
    input.id,
  );
  await refreshCompiled(deps, input.id);
  return getTemplate(deps, { id: input.id });
}

export function deleteTemplate(deps: MailDeps, input: { id: string }): { id: string; deleted: true } {
  getTemplateRow(deps, input.id);
  deps.db.run(`UPDATE mail_templates SET deleted_at = ? WHERE id = ?`, deps.now(), input.id);
  return { id: input.id, deleted: true };
}

export interface ResolvedTemplate {
  readonly subject: string;
  readonly fromName: string | null;
  readonly replyTo: string | null;
  readonly content: CompiledContent;
}

/** Template ready to render: uses the persisted compiled HTML cache when it is current. */
export async function loadTemplateContent(
  deps: MailDeps,
  id: string,
  subjectOverride: string | null,
): Promise<ResolvedTemplate> {
  let row = getTemplateRow(deps, id);
  const hash = await templateHash(deps, row.body, row.subject);
  if (row.compiled_hash !== hash) {
    await refreshCompiled(deps, id);
    row = getTemplateRow(deps, id);
    if (row.compiled_hash === null) {
      throw new MailError('invalid_content', 422, `template ${id} does not compile`);
    }
  }
  const compiled: CompiledEmail = {
    htmlTemplate: row.compiled_html ?? '',
    textTemplate: row.compiled_text ?? '',
    subjectTemplate: row.compiled_subject ?? '',
    preheader: row.compiled_preheader ?? '',
    requiresUnsubscribe: true,
  };
  const timezone = tenantTimeZone(deps);
  let content = rendererFor(`tpl:${hash}`, compiled, timezone);
  if (subjectOverride !== null && subjectOverride !== row.subject) {
    content = rendererFor(
      `tpl:${hash}:${await sha256Hex(subjectOverride)}`,
      { ...compiled, subjectTemplate: subjectOverride.replace(/[\r\n]+/g, ' ').trim() },
      timezone,
    );
  }
  return { subject: subjectOverride ?? row.subject, fromName: row.from_name, replyTo: row.reply_to, content };
}

// ------------------------------------------------------------------ snippets

interface SnippetRow {
  id: string;
  key: string;
  name: string;
  body: string;
  created_at: number;
  updated_at: number;
}

const toSnippet = (row: SnippetRow): Snippet => ({
  id: row.id,
  key: row.key,
  name: row.name,
  body: row.body,
  created_at: isoOf(row.created_at),
  updated_at: isoOf(row.updated_at),
});

export function listSnippets(deps: MailDeps): { data: Snippet[] } {
  return {
    data: deps.db.all<SnippetRow>(`SELECT * FROM mail_snippets ORDER BY name COLLATE NOCASE`).map(toSnippet),
  };
}

function getSnippetRow(deps: MailDeps, id: string): SnippetRow {
  const row = deps.db.all<SnippetRow>(`SELECT * FROM mail_snippets WHERE id = ?`, id)[0];
  if (row === undefined) throw notFound('snippet', id);
  return row;
}

export function getSnippet(deps: MailDeps, input: { id: string }): Snippet {
  return toSnippet(getSnippetRow(deps, input.id));
}

export function createSnippet(deps: MailDeps, input: CreateSnippetInput): Snippet {
  const exists = deps.db.all(`SELECT 1 AS x FROM mail_snippets WHERE key = ?`, input.key).length > 0;
  if (exists) throw new MailError('conflict', 409, `snippet key ${input.key} already exists`);
  const id = deps.newId();
  const now = deps.now();
  deps.db.run(
    `INSERT INTO mail_snippets (id, key, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    input.key,
    input.name,
    input.body,
    now,
    now,
  );
  return getSnippet(deps, { id });
}

export function updateSnippet(
  deps: MailDeps,
  input: { id: string; data: UpdateSnippetInput },
): Snippet {
  const row = getSnippetRow(deps, input.id);
  deps.db.run(
    `UPDATE mail_snippets SET name = ?, body = ?, updated_at = ? WHERE id = ?`,
    input.data.name ?? row.name,
    input.data.body ?? row.body,
    deps.now(),
    input.id,
  );
  return getSnippet(deps, { id: input.id });
}

export function deleteSnippet(deps: MailDeps, input: { id: string }): { id: string; deleted: true } {
  getSnippetRow(deps, input.id);
  deps.db.run(`DELETE FROM mail_snippets WHERE id = ?`, input.id);
  return { id: input.id, deleted: true };
}
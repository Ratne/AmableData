import {
  CLIPBOARD_MAX_ITEMS,
  CLIPBOARD_TTL_MS,
  type ClipboardItem,
  type CreateClipboardItemInput,
} from '@amable/api-types';
import { isHtmlDocument } from '@amable/builder';
import type { CrmContext } from '../crm/context';
import { CrmError } from '../crm/errors';
import { parseJson, toIso } from '../crm/util';
import { parseDocument } from './pages';

/**
 * Personal clipboard of the page builder: entries belong to the user who
 * copied them (`ctx.actor.id`), expire after 24h and are capped per user.
 * Cleanup is lazy, on every list/create.
 */

interface ClipboardRow {
  id: string;
  user_id: string;
  label: string;
  whole_page: number;
  source_page_name: string;
  nodes: string;
  created_at: number;
}

/** Owner of the entries: the clipboard is personal, so a user (or key) is required. */
function owner(ctx: CrmContext): string {
  if (ctx.actor.id === null) throw new CrmError('forbidden', 'the clipboard needs an authenticated actor');
  return ctx.actor.id;
}

function serialize(row: ClipboardRow): ClipboardItem {
  return {
    id: row.id,
    label: row.label,
    whole_page: row.whole_page === 1,
    source_page_name: row.source_page_name,
    nodes: parseJson<Record<string, unknown>[]>(row.nodes, []),
    created_at: toIso(row.created_at),
  };
}

function purge(ctx: CrmContext): void {
  ctx.db.run(
    `DELETE FROM canvas_clipboard WHERE user_id = ? AND created_at < ?`,
    owner(ctx),
    ctx.now() - CLIPBOARD_TTL_MS,
  );
  const extra = ctx.db.all<{ id: string }>(
    `SELECT id FROM canvas_clipboard WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?`,
    owner(ctx),
    CLIPBOARD_MAX_ITEMS,
  );
  for (const row of extra) ctx.db.run(`DELETE FROM canvas_clipboard WHERE id = ?`, row.id);
}

export function listClipboard(ctx: CrmContext, _input: Record<string, never>): { data: ClipboardItem[] } {
  purge(ctx);
  const rows = ctx.db.all<ClipboardRow>(
    `SELECT * FROM canvas_clipboard WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    owner(ctx),
    CLIPBOARD_MAX_ITEMS,
  );
  return { data: rows.map(serialize) };
}

export function createClipboardItem(ctx: CrmContext, input: CreateClipboardItemInput): ClipboardItem {
  // Validated and rich-text sanitized like a canvas document (size capped too).
  const doc = parseDocument({ editorKind: 'canvas', body: input.nodes }, 'nodes');
  if (isHtmlDocument(doc) || doc.body.length === 0) throw new CrmError('validation_failed', 'nodes required');
  const id = ctx.newId();
  ctx.db.run(
    `INSERT INTO canvas_clipboard (id, user_id, label, whole_page, source_page_name, nodes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    owner(ctx),
    input.label.trim(),
    input.whole_page === true ? 1 : 0,
    input.source_page_name ?? '',
    JSON.stringify(doc.body),
    ctx.now(),
  );
  purge(ctx);
  const row = ctx.db.all<ClipboardRow>(`SELECT * FROM canvas_clipboard WHERE id = ?`, id)[0];
  if (row === undefined) throw new CrmError('internal_error', 'clipboard entry not stored');
  return serialize(row);
}

export function deleteClipboardItem(ctx: CrmContext, input: { id: string }): { id: string; deleted: true } {
  ctx.db.run(`DELETE FROM canvas_clipboard WHERE id = ? AND user_id = ?`, input.id, owner(ctx));
  return { id: input.id, deleted: true };
}

export function clearClipboard(ctx: CrmContext, _input: Record<string, never>): { deleted: number } {
  const n = ctx.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM canvas_clipboard WHERE user_id = ?`, owner(ctx))[0]?.n ?? 0;
  ctx.db.run(`DELETE FROM canvas_clipboard WHERE user_id = ?`, owner(ctx));
  return { deleted: n };
}

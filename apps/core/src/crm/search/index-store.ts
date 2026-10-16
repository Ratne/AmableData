import type { GlobalSearchHit, GlobalSearchResponse } from '@amable/api-types';
import type { CrmContext, SearchMode } from '../context';
import { placeholders, type SqlDb, type SqlValue } from '../db/sql';
import { normalizeText } from '../util';

/**
 * Full-text index over `crm_search_documents`.
 *
 * Primary mode: an FTS5 external-content table kept in sync by triggers
 * (unicode61 tokenizer, diacritics folded, prefix indexes for 2-3 chars).
 * Fallback mode ("trigram"), used when the SQLite build lacks FTS5: a trigram
 * posting table narrows candidates, then LIKE over the normalized text
 * verifies them. Same API, same results modulo ranking.
 */

export type SearchEntityKind = 'contact' | 'company' | 'note' | 'order';

const FTS_DDL = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS crm_search_fts USING fts5(
     title, body,
     content='crm_search_documents', content_rowid='doc_id',
     tokenize='unicode61 remove_diacritics 2', prefix='2 3'
   )`,
  `CREATE TRIGGER IF NOT EXISTS crm_search_documents_ai AFTER INSERT ON crm_search_documents BEGIN
     INSERT INTO crm_search_fts (rowid, title, body) VALUES (new.doc_id, new.title, new.body);
   END`,
  `CREATE TRIGGER IF NOT EXISTS crm_search_documents_ad AFTER DELETE ON crm_search_documents BEGIN
     INSERT INTO crm_search_fts (crm_search_fts, rowid, title, body) VALUES ('delete', old.doc_id, old.title, old.body);
   END`,
  `CREATE TRIGGER IF NOT EXISTS crm_search_documents_au AFTER UPDATE ON crm_search_documents BEGIN
     INSERT INTO crm_search_fts (crm_search_fts, rowid, title, body) VALUES ('delete', old.doc_id, old.title, old.body);
     INSERT INTO crm_search_fts (rowid, title, body) VALUES (new.doc_id, new.title, new.body);
   END`,
];

/**
 * Creates the FTS5 index (idempotent) and returns the mode to use. Called once
 * per DO boot, after migrations. `forceMode` exists for tests.
 */
export function ensureSearchIndex(db: SqlDb, forceMode?: SearchMode): SearchMode {
  let mode: SearchMode = forceMode ?? 'fts5';
  if (mode === 'fts5') {
    try {
      const existed =
        db.all(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'crm_search_fts'`)
          .length > 0;
      db.transaction(() => {
        for (const statement of FTS_DDL) db.run(statement);
        if (!existed) db.run(`INSERT INTO crm_search_fts (crm_search_fts) VALUES ('rebuild')`);
      });
    } catch (error) {
      console.warn('[search] FTS5 unavailable, using trigram fallback:', error);
      mode = 'trigram';
    }
  }
  if (mode === 'trigram') {
    // Backfill postings for documents written while FTS5 was in use.
    const missing = db.all<{ doc_id: number; normalized: string }>(
      `SELECT doc_id, normalized FROM crm_search_documents d
       WHERE NOT EXISTS (SELECT 1 FROM crm_search_trigrams t WHERE t.doc_id = d.doc_id)`,
    );
    db.transaction(() => {
      for (const doc of missing) writeTrigrams(db, doc.doc_id, doc.normalized);
    });
  }
  db.run(
    `INSERT INTO tenant_meta (key, value) VALUES ('search_mode', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    mode,
  );
  return mode;
}

const MAX_TRIGRAMS = 4000;

export function trigramsOf(text: string): string[] {
  const grams = new Set<string>();
  for (const word of text.split(/\s+/)) {
    if (word.length < 3) continue;
    for (let i = 0; i + 3 <= word.length && grams.size < MAX_TRIGRAMS; i += 1) {
      grams.add(word.slice(i, i + 3));
    }
  }
  return [...grams];
}

function writeTrigrams(db: SqlDb, docId: number, normalized: string): void {
  db.run(`DELETE FROM crm_search_trigrams WHERE doc_id = ?`, docId);
  for (const gram of trigramsOf(normalized)) {
    db.run(`INSERT OR IGNORE INTO crm_search_trigrams (gram, doc_id) VALUES (?, ?)`, gram, docId);
  }
}

/** Inserts or replaces the search document of a record. */
export function indexDocument(
  ctx: CrmContext,
  entity: SearchEntityKind,
  entityId: string,
  title: string,
  bodyParts: Array<string | null | undefined>,
): void {
  const body = bodyParts.filter((p): p is string => typeof p === 'string' && p !== '').join(' \n ');
  const normalized = normalizeText(`${title} ${body}`).replace(/\s+/g, ' ');
  ctx.db.run(
    `INSERT INTO crm_search_documents (entity, entity_id, title, body, normalized, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (entity, entity_id) DO UPDATE SET
       title = excluded.title, body = excluded.body,
       normalized = excluded.normalized, updated_at = excluded.updated_at`,
    entity,
    entityId,
    title,
    body,
    normalized,
    ctx.now(),
  );
  if (ctx.searchMode === 'trigram') {
    const doc = ctx.db.all<{ doc_id: number }>(
      `SELECT doc_id FROM crm_search_documents WHERE entity = ? AND entity_id = ?`,
      entity,
      entityId,
    )[0];
    if (doc !== undefined) writeTrigrams(ctx.db, doc.doc_id, normalized);
  }
}

export function removeDocument(ctx: CrmContext, entity: SearchEntityKind, entityId: string): void {
  if (ctx.searchMode === 'trigram') {
    ctx.db.run(
      `DELETE FROM crm_search_trigrams WHERE doc_id IN
         (SELECT doc_id FROM crm_search_documents WHERE entity = ? AND entity_id = ?)`,
      entity,
      entityId,
    );
  }
  ctx.db.run(
    `DELETE FROM crm_search_documents WHERE entity = ? AND entity_id = ?`,
    entity,
    entityId,
  );
}

/** Normalized search terms (letters/digits runs), at most 10. */
export function searchTerms(q: string): string[] {
  return (normalizeText(q).match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 10);
}

/** FTS5 MATCH expression: every term must match as a prefix. */
export function ftsMatchExpression(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

function likeEscape(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * SQL fragment selecting `entity_id`s of documents matching `q`, for use as
 * `<id column> IN (<fragment>)`. Returns null when `q` has no searchable terms.
 */
export function matchingIdsSql(
  mode: SearchMode,
  entity: SearchEntityKind,
  q: string,
): { sql: string; params: SqlValue[] } | null {
  const terms = searchTerms(q);
  if (terms.length === 0) return null;
  if (mode === 'fts5') {
    return {
      sql: `SELECT d.entity_id FROM crm_search_documents d
            WHERE d.entity = ? AND d.doc_id IN
              (SELECT rowid FROM crm_search_fts WHERE crm_search_fts MATCH ?)`,
      params: [entity, ftsMatchExpression(terms)],
    };
  }
  return trigramCandidates(entity, terms);
}

function trigramCandidates(
  entity: SearchEntityKind | null,
  terms: string[],
): { sql: string; params: SqlValue[] } {
  const params: SqlValue[] = [];
  const clauses: string[] = [];
  if (entity !== null) {
    clauses.push('d.entity = ?');
    params.push(entity);
  }
  const grams = [...new Set(terms.flatMap((t) => trigramsOf(t)))];
  if (grams.length > 0) {
    clauses.push(
      `d.doc_id IN (SELECT doc_id FROM crm_search_trigrams WHERE gram IN (${placeholders(grams.length)})
                    GROUP BY doc_id HAVING COUNT(*) = ?)`,
    );
    params.push(...grams, grams.length);
  }
  for (const term of terms) {
    clauses.push(`d.normalized LIKE ? ESCAPE '\\'`);
    params.push(`%${likeEscape(term)}%`);
  }
  return {
    sql: `SELECT d.entity_id FROM crm_search_documents d WHERE ${clauses.join(' AND ')}`,
    params,
  };
}

/** Cross-entity search for the global search box. */
export function globalSearch(
  ctx: CrmContext,
  input: { q: string; types: SearchEntityKind[]; limit: number },
): GlobalSearchResponse {
  const terms = searchTerms(input.q);
  if (terms.length === 0 || input.types.length === 0) return { mode: ctx.searchMode, data: [] };

  if (ctx.searchMode === 'fts5') {
    const rows = ctx.db.all<{
      entity: GlobalSearchHit['type'];
      entity_id: string;
      title: string;
      snippet: string;
      rank: number;
    }>(
      `SELECT d.entity, d.entity_id, d.title,
              snippet(crm_search_fts, 1, '', '', '…', 12) AS snippet,
              bm25(crm_search_fts, 5.0, 1.0) AS rank
       FROM crm_search_fts JOIN crm_search_documents d ON d.doc_id = crm_search_fts.rowid
       WHERE crm_search_fts MATCH ? AND d.entity IN (${placeholders(input.types.length)})
       ORDER BY rank LIMIT ?`,
      ftsMatchExpression(terms),
      ...input.types,
      input.limit,
    );
    return {
      mode: 'fts5',
      data: rows.map((r) => ({
        type: r.entity,
        id: r.entity_id,
        title: r.title,
        snippet: r.snippet,
        rank: r.rank,
      })),
    };
  }

  const candidates = trigramCandidates(null, terms);
  const rows = ctx.db.all<{
    entity: GlobalSearchHit['type'];
    entity_id: string;
    title: string;
    body: string;
  }>(
    `SELECT entity, entity_id, title, body FROM crm_search_documents
     WHERE entity IN (${placeholders(input.types.length)})
       AND entity_id IN (${candidates.sql})
     ORDER BY updated_at DESC LIMIT ?`,
    ...input.types,
    ...candidates.params,
    input.limit,
  );
  return {
    mode: 'trigram',
    data: rows.map((r) => ({
      type: r.entity,
      id: r.entity_id,
      title: r.title,
      snippet: fallbackSnippet(r.body, terms[0] ?? ''),
      rank: 0,
    })),
  };
}

function fallbackSnippet(body: string, term: string): string {
  const index = normalizeText(body).indexOf(term);
  if (index === -1) return body.slice(0, 80);
  const start = Math.max(0, index - 30);
  return `${start > 0 ? '…' : ''}${body.slice(start, index + term.length + 40)}…`;
}

import { randomId, type SqlDb } from './db';
import { formIds, type Given, type QuizDefinition } from './quiz';

export type QuizStatus = 'draft' | 'published';

export interface Quiz {
  readonly id: string;
  readonly installId: string;
  /** In the public links and the embed code: random, unguessable. */
  readonly publicId: string;
  readonly name: string;
  readonly status: QuizStatus;
  readonly definition: QuizDefinition;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Session {
  readonly id: string;
  readonly installId: string;
  readonly quizId: string;
  readonly preview: boolean;
  readonly contactId: string | null;
  readonly submissionId: string | null;
  readonly score: number | null;
  readonly maxScore: number | null;
  readonly resultLabel: string | null;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly finishedAt: number | null;
  readonly syncedAt: number | null;
}

export interface AnswerRow {
  readonly stepId: string;
  readonly answerId: string | null;
  readonly text: string | null;
  readonly tagged: boolean;
  readonly updatedAt: number;
}

export const PUBLIC_ID = /^[0-9a-z]{16}$/;
export const SESSION_ID = /^s_[0-9a-z]{24}$/;

/** Unfinished sessions without a contact are dropped after this; pending links after a couple of days. */
const ANONYMOUS_TTL_MS = 90 * 24 * 3_600_000;
const PENDING_LINK_TTL_MS = 2 * 24 * 3_600_000;

interface QuizRow {
  id: string;
  install_id: string;
  public_id: string;
  name: string;
  status: string;
  definition: string;
  created_at: number;
  updated_at: number;
}

const quizOf = (row: QuizRow): Quiz => ({
  id: row.id,
  installId: row.install_id,
  publicId: row.public_id,
  name: row.name,
  status: row.status === 'published' ? 'published' : 'draft',
  definition: JSON.parse(row.definition) as QuizDefinition,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface SessionRow {
  id: string;
  install_id: string;
  quiz_id: string;
  preview: number;
  contact_id: string | null;
  submission_id: string | null;
  score: number | null;
  max_score: number | null;
  result_label: string | null;
  started_at: number;
  updated_at: number;
  finished_at: number | null;
  synced_at: number | null;
}

const sessionOf = (row: SessionRow): Session => ({
  id: row.id,
  installId: row.install_id,
  quizId: row.quiz_id,
  preview: row.preview === 1,
  contactId: row.contact_id,
  submissionId: row.submission_id,
  score: row.score,
  maxScore: row.max_score,
  resultLabel: row.result_label,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
  finishedAt: row.finished_at,
  syncedAt: row.synced_at,
});

/* ---------- quizzes ---------- */

export async function listQuizzes(db: SqlDb, installId: string): Promise<Quiz[]> {
  const { results } = await db
    .prepare('SELECT * FROM quizzes WHERE install_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
    .bind(installId)
    .all<QuizRow>();
  return results.map(quizOf);
}

export async function getQuiz(db: SqlDb, installId: string, id: string): Promise<Quiz | null> {
  const row = await db.prepare('SELECT * FROM quizzes WHERE install_id = ? AND id = ? AND deleted_at IS NULL').bind(installId, id).first<QuizRow>();
  return row === null ? null : quizOf(row);
}

export async function quizByPublicId(db: SqlDb, publicId: string): Promise<Quiz | null> {
  if (!PUBLIC_ID.test(publicId)) return null;
  const row = await db.prepare('SELECT * FROM quizzes WHERE public_id = ? AND deleted_at IS NULL').bind(publicId).first<QuizRow>();
  return row === null ? null : quizOf(row);
}

export interface QuizInput {
  readonly name: string;
  readonly status: QuizStatus;
  readonly definition: QuizDefinition;
}

/** `form_ids` is `,a,b,`: a webhook asks "is this form in one of my quizzes" with LIKE. */
const formColumn = (definition: QuizDefinition) => {
  const ids = formIds(definition);
  return ids.length === 0 ? '' : `,${ids.join(',')},`;
};

export async function saveQuiz(db: SqlDb, installId: string, id: string | null, input: QuizInput, at: number): Promise<Quiz | null> {
  const definition = JSON.stringify(input.definition);
  if (id === null) {
    const quizId = `qz_${randomId()}`;
    await db
      .prepare(
        'INSERT INTO quizzes (id, install_id, public_id, name, status, definition, form_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(quizId, installId, randomId(), input.name, input.status, definition, formColumn(input.definition), at, at)
      .run();
    return getQuiz(db, installId, quizId);
  }
  const { meta } = await db
    .prepare('UPDATE quizzes SET name = ?, status = ?, definition = ?, form_ids = ?, updated_at = ? WHERE install_id = ? AND id = ? AND deleted_at IS NULL')
    .bind(input.name, input.status, definition, formColumn(input.definition), at, installId, id)
    .run();
  return meta.changes === 0 ? null : getQuiz(db, installId, id);
}

export async function deleteQuiz(db: SqlDb, installId: string, id: string, at: number): Promise<boolean> {
  const { meta } = await db.prepare('UPDATE quizzes SET deleted_at = ? WHERE install_id = ? AND id = ? AND deleted_at IS NULL').bind(at, installId, id).run();
  return meta.changes > 0;
}

export async function usesForm(db: SqlDb, installId: string, formId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS hit FROM quizzes WHERE install_id = ? AND deleted_at IS NULL AND form_ids LIKE ? LIMIT 1")
    .bind(installId, `%,${formId},%`)
    .first();
  return row !== null;
}

export interface QuizCounts {
  readonly started: number;
  readonly finished: number;
  readonly contacts: number;
}

export async function quizCounts(db: SqlDb, installId: string): Promise<Map<string, QuizCounts>> {
  const { results } = await db
    .prepare(
      `SELECT quiz_id, COUNT(*) AS started, COUNT(finished_at) AS finished, COUNT(contact_id) AS contacts
       FROM sessions WHERE install_id = ? AND preview = 0 GROUP BY quiz_id`,
    )
    .bind(installId)
    .all<{ quiz_id: string; started: number; finished: number; contacts: number }>();
  return new Map(results.map((r) => [r.quiz_id, { started: r.started, finished: r.finished, contacts: r.contacts }]));
}

/* ---------- sessions ---------- */

export async function createSession(db: SqlDb, quiz: Quiz, contactId: string | null, preview: boolean, at: number): Promise<Session> {
  const id = `s_${randomId(24)}`;
  await db
    .prepare('INSERT INTO sessions (id, install_id, quiz_id, preview, contact_id, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, quiz.installId, quiz.id, preview ? 1 : 0, contactId, at, at)
    .run();
  return (await getSession(db, id))!;
}

export async function getSession(db: SqlDb, id: string): Promise<Session | null> {
  if (!SESSION_ID.test(id)) return null;
  const row = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first<SessionRow>();
  return row === null ? null : sessionOf(row);
}

export async function sessionBySubmission(db: SqlDb, installId: string, submissionId: string): Promise<Session | null> {
  const row = await db
    .prepare('SELECT * FROM sessions WHERE install_id = ? AND submission_id = ? LIMIT 1')
    .bind(installId, submissionId)
    .first<SessionRow>();
  return row === null ? null : sessionOf(row);
}

export async function setSubmission(db: SqlDb, sessionId: string, submissionId: string, at: number): Promise<void> {
  await db.prepare('UPDATE sessions SET submission_id = ?, updated_at = ? WHERE id = ?').bind(submissionId, at, sessionId).run();
}

/** Links the contact once: a session never changes person. */
export async function setContact(db: SqlDb, sessionId: string, contactId: string, at: number): Promise<boolean> {
  const { meta } = await db
    .prepare('UPDATE sessions SET contact_id = ?, updated_at = ? WHERE id = ? AND contact_id IS NULL')
    .bind(contactId, at, sessionId)
    .run();
  return meta.changes > 0;
}

export async function finishSession(db: SqlDb, sessionId: string, result: { score: number; maxScore: number; label: string | null }, at: number): Promise<void> {
  await db
    .prepare('UPDATE sessions SET score = ?, max_score = ?, result_label = ?, finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE id = ?')
    .bind(result.score, result.maxScore, result.label, at, at, sessionId)
    .run();
}

/** Takes the "send the result to the CRM" job; false when another request already has it. */
export async function claimSync(db: SqlDb, sessionId: string, at: number): Promise<boolean> {
  const { meta } = await db
    .prepare('UPDATE sessions SET synced_at = ? WHERE id = ? AND synced_at IS NULL AND finished_at IS NOT NULL AND contact_id IS NOT NULL')
    .bind(at, sessionId)
    .run();
  return meta.changes > 0;
}

export async function releaseSync(db: SqlDb, sessionId: string): Promise<void> {
  await db.prepare('UPDATE sessions SET synced_at = NULL WHERE id = ?').bind(sessionId).run();
}

/** Finished sessions whose result the CRM refused for a moment (no cron: retried when quizzes are used). */
export async function unsyncedSessions(db: SqlDb, at: number, limit = 5): Promise<Session[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM sessions WHERE finished_at IS NOT NULL AND contact_id IS NOT NULL AND synced_at IS NULL AND preview = 0
       AND updated_at < ? ORDER BY updated_at LIMIT ?`,
    )
    .bind(at - 60_000, limit)
    .all<SessionRow>();
  return results.map(sessionOf);
}

/* ---------- answers ---------- */

export async function sessionAnswers(db: SqlDb, sessionId: string): Promise<AnswerRow[]> {
  const { results } = await db
    .prepare('SELECT step_id, answer_id, value_text, tagged, updated_at FROM session_answers WHERE session_id = ? ORDER BY created_at, step_id')
    .bind(sessionId)
    .all<{ step_id: string; answer_id: string | null; value_text: string | null; tagged: number; updated_at: number }>();
  return results.map((r) => ({ stepId: r.step_id, answerId: r.answer_id, text: r.value_text, tagged: r.tagged === 1, updatedAt: r.updated_at }));
}

export const givenOf = (rows: readonly AnswerRow[]): Map<string, Given> => new Map(rows.map((r) => [r.stepId, { answerId: r.answerId, text: r.text }]));

/** Stores (or replaces) the answer of a step; a different choice has to be tagged again. */
export async function saveAnswer(db: SqlDb, session: Session, stepId: string, answerId: string | null, text: string | null, at: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO session_answers (session_id, install_id, quiz_id, step_id, answer_id, value_text, tagged, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT (session_id, step_id) DO UPDATE SET
         tagged = CASE WHEN session_answers.answer_id IS excluded.answer_id THEN session_answers.tagged ELSE 0 END,
         answer_id = excluded.answer_id, value_text = excluded.value_text, updated_at = excluded.updated_at`,
    )
    .bind(session.id, session.installId, session.quizId, stepId, answerId, text, at, at)
    .run();
  await db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').bind(at, session.id).run();
}

export async function markTagged(db: SqlDb, sessionId: string, stepIds: readonly string[]): Promise<void> {
  if (stepIds.length === 0) return;
  await db.batch(stepIds.map((step) => db.prepare('UPDATE session_answers SET tagged = 1 WHERE session_id = ? AND step_id = ?').bind(sessionId, step)));
}

/* ---------- form submissions that arrive before the quiz knows them ---------- */

export async function addPendingLink(db: SqlDb, installId: string, submissionId: string, contactId: string, at: number): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO pending_links (install_id, submission_id, contact_id, created_at) VALUES (?, ?, ?, ?)')
    .bind(installId, submissionId, contactId, at)
    .run();
}

export async function takePendingLink(db: SqlDb, installId: string, submissionId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT contact_id FROM pending_links WHERE install_id = ? AND submission_id = ?')
    .bind(installId, submissionId)
    .first<{ contact_id: string }>();
  if (row === null) return null;
  await db.prepare('DELETE FROM pending_links WHERE install_id = ? AND submission_id = ?').bind(installId, submissionId).run();
  return row.contact_id;
}

/* ---------- statistics and responses ---------- */

export interface QuizStats {
  readonly started: number;
  readonly finished: number;
  readonly contacts: number;
  readonly steps: ReadonlyArray<{ step_id: string; answered: number }>;
  readonly answers: ReadonlyArray<{ step_id: string; answer_id: string; count: number }>;
  readonly results: ReadonlyArray<{ label: string | null; count: number }>;
  readonly average_score: number | null;
}

export async function quizStats(db: SqlDb, installId: string, quizId: string, since: number): Promise<QuizStats> {
  const [totals, steps, answers, results] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS started, COUNT(finished_at) AS finished, COUNT(contact_id) AS contacts, AVG(score) AS average
         FROM sessions WHERE install_id = ? AND quiz_id = ? AND preview = 0 AND started_at >= ?`,
      )
      .bind(installId, quizId, since)
      .first<{ started: number; finished: number; contacts: number; average: number | null }>(),
    db
      .prepare(
        `SELECT a.step_id, COUNT(*) AS answered FROM session_answers a JOIN sessions s ON s.id = a.session_id
         WHERE a.install_id = ? AND a.quiz_id = ? AND s.preview = 0 AND s.started_at >= ? GROUP BY a.step_id`,
      )
      .bind(installId, quizId, since)
      .all<{ step_id: string; answered: number }>(),
    db
      .prepare(
        `SELECT a.step_id, a.answer_id, COUNT(*) AS count FROM session_answers a JOIN sessions s ON s.id = a.session_id
         WHERE a.install_id = ? AND a.quiz_id = ? AND s.preview = 0 AND s.started_at >= ? AND a.answer_id IS NOT NULL
         GROUP BY a.step_id, a.answer_id`,
      )
      .bind(installId, quizId, since)
      .all<{ step_id: string; answer_id: string; count: number }>(),
    db
      .prepare(
        `SELECT result_label AS label, COUNT(*) AS count FROM sessions
         WHERE install_id = ? AND quiz_id = ? AND preview = 0 AND started_at >= ? AND finished_at IS NOT NULL
         GROUP BY result_label ORDER BY count DESC`,
      )
      .bind(installId, quizId, since)
      .all<{ label: string | null; count: number }>(),
  ]);
  return {
    started: totals?.started ?? 0,
    finished: totals?.finished ?? 0,
    contacts: totals?.contacts ?? 0,
    average_score: totals?.average === null || totals?.average === undefined ? null : Math.round(totals.average * 10) / 10,
    steps: steps.results,
    answers: answers.results,
    results: results.results,
  };
}

export async function listSessions(
  db: SqlDb,
  installId: string,
  quizId: string,
  options: { before: number | null; limit: number; finishedOnly: boolean },
): Promise<Session[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM sessions WHERE install_id = ? AND quiz_id = ? AND preview = 0 AND started_at < ?
       ${options.finishedOnly ? 'AND finished_at IS NOT NULL' : ''} ORDER BY started_at DESC LIMIT ?`,
    )
    .bind(installId, quizId, options.before ?? Number.MAX_SAFE_INTEGER, options.limit)
    .all<SessionRow>();
  return results.map(sessionOf);
}

export async function answersOf(db: SqlDb, sessionIds: readonly string[]): Promise<Map<string, AnswerRow[]>> {
  const out = new Map<string, AnswerRow[]>();
  if (sessionIds.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT session_id, step_id, answer_id, value_text, tagged, updated_at FROM session_answers
       WHERE session_id IN (${sessionIds.map(() => '?').join(', ')}) ORDER BY created_at, step_id`,
    )
    .bind(...sessionIds)
    .all<{ session_id: string; step_id: string; answer_id: string | null; value_text: string | null; tagged: number; updated_at: number }>();
  for (const r of results) {
    const list = out.get(r.session_id) ?? [];
    list.push({ stepId: r.step_id, answerId: r.answer_id, text: r.value_text, tagged: r.tagged === 1, updatedAt: r.updated_at });
    out.set(r.session_id, list);
  }
  return out;
}

/* ---------- privacy and housekeeping ---------- */

export async function contactSessions(db: SqlDb, installId: string, contactId: string): Promise<Array<Session & { quizName: string }>> {
  const { results } = await db
    .prepare(
      `SELECT s.*, q.name AS quiz_name FROM sessions s JOIN quizzes q ON q.id = s.quiz_id
       WHERE s.install_id = ? AND s.contact_id = ? ORDER BY s.started_at`,
    )
    .bind(installId, contactId)
    .all<SessionRow & { quiz_name: string }>();
  return results.map((r) => ({ ...sessionOf(r), quizName: r.quiz_name }));
}

export async function eraseContact(db: SqlDb, installId: string, contactId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM session_answers WHERE session_id IN (SELECT id FROM sessions WHERE install_id = ? AND contact_id = ?)').bind(installId, contactId),
    db.prepare('DELETE FROM sessions WHERE install_id = ? AND contact_id = ?').bind(installId, contactId),
    db.prepare('DELETE FROM pending_links WHERE install_id = ? AND contact_id = ?').bind(installId, contactId),
  ]);
}

export async function eraseInstall(db: SqlDb, installId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM session_answers WHERE install_id = ?').bind(installId),
    db.prepare('DELETE FROM sessions WHERE install_id = ?').bind(installId),
    db.prepare('DELETE FROM pending_links WHERE install_id = ?').bind(installId),
    db.prepare('DELETE FROM quizzes WHERE install_id = ?').bind(installId),
  ]);
}

/** Unfinished anonymous sessions, old previews and stale pending links: nobody will ever claim them. */
export async function cleanup(db: SqlDb, at: number): Promise<void> {
  const stale = 'contact_id IS NULL AND (finished_at IS NULL AND updated_at < ? OR preview = 1 AND updated_at < ?)';
  const bounds = [at - ANONYMOUS_TTL_MS, at - PENDING_LINK_TTL_MS];
  await db.batch([
    db.prepare(`DELETE FROM session_answers WHERE session_id IN (SELECT id FROM sessions WHERE ${stale})`).bind(...bounds),
    db.prepare(`DELETE FROM sessions WHERE ${stale}`).bind(...bounds),
    db.prepare('DELETE FROM pending_links WHERE created_at < ?').bind(at - PENDING_LINK_TTL_MS),
  ]);
}

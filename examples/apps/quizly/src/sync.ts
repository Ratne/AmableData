import { AmableApiError, type AppContext } from '@amable/app-sdk';
import manifest from '../manifest.json';
import type { SqlDb } from './db';
import { pickRange, walk, type QuizDefinition } from './quiz';
import {
  claimSync,
  getSession,
  givenOf,
  markTagged,
  releaseSync,
  sessionAnswers,
  type AnswerRow,
  type Quiz,
  type Session,
} from './store';

/**
 * What reaches the CRM, as soon as the session knows its contact:
 *   - the tags of every chosen answer (once per answer);
 *   - a summary on the contact (app values `quiz_<id>`), updated at each answer;
 *   - at the end: the result's tag, the custom fields, the
 *     `quiz_completed` trigger and a timeline entry (once per session).
 * Without a contact nothing leaves the app: a form submission may link one later.
 */

/** Transient failures are retried at the next sync; refusals (contact erased, app paused) are not. */
const transient = (error: unknown) => !(error instanceof AmableApiError) || error.status >= 500 || error.status === 429;

const field = (key: string) => `app_${manifest.id.replace(/-/g, '_')}_${key}`;

const ENTITY_MAX_BYTES = 14_000;

const TEXT = {
  it: { completed: 'Quiz completato', score: 'Punteggio', result: 'Risultato' },
  en: { completed: 'Quiz completed', score: 'Score', result: 'Result' },
} as const;

export interface AnsweredStep {
  readonly step_id: string;
  readonly question: string;
  readonly answer: string;
  readonly points: number | null;
}

/** The answers in the order given, with the texts of the questions; off-path answers left out once finished. */
export function answeredSteps(definition: QuizDefinition, rows: readonly AnswerRow[], finished: boolean): AnsweredStep[] {
  const onPath = finished ? new Set(walk(definition, givenOf(rows)).path.map((s) => s.id)) : null;
  const out: AnsweredStep[] = [];
  for (const row of rows) {
    if (onPath !== null && !onPath.has(row.stepId)) continue;
    const step = definition.steps.find((s) => s.id === row.stepId);
    if (step === undefined || step.kind === 'optin') continue;
    if (step.kind === 'choice') {
      const choice = step.answers.find((a) => a.id === row.answerId);
      if (choice !== undefined) out.push({ step_id: step.id, question: step.text, answer: choice.text, points: choice.points });
    } else if ((row.text ?? '') !== '') {
      out.push({ step_id: step.id, question: step.text, answer: row.text ?? '', points: null });
    }
  }
  return out;
}

function entityValue(quiz: Quiz, session: Session, answers: readonly AnsweredStep[]) {
  const value = {
    quiz: quiz.name,
    status: session.finishedAt === null ? 'started' : 'completed',
    score: session.score,
    max_score: session.maxScore,
    result: session.resultLabel,
    started_at: new Date(session.startedAt).toISOString(),
    finished_at: session.finishedAt === null ? null : new Date(session.finishedAt).toISOString(),
    answers: answers.map((a) => ({ q: a.question.slice(0, 200), a: a.answer.slice(0, 500) })),
  };
  while (value.answers.length > 0 && new TextEncoder().encode(JSON.stringify(value)).length > ENTITY_MAX_BYTES) value.answers.pop();
  return value;
}

async function applyTags(ctx: AppContext, contactId: string, tagIds: readonly string[]): Promise<void> {
  await ctx.api.request('POST', `/contacts/${encodeURIComponent(contactId)}/tags`, { tag_ids: [...tagIds] });
}

/** The tags of the answers not tagged yet; kept for the next sync when the CRM does not answer. */
async function tagAnswers(ctx: AppContext, db: SqlDb, quiz: Quiz, session: Session, rows: readonly AnswerRow[]): Promise<void> {
  const done: string[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.tagged || row.answerId === null) continue;
    const step = quiz.definition.steps.find((s) => s.id === row.stepId);
    const choice = step?.kind === 'choice' ? step.answers.find((a) => a.id === row.answerId) : undefined;
    for (const tag of choice?.tags ?? []) if (tag.id !== null) ids.add(tag.id);
    done.push(row.stepId);
  }
  if (ids.size > 0) {
    try {
      await applyTags(ctx, session.contactId!, [...ids]);
    } catch (error) {
      if (transient(error)) {
        console.warn('[quizly] tags deferred', session.id, error instanceof Error ? error.message : error);
        return;
      }
    }
  }
  await markTagged(db, session.id, done);
}

async function finishActions(ctx: AppContext, quiz: Quiz, session: Session, answers: readonly AnsweredStep[]): Promise<void> {
  const contactId = session.contactId!;
  const score = session.score ?? 0;
  const picked = pickRange(quiz.definition, score);
  const label = session.resultLabel ?? '';
  if (picked?.range.tag?.id) {
    try {
      await applyTags(ctx, contactId, [picked.range.tag.id]);
    } catch (error) {
      if (transient(error)) throw error;
    }
  }
  await ctx.api.contacts.update(contactId, {
    custom_fields: { [field('last_quiz')]: quiz.name, [field('last_score')]: score, [field('last_result')]: label === '' ? null : label },
  });
  await ctx.api.events.fire({
    key: 'quiz_completed',
    contact_id: contactId,
    event_id: `done:${session.id}`,
    data: { quiz_id: quiz.id, quiz_name: quiz.name, score, max_score: session.maxScore ?? 0, result: label },
  });
  const t = TEXT[quiz.definition.settings.locale];
  const lines = [
    `${t.score}: ${String(score)} / ${String(session.maxScore ?? 0)}`,
    ...(label === '' ? [] : [`${t.result}: ${label}`]),
    '',
    ...answers.map((a) => `${a.question} → ${a.answer}`),
  ];
  try {
    await ctx.api.timeline.add({ contact_id: contactId, title: `${t.completed}: ${quiz.name}`.slice(0, 200), body: lines.join('\n').slice(0, 2000), icon: 'check' });
  } catch (error) {
    console.warn('[quizly] timeline entry skipped', session.id, error instanceof Error ? error.message : error);
  }
}

/** Sends what the CRM does not have yet about the session. Safe to call any number of times. */
export async function syncSession(ctx: AppContext, db: SqlDb, quiz: Quiz, sessionId: string, at: number): Promise<void> {
  const session = await getSession(db, sessionId);
  if (session === null || session.preview || session.contactId === null) return;
  const rows = await sessionAnswers(db, session.id);
  await tagAnswers(ctx, db, quiz, session, rows);
  const answers = answeredSteps(quiz.definition, rows, session.finishedAt !== null);
  try {
    await ctx.api.entities.set('contact', session.contactId, { [`quiz_${quiz.id}`]: entityValue(quiz, session, answers) });
  } catch (error) {
    console.warn('[quizly] summary deferred', session.id, error instanceof Error ? error.message : error);
  }
  if (session.finishedAt === null || session.syncedAt !== null || !(await claimSync(db, session.id, at))) return;
  try {
    await finishActions(ctx, quiz, session, answers);
  } catch (error) {
    if (transient(error)) {
      await releaseSync(db, session.id);
      console.warn('[quizly] result deferred', session.id, error instanceof Error ? error.message : error);
    } else {
      console.warn('[quizly] result refused', session.id, error instanceof Error ? error.message : error);
    }
  }
}
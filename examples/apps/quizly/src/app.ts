import {
  AmableApiError,
  appBaseUrl,
  appKeysLoader,
  appPath,
  createAppHandler,
  d1InstallStore,
  type AppContext,
  type Fetch,
} from '@amable/app-sdk';
import manifest from '../manifest.json';
import { assets } from './assets';
import { ensureSchema, type SqlDb } from './db';
import { messagePage, playerPage, quizzesPage } from './pages';
import {
  definitionTags,
  formIds,
  maxScore,
  parseDefinition,
  pickRange,
  publicQuiz,
  walk,
  withTagIds,
  LIMITS,
  type QuizDefinition,
  type Step,
} from './quiz';
import {
  addPendingLink,
  answersOf,
  cleanup,
  contactSessions,
  createSession,
  deleteQuiz,
  eraseContact,
  eraseInstall,
  finishSession,
  getQuiz,
  getSession,
  givenOf,
  listQuizzes,
  listSessions,
  quizByPublicId,
  quizCounts,
  quizStats,
  saveAnswer,
  saveQuiz,
  sessionAnswers,
  sessionBySubmission,
  setContact,
  setSubmission,
  takePendingLink,
  unsyncedSessions,
  usesForm,
  type Quiz,
  type QuizCounts,
  type QuizStatus,
  type Session,
} from './store';
import { answeredSteps, syncSession } from './sync';

/**
 * Quizly for AmableData: quiz funnels. A quiz is a chain of questions; each
 * choice gives points, may apply CRM tags and may open its own path. An
 * opt-in step shows one of the workspace's forms (its connections keep
 * working) and tells Quizly who is answering. At the end the score picks a
 * result: a thank-you page, a tag, custom fields and the `quiz_completed`
 * automation trigger.
 *
 * Public URLs (no CRM signature: browsers call them) carry the quiz's random
 * public id; the session id the player gets is the only key to its answers:
 *   GET  /q/<public id>            the quiz page (`?embed=1` inside the embed iframe, `?preview=1` from the editor)
 *   POST /q/<public id>/session    start (or resume) answering; `c` / `email` name a known contact
 *   POST /q/<public id>/answer     one answer, stored at once (a quiz left halfway still counts)
 *   POST /q/<public id>/optin      the submission id of the opt-in form, matched with `form.submitted`
 *   POST /q/<public id>/finish     the score, picked on the server, and where to go
 *
 * It runs in the workspace's own Cloudflare account, deployed by the CRM: one
 * D1 database keeps the quizzes, the answers, the installs and the signing
 * keys (created on first use). Nothing to configure.
 */

export interface Env {
  DB: SqlDb;
  /** URL of this Worker, set by the CRM when it deploys the app. */
  APP_BASE_URL?: string;
  /** Signing keys, only for a copy hosted elsewhere; normally created in DB. */
  APP_KEYS?: string;
}

/** Work that may finish after the answer (`ctx.waitUntil`); awaited when absent. */
export type Defer = (task: Promise<unknown>) => void;

const keysOf = appKeysLoader({ kid: 'quizly-1' });
const PUBLIC_ID = '[0-9a-z]{16}';
const CONTACT_ID = /^[A-Za-z0-9_-]{4,64}$/;
const SUBMISSION_ID = /^[A-Za-z0-9_-]{4,64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const RATE_LIMIT = { requests: 120, windowMs: 60_000 };
const HOUSEKEEPING_MS = 10 * 60_000;

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const failure = (status: number, error: string) => json({ error }, status);

const hits = new Map<string, { count: number; until: number }>();

function limited(request: Request, now: number): boolean {
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  const entry = hits.get(ip);
  if (entry === undefined || entry.until <= now) {
    if (hits.size > 10_000) hits.clear();
    hits.set(ip, { count: 1, until: now + RATE_LIMIT.windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT.requests;
}

/** What the editor shows next to a quiz: the link and the code to paste. */
export function snippets(base: string, quiz: Pick<Quiz, 'publicId'>): Record<string, string> {
  const link = `${base}/q/${quiz.publicId}`;
  return {
    link,
    email_link: `${link}?c={{ contact.id }}`,
    preview: `${link}?preview=1`,
    embed: `<div data-quizly="${quiz.publicId}"></div>\n<script async src="${base}/embed.js"></script>`,
    iframe: `<iframe src="${link}?embed=1" style="width:100%;min-height:560px;border:0" title="Quiz" allow="clipboard-write"></iframe>`,
  };
}

function quizView(base: string, quiz: Quiz, counts?: QuizCounts, warnings: readonly string[] = []) {
  return {
    id: quiz.id,
    public_id: quiz.publicId,
    name: quiz.name,
    status: quiz.status,
    definition: quiz.definition,
    max_score: maxScore(quiz.definition),
    steps: quiz.definition.steps.length,
    created_at: quiz.createdAt,
    updated_at: quiz.updatedAt,
    started: counts?.started ?? 0,
    finished: counts?.finished ?? 0,
    contacts: counts?.contacts ?? 0,
    snippets: snippets(base, quiz),
    warnings,
  };
}

function contactName(contact: Record<string, unknown>): string {
  const name = [contact['given_name'], contact['family_name']].filter((v) => typeof v === 'string' && v !== '').join(' ');
  if (name !== '') return name;
  const emails = Array.isArray(contact['emails']) ? (contact['emails'] as Array<{ email?: unknown; is_primary?: unknown }>) : [];
  const email = emails.find((e) => e.is_primary === true) ?? emails[0];
  if (typeof email?.email === 'string') return email.email;
  return typeof contact['primary_email'] === 'string' ? contact['primary_email'] : String(contact['id'] ?? '');
}

async function mapLimited<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await map(items[index]!);
      }
    }),
  );
  return out;
}

const bodyOf = async (request: Request): Promise<Record<string, unknown>> => {
  const raw: unknown = await request.json().catch(() => null);
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
};

/** The tag ids for the names used in the quiz: found by exact name, or created. */
async function resolveTags(ctx: AppContext, definition: QuizDefinition): Promise<QuizDefinition> {
  const ids = new Map<string, string>();
  const missing = new Map<string, string>();
  for (const tag of definitionTags(definition)) {
    const key = tag.name.toLowerCase();
    if (tag.id !== null) ids.set(key, tag.id);
    else if (!ids.has(key)) missing.set(key, tag.name);
  }
  const find = async (name: string) => {
    const page = await ctx.api.request<{ data: Array<{ id: string; name: string }> }>('GET', `/tags?${new URLSearchParams({ q: name, limit: '50' }).toString()}`);
    return page.data.find((t) => t.name.toLowerCase() === name.toLowerCase())?.id ?? null;
  };
  for (const [key, name] of missing) {
    if (ids.has(key)) continue;
    let id = await find(name);
    if (id === null) {
      try {
        id = (await ctx.api.request<{ id: string }>('POST', '/tags', { name })).id;
      } catch (error) {
        if (!(error instanceof AmableApiError) || error.status !== 409) throw error;
        id = await find(name);
      }
    }
    if (id !== null) ids.set(key, id);
  }
  return withTagIds(definition, ids);
}

interface FormFacts {
  readonly name: string;
  readonly status: string;
  readonly scriptUrl: string;
  readonly tenant: string;
  readonly allowedDomains: readonly string[];
}

async function formFacts(ctx: AppContext, formId: string): Promise<FormFacts | null> {
  try {
    const [form, embed] = await Promise.all([
      ctx.api.request<{ name: string; status: string; definition?: { settings?: { allowed_domains?: unknown } } }>('GET', `/forms/${encodeURIComponent(formId)}`),
      ctx.api.request<{ script_url: string; tenant: string }>('GET', `/forms/${encodeURIComponent(formId)}/embed`),
    ]);
    const allowed = form.definition?.settings?.allowed_domains;
    return {
      name: form.name,
      status: form.status,
      scriptUrl: embed.script_url,
      tenant: embed.tenant,
      allowedDomains: Array.isArray(allowed) ? allowed.filter((d): d is string => typeof d === 'string') : [],
    };
  } catch (error) {
    if (error instanceof AmableApiError && error.status === 404) return null;
    throw error;
  }
}

const hostAllowed = (host: string, domains: readonly string[]) =>
  domains.length === 0 ||
  domains.some((raw) => {
    const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (domain.startsWith('*.')) return host.endsWith(domain.slice(1)) || host === domain.slice(2);
    return host === domain;
  });

/** Fills the opt-in steps with the embed facts of their forms; the warnings tell the editor what will not work. */
async function resolveForms(ctx: AppContext, definition: QuizDefinition, baseUrl: string): Promise<{ definition: QuizDefinition; warnings: string[] } | { error: string }> {
  const host = new URL(baseUrl).hostname;
  const facts = new Map<string, FormFacts>();
  const warnings: string[] = [];
  for (const formId of formIds(definition)) {
    const found = await formFacts(ctx, formId);
    if (found === null) return { error: `the opt-in form ${formId} no longer exists: choose another one` };
    facts.set(formId, found);
    if (found.status !== 'active') warnings.push(`form_inactive:${found.name}`);
    if (!hostAllowed(host, found.allowedDomains)) warnings.push(`form_domain:${found.name}:${host}`);
  }
  const steps = definition.steps.map((step): Step => {
    if (step.kind !== 'optin') return step;
    const f = facts.get(step.form_id)!;
    return { ...step, form_name: f.name, script_url: f.scriptUrl, tenant: f.tenant };
  });
  return { definition: { ...definition, steps }, warnings };
}

export function createWorker(deps: { fetch?: Fetch; now?: () => number } = {}) {
  const outbound: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const handlers = new Map<string, ReturnType<typeof createAppHandler>>();
  const baseOf = (env: Env, request?: Request) => appBaseUrl(manifest.base_url, env.APP_BASE_URL, request);
  let lastHousekeeping = 0;

  async function handlerFor(env: Env, baseUrl: string) {
    const keys = await keysOf(env);
    const cacheKey = JSON.stringify([baseUrl, keys.map((k) => [k.kid, k.x])]);
    let app = handlers.get(cacheKey);
    if (app !== undefined) return app;
    app = createAppHandler({
      appId: manifest.id,
      baseUrl,
      keys,
      store: d1InstallStore(env.DB),
      manifest,
      assets,
      fetch: outbound,
      now,
      async onEvent(event, ctx) {
        const type = String(event['type'] ?? event['event'] ?? '');
        if (type === 'app.uninstalled') await eraseInstall(env.DB, ctx.install.id);
        if (type === 'form.submitted') await formSubmitted(env, ctx, (event['data'] ?? {}) as Record<string, unknown>);
      },
      calls: {
        '/privacy/erasure': async (body, ctx) => {
          const contactId = privacyContact(body);
          if (contactId !== null) await eraseContact(env.DB, ctx.install.id, contactId);
          return { ok: true };
        },
        '/privacy/data': async (body, ctx) => {
          const contactId = privacyContact(body);
          const sessions = contactId === null ? [] : await contactSessions(env.DB, ctx.install.id, contactId);
          if (sessions.length === 0) return { data: null };
          const answers = await answersOf(env.DB, sessions.map((s) => s.id));
          const quizzes = new Map<string, Quiz | null>();
          const data = [];
          for (const s of sessions) {
            if (!quizzes.has(s.quizId)) quizzes.set(s.quizId, await getQuiz(env.DB, ctx.install.id, s.quizId));
            const quiz = quizzes.get(s.quizId);
            data.push({
              quiz: s.quizName,
              started_at: new Date(s.startedAt).toISOString(),
              finished_at: s.finishedAt === null ? null : new Date(s.finishedAt).toISOString(),
              score: s.score,
              result: s.resultLabel,
              answers: quiz ? answeredSteps(quiz.definition, answers.get(s.id) ?? [], false).map((a) => ({ question: a.question, answer: a.answer })) : [],
            });
          }
          return { data: { quizzes: data } };
        },
      },
      screens: {
        '/ui/quizzes': () => quizzesPage(baseUrl),
      },
      screenApi: {
        '/api/quizzes': async (req, _session, ctx) => {
          const at = now();
          const url = new URL(req.url);
          if (req.method === 'GET') {
            const counts = await quizCounts(env.DB, ctx.install.id);
            const id = url.searchParams.get('id');
            if (id !== null) {
              const quiz = await getQuiz(env.DB, ctx.install.id, id);
              return quiz === null ? failure(404, 'quiz not found') : json(quizView(baseUrl, quiz, counts.get(quiz.id)));
            }
            const quizzes = await listQuizzes(env.DB, ctx.install.id);
            return json({ data: quizzes.map((q) => quizView(baseUrl, q, counts.get(q.id))), base_url: baseUrl });
          }
          if (req.method === 'DELETE') {
            const id = url.searchParams.get('id') ?? '';
            return (await deleteQuiz(env.DB, ctx.install.id, id, at)) ? json({ ok: true }) : failure(404, 'quiz not found');
          }
          if (req.method !== 'POST') return failure(405, 'GET, POST or DELETE');
          const raw = await bodyOf(req);
          const id = typeof raw['id'] === 'string' && raw['id'] !== '' ? raw['id'] : null;
          const name = typeof raw['name'] === 'string' ? raw['name'].trim().slice(0, 200) : '';
          if (name === '') return failure(422, 'give the quiz a name');
          const status: QuizStatus = raw['status'] === 'published' ? 'published' : 'draft';
          const parsed = parseDefinition(raw['definition']);
          if (!parsed.ok) return failure(422, parsed.error);
          const forms = await resolveForms(ctx, parsed.value, baseUrl);
          if ('error' in forms) return failure(422, forms.error);
          const definition = await resolveTags(ctx, forms.definition);
          const saved = await saveQuiz(env.DB, ctx.install.id, id, { name, status, definition }, at);
          if (saved === null) return failure(404, 'quiz not found');
          const counts = await quizCounts(env.DB, ctx.install.id);
          return json(quizView(baseUrl, saved, counts.get(saved.id), forms.warnings), id === null ? 201 : 200);
        },
        '/api/quizzes/duplicate': async (req, _session, ctx) => {
          if (req.method !== 'POST') return failure(405, 'POST only');
          const body = await bodyOf(req);
          const quiz = await getQuiz(env.DB, ctx.install.id, String(body['id'] ?? ''));
          if (quiz === null) return failure(404, 'quiz not found');
          const suffix = typeof body['suffix'] === 'string' ? body['suffix'].slice(0, 40) : ' (copy)';
          const copy = await saveQuiz(env.DB, ctx.install.id, null, { name: `${quiz.name}${suffix}`.slice(0, 200), status: 'draft', definition: quiz.definition }, now());
          return json(quizView(baseUrl, copy!), 201);
        },
        '/api/forms': async (_req, _session, ctx) => {
          const page = await ctx.api.request<{ data: Array<{ id: string; name: string; status: string }> }>('GET', '/forms?limit=200');
          return json({ data: page.data.map((f) => ({ id: f.id, name: f.name, status: f.status })) });
        },
        '/api/tags': async (req, _session, ctx) => {
          const q = (new URL(req.url).searchParams.get('q') ?? '').trim().slice(0, 100);
          const page = await ctx.api.request<{ data: Array<{ id: string; name: string }> }>(
            'GET',
            `/tags?${new URLSearchParams(q === '' ? { limit: '50' } : { q, limit: '20' }).toString()}`,
          );
          return json({ data: page.data.map((t) => ({ id: t.id, name: t.name })) });
        },
        '/api/stats': async (req, _session, ctx) => {
          const url = new URL(req.url);
          const quiz = await getQuiz(env.DB, ctx.install.id, url.searchParams.get('quiz') ?? '');
          if (quiz === null) return failure(404, 'quiz not found');
          const days = Math.min(3650, Math.max(0, Number(url.searchParams.get('days') ?? 0) || 0));
          return json(await quizStats(env.DB, ctx.install.id, quiz.id, days === 0 ? 0 : now() - days * 86_400_000));
        },
        '/api/responses': async (req, _session, ctx) => {
          const url = new URL(req.url);
          const quiz = await getQuiz(env.DB, ctx.install.id, url.searchParams.get('quiz') ?? '');
          if (quiz === null) return failure(404, 'quiz not found');
          const before = Number(url.searchParams.get('before'));
          const sessions = await listSessions(env.DB, ctx.install.id, quiz.id, {
            before: Number.isFinite(before) && before > 0 ? before : null,
            limit: 30,
            finishedOnly: url.searchParams.get('finished') === 'true',
          });
          const answers = await answersOf(env.DB, sessions.map((s) => s.id));
          const names = await mapLimited(sessions, 5, async (s) => {
            if (s.contactId === null) return null;
            try {
              return contactName(await ctx.api.contacts.get(s.contactId));
            } catch {
              return null;
            }
          });
          return json({
            data: sessions.map((s, i) => ({
              id: s.id,
              contact_id: s.contactId,
              contact_name: names[i],
              started_at: s.startedAt,
              finished_at: s.finishedAt,
              score: s.score,
              max_score: s.maxScore,
              result: s.resultLabel,
              answers: answeredSteps(quiz.definition, answers.get(s.id) ?? [], s.finishedAt !== null),
            })),
            next_before: sessions.length === 30 ? sessions[sessions.length - 1]!.startedAt : null,
          });
        },
      },
    });
    handlers.set(cacheKey, app);
    return app;
  }

  async function contextOf(env: Env, installId: string): Promise<AppContext | null> {
    return (await handlerFor(env, baseOf(env))).contextFor(installId);
  }

  /** The opt-in form was submitted: the session it belongs to now knows its contact. */
  async function formSubmitted(env: Env, ctx: AppContext, data: Record<string, unknown>): Promise<void> {
    const pick = (camel: string, snake: string) => {
      const value = data[camel] ?? data[snake];
      return typeof value === 'string' ? value : null;
    };
    const submissionId = pick('submissionId', 'submission_id');
    const contactId = pick('contactId', 'contact_id');
    const formId = pick('formId', 'form_id');
    if (submissionId === null || contactId === null || formId === null || !CONTACT_ID.test(contactId)) return;
    const at = now();
    const session = await sessionBySubmission(env.DB, ctx.install.id, submissionId);
    if (session === null) {
      // The browser has not told us yet which session sent it: keep the contact for a while.
      if (await usesForm(env.DB, ctx.install.id, formId)) await addPendingLink(env.DB, ctx.install.id, submissionId, contactId, at);
      return;
    }
    if (session.preview || !(await setContact(env.DB, session.id, contactId, at))) return;
    const quiz = await getQuiz(env.DB, ctx.install.id, session.quizId);
    if (quiz !== null) await syncSession(ctx, env.DB, quiz, session.id, at);
  }

  function background(defer: Defer | undefined, task: () => Promise<unknown>): Promise<void> {
    const run = task().then(
      () => undefined,
      (error: unknown) => console.error('[quizly] background', error),
    );
    if (defer === undefined) return run;
    defer(run);
    return Promise.resolve();
  }

  async function sync(env: Env, quiz: Quiz, sessionId: string): Promise<void> {
    const ctx = await contextOf(env, quiz.installId);
    if (ctx !== null) await syncSession(ctx, env.DB, quiz, sessionId, now());
  }

  /** Old anonymous sessions out, and another try for results the CRM refused for a moment. */
  async function housekeeping(env: Env): Promise<void> {
    const at = now();
    if (at - lastHousekeeping < HOUSEKEEPING_MS) return;
    lastHousekeeping = at;
    await cleanup(env.DB, at);
    for (const session of await unsyncedSessions(env.DB, at)) {
      const quiz = await getQuiz(env.DB, session.installId, session.quizId);
      if (quiz !== null) await sync(env, quiz, session.id);
    }
  }

  /** The contact the link names (`c`, or an email of an existing contact); contacts are never created here. */
  async function knownContact(env: Env, quiz: Quiz, c: unknown, email: unknown): Promise<string | null> {
    const id = typeof c === 'string' && CONTACT_ID.test(c) ? c : null;
    const address = typeof email === 'string' && EMAIL.test(email.trim()) ? email.trim().toLowerCase() : null;
    if (id === null && address === null) return null;
    const ctx = await contextOf(env, quiz.installId);
    if (ctx === null) return null;
    try {
      if (id !== null) {
        await ctx.api.contacts.get(id);
        return id;
      }
      const found = await ctx.api.contacts.list({ email: address!, limit: '1' });
      const contact = found.data[0];
      return contact === undefined ? null : String(contact['id']);
    } catch (error) {
      if (!(error instanceof AmableApiError) || error.status >= 500) console.warn('[quizly] contact lookup failed', error instanceof Error ? error.message : error);
      return null;
    }
  }

  async function sessionFor(env: Env, quiz: Quiz, body: Record<string, unknown>): Promise<Session | Response> {
    const session = await getSession(env.DB, typeof body['session'] === 'string' ? body['session'] : '');
    if (session === null || session.quizId !== quiz.id) return failure(404, 'session_not_found');
    return session;
  }

  async function start(env: Env, quiz: Quiz, body: Record<string, unknown>, defer: Defer | undefined): Promise<Response> {
    const preview = body['preview'] === true;
    const at = now();
    const resumed = await getSession(env.DB, typeof body['resume'] === 'string' ? body['resume'] : '');
    if (resumed !== null && resumed.quizId === quiz.id && resumed.finishedAt === null && resumed.preview === preview) {
      return json({ session: resumed.id, known: resumed.contactId !== null, resumed: true });
    }
    const contactId = preview ? null : await knownContact(env, quiz, body['c'], body['email']);
    const session = await createSession(env.DB, quiz, contactId, preview, at);
    await background(defer, () => housekeeping(env));
    return json({ session: session.id, known: contactId !== null, resumed: false }, 201);
  }

  async function answer(env: Env, quiz: Quiz, body: Record<string, unknown>, defer: Defer | undefined): Promise<Response> {
    const session = await sessionFor(env, quiz, body);
    if (session instanceof Response) return session;
    if (session.finishedAt !== null) return failure(409, 'already_finished');
    const step = quiz.definition.steps.find((s) => s.id === body['step_id']);
    if (step === undefined || step.kind === 'optin') return failure(422, 'unknown_step');
    let answerId: string | null = null;
    let text: string | null = null;
    if (step.kind === 'choice') {
      const choice = step.answers.find((a) => a.id === body['answer_id']);
      if (choice === undefined) return failure(422, 'unknown_answer');
      answerId = choice.id;
    } else {
      text = typeof body['text'] === 'string' ? body['text'].trim().slice(0, LIMITS.open) : '';
      if (text === '' && step.required) return failure(422, 'answer_required');
    }
    await saveAnswer(env.DB, session, step.id, answerId, text, now());
    if (session.contactId !== null && !session.preview) await background(defer, () => sync(env, quiz, session.id));
    return json({ ok: true });
  }

  async function optin(env: Env, quiz: Quiz, body: Record<string, unknown>, defer: Defer | undefined): Promise<Response> {
    const session = await sessionFor(env, quiz, body);
    if (session instanceof Response) return session;
    const submissionId = typeof body['submission_id'] === 'string' ? body['submission_id'] : '';
    if (!SUBMISSION_ID.test(submissionId)) return failure(422, 'invalid_submission');
    if (session.preview) return json({ ok: true, known: false });
    const at = now();
    await setSubmission(env.DB, session.id, submissionId, at);
    const contactId = await takePendingLink(env.DB, session.installId, submissionId);
    if (contactId !== null && (await setContact(env.DB, session.id, contactId, at))) await background(defer, () => sync(env, quiz, session.id));
    return json({ ok: true, known: contactId !== null || session.contactId !== null });
  }

  async function finish(env: Env, quiz: Quiz, body: Record<string, unknown>, defer: Defer | undefined): Promise<Response> {
    const session = await sessionFor(env, quiz, body);
    if (session instanceof Response) return session;
    const walked = walk(quiz.definition, givenOf(await sessionAnswers(env.DB, session.id)));
    if (!walked.complete) return failure(422, 'incomplete');
    const max = maxScore(quiz.definition);
    const picked = pickRange(quiz.definition, walked.score);
    const label = picked?.range.label ?? null;
    if (session.finishedAt === null) {
      await finishSession(env.DB, session.id, { score: walked.score, maxScore: max, label }, now());
      if (session.contactId !== null && !session.preview) await background(defer, () => sync(env, quiz, session.id));
    }
    const settings = quiz.definition.settings;
    return json({
      score: walked.score,
      max_score: max,
      label,
      message: picked?.range.message || settings.default_message,
      redirect_url: picked === null ? settings.default_redirect_url : (picked.range.redirect_url ?? settings.default_redirect_url),
    });
  }

  async function publicRoute(env: Env, request: Request, url: URL, path: string, defer: Defer | undefined): Promise<Response | null> {
    const m = path.match(new RegExp(`^/q/(${PUBLIC_ID})(?:/(session|answer|optin|finish))?$`));
    if (m === null) return null;
    const action = m[2];
    if (action === undefined ? request.method !== 'GET' && request.method !== 'HEAD' : request.method !== 'POST') return failure(405, 'method_not_allowed');
    if (limited(request, now())) return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
    await ensureSchema(env.DB);
    const quiz = await quizByPublicId(env.DB, m[1]!);
    if (action === undefined) {
      const preview = url.searchParams.get('preview') === '1';
      if (quiz === null || (quiz.status !== 'published' && !preview)) return messagePage('Quizly', 'This quiz is not available.', 404);
      return playerPage(baseOf(env, request), publicQuiz(quiz.publicId, quiz.name, quiz.definition, preview), url.searchParams.get('embed') === '1');
    }
    if (quiz === null) return failure(404, 'quiz_not_found');
    const body = await bodyOf(request);
    if (quiz.status !== 'published' && body['preview'] !== true && action === 'session') return failure(404, 'quiz_not_found');
    if (action === 'session') return start(env, quiz, body, defer);
    if (action === 'answer') return answer(env, quiz, body, defer);
    if (action === 'optin') return optin(env, quiz, body, defer);
    return finish(env, quiz, body, defer);
  }

  return {
    async fetch(request: Request, env: Env, defer?: Defer): Promise<Response> {
      const url = new URL(request.url);
      const baseUrl = baseOf(env, request);
      const path = appPath(url, baseUrl) ?? '';
      if (path.startsWith('/q/')) {
        try {
          return (await publicRoute(env, request, url, path, defer)) ?? failure(404, 'not_found');
        } catch (error) {
          console.error('[quizly]', error);
          return failure(500, 'internal_error');
        }
      }
      await ensureSchema(env.DB);
      return (await handlerFor(env, baseUrl)).fetch(request);
    },
  };
}

function privacyContact(body: Record<string, unknown>): string | null {
  const data = (body['data'] ?? {}) as { contact_id?: unknown };
  const id = typeof data.contact_id === 'string' ? data.contact_id : typeof body['contact_id'] === 'string' ? body['contact_id'] : null;
  return id !== null && CONTACT_ID.test(id) ? id : null;
}

import { d1InstallStore } from '@amable/app-sdk';
import { fakeCrm, routeFetch, signedCaller, testInstall } from '@amable/app-sdk/testing';
import { memoryD1 } from '@amable/app-sdk/testing/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { passed, runConformance } from '../../../../packages/app-cli/src/conformance';
import { appCustomFieldKey, parseAppManifest } from '../../../../packages/core/src/apps';
import manifest from '../manifest.json';
import { createWorker } from '../src/app';
import { maxScore, parseDefinition, pickRange, publicQuiz, walk, type Given, type QuizDefinition } from '../src/quiz';

/** Where the CRM deployed this copy (`APP_BASE_URL`). */
const BASE = 'https://amable-app-quizly.acme.workers.dev';
const SCRIPT = 'https://acme.amabledata.com/forms.js';

let ip = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-22T10:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Two questions and an opt-in; the first answer of q1 jumps over q2. */
const DEFINITION = {
  steps: [
    {
      id: 'q1',
      kind: 'choice',
      text: 'How big is your team?',
      answers: [
        { id: 'solo', text: 'Just me', points: 1, tags: ['Solo'], next: 'optin' },
        { id: 'team', text: 'A team', points: 3, tags: ['Team', 'B2B'] },
      ],
    },
    {
      id: 'q2',
      kind: 'choice',
      text: 'How many people?',
      answers: [
        { id: 'small', text: '2-10', points: 2, tags: [] },
        { id: 'large', text: '10+', points: 5, tags: ['Enterprise'] },
      ],
    },
    { id: 'optin', kind: 'optin', text: 'Where do we send your result?', form_id: 'frm_lead', skippable: true },
    { id: 'notes', kind: 'open', text: 'Anything else?', required: false },
  ],
  ranges: [
    { min: 0, max: 2, label: 'Starter', message: 'Start small.', redirect_url: 'https://site.example.com/starter', tag: 'Result: starter' },
    { min: 3, max: 100, label: 'Pro', redirect_url: 'https://site.example.com/pro', tag: 'Result: pro' },
  ],
  settings: { locale: 'en', default_redirect_url: 'https://site.example.com/thanks' },
  style: { accent: '#ff0066' },
};

async function setup(options: { allowedDomains?: string[] } = {}) {
  const db = memoryD1();
  const install = testInstall({ scopes: manifest.scopes, expiresAt: Number.MAX_SAFE_INTEGER });
  await d1InstallStore(db).put(install);
  const crm = fakeCrm();
  crm.contacts.set('ct_ada', { id: 'ct_ada', given_name: 'Ada', family_name: 'Lovelace', emails: [{ email: 'ada@example.com', is_primary: true }] });
  crm.contacts.set('ct_bob', { id: 'ct_bob', emails: [{ email: 'bob@example.com', is_primary: true }] });
  const tags = new Map<string, string>([['tg_team', 'Team']]);
  const applied: Array<{ contact: string; tag_ids: string[] }> = [];
  const patches: Array<{ contact: string; body: Record<string, unknown> }> = [];
  crm.on('GET', /^\/contacts$/, (call) => {
    const params = new URL(call.url).searchParams;
    const email = params.get('email')?.toLowerCase();
    const data = [...crm.contacts.values()].filter((c) => email === undefined || JSON.stringify(c['emails'] ?? []).toLowerCase().includes(`"${email}"`));
    return Response.json({ data, next_cursor: null });
  });
  crm.on('PATCH', /^\/contacts\/([^/]+)$/, (call, m) => {
    patches.push({ contact: m[1]!, body: call.body as Record<string, unknown> });
    return Response.json(crm.contacts.get(m[1]!) ?? {});
  });
  crm.on('POST', /^\/contacts\/([^/]+)\/tags$/, (call, m) => {
    if (!crm.contacts.has(m[1]!)) return Response.json({ error: 'not_found' }, { status: 404 });
    applied.push({ contact: m[1]!, tag_ids: (call.body as { tag_ids: string[] }).tag_ids });
    return Response.json(crm.contacts.get(m[1]!));
  });
  crm.on('GET', /^\/tags$/, (call) => {
    const q = new URL(call.url).searchParams.get('q')?.toLowerCase() ?? '';
    const data = [...tags].filter(([, name]) => name.toLowerCase().includes(q)).map(([id, name]) => ({ id, name }));
    return Response.json({ data, next_cursor: null });
  });
  crm.on('POST', /^\/tags$/, (call) => {
    const name = (call.body as { name: string }).name;
    const id = `tg_${String(tags.size + 1)}`;
    tags.set(id, name);
    return Response.json({ id, name }, { status: 201 });
  });
  const form = { id: 'frm_lead', name: 'Lead form', status: 'active' };
  // Later routes win: the catch-all goes first.
  crm.on('GET', /^\/forms\/[^/]+(\/embed)?$/, () => Response.json({ error: 'not_found' }, { status: 404 }));
  crm.on('GET', /^\/forms$/, () => Response.json({ data: [form], next_cursor: null }));
  crm.on('GET', /^\/forms\/frm_lead$/, () => Response.json({ ...form, definition: { settings: { allowed_domains: options.allowedDomains ?? [] } } }));
  crm.on('GET', /^\/forms\/frm_lead\/embed$/, () =>
    Response.json({ form_id: 'frm_lead', tenant: 'acme', script_url: SCRIPT, config_url: '', hosted_url: '', hosted_enabled: false, snippet: '' }),
  );
  const worker = createWorker({ fetch: routeFetch(crm.fetch) });
  // As deployed by the CRM: no keys in the environment, the app creates them in its database.
  const env = { DB: db, APP_BASE_URL: BASE };
  const fetch = (request: Request) => worker.fetch(request, env);
  const call = signedCaller({ fetch, baseUrl: BASE, install });
  const screen = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const token = await crm.sessionToken({ appId: manifest.id, audience: BASE, install });
    const response = await fetch(
      new Request(`${BASE}${path}`, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  /** A browser request, each from its own address. */
  const pub = async (path: string, body?: unknown) => {
    const response = await fetch(
      new Request(`${BASE}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'cf-connecting-ip': `10.0.${String((ip += 1) % 250)}.${String(ip % 250)}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // HTML page
    }
    return { status: response.status, text, body: json };
  };
  const quiz = async (body: Record<string, unknown> = {}) => {
    const created = await screen('/api/quizzes', { method: 'POST', body: { name: 'Team quiz', status: 'published', definition: DEFINITION, ...body } });
    expect(created.status).toBe(201);
    return created.body as { id: string; public_id: string; definition: QuizDefinition; snippets: Record<string, string>; warnings: string[] };
  };
  const play = async (publicId: string, start: Record<string, unknown> = {}) => {
    const started = await pub(`/q/${publicId}/session`, start);
    expect(started.status).toBe(201);
    const session = started.body['session'] as string;
    return {
      session,
      known: started.body['known'] as boolean,
      answer: (step_id: string, answer: { answer_id?: string; text?: string }) => pub(`/q/${publicId}/answer`, { session, step_id, ...answer }),
      optin: (submission_id: string) => pub(`/q/${publicId}/optin`, { session, submission_id }),
      finish: () => pub(`/q/${publicId}/finish`, { session }),
    };
  };
  const submitted = (data: Record<string, unknown>) => call('/webhooks', { type: 'form.submitted', data: { formId: 'frm_lead', ...data } });
  const count = (table: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { install, crm, db, env, worker, fetch, call, screen, pub, quiz, play, submitted, tags, applied, patches, count };
}

const definition = (input: unknown) => {
  const parsed = parseDefinition(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

const given = (answers: Record<string, string>) => new Map<string, Given>(Object.entries(answers).map(([step, answerId]) => [step, { answerId, text: null }]));

describe('quizly: manifest', () => {
  it('is a valid manifest deployed in the workspace account, with its page in the Marketing menu', () => {
    const parsed = parseAppManifest(manifest);
    expect(parsed.ok).toBe(true);
    expect(manifest.deployment).toEqual({ kind: 'cloudflare_worker', compatibility_date: '2026-10-01', d1: [{ binding: 'DB' }] });
    expect(manifest.base_url).toBe('https://deployed-app.invalid');
    const page = manifest.extensions.ui.find((u) => u.slot === 'app.page');
    expect(page).toMatchObject({ nav_group: 'marketing', path: '/ui/quizzes' });
    expect(manifest.webhooks.events).toEqual(['form.submitted']);
  });
});

describe('quizly: quiz model', () => {
  it('only accepts forward jumps, unique ids and ordered results', () => {
    expect(parseDefinition({ steps: [] })).toMatchObject({ ok: false });
    const backward = structuredClone(DEFINITION) as typeof DEFINITION;
    (backward.steps[1] as { answers: Array<{ next?: string }> }).answers[0]!.next = 'q1';
    expect(parseDefinition(backward)).toMatchObject({ ok: false, error: expect.stringContaining('later step') });
    const missing = structuredClone(DEFINITION) as typeof DEFINITION;
    (missing.steps[0] as { answers: Array<{ next?: string }> }).answers[0]!.next = 'nope';
    expect(parseDefinition(missing)).toMatchObject({ ok: false });
    expect(parseDefinition({ ...DEFINITION, ranges: [{ min: 5, max: 1 }] })).toMatchObject({ ok: false });
    expect(parseDefinition({ ...DEFINITION, settings: { default_redirect_url: 'javascript:alert(1)' } })).toMatchObject({ ok: false });
  });

  it('scores the walked path only, and knows the highest score of any path', () => {
    const def = definition(DEFINITION);
    // "Just me" jumps over q2: a stale q2 answer (given before going back) does not count.
    const solo = walk(def, given({ q1: 'solo', q2: 'large' }));
    expect(solo).toMatchObject({ score: 1, complete: true });
    expect(solo.path.map((s) => s.id)).toEqual(['q1', 'optin', 'notes']);
    expect(walk(def, given({ q1: 'team', q2: 'large' })).score).toBe(8);
    expect(walk(def, given({ q1: 'team' })).complete).toBe(false);
    expect(maxScore(def)).toBe(8);
    expect(pickRange(def, 1)?.range.label).toBe('Starter');
    expect(pickRange(def, 8)?.range.label).toBe('Pro');
    expect(pickRange(def, 500)).toBeNull();
  });

  it('gives the browser no points, tags or results', () => {
    const view = JSON.stringify(publicQuiz('p', 'Quiz', definition(DEFINITION), false));
    expect(view).not.toContain('points');
    expect(view).not.toContain('Enterprise');
    expect(view).not.toContain('ranges');
    expect(view).not.toContain('site.example.com');
  });
});

describe('quizly: editor', () => {
  it('saves a quiz, finding or creating its tags and filling the opt-in form', async () => {
    const app = await setup();
    const q = await app.quiz();
    const [q1, , optin] = q.definition.steps;
    expect(q1).toMatchObject({ answers: [{ tags: [{ name: 'Solo', id: expect.stringMatching(/^tg_/) }] }, { tags: [{ id: 'tg_team' }, { name: 'B2B' }] }] });
    expect(new Set(app.tags.values())).toEqual(new Set(['Team', 'Solo', 'B2B', 'Enterprise', 'Result: starter', 'Result: pro']));
    expect(optin).toMatchObject({ form_id: 'frm_lead', form_name: 'Lead form', script_url: SCRIPT, tenant: 'acme' });
    expect(q.warnings).toEqual([]);
    expect(q.snippets['embed']).toBe(`<div data-quizly="${q.public_id}"></div>\n<script async src="${BASE}/embed.js"></script>`);
    expect(q.snippets['email_link']).toBe(`${BASE}/q/${q.public_id}?c={{ contact.id }}`);

    // Saving again does not create the same tags twice.
    const again = await app.screen('/api/quizzes', { method: 'POST', body: { id: q.id, name: 'Team quiz', status: 'published', definition: q.definition } });
    expect(again.status).toBe(200);
    expect(app.tags.size).toBe(6);
    const list = await app.screen('/api/quizzes');
    expect(list.body['data']).toMatchObject([{ id: q.id, name: 'Team quiz', max_score: 8, steps: 4 }]);
  });

  it('warns when the opt-in form does not accept the app domain, and refuses a missing form', async () => {
    const app = await setup({ allowedDomains: ['www.site.example.com'] });
    expect((await app.quiz()).warnings).toEqual([`form_domain:Lead form:amable-app-quizly.acme.workers.dev`]);
    const steps = DEFINITION.steps.map((s) => (s.kind === 'optin' ? { ...s, form_id: 'frm_gone' } : s));
    const refused = await app.screen('/api/quizzes', { method: 'POST', body: { name: 'X', definition: { ...DEFINITION, steps } } });
    expect(refused.status).toBe(422);
  });

  it('lists forms and tags for the pickers, duplicates and deletes quizzes', async () => {
    const app = await setup();
    expect((await app.screen('/api/forms')).body['data']).toEqual([{ id: 'frm_lead', name: 'Lead form', status: 'active' }]);
    expect((await app.screen('/api/tags?q=tea')).body['data']).toEqual([{ id: 'tg_team', name: 'Team' }]);
    const q = await app.quiz();
    const copy = await app.screen('/api/quizzes/duplicate', { method: 'POST', body: { id: q.id } });
    expect(copy.body).toMatchObject({ name: 'Team quiz (copy)', status: 'draft' });
    expect((await app.screen(`/api/quizzes?id=${q.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.pub(`/q/${q.public_id}`)).status).toBe(404);
  });
});

describe('quizly: answering', () => {
  it('serves the quiz page without the scoring, frameable', async () => {
    const app = await setup();
    const q = await app.quiz();
    const page = await app.pub(`/q/${q.public_id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`${BASE}/player.js`);
    expect(page.text).toContain('--qz-accent: #ff0066');
    expect(page.text).not.toContain('Enterprise');
    expect(page.text).not.toContain('"points"');
    const draft = await app.quiz({ status: 'draft' });
    expect((await app.pub(`/q/${draft.public_id}`)).status).toBe(404);
    expect((await app.pub(`/q/${draft.public_id}?preview=1`)).status).toBe(200);
  });

  it('sends the answers of a known contact at once, and the result at the end', async () => {
    const app = await setup();
    const q = await app.quiz();
    const tagId = (name: string) => [...app.tags].find(([, n]) => n === name)![0];
    const player = await app.play(q.public_id, { c: 'ct_ada' });
    expect(player.known).toBe(true);

    expect((await player.answer('q1', { answer_id: 'team' })).status).toBe(200);
    expect(app.applied).toEqual([{ contact: 'ct_ada', tag_ids: ['tg_team', tagId('B2B')] }]);
    // Left halfway, the contact already has the answers so far.
    expect(app.crm.entities.get('contact:ct_ada')).toMatchObject({
      [`quiz_${q.id}`]: { quiz: 'Team quiz', status: 'started', answers: [{ q: 'How big is your team?', a: 'A team' }] },
    });
    expect((await player.finish()).status).toBe(422);

    await player.answer('q2', { answer_id: 'large' });
    await player.answer('notes', { text: 'Call me on Monday' });
    const result = await player.finish();
    expect(result.body).toEqual({ score: 8, max_score: 8, label: 'Pro', message: '', redirect_url: 'https://site.example.com/pro' });

    expect(app.applied.map((a) => a.tag_ids)).toEqual([['tg_team', tagId('B2B')], [tagId('Enterprise')], [tagId('Result: pro')]]);
    expect(app.patches).toEqual([
      {
        contact: 'ct_ada',
        body: {
          custom_fields: {
            [appCustomFieldKey('quizly', 'last_quiz')]: 'Team quiz',
            [appCustomFieldKey('quizly', 'last_score')]: 8,
            [appCustomFieldKey('quizly', 'last_result')]: 'Pro',
          },
        },
      },
    ]);
    expect(app.crm.events).toEqual([
      { key: 'quiz_completed', contact_id: 'ct_ada', event_id: `done:${player.session}`, data: { quiz_id: q.id, quiz_name: 'Team quiz', score: 8, max_score: 8, result: 'Pro' } },
    ]);
    expect(app.crm.timeline).toMatchObject([{ contact_id: 'ct_ada', title: 'Quiz completed: Team quiz', icon: 'check' }]);
    expect(String(app.crm.timeline[0]!['body'])).toContain('Anything else? → Call me on Monday');
    expect(app.crm.entities.get('contact:ct_ada')).toMatchObject({ [`quiz_${q.id}`]: { status: 'completed', score: 8, result: 'Pro' } });

    // Finishing twice gives the same result and sends nothing again.
    expect((await player.finish()).body).toMatchObject({ label: 'Pro' });
    expect(app.crm.events).toHaveLength(1);
    expect(app.crm.timeline).toHaveLength(1);
    expect((await player.answer('notes', { text: 'late' })).status).toBe(409);
  });

  it('follows the branch of an answer and recognises a contact by email, never creating one', async () => {
    const app = await setup();
    const q = await app.quiz();
    const player = await app.play(q.public_id, { email: 'BOB@example.com' });
    expect(player.known).toBe(true);
    await player.answer('q1', { answer_id: 'solo' });
    // "Just me" jumps to the opt-in: q2 is not needed.
    expect((await player.finish()).body).toMatchObject({ score: 1, label: 'Starter', message: 'Start small.', redirect_url: 'https://site.example.com/starter' });
    expect(app.crm.events).toMatchObject([{ contact_id: 'ct_bob', data: { result: 'Starter' } }]);

    const stranger = await app.play(q.public_id, { email: 'nobody@example.com', c: 'ct_missing' });
    expect(stranger.known).toBe(false);
    expect(app.crm.calls.some((c) => c.method === 'POST' && c.url.endsWith('/contacts'))).toBe(false);
  });

  it('sends nothing to the CRM without a contact', async () => {
    const app = await setup();
    const q = await app.quiz();
    const player = await app.play(q.public_id);
    expect(player.known).toBe(false);
    await player.answer('q1', { answer_id: 'team' });
    await player.answer('q2', { answer_id: 'small' });
    expect((await player.finish()).body).toMatchObject({ score: 5, label: 'Pro' });
    expect(app.applied).toEqual([]);
    expect(app.crm.events).toEqual([]);
    expect(app.crm.entities.size).toBe(0);
  });

  it('links the contact of the opt-in form when the webhook comes after the browser', async () => {
    const app = await setup();
    const q = await app.quiz();
    const player = await app.play(q.public_id);
    await player.answer('q1', { answer_id: 'solo' });
    expect(app.applied).toEqual([]);
    expect((await player.optin('sub_1')).body).toEqual({ ok: true, known: false });
    expect((await app.submitted({ submissionId: 'sub_1', contactId: 'ct_ada' })).status).toBeLessThan(300);
    // The answers given before the opt-in reach the contact too.
    expect(app.applied).toMatchObject([{ contact: 'ct_ada', tag_ids: [expect.stringMatching(/^tg_/)] }]);
    await player.finish();
    expect(app.crm.events).toMatchObject([{ contact_id: 'ct_ada', data: { result: 'Starter' } }]);
  });

  it('links the contact when the webhook comes first, and results finished before the link', async () => {
    const app = await setup();
    const q = await app.quiz();
    const player = await app.play(q.public_id);
    await player.answer('q1', { answer_id: 'solo' });
    // A submission of a form no quiz uses is not kept.
    await app.submitted({ formId: 'frm_other', submissionId: 'sub_x', contactId: 'ct_bob' });
    expect(app.count('pending_links')).toBe(0);
    await app.submitted({ submissionId: 'sub_2', contactId: 'ct_ada' });
    expect(app.count('pending_links')).toBe(1);
    expect((await player.optin('sub_2')).body).toEqual({ ok: true, known: true });
    expect(app.count('pending_links')).toBe(0);
    expect(app.applied).toHaveLength(1);

    // Finished anonymously, linked afterwards: the result is sent on the link.
    const late = await app.play(q.public_id);
    await late.answer('q1', { answer_id: 'solo' });
    await late.optin('sub_3');
    await late.finish();
    expect(app.crm.events).toHaveLength(0);
    await app.submitted({ submission_id: 'sub_3', contact_id: 'ct_bob' });
    expect(app.crm.events).toMatchObject([{ contact_id: 'ct_bob', event_id: `done:${late.session}` }]);
  });

  it('retries a result the CRM could not take, the next time quizzes are used', async () => {
    const app = await setup();
    const q = await app.quiz();
    let down = true;
    app.crm.on('POST', /^\/apps\/events$/, (call) => {
      if (down) return Response.json({ error: 'unavailable' }, { status: 503 });
      app.crm.events.push(call.body as Record<string, unknown>);
      return Response.json({ event_id: 'ev', event: 'x', matched: 0 }, { status: 201 });
    });
    const player = await app.play(q.public_id, { c: 'ct_ada' });
    await player.answer('q1', { answer_id: 'solo' });
    await player.finish();
    expect(app.crm.events).toHaveLength(0);
    down = false;
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await app.play(q.public_id);
    expect(app.crm.events).toMatchObject([{ event_id: `done:${player.session}` }]);
  });

  it('keeps previews out of the CRM and of the statistics', async () => {
    const app = await setup();
    const q = await app.quiz({ status: 'draft' });
    expect((await app.pub(`/q/${q.public_id}/session`, {})).status).toBe(404);
    const preview = await app.play(q.public_id, { preview: true, c: 'ct_ada' });
    expect(preview.known).toBe(false);
    await preview.answer('q1', { answer_id: 'team' });
    await preview.answer('q2', { answer_id: 'large' });
    expect((await preview.finish()).body).toMatchObject({ score: 8 });
    expect(app.applied).toEqual([]);
    expect((await app.screen(`/api/stats?quiz=${q.id}`)).body).toMatchObject({ started: 0 });
  });

  it('counts answers per step and lists the responses with their contacts', async () => {
    const app = await setup();
    const q = await app.quiz();
    const ada = await app.play(q.public_id, { c: 'ct_ada' });
    await ada.answer('q1', { answer_id: 'team' });
    await ada.answer('q2', { answer_id: 'large' });
    await ada.finish();
    const anon = await app.play(q.public_id);
    await anon.answer('q1', { answer_id: 'solo' });
    const stats = await app.screen(`/api/stats?quiz=${q.id}&days=30`);
    expect(stats.body).toMatchObject({ started: 2, finished: 1, contacts: 1, average_score: 8, results: [{ label: 'Pro', count: 1 }] });
    expect(stats.body['answers']).toEqual(
      expect.arrayContaining([
        { step_id: 'q1', answer_id: 'team', count: 1 },
        { step_id: 'q1', answer_id: 'solo', count: 1 },
      ]),
    );
    const responses = await app.screen(`/api/responses?quiz=${q.id}`);
    expect(responses.body['data']).toMatchObject([
      { contact_id: null, finished_at: null, answers: [{ question: 'How big is your team?', answer: 'Just me' }] },
      { contact_id: 'ct_ada', contact_name: 'Ada Lovelace', score: 8, result: 'Pro' },
    ]);
    const quizzes = await app.screen('/api/quizzes');
    expect(quizzes.body['data']).toMatchObject([{ started: 2, finished: 1, contacts: 1 }]);
  });

  it('refuses unknown sessions, steps and answers', async () => {
    const app = await setup();
    const q = await app.quiz();
    const player = await app.play(q.public_id);
    expect((await app.pub(`/q/${q.public_id}/answer`, { session: 's_nope', step_id: 'q1', answer_id: 'team' })).status).toBe(404);
    expect((await player.answer('q9', { answer_id: 'team' })).status).toBe(422);
    expect((await player.answer('q1', { answer_id: 'nope' })).status).toBe(422);
    expect((await player.optin('bad id!')).status).toBe(422);
    const other = await app.quiz();
    expect((await app.pub(`/q/${other.public_id}/answer`, { session: player.session, step_id: 'q1', answer_id: 'team' })).status).toBe(404);
  });
});

describe('quizly: privacy and lifecycle', () => {
  it('exports and erases the answers of a contact', async () => {
    const app = await setup();
    const q = await app.quiz();
    const player = await app.play(q.public_id, { c: 'ct_ada' });
    await player.answer('q1', { answer_id: 'solo' });
    await player.finish();
    const exported = await app.call('/privacy/data', { data: { contact_id: 'ct_ada' } });
    expect(exported.body).toMatchObject({ data: { quizzes: [{ quiz: 'Team quiz', score: 1, result: 'Starter', answers: [{ answer: 'Just me' }] }] } });
    expect((await app.call('/privacy/erasure', { data: { contact_id: 'ct_ada' } })).body).toEqual({ ok: true });
    expect((await app.call('/privacy/data', { data: { contact_id: 'ct_ada' } })).body).toEqual({ data: null });
    expect(app.count('session_answers')).toBe(0);
  });

  it('deletes everything of the install when the app is uninstalled', async () => {
    const app = await setup();
    const q = await app.quiz();
    const player = await app.play(q.public_id);
    await player.answer('q1', { answer_id: 'solo' });
    const uninstalled = await app.call('/webhooks', { type: 'app.uninstalled', data: {} });
    expect(uninstalled.status).toBeLessThan(300);
    for (const table of ['quizzes', 'sessions', 'session_answers', 'pending_links']) expect(app.count(table)).toBe(0);
  });

  it('serves the screen and passes the conformance suite', async () => {
    const app = await setup();
    const token = await app.crm.sessionToken({ appId: manifest.id, audience: BASE, install: app.install });
    const response = await app.fetch(new Request(`${BASE}/ui/quizzes?session=${token}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`<base href="${BASE}/" />`);
    const results = await runConformance({
      manifest,
      fetch: (input, init) => app.fetch(new Request(input, init)),
      secret: app.install.webhookSecrets[0]!,
      installationId: app.install.id,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(passed(results)).toBe(true);
  });
});
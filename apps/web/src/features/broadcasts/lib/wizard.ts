import type { BroadcastEstimate, BroadcastSegment } from '@amable/api-types';

/**
 * Pure logic of the broadcast wizard: steps and their validation, audience
 * draft ↔ segment, preheader inside the email document, pre-send checklist
 * (links, unsubscribe, spam hints) and wall-clock time in a zone → UTC.
 */

export const WIZARD_STEPS = ['recipients', 'email', 'review'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

// ----------------------------------------------------------------- audience

export interface AudienceDraft {
  readonly includeTagIds: readonly string[];
  readonly tagMatch: 'any' | 'all';
  readonly includeSavedSearchIds: readonly string[];
  readonly excludeTagIds: readonly string[];
  readonly excludeSavedSearchIds: readonly string[];
}

export const EMPTY_AUDIENCE: AudienceDraft = {
  includeTagIds: [],
  tagMatch: 'any',
  includeSavedSearchIds: [],
  excludeTagIds: [],
  excludeSavedSearchIds: [],
};

/** Any stored segment (older drafts use `saved_search` / `tags`) as an editable draft. */
export function audienceFromSegment(segment: BroadcastSegment | null): AudienceDraft {
  if (segment === null) return EMPTY_AUDIENCE;
  switch (segment.type) {
    case 'saved_search':
      return { ...EMPTY_AUDIENCE, includeSavedSearchIds: [segment.saved_search_id] };
    case 'tags':
      return segment.match === 'none'
        ? { ...EMPTY_AUDIENCE, excludeTagIds: segment.tag_ids }
        : { ...EMPTY_AUDIENCE, includeTagIds: segment.tag_ids, tagMatch: segment.match };
    case 'audience':
      return {
        includeTagIds: segment.include_tag_ids,
        tagMatch: segment.tag_match,
        includeSavedSearchIds: segment.include_saved_search_ids,
        excludeTagIds: segment.exclude_tag_ids,
        excludeSavedSearchIds: segment.exclude_saved_search_ids,
      };
  }
}

export function hasInclude(draft: AudienceDraft): boolean {
  return draft.includeTagIds.length > 0 || draft.includeSavedSearchIds.length > 0;
}

/** The segment to store; `null` while nothing is included. */
export function segmentFromAudience(draft: AudienceDraft): BroadcastSegment | null {
  if (!hasInclude(draft)) return null;
  return {
    type: 'audience',
    include_tag_ids: [...draft.includeTagIds],
    tag_match: draft.tagMatch,
    include_saved_search_ids: [...draft.includeSavedSearchIds],
    exclude_tag_ids: [...draft.excludeTagIds],
    exclude_saved_search_ids: [...draft.excludeSavedSearchIds],
  };
}

// --------------------------------------------------------------- documents

export interface DocNode {
  readonly type?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly marks?: readonly { readonly type: string; readonly attrs?: Readonly<Record<string, unknown>> }[];
  readonly content?: readonly DocNode[];
  readonly text?: string;
}

export interface EmailDoc extends DocNode {
  readonly type: 'doc';
  readonly content?: readonly DocNode[];
}

const PREHEADER = 'emailPreheader';
const FOOTER = 'emailFooter';
const BUTTON = 'emailButton';

function walk(node: DocNode, visit: (node: DocNode) => void): void {
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
}

export function getPreheader(doc: EmailDoc): string {
  const node = (doc.content ?? []).find((child) => child.type === PREHEADER);
  const text = node?.attrs?.['text'];
  return typeof text === 'string' ? text : '';
}

/** Writes the preheader block (first top-level node, created when missing). */
export function setPreheader(doc: EmailDoc, text: string): EmailDoc {
  const content = [...(doc.content ?? [])];
  const index = content.findIndex((child) => child.type === PREHEADER);
  if (index >= 0) {
    const node = content[index] ?? {};
    content[index] = { ...node, attrs: { ...node.attrs, text } };
  } else {
    if (text.trim() === '') return doc;
    content.unshift({ type: PREHEADER, attrs: { text } });
  }
  return { ...doc, content };
}

/** Link targets: link marks and button hrefs. */
export function collectLinks(doc: EmailDoc): string[] {
  const links: string[] = [];
  walk(doc, (node) => {
    if (node.type === BUTTON && typeof node.attrs?.['href'] === 'string') links.push(node.attrs['href']);
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link' && typeof mark.attrs?.['href'] === 'string') links.push(mark.attrs['href']);
    }
  });
  return links;
}

/** http(s) URLs with a host, mailto:, tel:, or anything built with Liquid. */
export function isValidLink(href: string): boolean {
  const value = href.trim();
  if (value === '') return false;
  if (value.includes('{{')) return true;
  if (/^(mailto|tel):\S+$/i.test(value)) return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}

export function invalidLinks(doc: EmailDoc): string[] {
  return [...new Set(collectLinks(doc).filter((href) => !isValidLink(href)))];
}

/** The email carries its own unsubscribe link (footer block or `unsubscribe_url`). */
export function hasUnsubscribe(doc: EmailDoc): boolean {
  if ((doc.content ?? []).some((node) => node.type === FOOTER)) return true;
  let found = false;
  walk(doc, (node) => {
    if (node.text?.includes('unsubscribe_url') === true) found = true;
    for (const mark of node.marks ?? []) {
      if (String(mark.attrs?.['href'] ?? '').includes('unsubscribe_url')) found = true;
    }
  });
  return found;
}

/** Visible text of the body (text nodes + button labels), preheader excluded. */
export function docText(doc: EmailDoc): string {
  const parts: string[] = [];
  walk(doc, (node) => {
    if (typeof node.text === 'string') parts.push(node.text);
    if (node.type === BUTTON && typeof node.attrs?.['label'] === 'string') parts.push(node.attrs['label']);
  });
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function hasContent(doc: EmailDoc): boolean {
  if (docText(doc) !== '') return true;
  let media = false;
  walk(doc, (node) => {
    if (node.type === 'image' || node.type === BUTTON) media = true;
  });
  return media;
}

// ----------------------------------------------------------------- spam hints

const SPAM_PHRASES = [
  'act now',
  'buy now',
  'cash',
  'click here',
  'free',
  'guaranteed',
  'limited time',
  'risk-free',
  'winner',
  'clicca qui',
  'compra ora',
  'garantito',
  'gratis',
  'offerta limitata',
  'senza rischi',
  'urgente',
  'vincitore',
  '100%',
  '$$$',
  '!!!',
] as const;

/** Phrases that often trip spam filters, and an all-caps subject. */
export function spamHints(subject: string, text: string): string[] {
  const haystack = ` ${`${subject} ${text}`.toLowerCase()} `;
  const hits: string[] = SPAM_PHRASES.filter((phrase) =>
    /^[a-z]/.test(phrase)
      ? new RegExp(`[^\\p{L}]${phrase}[^\\p{L}]`, 'u').test(haystack)
      : haystack.includes(phrase),
  );
  const letters = subject.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 6 && letters === letters.toUpperCase()) hits.push('ALL CAPS');
  return hits;
}

// ---------------------------------------------------------------- validation

export interface WizardState {
  readonly name: string;
  readonly audience: AudienceDraft;
  /** Recipients the server would send to (`null` until estimated). */
  readonly eligible: number | null;
  readonly subject: string;
  readonly fromEmail: string | null;
  readonly doc: EmailDoc;
}

export type StepError =
  | 'name_required'
  | 'no_audience'
  | 'empty_audience'
  | 'subject_required'
  | 'sender_missing'
  | 'content_empty'
  | 'invalid_links';

export function stepErrors(step: WizardStep, state: WizardState): StepError[] {
  const errors: StepError[] = [];
  if (step === 'recipients') {
    if (state.name.trim() === '') errors.push('name_required');
    if (!hasInclude(state.audience)) errors.push('no_audience');
    else if (state.eligible === 0) errors.push('empty_audience');
  }
  if (step === 'email') {
    if (state.subject.trim() === '') errors.push('subject_required');
    if (state.fromEmail === null || state.fromEmail === '') errors.push('sender_missing');
    if (!hasContent(state.doc)) errors.push('content_empty');
    if (invalidLinks(state.doc).length > 0) errors.push('invalid_links');
  }
  return errors;
}

/** Index of the first step with errors (= last reachable step); all valid → review. */
export function firstOpenStep(state: WizardState): number {
  const index = WIZARD_STEPS.findIndex((step) => stepErrors(step, state).length > 0);
  return index === -1 ? WIZARD_STEPS.length - 1 : index;
}

/** A step can be opened when every step before it is valid. */
export function canOpenStep(target: number, state: WizardState): boolean {
  return target >= 0 && target < WIZARD_STEPS.length && target <= firstOpenStep(state);
}

// ----------------------------------------------------------------- checklist

export type CheckStatus = 'ok' | 'warn' | 'fail';
export type CheckId =
  | 'domain'
  | 'sender'
  | 'address'
  | 'unsubscribe'
  | 'subject'
  | 'preheader'
  | 'links'
  | 'recipients'
  | 'quota'
  | 'warmup'
  | 'spam';

export interface CheckItem {
  readonly id: CheckId;
  readonly status: CheckStatus;
  readonly detail?: string;
}

export interface ChecklistInput {
  readonly sendingState: 'verified' | 'unverified' | 'dev_override' | null;
  readonly fromEmail: string | null;
  readonly physicalAddress: string | null;
  readonly subject: string;
  readonly doc: EmailDoc;
  readonly estimate: BroadcastEstimate | null;
}

export function buildChecklist(input: ChecklistInput): CheckItem[] {
  const preheader = getPreheader(input.doc).trim();
  const bad = invalidLinks(input.doc);
  const spam = spamHints(input.subject, docText(input.doc));
  const e = input.estimate;
  const items: CheckItem[] = [
    {
      id: 'domain',
      status:
        input.sendingState === 'verified' ? 'ok' : input.sendingState === 'dev_override' ? 'warn' : 'fail',
    },
    { id: 'sender', status: input.fromEmail ? 'ok' : 'fail', ...(input.fromEmail ? { detail: input.fromEmail } : {}) },
    { id: 'address', status: input.physicalAddress ? 'ok' : 'fail' },
    { id: 'unsubscribe', status: hasUnsubscribe(input.doc) ? 'ok' : 'warn' },
    { id: 'subject', status: input.subject.trim() === '' ? 'fail' : 'ok' },
    { id: 'preheader', status: preheader === '' ? 'warn' : 'ok' },
    { id: 'links', status: bad.length === 0 ? 'ok' : 'fail', ...(bad.length > 0 ? { detail: bad.join(', ') } : {}) },
    {
      id: 'recipients',
      status: e === null ? 'warn' : e.eligible > 0 ? 'ok' : 'fail',
      detail: String(e?.eligible ?? '—'),
    },
    {
      id: 'quota',
      status: e === null ? 'warn' : e.quota.action === 'allow' ? 'ok' : 'fail',
      ...(e?.quota.reason ? { detail: e.quota.reason } : {}),
    },
  ];
  if (e !== null && e.warmup.daily_cap !== null && (e.warmup.remaining_today ?? 0) < e.eligible) {
    items.push({ id: 'warmup', status: 'warn', detail: String(e.warmup.remaining_today ?? 0) });
  }
  items.push({ id: 'spam', status: spam.length === 0 ? 'ok' : 'warn', ...(spam.length > 0 ? { detail: spam.join(', ') } : {}) });
  return items;
}

export function checklistBlocks(items: readonly CheckItem[]): boolean {
  return items.some((item) => item.status === 'fail');
}

// --------------------------------------------------------------------- time

function zoneOffsetMs(zone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

/** `2026-10-16` + `09:00` in `Europe/Rome` → epoch ms (DST aware). */
export function zonedLocalToUtc(date: string, time: string, zone: string): number {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const [h = 0, min = 0] = time.split(':').map(Number);
  const local = Date.UTC(y, m - 1, d, h, min);
  const first = local - zoneOffsetMs(zone, local);
  return local - zoneOffsetMs(zone, first);
}

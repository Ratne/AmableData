import type { BroadcastEstimate } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import {
  audienceFromSegment,
  buildChecklist,
  canOpenStep,
  checklistBlocks,
  EMPTY_AUDIENCE,
  firstOpenStep,
  getPreheader,
  hasUnsubscribe,
  invalidLinks,
  segmentFromAudience,
  setPreheader,
  spamHints,
  stepErrors,
  zonedLocalToUtc,
  type EmailDoc,
  type WizardState,
} from '../src/features/broadcasts/lib/wizard';

const doc = (extra: EmailDoc['content'] = []): EmailDoc => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello, read ' },
        { type: 'text', text: 'our news', marks: [{ type: 'link', attrs: { href: 'https://acme.test/news' } }] },
      ],
    },
    ...(extra ?? []),
    { type: 'emailFooter', attrs: { unsubscribeLabel: 'Unsubscribe' }, content: [{ type: 'paragraph' }] },
  ],
});

const state = (patch: Partial<WizardState> = {}): WizardState => ({
  name: 'October',
  audience: { ...EMPTY_AUDIENCE, includeTagIds: ['t1'] },
  eligible: 3,
  subject: 'News for you',
  fromEmail: 'news@acme.test',
  doc: doc(),
  ...patch,
});

const estimate = (patch: Partial<BroadcastEstimate> = {}): BroadcastEstimate => ({
  segment_size: 4,
  eligible: 3,
  excluded: { no_email: 1, suppressed: 0, unmarketable: 0 },
  warmup: { daily_cap: null, remaining_today: null },
  quota: { action: 'allow', reason: null },
  can_send: true,
  block_reason: null,
  ...patch,
});

describe('wizard step validation', () => {
  it('blocks Recipients without an include or with nobody eligible', () => {
    expect(stepErrors('recipients', state())).toEqual([]);
    expect(stepErrors('recipients', state({ audience: { ...EMPTY_AUDIENCE, excludeTagIds: ['x'] } }))).toEqual([
      'no_audience',
    ]);
    expect(stepErrors('recipients', state({ eligible: 0 }))).toEqual(['empty_audience']);
    expect(stepErrors('recipients', state({ eligible: null }))).toEqual([]);
    expect(stepErrors('recipients', state({ name: ' ' }))).toEqual(['name_required']);
  });

  it('blocks Email without subject, sender, content or with broken links', () => {
    expect(stepErrors('email', state())).toEqual([]);
    const broken = doc([
      { type: 'emailButton', attrs: { label: 'Go', href: 'htp:/nope' } },
      { type: 'emailButton', attrs: { label: 'Me', href: 'mailto:me@acme.test' } },
      { type: 'emailButton', attrs: { label: 'You', href: '{{ contact.website }}' } },
    ]);
    expect(invalidLinks(broken)).toEqual(['htp:/nope']);
    expect(
      stepErrors('email', state({ subject: '', fromEmail: null, doc: { type: 'doc', content: [] } })),
    ).toEqual(['subject_required', 'sender_missing', 'content_empty']);
    expect(stepErrors('email', state({ doc: broken }))).toEqual(['invalid_links']);
  });

  it('opens only completed steps and the first open one', () => {
    expect(firstOpenStep(state())).toBe(2);
    expect(canOpenStep(2, state())).toBe(true);
    const noSubject = state({ subject: '' });
    expect(firstOpenStep(noSubject)).toBe(1);
    expect(canOpenStep(0, noSubject)).toBe(true);
    expect(canOpenStep(2, noSubject)).toBe(false);
    expect(canOpenStep(1, state({ audience: EMPTY_AUDIENCE }))).toBe(false);
    expect(canOpenStep(3, state())).toBe(false);
  });
});

describe('audience draft', () => {
  it('round-trips the audience segment and upgrades older segments', () => {
    const draft = {
      includeTagIds: ['a', 'b'],
      tagMatch: 'all' as const,
      includeSavedSearchIds: ['s1'],
      excludeTagIds: ['c'],
      excludeSavedSearchIds: ['s2'],
    };
    const segment = segmentFromAudience(draft);
    expect(segment).toEqual({
      type: 'audience',
      include_tag_ids: ['a', 'b'],
      tag_match: 'all',
      include_saved_search_ids: ['s1'],
      exclude_tag_ids: ['c'],
      exclude_saved_search_ids: ['s2'],
    });
    expect(audienceFromSegment(segment)).toEqual(draft);
    expect(audienceFromSegment({ type: 'saved_search', saved_search_id: 's9' }).includeSavedSearchIds).toEqual(['s9']);
    expect(audienceFromSegment({ type: 'tags', match: 'any', tag_ids: ['t'] }).includeTagIds).toEqual(['t']);
    expect(audienceFromSegment({ type: 'tags', match: 'none', tag_ids: ['t'] }).excludeTagIds).toEqual(['t']);
    expect(segmentFromAudience(EMPTY_AUDIENCE)).toBeNull();
  });
});

describe('email document helpers', () => {
  it('reads and writes the preheader block', () => {
    const base = doc();
    expect(getPreheader(base)).toBe('');
    expect(setPreheader(base, '')).toBe(base);
    const withPre = setPreheader(base, 'Inside: deals');
    expect(withPre.content?.[0]).toEqual({ type: 'emailPreheader', attrs: { text: 'Inside: deals' } });
    expect(getPreheader(setPreheader(withPre, 'Changed'))).toBe('Changed');
    expect(setPreheader(withPre, 'Changed').content).toHaveLength(withPre.content?.length ?? 0);
  });

  it('detects the unsubscribe link', () => {
    expect(hasUnsubscribe(doc())).toBe(true);
    expect(
      hasUnsubscribe({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bye {{ unsubscribe_url }}' }] }],
      }),
    ).toBe(true);
    expect(hasUnsubscribe({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(false);
  });

  it('hints spammy words as whole words and all-caps subjects', () => {
    expect(spamHints('Your October news', 'Read it')).toEqual([]);
    expect(spamHints('FREE SHIPPING TODAY', 'Click here!!!')).toEqual(['click here', 'free', '!!!', 'ALL CAPS']);
    expect(spamHints('Freedom', 'carefree')).toEqual([]);
    expect(spamHints('Offerta', 'Spedizione gratis')).toEqual(['gratis']);
  });
});

describe('pre-send checklist', () => {
  const input = {
    sendingState: 'verified' as const,
    fromEmail: 'news@acme.test',
    physicalAddress: 'Via Roma 1, Milano',
    subject: 'News',
    doc: setPreheader(doc(), 'Inside'),
    estimate: estimate(),
  };

  it('passes a ready broadcast', () => {
    const items = buildChecklist(input);
    expect(items.every((item) => item.status === 'ok')).toBe(true);
    expect(checklistBlocks(items)).toBe(false);
  });

  it('fails on domain, quota, recipients and warns on preheader, warm-up and spam', () => {
    const items = buildChecklist({
      ...input,
      sendingState: 'unverified',
      subject: 'FREE STUFF NOW',
      doc: doc(),
      estimate: estimate({
        eligible: 0,
        quota: { action: 'deny', reason: 'balance too low' },
        warmup: { daily_cap: 50, remaining_today: 0 },
      }),
    });
    const status = Object.fromEntries(items.map((item) => [item.id, item.status]));
    expect(status).toMatchObject({
      domain: 'fail',
      recipients: 'fail',
      quota: 'fail',
      preheader: 'warn',
      spam: 'warn',
      sender: 'ok',
    });
    expect(status['warmup']).toBeUndefined();
    expect(checklistBlocks(items)).toBe(true);
    const warm = buildChecklist({ ...input, estimate: estimate({ warmup: { daily_cap: 50, remaining_today: 1 } }) });
    expect(warm.find((item) => item.id === 'warmup')?.status).toBe('warn');
  });
});

describe('zoned time', () => {
  it('converts a wall-clock time in a zone to UTC across DST', () => {
    expect(new Date(zonedLocalToUtc('2026-10-16', '09:00', 'Europe/Rome')).toISOString()).toBe('2026-10-16T07:00:00.000Z');
    expect(new Date(zonedLocalToUtc('2026-12-16', '09:00', 'Europe/Rome')).toISOString()).toBe('2026-12-16T08:00:00.000Z');
    expect(new Date(zonedLocalToUtc('2026-10-16', '09:00', 'America/New_York')).toISOString()).toBe('2026-10-16T13:00:00.000Z');
    expect(new Date(zonedLocalToUtc('2026-10-16', '09:00', 'Asia/Kolkata')).toISOString()).toBe('2026-10-16T03:30:00.000Z');
  });
});

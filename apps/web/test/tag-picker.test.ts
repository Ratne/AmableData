import type { Activity } from '@amable/api-types/crm';
import { describe, expect, it } from 'vitest';
import { activityDetail } from '../src/features/crm/activity-types';
import {
  idBatches,
  shouldOfferCreate,
  toggleTag,
} from '../src/features/crm/components/tag-picker-model';

describe('tag picker model', () => {
  it('toggles in multi mode and replaces in single mode', () => {
    expect(toggleTag([], 'a', { multiple: true })).toEqual(['a']);
    expect(toggleTag(['a', 'b'], 'a', { multiple: true })).toEqual(['b']);
    expect(toggleTag(['a'], 'b', { multiple: false })).toEqual(['b']);
    expect(toggleTag(['a'], 'a', { multiple: false })).toEqual([]);
  });

  it('stops adding at max but still removes', () => {
    expect(toggleTag(['a', 'b'], 'c', { multiple: true, max: 2 })).toEqual(['a', 'b']);
    expect(toggleTag(['a', 'b'], 'b', { multiple: true, max: 2 })).toEqual(['a']);
  });

  it('offers "create" only for a new, usable name', () => {
    expect(shouldOfferCreate('  ', [])).toBe(false);
    expect(shouldOfferCreate('VIP', ['vip', 'Lead'])).toBe(false);
    expect(shouldOfferCreate('VIP 2', ['vip'])).toBe(true);
    expect(shouldOfferCreate('x'.repeat(101), [])).toBe(false);
  });

  it('batches ids for GET /tags?ids= without duplicates', () => {
    const ids = Array.from({ length: 205 }, (_, i) => `t${String(i)}`);
    const batches = idBatches([...ids, 't0', 't1']);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 5]);
    expect(batches.flat()).toEqual(ids);
  });

  it('falls back to the tag name stored on the activity when the live name is unknown', () => {
    const activity = {
      id: 'a1',
      type: 'contact.tag_applied',
      data: { tagId: 't1', tagName: 'Newsletter' },
    } as unknown as Activity;
    expect(activityDetail(activity, { locale: 'en', tagName: (id) => id })).toBe('Newsletter');
    expect(activityDetail(activity, { locale: 'en', tagName: () => 'Renamed' })).toBe('Renamed');
  });
});

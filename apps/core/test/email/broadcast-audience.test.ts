import { broadcastSegmentSchema } from '@amable/api-types';
import { describe, expect, it } from 'vitest';
import { configureSender, createMailWorld, sampleDoc } from './helpers';

type World = ReturnType<typeof createMailWorld>;

function tagId(world: World, name: string): string {
  const tag = world.crm.op('tags.list', { limit: 50, q: name }).data.find((t) => t.name === name);
  if (tag === undefined) throw new Error(`no tag ${name}`);
  return tag.id;
}

describe('broadcast audience segment', () => {
  it('unions tag and saved-search includes and removes every exclusion', async () => {
    const world = createMailWorld();
    await configureSender(world);
    const ada = world.contact({ email: 'ada@x.test', given: 'Ada', tags: ['News'] });
    const bob = world.contact({ email: 'bob@x.test', given: 'Bob', tags: ['News', 'Churned'] });
    const cy = world.contact({ email: 'cy@x.test', given: 'Cy', tags: ['Events'] });
    const dee = world.contact({ email: 'dee@x.test', given: 'Dee', tags: ['Events', 'Staff'] });
    world.contact({ email: 'eve@x.test', given: 'Eve', tags: [] });
    const cys = world.crm.op('savedSearches.create', {
      name: 'Cy and Dee',
      query: {
        entity: 'contact',
        filter: {
          type: 'group',
          op: 'and',
          conditions: [{ type: 'tags', match: 'any', tag_ids: [tagId(world, 'Events')] }],
        },
      },
    });
    const staff = world.crm.op('savedSearches.create', {
      name: 'Staff',
      query: {
        entity: 'contact',
        filter: {
          type: 'group',
          op: 'and',
          conditions: [{ type: 'tags', match: 'any', tag_ids: [tagId(world, 'Staff')] }],
        },
      },
    });
    const segment = broadcastSegmentSchema.parse({
      type: 'audience',
      include_tag_ids: [tagId(world, 'News')],
      tag_match: 'any',
      include_saved_search_ids: [cys.id],
      exclude_tag_ids: [tagId(world, 'Churned')],
      exclude_saved_search_ids: [staff.id],
    });
    const members = world.crm.op('mail.segmentMemberIds', { segment });
    expect([...members].sort()).toEqual([ada, cy].sort());
    expect(members).not.toContain(bob);
    expect(members).not.toContain(dee);

    const b = await world.op('broadcasts.create', {
      name: 'Audience',
      subject: 'Hi',
      body: sampleDoc() as never,
      segment,
      createdBy: 'user_owner',
    });
    expect(await world.op('broadcasts.estimate', { id: b.id })).toMatchObject({
      segment_size: 2,
      eligible: 2,
      can_send: true,
    });
  });

  it('is empty without includes and supports tag_match all', async () => {
    const world = createMailWorld();
    const both = world.contact({ email: 'a@x.test', tags: ['A', 'B'] });
    world.contact({ email: 'b@x.test', tags: ['A'] });
    const base = {
      type: 'audience' as const,
      include_tag_ids: [] as string[],
      tag_match: 'any' as const,
      include_saved_search_ids: [] as string[],
      exclude_tag_ids: [tagId(world, 'B')],
      exclude_saved_search_ids: [] as string[],
    };
    expect(world.crm.op('mail.segmentMemberIds', { segment: base })).toEqual([]);
    expect(
      world.crm.op('mail.segmentMemberIds', {
        segment: { ...base, include_tag_ids: [tagId(world, 'A'), tagId(world, 'B')], tag_match: 'all', exclude_tag_ids: [] },
      }),
    ).toEqual([both]);
    expect(broadcastSegmentSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

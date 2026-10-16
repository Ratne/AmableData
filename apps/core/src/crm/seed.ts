import type { CustomFieldValues } from '@amable/api-types';
import { createCrmContext, SYSTEM_ACTOR, type CrmContext, type SearchMode } from './context';
import type { SqlDb } from './db/sql';
import { createCompany, createLeadSource } from './companies';
import { createContact } from './contacts';
import {
  createCustomField,
  createCustomFieldGroup,
  createCustomFieldTab,
} from './custom-fields/repo';
import { createAppointment, createTask, completeTask } from './calendar';
import { createOpportunity, createPipeline, updateOpportunity } from './deals';
import { createNote } from './notes';
import { createSavedSearch } from './saved-searches';
import { createTag, createTagCategory } from './tags';

export interface CrmSeedSummary {
  seeded: boolean;
  contacts: number;
  companies: number;
  tags: number;
  customFields: number;
  opportunities: number;
  notes: number;
  tasks: number;
  appointments: number;
}

const GIVEN = [
  'Giulia',
  'Marco',
  'Sofia',
  'Luca',
  'Chiara',
  'Matteo',
  'Elena',
  'Davide',
  'Sara',
  'Andrea',
  'Francesca',
  'Alessandro',
  'Martina',
  'Lorenzo',
  'Anna',
  'Emma',
  'Noah',
  'Olivia',
  'Liam',
  'Ava',
  'Lucas',
  'Mia',
  'Ethan',
  'Zoe',
  'Hugo',
  'Léa',
  'Jonas',
  'Nina',
  'Pablo',
  'Inès',
];
const FAMILY = [
  'Rossi',
  'Bianchi',
  'Romano',
  'Colombo',
  'Ricci',
  'Marino',
  'Greco',
  'Bruno',
  'Gallo',
  'Conti',
  'De Luca',
  'Mancini',
  'Costa',
  'Giordano',
  'Rizzo',
  'Smith',
  'Johnson',
  'Brown',
  'Taylor',
  'Martin',
  'Müller',
  'Schmidt',
  'García',
  'López',
  'Dubois',
  'Moreau',
  'Novak',
  'Jansen',
  'Silva',
  'Kowalski',
];
const COMPANY_WORDS = [
  'Nordic',
  'Alpine',
  'Lumen',
  'Vertex',
  'Orbit',
  'Cobalt',
  'Aurora',
  'Pixel',
  'Terra',
  'Nimbus',
  'Solaris',
  'Quanta',
  'Mosaic',
  'Harbor',
  'Juniper',
  'Atlas',
  'Beacon',
  'Cedar',
  'Delta',
  'Ember',
  'Fjord',
  'Granite',
  'Helix',
  'Iris',
  'Kite',
];
const COMPANY_SUFFIX = [
  'Labs',
  'Studio',
  'S.r.l.',
  'Group',
  'Digital',
  'Consulting',
  'Foods',
  'Design',
];
const CITIES: Array<[string, string, string]> = [
  ['Milano', 'IT-MI', 'IT'],
  ['Roma', 'IT-RM', 'IT'],
  ['Torino', 'IT-TO', 'IT'],
  ['Bologna', 'IT-BO', 'IT'],
  ['Napoli', 'IT-NA', 'IT'],
  ['Berlin', 'DE-BE', 'DE'],
  ['Paris', 'FR-75', 'FR'],
  ['Madrid', 'ES-M', 'ES'],
  ['London', 'GB-LND', 'GB'],
  ['Austin', 'US-TX', 'US'],
];
const JOBS = [
  'CEO',
  'Marketing Manager',
  'Sales Director',
  'Founder',
  'CTO',
  'Office Manager',
  'Designer',
  'Consultant',
];

/** Deterministic PRNG (mulberry32) so every local seed is identical. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Fills an empty tenant with ~200 contacts and related data. Idempotent. */
export function seedCrm(db: SqlDb, searchMode: SearchMode): CrmSeedSummary {
  const done = db.all<{ value: string }>(
    `SELECT value FROM tenant_meta WHERE key = 'crm_seeded_at'`,
  )[0];
  const empty: CrmSeedSummary = {
    seeded: false,
    contacts: 0,
    companies: 0,
    tags: 0,
    customFields: 0,
    opportunities: 0,
    notes: 0,
    tasks: 0,
    appointments: 0,
  };
  if (done !== undefined) return empty;
  const ctx = createCrmContext(db, SYSTEM_ACTOR, searchMode);
  return db.transaction(() => {
    const summary = seedInto(ctx);
    db.run(`INSERT INTO tenant_meta (key, value) VALUES ('crm_seeded_at', ?)`, String(ctx.now()));
    return summary;
  });
}

function seedInto(ctx: CrmContext): CrmSeedSummary {
  const random = rng(20261015);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const chance = (p: number): boolean => random() < p;
  const day = 86_400_000;
  const now = ctx.now();

  // ---- tags
  const lifecycle = createTagCategory(ctx, {
    name: 'Lifecycle',
    description: 'Where the contact is in the funnel',
  });
  const interests = createTagCategory(ctx, { name: 'Interests' });
  const tagSpecs: Array<[string, string | null]> = [
    ['Lead', lifecycle.id],
    ['Customer', lifecycle.id],
    ['VIP', lifecycle.id],
    ['Churn risk', lifecycle.id],
    ['Newsletter', interests.id],
    ['Webinar 2026', interests.id],
    ['Pricing interest', interests.id],
    ['Ebook download', interests.id],
    ['Partner', null],
    ['Event Milan', null],
  ];
  const tags = tagSpecs.map(([name, categoryId]) =>
    createTag(ctx, { name, category_id: categoryId }),
  );
  const tagId = (name: string): string => tags.find((t) => t.name === name)?.id ?? '';

  // ---- custom fields with tabs/groups
  const tab = createCustomFieldTab(ctx, { entity: 'contact', data: { name: 'Profile' } });
  const subscription = createCustomFieldGroup(ctx, {
    entity: 'contact',
    data: { tab_id: tab.id, name: 'Subscription' },
  });
  const personal = createCustomFieldGroup(ctx, {
    entity: 'contact',
    data: { tab_id: tab.id, name: 'Personal', position: 1 },
  });
  const fields = [
    createCustomField(ctx, {
      entity: 'contact',
      data: {
        key: 'plan',
        label: 'Plan',
        type: 'DROPDOWN',
        group_id: subscription.id,
        options: [
          { value: 'free', label: 'Free' },
          { value: 'pro', label: 'Pro' },
          { value: 'team', label: 'Team' },
        ],
      },
    }),
    createCustomField(ctx, {
      entity: 'contact',
      data: {
        key: 'lifetime_value',
        label: 'Lifetime value',
        type: 'CURRENCY',
        group_id: subscription.id,
        config: { currency: 'EUR', decimals: 2 },
      },
    }),
    createCustomField(ctx, {
      entity: 'contact',
      data: { key: 'renewal_date', label: 'Renewal date', type: 'DATE', group_id: subscription.id },
    }),
    createCustomField(ctx, {
      entity: 'contact',
      data: {
        key: 'nps',
        label: 'NPS',
        type: 'WHOLE_NUMBER',
        group_id: subscription.id,
        config: { min: 0, max: 10 },
      },
    }),
    createCustomField(ctx, {
      entity: 'contact',
      data: {
        key: 'interests',
        label: 'Interests',
        type: 'LIST_BOX',
        group_id: personal.id,
        options: [
          { value: 'email', label: 'Email marketing' },
          { value: 'automation', label: 'Automation' },
          { value: 'analytics', label: 'Analytics' },
          { value: 'ecommerce', label: 'E-commerce' },
        ],
      },
    }),
    createCustomField(ctx, {
      entity: 'contact',
      data: {
        key: 'industry',
        label: 'Industry',
        type: 'DRILLDOWN',
        group_id: personal.id,
        options: [
          {
            value: 'services',
            label: 'Services',
            children: [
              { value: 'agency', label: 'Agency' },
              { value: 'consulting', label: 'Consulting' },
            ],
          },
          {
            value: 'retail',
            label: 'Retail',
            children: [
              { value: 'fashion', label: 'Fashion' },
              { value: 'food', label: 'Food' },
            ],
          },
        ],
      },
    }),
    createCustomField(ctx, {
      entity: 'contact',
      data: {
        key: 'newsletter_weekly',
        label: 'Weekly newsletter',
        type: 'YES_NO',
        group_id: personal.id,
      },
    }),
    createCustomField(ctx, {
      entity: 'contact',
      data: {
        key: 'preferred_day',
        label: 'Preferred day',
        type: 'DAY_OF_WEEK',
        group_id: personal.id,
      },
    }),
    createCustomField(ctx, {
      entity: 'contact',
      data: {
        key: 'tax_code',
        label: 'Tax code',
        type: 'SOCIAL_SECURITY_NUMBER',
        group_id: personal.id,
      },
    }),
    createCustomField(ctx, {
      entity: 'company',
      data: { key: 'employees', label: 'Employees', type: 'WHOLE_NUMBER' },
    }),
    createCustomField(ctx, {
      entity: 'company',
      data: {
        key: 'sector',
        label: 'Sector',
        type: 'RADIO',
        options: [
          { value: 'b2b', label: 'B2B' },
          { value: 'b2c', label: 'B2C' },
        ],
      },
    }),
    createCustomField(ctx, {
      entity: 'opportunity',
      data: { key: 'campaign', label: 'Campaign', type: 'TEXT' },
    }),
  ];

  // ---- lead sources
  const sources = ['Website', 'Referral', 'Event', 'Paid ads', 'Partner'].map((name) =>
    createLeadSource(ctx, { name }),
  );

  // ---- companies
  const companies = COMPANY_WORDS.map((word, i) => {
    const [city, region, country] = pick(CITIES);
    const name = `${word} ${COMPANY_SUFFIX[i % COMPANY_SUFFIX.length] ?? 'Labs'}`;
    return createCompany(ctx, {
      name,
      website: `https://${slug(word)}.example.com`,
      email: `hello@${slug(word)}.example.com`,
      phone: `+39 02 ${1000000 + i * 7919}`,
      address: { locality: city, region, country_code: country },
      custom_fields: {
        employees: 5 + Math.floor(random() * 500),
        sector: chance(0.6) ? 'b2b' : 'b2c',
      },
    });
  });

  // ---- contacts
  const contacts: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    const given = pick(GIVEN);
    const family = pick(FAMILY);
    const [city, region, country] = pick(CITIES);
    const company = chance(0.7) ? pick(companies) : null;
    const plan = pick(['free', 'free', 'pro', 'team']);
    const custom: CustomFieldValues = { plan };
    if (plan !== 'free') custom['lifetime_value'] = Math.round(random() * 500000) / 100;
    if (chance(0.5)) custom['nps'] = Math.floor(random() * 11);
    if (chance(0.6))
      custom['interests'] = [
        ...new Set([pick(['email', 'automation']), pick(['analytics', 'ecommerce'])]),
      ];
    if (chance(0.4))
      custom['industry'] = chance(0.5)
        ? ['services', pick(['agency', 'consulting'])]
        : ['retail', pick(['fashion', 'food'])];
    if (chance(0.5)) custom['newsletter_weekly'] = chance(0.7);
    if (chance(0.3)) custom['preferred_day'] = 1 + Math.floor(random() * 5);
    if (chance(0.3))
      custom['renewal_date'] = new Date(now + Math.floor(random() * 365) * day)
        .toISOString()
        .slice(0, 10);
    if (chance(0.2)) {
      const code = (text: string): string => slug(text).slice(0, 3).toUpperCase().padEnd(3, 'X');
      custom['tax_code'] = `${code(family)}${code(given)}80A01F205Z`;
    }

    const contactTags = [chance(0.6) ? 'Lead' : 'Customer'];
    if (chance(0.1)) contactTags.push('VIP');
    if (chance(0.4)) contactTags.push('Newsletter');
    if (chance(0.2)) contactTags.push('Webinar 2026');
    if (chance(0.15)) contactTags.push('Pricing interest');
    if (chance(0.05)) contactTags.push('Churn risk');
    if (city === 'Milano' && chance(0.5)) contactTags.push('Event Milan');

    const contact = createContact(ctx, {
      given_name: given,
      family_name: family,
      job_title: chance(0.6) ? pick(JOBS) : null,
      company_id: company?.id ?? null,
      emails: [{ email: `${slug(given)}.${slug(family)}${i}@example.com`, label: 'work' }],
      phones: chance(0.7)
        ? [
            {
              number: `+39 3${Math.floor(10 + random() * 89)} ${Math.floor(1000000 + random() * 8999999)}`,
              type: 'mobile',
            },
          ]
        : [],
      addresses: [{ type: 'billing', locality: city, region, country_code: country }],
      lead_source_id: pick(sources).id,
      source_type: pick(['manual', 'form', 'import', 'api'] as const),
      utm: chance(0.4)
        ? {
            source: pick(['google', 'newsletter', 'linkedin']),
            medium: pick(['cpc', 'email', 'social']),
            campaign: 'autumn-2026',
          }
        : {},
      score_value: Math.floor(random() * 100),
      marketable_status: pick([
        'single_opt_in',
        'double_opt_in',
        'unknown',
        'unsubscribed',
      ] as const),
      time_zone: country === 'US' ? 'America/Chicago' : 'Europe/Rome',
      custom_fields: custom,
      tag_ids: contactTags.map(tagId),
    });
    contacts.push(contact.id);
  }

  // ---- notes, tasks, appointments
  let notes = 0;
  let tasks = 0;
  let appointments = 0;
  contacts.forEach((contactId, i) => {
    if (i % 3 === 0) {
      createNote(ctx, {
        contact_id: contactId,
        title: pick(['Discovery call', 'Follow-up', 'Pricing question', 'Onboarding']),
        type: pick(['call', 'meeting', 'note'] as const),
        body: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: pick([
                    'Interested in the automation builder and the broadcast scheduler.',
                    'Asked about migrating their newsletter list and custom fields.',
                    'Wants a demo of the analytics dashboard with revenue attribution.',
                    'Budget approved for next quarter, needs a proposal by Friday.',
                  ]),
                },
              ],
            },
          ],
        },
      });
      notes += 1;
    }
    if (i % 5 === 0) {
      const task = createTask(ctx, {
        title: pick(['Call back', 'Send proposal', 'Share case study', 'Schedule demo']),
        contact_id: contactId,
        due_at: new Date(now + (Math.floor(random() * 20) - 5) * day).toISOString(),
        priority: pick(['low', 'normal', 'high'] as const),
        type: pick(['call', 'email', 'todo'] as const),
      });
      if (chance(0.3)) completeTask(ctx, { id: task.id });
      tasks += 1;
    }
    if (i % 10 === 0) {
      const start = now + Math.floor(random() * 30) * day + 9 * 3_600_000;
      createAppointment(ctx, {
        title: pick(['Demo', 'Quarterly review', 'Kick-off', 'Coffee chat']),
        contact_id: contactId,
        start_at: new Date(start).toISOString(),
        end_at: new Date(start + 45 * 60_000).toISOString(),
        location: pick(['Online', 'Milano office', 'Client site']),
        reminder_minutes: [30],
      });
      appointments += 1;
    }
  });

  // ---- pipeline & opportunities
  const pipeline = createPipeline(ctx, { name: 'Sales', is_default: true });
  let opportunities = 0;
  for (let i = 0; i < 40; i += 1) {
    const contactId = pick(contacts);
    const opp = createOpportunity(ctx, {
      title: `${pick(['Annual plan', 'Team upgrade', 'Onboarding package', 'Custom integration'])} #${i + 1}`,
      pipeline_id: pipeline.id,
      contact_id: contactId,
      value_minor: (5 + Math.floor(random() * 95)) * 10000,
      currency: 'EUR',
      expected_close_date: new Date(now + Math.floor(random() * 90) * day)
        .toISOString()
        .slice(0, 10),
      custom_fields: { campaign: pick(['autumn-2026', 'webinar', 'referral']) },
    });
    const target = pipeline.stages[Math.floor(random() * pipeline.stages.length)];
    if (target !== undefined && target.id !== opp.stage_id) {
      updateOpportunity(ctx, { id: opp.id, data: { stage_id: target.id } });
    }
    opportunities += 1;
  }

  // ---- saved searches
  createSavedSearch(ctx, {
    name: 'VIP customers in Italy',
    query: {
      entity: 'contact',
      filter: {
        type: 'group',
        op: 'and',
        conditions: [
          { type: 'tags', match: 'all', tag_ids: [tagId('VIP'), tagId('Customer')] },
          { type: 'field', field: 'country_code', operator: 'equals', value: 'IT' },
        ],
      },
      columns: ['id', 'given_name', 'family_name', 'email', 'custom.plan', 'tags'],
      sort: { field: 'family_name', direction: 'asc' },
    },
  });
  createSavedSearch(ctx, {
    name: 'Pro/Team plans, not churn risk',
    query: {
      entity: 'contact',
      filter: {
        type: 'group',
        op: 'and',
        conditions: [
          { type: 'field', field: 'custom.plan', operator: 'in', value: ['pro', 'team'] },
          { type: 'tags', match: 'none', tag_ids: [tagId('Churn risk')] },
        ],
      },
      sort: { field: 'custom.lifetime_value', direction: 'desc' },
    },
  });

  return {
    seeded: true,
    contacts: contacts.length,
    companies: companies.length,
    tags: tags.length,
    customFields: fields.length,
    opportunities,
    notes,
    tasks,
    appointments,
  };
}

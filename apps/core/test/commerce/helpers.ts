import { createTestTenant, type TestTenant } from '../crm/helpers';

export const DAY = 86_400_000;

export interface CommerceWorld {
  t: TestTenant;
  contactId: string;
  otherContactId: string;
  course: string;
  mug: string;
  software: string;
  monthly: string;
  yearly: string;
  trialPlan: string;
}

/** A tenant with two contacts, a few products and plans. */
export function commerceWorld(): CommerceWorld {
  const t = createTestTenant();
  const contactId = t.op('contacts.create', {
    given_name: 'Ada',
    family_name: 'Lovelace',
    emails: [{ email: 'ada@example.com' }],
  }).id;
  const otherContactId = t.op('contacts.create', { given_name: 'Grace', family_name: 'Hopper' }).id;
  const course = t.op('products.create', {
    name: 'Analytics Course',
    sku: 'CO-1',
    price_minor: 19_900,
    currency: 'EUR',
    tax_rate_bps: 2200,
  }).id;
  const mug = t.op('products.create', {
    name: 'Mug',
    sku: 'MUG',
    price_minor: 1_250,
    currency: 'EUR',
    tax_rate_bps: 1000,
  }).id;
  const product = t.op('products.create', {
    name: 'CRM Pro',
    sku: 'SW-PRO',
    price_minor: 4_900,
    currency: 'EUR',
    tax_rate_bps: 2200,
    plans: [
      { name: 'Monthly', interval: 'month', price_minor: 4_900 },
      { name: 'Yearly', interval: 'year', price_minor: 49_000 },
      { name: 'Monthly with trial', interval: 'month', price_minor: 4_900, trial_days: 14 },
    ],
  });
  const [monthly, yearly, trialPlan] = product.plans.map((p) => p.id);
  if (monthly === undefined || yearly === undefined || trialPlan === undefined) {
    throw new Error('plans missing');
  }
  return {
    t,
    contactId,
    otherContactId,
    course,
    mug,
    software: product.id,
    monthly,
    yearly,
    trialPlan,
  };
}

/** Outbox events of the given types, in emission order. */
export function eventsOf(
  t: TestTenant,
  ...types: string[]
): Array<{ type: string; payload: Record<string, unknown> }> {
  return t.db
    .all<{ type: string; payload: string }>(`SELECT type, payload FROM crm_outbox ORDER BY id`)
    .map((r) => ({ type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown> }))
    .filter((e) => types.length === 0 || types.includes(e.type));
}

/** Expects an op to fail with the given error code. */
export function failure(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    const shape = (error as { shape?: { code: string; message: string } }).shape;
    if (shape !== undefined) return shape;
    throw error;
  }
  throw new Error('expected the operation to fail');
}

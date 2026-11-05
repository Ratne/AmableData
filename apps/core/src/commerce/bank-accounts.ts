import type { BankAccount, CreateBankAccountInput, UpdateBankAccountInput } from '@amable/api-types';
import type { CrmContext } from '../crm/context';
import { notFound } from '../crm/errors';
import { parseJson, toIso } from '../crm/util';

/**
 * Bank accounts of the workspace (bank transfer payments of checkouts), one
 * `tenant_meta` row holding the list. Checkouts reference an account by id:
 * deleting it only stops those checkouts from offering bank transfer.
 */
export interface StoredBankAccount {
  id: string;
  label: string;
  holder: string;
  iban: string;
  bic: string;
  bank_name: string;
  instructions: string;
  created_at: number;
  updated_at: number;
}

const META_KEY = 'commerce_bank_accounts';

export function readBankAccounts(ctx: Pick<CrmContext, 'db'>): StoredBankAccount[] {
  const row = ctx.db.all<{ value: string }>(`SELECT value FROM tenant_meta WHERE key = ?`, META_KEY)[0];
  const list = parseJson<unknown>(row?.value, []);
  return Array.isArray(list) ? (list as StoredBankAccount[]).filter((a) => typeof a?.id === 'string') : [];
}

export function bankAccountById(ctx: Pick<CrmContext, 'db'>, id: string): StoredBankAccount | null {
  return readBankAccounts(ctx).find((a) => a.id === id) ?? null;
}

function write(ctx: CrmContext, list: StoredBankAccount[]): void {
  ctx.db.run(
    `INSERT INTO tenant_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    META_KEY,
    JSON.stringify(list),
  );
}

function toApi(a: StoredBankAccount): BankAccount {
  return { ...a, created_at: toIso(a.created_at), updated_at: toIso(a.updated_at) };
}

export function listBankAccounts(ctx: CrmContext, _input: Record<string, never> = {}): { data: BankAccount[] } {
  return { data: readBankAccounts(ctx).map(toApi) };
}

export function createBankAccount(ctx: CrmContext, input: CreateBankAccountInput): BankAccount {
  const now = ctx.now();
  const account: StoredBankAccount = {
    id: ctx.newId(),
    label: input.label,
    holder: input.holder,
    iban: input.iban,
    bic: input.bic ?? '',
    bank_name: input.bank_name ?? '',
    instructions: input.instructions ?? '',
    created_at: now,
    updated_at: now,
  };
  write(ctx, [...readBankAccounts(ctx), account]);
  return toApi(account);
}

export function updateBankAccount(ctx: CrmContext, input: { id: string; data: UpdateBankAccountInput }): BankAccount {
  const list = readBankAccounts(ctx);
  const current = list.find((a) => a.id === input.id);
  if (current === undefined) throw notFound('bank account', input.id);
  const d = input.data;
  const next: StoredBankAccount = {
    ...current,
    label: d.label ?? current.label,
    holder: d.holder ?? current.holder,
    iban: d.iban ?? current.iban,
    bic: d.bic ?? current.bic,
    bank_name: d.bank_name ?? current.bank_name,
    instructions: d.instructions ?? current.instructions,
    updated_at: ctx.now(),
  };
  write(
    ctx,
    list.map((a) => (a.id === next.id ? next : a)),
  );
  return toApi(next);
}

export function deleteBankAccount(ctx: CrmContext, input: { id: string }): { id: string; deleted: true } {
  const list = readBankAccounts(ctx);
  if (!list.some((a) => a.id === input.id)) throw notFound('bank account', input.id);
  write(
    ctx,
    list.filter((a) => a.id !== input.id),
  );
  return { id: input.id, deleted: true };
}

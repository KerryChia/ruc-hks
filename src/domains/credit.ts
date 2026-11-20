import { createHash } from 'node:crypto';
import type { Queryable } from '../db';
import { fail } from '../errors';

export type Currency = 'CC' | 'RP';

export async function openAccounts(tx: Queryable, userId: string) {
  await tx.query("insert into credit_account(user_id,currency) values ($1,'CC'),($1,'RP') on conflict do nothing", [userId]);
}

export async function balances(db: Queryable, userId: string): Promise<Record<Currency, number>> {
  const { rows } = await db.query<{ currency: Currency; balance: number }>('select currency,balance from credit_account where user_id=$1', [userId]);
  return { CC: 0, RP: 0, ...Object.fromEntries(rows.map(({ currency, balance }) => [currency, balance])) };
}

export async function history(db: Queryable, userId: string) {
  return (await db.query<{ currency: Currency; delta: number; reason: string; createdAt: Date; balanceAfter: number }>(
    'select currency,delta,reason,balance_after as "balanceAfter",created_at as "createdAt" from ledger_entry where user_id=$1 order by id desc limit 50', [userId])).rows;
}

// Call only inside the transaction that records the associated business event.
export async function post(tx: Queryable, userId: string, currency: Currency, delta: number, reason: string, idemKey: string) {
  if (!Number.isSafeInteger(delta) || delta === 0 || !idemKey) throw new Error('Invalid ledger entry');
  const account = (await tx.query<{ balance: number; last_hash: string }>(
    'select balance,last_hash from credit_account where user_id=$1 and currency=$2 for update', [userId, currency])).rows[0];
  if (!account) fail('ACCOUNT_NOT_FOUND', '未找到账户。');
  const seen = (await tx.query<{ delta: number; reason: string; balance_after: number }>(
    'select delta,reason,balance_after from ledger_entry where user_id=$1 and currency=$2 and idem_key=$3', [userId, currency, idemKey])).rows[0];
  if (seen) {
    if (seen.delta !== delta || seen.reason !== reason) fail('IDEMPOTENCY_CONFLICT', '该流水键已用于不同操作。');
    return seen.balance_after;
  }
  const balance = account.balance + delta;
  if (balance < 0) fail(currency === 'CC' ? 'INSUFFICIENT_CC' : 'INSUFFICIENT_RP', '积分余额不足。');
  const hash = createHash('sha256').update(JSON.stringify([account.last_hash, userId, currency, delta, reason, idemKey, balance])).digest('hex');
  await tx.query('update credit_account set balance=$3,last_hash=$4 where user_id=$1 and currency=$2', [userId, currency, balance, hash]);
  await tx.query('insert into ledger_entry(user_id,currency,delta,reason,idem_key,balance_after,prev_hash,hash) values($1,$2,$3,$4,$5,$6,$7,$8)',
    [userId, currency, delta, reason, idemKey, balance, account.last_hash, hash]);
  return balance;
}

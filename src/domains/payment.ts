import { randomInt, randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db';
import { fail, uuid } from '../errors';
import { post } from './credit';
import { lockUser } from './entitlement';
import { requireReviewer } from './identity';

// This module records only simulated events. It never accepts payment screenshots or settles funds.
type SandboxOrder = { id: string; userId: string; baseCents: number; amountCents: number; status: string; createdAt: Date; expiresAt: Date };
const fields = 'id,user_id as "userId",base_cents as "baseCents",amount_cents as "amountCents",status,created_at as "createdAt",expires_at as "expiresAt"';
const tierCredits = new Map([[1000, 1000], [3000, 3300], [4900, 5700]]);

async function log(tx: Queryable, actorId: string, orderId: string, status: string) {
  await tx.query('insert into sandbox_events(order_id,actor_id,status) values($1,$2,$3)', [orderId, actorId, status]);
}

async function order(tx: Queryable, id: string) {
  const result = (await tx.query<SandboxOrder & { expired: boolean }>(`select ${fields},expires_at<=now() as expired from sandbox_orders where id=$1 for update`, [uuid(id)])).rows[0];
  if (!result) fail('NOT_FOUND', '未找到沙箱订单。');
  return result;
}

export async function createOrder(db: Database, userId: string, baseCents: number) {
  if (!tierCredits.has(baseCents)) fail('TIER_INVALID', '请选择支持的模拟档位。');
  return db.transaction(async tx => {
    await lockUser(tx, userId);
    await tx.query(`with expired as (update sandbox_orders set status='expired' where status='awaiting_payment' and expires_at<=now() returning id,user_id)
      insert into sandbox_events(order_id,actor_id,status) select id,user_id,'expired' from expired`);
    const { cents, pending } = (await tx.query<{ cents: number; pending: number }>(`select
      coalesce(sum(amount_cents) filter(where status in ('awaiting_payment','pending_review','credited')),0)::int as cents,
      count(*) filter(where status in ('awaiting_payment','pending_review'))::int as pending
      from sandbox_orders where user_id=$1 and created_at >= (date_trunc('month',now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai')`, [userId])).rows[0];
    if (pending >= 3 || cents + baseCents + 1 > 20000) fail('SANDBOX_LIMIT', '超过沙箱未结订单或月度额度。');
    const start = randomInt(99);
    const id = randomUUID();
    for (let i = 0; i < 99; i++) {
      const amount = baseCents + (start + i) % 99 + 1;
      if (cents + amount > 20000) continue;
      const item = (await tx.query<SandboxOrder>(`insert into sandbox_orders(id,user_id,base_cents,amount_cents,expires_at)
        values($1,$2,$3,$4,now()+interval '30 minutes') on conflict(amount_cents) where status in ('awaiting_payment','pending_review') do nothing returning ${fields}`,
        [id, userId, baseCents, amount])).rows[0];
      if (item) {
        await log(tx, userId, id, 'awaiting_payment');
        return item;
      }
    }
    return fail('NO_SANDBOX_AMOUNT', '当前没有可用尾数，请稍后重试。');
  });
}

export async function markSimulatedPaid(db: Database, userId: string, id: string) {
  return db.transaction(async tx => {
    const item = await order(tx, id);
    if (item.userId !== userId) fail('NOT_FOUND', '未找到沙箱订单。');
    if (['pending_review', 'credited'].includes(item.status)) return;
    if (item.status !== 'awaiting_payment' || item.expired) fail('ORDER_UNAVAILABLE', '订单已过期或不可提交。');
    await tx.query("update sandbox_orders set status='pending_review' where id=$1", [id]);
    await log(tx, userId, id, 'pending_review');
  });
}

export async function reviewOrder(db: Database, reviewerId: string, id: string, approved: boolean) {
  return db.transaction(async tx => {
    await requireReviewer(tx, reviewerId);
    const item = await order(tx, id);
    if (item.userId === reviewerId) fail('FORBIDDEN', '不能审核自己的沙箱订单。');
    const next = approved ? 'credited' : 'rejected';
    if (item.status === next) return;
    if (item.status !== 'pending_review') fail('ORDER_UNAVAILABLE', '该订单不处于待核验状态。');
    if (approved) {
      await post(tx, item.userId, 'CC', item.baseCents, 'topup', `sandbox:${id}`);
      const bonus = tierCredits.get(item.baseCents)! - item.baseCents;
      if (bonus) await post(tx, item.userId, 'CC', bonus, 'topup_bonus', `sandbox-bonus:${id}`);
      await tx.query('insert into sandbox_book(order_id,amount_cents) values($1,$2)', [id, item.amountCents]);
    }
    await tx.query('update sandbox_orders set status=$2,reviewer_id=$3 where id=$1', [id, next, reviewerId]);
    await log(tx, reviewerId, id, next);
  });
}

export async function listOrders(db: Queryable, userId: string, review = false) {
  if (review) {
    await requireReviewer(db, userId);
    return (await db.query<SandboxOrder>(`select ${fields} from sandbox_orders where status='pending_review' order by created_at limit 50`)).rows;
  }
  return (await db.query<SandboxOrder>(`select ${fields.replace(',status,', ",case when status='awaiting_payment' and expires_at<=now() then 'expired' else status end as status,")}
      from sandbox_orders where user_id=$1 order by created_at desc limit 50`, [userId])).rows;
}

export async function transparency(db: Queryable) {
  return (await db.query<{ creditedCents: number; creditedCount: number; pendingCents: number; pendingCount: number }>(`select
    (select coalesce(sum(amount_cents),0)::int from sandbox_book) as "creditedCents",
    (select count(*)::int from sandbox_book) as "creditedCount",
    coalesce(sum(amount_cents),0)::int as "pendingCents",count(*)::int as "pendingCount" from sandbox_orders where status='pending_review'`)).rows[0];
}

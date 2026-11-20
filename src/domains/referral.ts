import type { Queryable } from '../db';
import { openAccounts, post } from './credit';

// The invitee starts with 30 CC; the inviter earns the same amount only after the
// invitee actually uses the site, so an unused throwaway account pays nothing.
export const INVITE_SIGNUP_CC = 30;
export const INVITE_REWARD_CC = 30;

// Called inside the transaction that records the invitee's first real use (opening a
// live pack, buying a licence, or running an AI review). Idempotent per invitee: the
// ledger key keeps the reward to one payout even when several paths fire at once.
export async function rewardInviter(tx: Queryable, inviteeId: string): Promise<number | null> {
  const inviter = (await tx.query<{ id: string }>(`select u.id
    from invitations i join users u on u.id=i.created_by and u.status='active' and u.role='student'
    where i.used_by=$1 and i.used_at is not null and i.created_by<>$1
    order by i.created_at desc limit 1`, [inviteeId])).rows[0];
  if (!inviter) return null;
  await openAccounts(tx, inviter.id);
  return post(tx, inviter.id, 'CC', INVITE_REWARD_CC, 'invite_reward', `invite-reward:${inviteeId}`);
}

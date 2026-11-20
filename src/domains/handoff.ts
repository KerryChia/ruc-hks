import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db';
import { fail } from '../errors';
import { getPack, questionsForAttempt, searchPacks, type Pack } from './catalog';
import { balances, post } from './credit';
import { licensePrice, lockUser, type License } from './entitlement';
import { startAttemptTx } from './attempt';
import { activePromotion } from './promotion';

// Crockford Base32 without I, L, O and U. Sixteen symbols carry 80 bits, so a code
// cannot be guessed by counting upwards; it is random, opaque and single-pack by design.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 16;
const CODE_TTL = '30 minutes';
// After the pack is opened the code must survive long enough to submit and review.
const OPEN_TTL = '2 hours';

export type HandoffMode = 'pack' | 'catalog';
export type Handoff = {
  id: string; userId: string; mode: HandoffMode; packId: string | null; license: License;
  budgetCc: number; spentCc: number; attemptId: string | null; expiresAt: Date; usedAt: Date | null; revokedAt: Date | null; createdAt: Date;
};
export type CreatedHandoff = {
  id: string; code: string; mode: HandoffMode; packId: string | null; budgetCc: number;
  priceCc: number; expiresAt: Date; packTitle: string | null;
};

const fields = `h.id,h.user_id as "userId",h.mode,h.pack_id as "packId",h.license,h.budget_cc as "budgetCc",
  h.spent_cc as "spentCc",h.attempt_id as "attemptId",h.expires_at as "expiresAt",h.used_at as "usedAt",h.revoked_at as "revokedAt",h.created_at as "createdAt"`;
const digest = (code: string) => createHash('sha256').update(`examhub-handoff:${code}`).digest('hex');

export function normalizeCode(raw: string) {
  const cleaned = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  // Accept both "EH-XXXX-..." and the bare sixteen symbols.
  return cleaned.length === LENGTH + 2 && cleaned.startsWith('EH') ? cleaned.slice(2) : cleaned;
}

export function formatCode(code: string) {
  return `EH-${code.match(/.{1,4}/g)?.join('-') ?? code}`;
}

function randomCode() {
  const bytes = randomBytes(16);
  let out = '', accumulator = 0, bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.slice(0, LENGTH);
}

// What the code is expected to cost right now: zero when the user already holds a licence or
// still has a free opening, otherwise the practice price.
async function expectedCharge(db: Queryable, userId: string, pack: Pack) {
  if (await activePromotion(db)) return 0;
  const licensed = (await db.query<{ id: string }>(`select id from permissions
    where user_id=$1 and pack_id=$2 and license=any($3::text[]) and (expires_at is null or expires_at>now()) limit 1`,
    [userId, pack.id, ['practice', 'collection']])).rows[0];
  if (licensed) return 0;
  if (pack.starterRank) {
    const { count } = (await db.query<{ count: number }>(`select count(*)::int as count from free_opens
      where user_id=$1 and pack_id=$2 and created_at>now()-interval '30 days'`, [userId, pack.id])).rows[0];
    if (count < 2) return 0;
  }
  return licensePrice(pack, 'practice');
}

export async function createHandoff(
  db: Database,
  userId: string,
  input: { mode: 'pack'; packId: string } | { mode: 'catalog'; budgetCc?: number },
): Promise<CreatedHandoff> {
  let pack: Pack | null = null;
  let priceCc = 5;
  let budgetCc: number;
  if (input.mode === 'pack') {
    pack = await getPack(db, input.packId);
    budgetCc = licensePrice(pack, 'practice');
    priceCc = await expectedCharge(db, userId, pack);
    if (priceCc > 0 && (await balances(db, userId)).CC < priceCc) fail('INSUFFICIENT_CC', `这套题需要 ${priceCc} CC，当前余额不足。`);
  } else {
    budgetCc = input.budgetCc ?? 10;
    if (![5, 10, 20].includes(budgetCc)) fail('HANDOFF_BUDGET_INVALID', '口令预算只能选择 5、10 或 20 CC。');
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const id = randomUUID();
    try {
      const row = (await db.query<{ expiresAt: Date }>(`insert into handoff_codes(id,code_hash,user_id,mode,pack_id,license,budget_cc,expires_at)
        values($1,$2,$3,$4,$5,'practice',$6,now()+interval '${CODE_TTL}') returning expires_at as "expiresAt"`,
        [id, digest(code), userId, input.mode, pack?.id ?? null, budgetCc])).rows[0];
      return {
        id, code: formatCode(code), mode: input.mode, packId: pack?.id ?? null,
        budgetCc, priceCc, expiresAt: row.expiresAt,
        packTitle: pack?.title ?? null,
      };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') continue;
      throw error;
    }
  }
  return fail('HANDOFF_CODE_FAILED', '生成口令失败，请重试。');
}

export async function resolveHandoff(db: Queryable, raw: string): Promise<Handoff | null> {
  const code = normalizeCode(raw);
  if (code.length !== LENGTH) return null;
  return (await db.query<Handoff>(`select ${fields} from handoff_codes h join users u on u.id=h.user_id
    where h.code_hash=$1 and h.revoked_at is null and h.expires_at>now() and u.status='active'`, [digest(code)])).rows[0] ?? null;
}

export async function listHandoffs(db: Queryable, userId: string) {
  return (await db.query<Handoff & { packTitle: string | null }>(`select ${fields},p.title as "packTitle" from handoff_codes h
    left join packs p on p.id=h.pack_id where h.user_id=$1 order by h.created_at desc limit 10`, [userId])).rows;
}

export async function revokeHandoffs(db: Queryable, userId: string) {
  await db.query('update handoff_codes set revoked_at=now() where user_id=$1 and revoked_at is null', [userId]);
}

// The browser already expressed the intent to spend by generating the code, so the code
// replaces the quote-approval click. The CC budget and single-pack binding limit the blast
// radius if the pasted text leaks.
async function ensureAccess(tx: Queryable, row: Handoff, pack: Pack) {
  if (await activePromotion(tx)) return 0;
  const licensed = (await tx.query<{ id: string }>(`select id from permissions
    where user_id=$1 and pack_id=$2 and license=any($3::text[]) and (expires_at is null or expires_at>now()) limit 1`,
    [row.userId, pack.id, ['practice', 'collection']])).rows[0];
  if (licensed) return 0;
  const price = licensePrice(pack, row.license);
  if (row.license === 'practice' && pack.starterRank) {
    const { count } = (await tx.query<{ count: number }>(`select count(*)::int as count from free_opens
      where user_id=$1 and pack_id=$2 and created_at>now()-interval '30 days'`, [row.userId, pack.id])).rows[0];
    if (count < 2) return 0;
  }
  if (row.spentCc + price > row.budgetCc) {
    fail('HANDOFF_BUDGET', `这套题需要 ${price} CC，口令剩余预算 ${Math.max(0, row.budgetCc - row.spentCc)} CC。`);
  }
  if (price) await post(tx, row.userId, 'CC', -price, 'agent_handoff', `handoff:${row.id}:${pack.id}`);
  await tx.query(`insert into permissions(id,user_id,pack_id,license,expires_at) values($1,$2,$3,$4,now()+interval '30 days')
    on conflict(user_id,pack_id,license) do update set expires_at=excluded.expires_at`,
    [randomUUID(), row.userId, pack.id, row.license]);
  return price;
}

export async function openResolvedHandoff(db: Database, handoff: Handoff, input: { packId?: string } = {}) {
  return db.transaction(async tx => {
    const row = (await tx.query<Handoff>(`select ${fields} from handoff_codes h where h.id=$1 for update`, [handoff.id])).rows[0];
    if (!row || row.revokedAt) fail('HANDOFF_INVALID', '口令无效或已撤销。');
    if (new Date(row.expiresAt).getTime() <= Date.now()) fail('HANDOFF_EXPIRED', '口令已过期，请重新生成。');
    if (row.attemptId) {
      if (input.packId && row.packId !== input.packId) fail('HANDOFF_USED', '这个口令已经打开过另一套题，请重新生成口令。');
      const questions = await questionsForAttempt(tx, row.packId!);
      const title = (await getPack(tx, row.packId!)).title;
      return { attemptId: row.attemptId, packId: row.packId!, title, chargedCc: 0, reused: true, questions };
    }
    const target = row.mode === 'pack' ? row.packId! : input.packId;
    if (!target) fail('PACK_REQUIRED', '请先选择一套题，再打开。');
    if (row.mode === 'pack' && input.packId && input.packId !== row.packId) {
      fail('HANDOFF_BOUND', '这个口令只对应生成它的那一套题。');
    }
    const pack = await getPack(tx, target);
    await lockUser(tx, row.userId);
    const chargedCc = await ensureAccess(tx, row, pack);
    const attempt = await startAttemptTx(tx, row.userId, pack.id, 'paper');
    await tx.query(`update handoff_codes set attempt_id=$2,used_at=coalesce(used_at,now()),spent_cc=spent_cc+$3,
      pack_id=coalesce(pack_id,$4),expires_at=greatest(expires_at,now()+interval '${OPEN_TTL}') where id=$1`,
      [row.id, attempt.id, chargedCc, pack.id]);
    return { attemptId: attempt.id, packId: pack.id, title: pack.title, chargedCc, reused: false, questions: attempt.questions };
  });
}

export async function openWithHandoff(db: Database, raw: string, input: { packId?: string } = {}) {
  const handoff = await resolveHandoff(db, raw);
  if (!handoff) fail('HANDOFF_INVALID', '口令无效、已撤销或已过期。');
  return openResolvedHandoff(db, handoff, input);
}

// Read the row instead of trusting the object captured when the request started: a code
// can be opened by one tool call and submitted by the next.
export async function assertHandoffAttempt(db: Queryable, handoff: Handoff, attemptId: string) {
  const row = (await db.query<{ attemptId: string | null }>(
    'select attempt_id as "attemptId" from handoff_codes where id=$1 and revoked_at is null', [handoff.id])).rows[0];
  if (!row?.attemptId || row.attemptId !== attemptId) fail('HANDOFF_BOUND', '这个口令只能访问它自己打开的那次作答。');
}

export async function handoffCatalogue(db: Queryable, keyword?: string) {
  return searchPacks(db, keyword ? { keyword } : {});
}

export async function handoffStatus(db: Queryable, handoff: Handoff) {
  const row = (await db.query<Handoff>(`select ${fields} from handoff_codes h where h.id=$1`, [handoff.id])).rows[0] ?? handoff;
  const pack = row.packId ? await getPack(db, row.packId).catch(() => null) : null;
  return {
    mode: row.mode,
    opened: Boolean(row.attemptId),
    pack: pack ? { id: pack.id, title: pack.title, itemCount: pack.itemCount, priceCc: await expectedCharge(db, row.userId, pack) } : null,
    budgetCc: row.budgetCc,
    remainingCc: Math.max(0, row.budgetCc - row.spentCc),
    expiresAt: row.expiresAt,
  };
}

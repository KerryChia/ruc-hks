import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db';
import { fail, uuid } from '../errors';
import { getPack, privateQuestions, questionsForAttempt, type Pack } from './catalog';
import { post } from './credit';
import { activePromotion } from './promotion';
import { rewardInviter } from './referral';

export type License = 'practice' | 'read' | 'collection';
export type Mode = 'paper' | 'collection';
export type Quote = { id: string; packId: string; title: string; license: License; priceCc: number; expiresAt: Date; approvedAt: Date | null; permissionId: string | null; expired: boolean };

export async function lockUser(tx: Queryable, userId: string) {
  const result = await tx.query("select id from users where id=$1 and status='active' for update", [uuid(userId)]);
  if (!result.rows.length) fail('FORBIDDEN', '账号不可用。');
}

async function activePermission(db: Queryable, userId: string, packId: string, licenses: License[]) {
  return (await db.query<{ id: string; expiresAt: Date | null }>(`select id,expires_at as "expiresAt" from permissions
    where user_id=$1 and pack_id=$2 and license=any($3::text[]) and (expires_at is null or expires_at>now()) limit 1`, [userId, packId, licenses])).rows[0];
}

type PaperAccess = {
  pack: Pack; version: number; isFree: boolean; authored: boolean; campaign: boolean; isSample: boolean;
};

export async function paperAccess(tx: Queryable, userId: string, packId: string, mode: Mode): Promise<PaperAccess> {
  const pack = await getPack(tx, packId);
  const internal = (await tx.query<{ authorId: string | null; version: number; isSample: boolean }>('select author_id as "authorId",version,is_sample as "isSample" from packs where id=$1', [packId])).rows[0];
  if (internal.authorId === userId) return { pack, version: internal.version, isFree: false, authored: true, campaign: false, isSample: internal.isSample };
  // Sample packs are the complete free demo: every mode, unlimited opens, no licence.
  if (internal.isSample) return { pack, version: internal.version, isFree: false, authored: false, campaign: false, isSample: true };
  // A running free-all campaign opens every live pack, including collection mode, without
  // consuming a free opening or creating a licence.
  if (await activePromotion(tx)) return { pack, version: internal.version, isFree: false, authored: false, campaign: true, isSample: internal.isSample };
  if (mode === 'collection') {
    if (!await activePermission(tx, userId, packId, ['collection'])) fail('COLLECTION_REQUIRES_LICENSE', '题集模式需要题集许可。');
    return { pack, version: internal.version, isFree: false, authored: false, campaign: false, isSample: internal.isSample };
  }
  if (await activePermission(tx, userId, packId, ['practice', 'collection'])) return { pack, version: internal.version, isFree: false, authored: false, campaign: false, isSample: internal.isSample };
  if (!pack.starterRank) fail('PACK_LOCKED', '这套卷需要练习许可。');
  const { count } = (await tx.query<{ count: number }>(`select count(*)::int as count from free_opens where user_id=$1 and pack_id=$2 and created_at>now()-interval '30 days'`, [userId, packId])).rows[0];
  if (count >= 2) fail('FREE_LIMIT', '近 30 天已打开这套免费卷两次，可以继续未交卷的作答，或解锁练习许可。');
  return { pack, version: internal.version, isFree: true, authored: false, campaign: false, isSample: internal.isSample };
}

// Whether the drill may show explanations the moment a question is graded. Sample
// packs (and promotions/authors/licences) get the full quiz-room experience.
export async function explanationAccess(db: Queryable, userId: string, packId: string) {
  const internal = (await db.query<{ authorId: string | null; isSample: boolean }>('select author_id as "authorId",is_sample as "isSample" from packs where id=$1', [packId])).rows[0];
  if (!internal) fail('NOT_FOUND', '未找到这套题包。');
  if (internal.authorId === userId || internal.isSample) return true;
  if (await activePromotion(db)) return true;
  return Boolean(await activePermission(db, userId, packId, ['practice', 'collection']));
}

const quoteFields = `q.id,q.pack_id as "packId",p.title,q.license,q.price_cc as "priceCc",q.expires_at as "expiresAt",
  q.approved_at as "approvedAt",q.permission_id as "permissionId",q.expires_at<=now() as expired`;

export async function getQuote(db: Queryable, userId: string, id: string): Promise<Quote> {
  const q = (await db.query<Quote>(`select ${quoteFields} from quotes q join packs p on p.id=q.pack_id where q.id=$1 and q.user_id=$2`, [uuid(id), userId])).rows[0];
  if (!q) fail('NOT_FOUND', '未找到这份报价。');
  return q;
}

// Single source of truth for license pricing, shared with Agent handoff codes.
export function licensePrice(pack: { priceCc: number; isSample?: boolean }, license: License) {
  if (pack.isSample) return 0;
  return license === 'practice' ? 5 : license === 'read' ? pack.priceCc : 8;
}

export async function quote(db: Database, userId: string, packId: string, license: License) {
  if (!['practice', 'read', 'collection'].includes(license)) fail('LICENSE_INVALID', '不支持的许可类型。');
  const pack = await getPack(db, packId);
  const price = await activePromotion(db) ? 0 : licensePrice(pack, license);
  const id = randomUUID();
  await db.transaction(async tx => {
    await lockUser(tx, userId);
    const recent = await tx.query('select id from quotes where user_id=$1 and expires_at>now() limit 30', [userId]);
    if (recent.rows.length >= 30) fail('QUOTE_LIMIT', '有效报价过多，请等待已有报价过期。');
    await tx.query(`insert into quotes(id,user_id,pack_id,license,price_cc,expires_at) values($1,$2,$3,$4,$5,now()+interval '10 minutes')`, [id, userId, pack.id, license, price]);
  });
  return getQuote(db, userId, id);
}

// Browser-only: the MCP credential has no route that can call this operation.
export async function approveQuote(db: Queryable, userId: string, id: string) {
  const approved = await db.query('update quotes set approved_at=coalesce(approved_at,now()) where id=$1 and user_id=$2 and (expires_at>now() or permission_id is not null) returning id', [uuid(id), userId]);
  if (!approved.rows.length) fail('QUOTE_EXPIRED', '报价不存在或已过期，请重新获取。');
}

export async function acquire(db: Database, userId: string, id: string) {
  return db.transaction(async tx => {
    await lockUser(tx, userId);
    const q = await getQuote(tx, userId, id);
    if (q.permissionId) return { licenseId: q.permissionId };
    if (q.expired) fail('QUOTE_EXPIRED', '报价已过期，请重新获取。');
    if (!q.approvedAt) fail('CONFIRMATION_REQUIRED', '请先在网页上确认该报价。');
    const pack = await getPack(tx, q.packId);
    const active = await activePermission(tx, userId, q.packId, [q.license]);
    let licenseId = active?.id;
    if (!licenseId) {
      if (q.priceCc) await post(tx, userId, 'CC', -q.priceCc, 'unlock_pack', `quote:${id}`);
      licenseId = (await tx.query<{ id: string }>(`insert into permissions(id,user_id,pack_id,license,expires_at)
        values($1,$2,$3,$4,case when $4='read' then null else now()+interval '30 days' end)
        on conflict(user_id,pack_id,license) do update set expires_at=excluded.expires_at returning id`, [randomUUID(), userId, q.packId, q.license])).rows[0].id;
      // Buying a licence is real use too, so the inviter's reward can land here first.
      if (!pack.isSample) await rewardInviter(tx, userId);
    }
    await tx.query('update quotes set permission_id=$2 where id=$1', [id, licenseId]);
    return { licenseId };
  });
}

export async function getReadContent(db: Queryable, userId: string, packId: string) {
  const pack = await getPack(db, packId);
  if (!await activePromotion(db) && !await activePermission(db, userId, packId, ['read'])) fail('PACK_LOCKED', '请先解锁阅读许可。');
  return { pack, questions: await questionsForAttempt(db, packId) };
}

export async function getRubric(db: Queryable, userId: string, attemptId: string) {
  const entry = (await db.query<{ pack_id: string; version: number; current: number; submitted_at: Date | null; author_id: string | null; isSample: boolean }>(`select a.pack_id,a.version,p.version as current,a.submitted_at,p.author_id,p.is_sample as "isSample"
    from attempts a join packs p on p.id=a.pack_id where a.id=$1 and a.user_id=$2 and p.status='live'`, [uuid(attemptId), userId])).rows[0];
  if (!entry) fail('NOT_FOUND', '未找到对应作答。');
  if (!entry.submitted_at) fail('ATTEMPT_NOT_SUBMITTED', '交卷后才可访问参考答案。');
  if (entry.current !== entry.version) fail('VERSION_MISMATCH', '作答版本已不可用。');
  if (!entry.isSample && entry.author_id !== userId && !await activePromotion(db) && !await activePermission(db, userId, entry.pack_id, ['practice', 'collection'])) {
    fail('RUBRIC_REQUIRES_LICENSE', '参考答案需要练习或题集许可。');
  }
  return privateQuestions(db, entry.pack_id);
}

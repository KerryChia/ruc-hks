import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from '../db';
import { fail, uuid } from '../errors';
import { getCourse, insertQuestions, privateQuestions, questionSchema } from './catalog';
import { balances, post } from './credit';
import { lockUser } from './entitlement';
import { requireReviewer } from './identity';

export const submissionSchema = z.object({
  courseId: z.string().uuid(), title: z.string().trim().min(2).max(100), licenseNote: z.string().trim().min(10).max(500),
  year: z.number().int().min(1980).max(2100).optional(), sourceType: z.enum(['past_exam', 'mock']).optional(),
  questions: z.array(questionSchema).min(1).max(100)
});

type EditablePack = { id: string; title: string; licenseNote: string; status: string; itemCount: number; courseId: string; authorId: string };
const fields = 'p.id,p.title,p.license_note as "licenseNote",p.status,p.item_count as "itemCount",p.course_id as "courseId",p.author_id as "authorId"';

export function parseSubmission(input: unknown) {
  const result = submissionSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    fail('INVALID_SUBMISSION', `套卷格式不符合要求：${issue.path.join('.') || '套卷'}（${issue.message}）。`);
  }
  return result.data;
}

export async function validateSubmission(db: Queryable, input: unknown) {
  const data = parseSubmission(input);
  const course = await getCourse(db, data.courseId);
  if (data.questions.some(q => q.tags.some(tag => !course.tags.includes(tag)))) fail('UNKNOWN_TAG', `知识点必须来自课程词表：${course.tags.join('、')}。`);
  return data;
}

export async function submitPack(db: Database, userId: string, input: unknown) {
  const data = await validateSubmission(db, input);
  const contents = data.questions.map(q => q.stem.normalize('NFKC').replace(/\s+/g, '').toLowerCase());
  if (new Set(contents).size !== contents.length) fail('DUPLICATE_PACK', '同一套卷中有重复题干。');
  const fingerprint = createHash('sha256').update(JSON.stringify(contents.sort())).digest('hex');
  const packId = randomUUID();
  const award = Math.min(800, data.questions.reduce((sum, q) => sum + (q.explanation.length >= 30 ? 5 : 2), 0));
  await db.transaction(async tx => {
    await lockUser(tx, userId);
    const pending = await tx.query("select id from packs where author_id=$1 and status='reviewing' limit 5", [userId]);
    if (pending.rows.length >= 5) fail('SUBMISSION_LIMIT', '待审套卷达到 5 套，请等待审核。');
    await tx.query(`insert into packs(id,course_id,author_id,title,year,source_type,license_note,status,item_count)
      values($1,$2,$3,$4,$5,$6,$7,'reviewing',$8)`, [packId, data.courseId, userId, data.title, data.year ?? new Date().getUTCFullYear(), data.sourceType ?? 'mock', data.licenseNote, data.questions.length]);
    const saved = await tx.query('insert into uploads(pack_id,fingerprint,reward_total) values($1,$2,$3) on conflict(fingerprint) do nothing returning pack_id', [packId, fingerprint, award]);
    if (!saved.rows.length) fail('DUPLICATE_PACK', '该套题目已经提交。');
    await insertQuestions(tx, packId, data.questions);
  });
  return packId;
}

export async function listSubmissions(db: Queryable, reviewerId: string) {
  await requireReviewer(db, reviewerId);
  return (await db.query<EditablePack>(`select ${fields} from packs p join uploads u on u.pack_id=p.id where p.status='reviewing' order by p.created_at,p.id limit 50`)).rows;
}

export async function getSubmission(db: Queryable, reviewerId: string, packId: string) {
  await requireReviewer(db, reviewerId);
  const item = (await db.query<EditablePack>(`select ${fields} from packs p join uploads u on u.pack_id=p.id where p.id=$1`, [uuid(packId)])).rows[0];
  if (!item) fail('NOT_FOUND', '未找到投稿。');
  if (item.authorId === reviewerId) fail('FORBIDDEN', '不能审核自己的投稿。');
  return { ...item, questions: await privateQuestions(db, packId) };
}

async function payReward(tx: Queryable, userId: string, courseId: string, packId: string, desired: number, stage: 'upload_reward' | 'upload_final') {
  const used = (await tx.query<{ monthly: number; course: number; pack: number }>(`select
    coalesce(sum(l.delta) filter(where l.created_at >= (date_trunc('month',now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai')),0)::int as monthly,
    coalesce(sum(l.delta) filter(where p.course_id=$2),0)::int as course,
    coalesce(sum(l.delta) filter(where p.id=$3),0)::int as pack
    from ledger_entry l join packs p on p.id::text=split_part(l.idem_key,':',2)
    where l.user_id=$1 and l.currency='CC' and l.reason in ('upload_reward','upload_final')`, [userId, courseId, packId])).rows[0];
  const award = Math.max(0, Math.min(desired, 800 - used.pack, 1500 - used.course, 3000 - used.monthly));
  if (award) await post(tx, userId, 'CC', award, stage, `${stage}:${packId}`);
  if (award < desired) await post(tx, userId, 'RP', desired - award, 'reward_over_cap', `${stage}-cap:${packId}`);
  return award;
}

export async function publishSubmission(db: Database, reviewerId: string, packId: string, approved: boolean) {
  return db.transaction(async tx => {
    await requireReviewer(tx, reviewerId);
    const item = (await tx.query<EditablePack & { rewardTotal: number }>(`select ${fields},u.reward_total as "rewardTotal" from packs p join uploads u on u.pack_id=p.id where p.id=$1 for update of p,u`, [uuid(packId)])).rows[0];
    if (!item) fail('NOT_FOUND', '未找到投稿。');
    if (item.authorId === reviewerId) fail('FORBIDDEN', '不能审核自己的投稿。');
    const next = approved ? 'live' : 'rejected';
    if (item.status === next) return;
    if (item.status !== 'reviewing') fail('REVIEW_CLOSED', '这份投稿已裁决。');
    let cc = 0;
    if (approved) {
      await lockUser(tx, item.authorId);
      cc = await payReward(tx, item.authorId, item.courseId, packId, Math.floor(item.rewardTotal * 0.7), 'upload_reward');
      await post(tx, item.authorId, 'RP', Math.max(1, Math.floor(item.rewardTotal / 2)), 'upload_reputation', `upload-rp:${packId}`);
    }
    await tx.query('update packs set status=$2 where id=$1', [packId, next]);
    await tx.query("update uploads set reviewer_id=$2,reviewed_at=now(),released_cc=$3,unlocks_at=case when $4 then now()+interval '30 days' end where pack_id=$1",
      [packId, reviewerId, cc, approved]);
  });
}

export async function settleRewards(db: Database) {
  const pending = (await db.query<{ packId: string }>(`select u.pack_id as "packId" from uploads u join packs p on p.id=u.pack_id
    where p.status='live' and u.unlocks_at<=now() and u.settled_at is null order by u.unlocks_at limit 100`)).rows;
  let settled = 0;
  for (const { packId } of pending) {
    settled += await db.transaction(async tx => {
      const item = (await tx.query<EditablePack & { rewardTotal: number }>(`select ${fields},u.reward_total as "rewardTotal" from packs p join uploads u on u.pack_id=p.id
        where p.id=$1 and p.status='live' and u.unlocks_at<=now() and u.settled_at is null for update of p,u`, [packId])).rows[0];
      if (!item) return 0;
      const { users, issues } = (await tx.query<{ users: number; issues: number }>(`select count(*)::int as users, count(*) filter(where r.confirmed)::int as issues
        from (select distinct user_id from attempts where pack_id=$1 and user_id<>$2 and submitted_at is not null) a
        left join issue_reports r on r.pack_id=$1 and r.user_id=a.user_id`, [packId, item.authorId])).rows[0];
      if (users < 20) return 0;
      await lockUser(tx, item.authorId);
      const errorRate = issues / users;
      if (errorRate < .02) {
        await payReward(tx, item.authorId, item.courseId, packId, item.rewardTotal - Math.floor(item.rewardTotal * 0.7), 'upload_final');
      } else if (errorRate >= .05) {
        const amount = Math.min((await balances(tx, item.authorId)).RP, Math.floor(item.rewardTotal / 4));
        if (amount) await post(tx, item.authorId, 'RP', -amount, 'quality_penalty', `upload-penalty:${packId}`);
      }
      await tx.query('update uploads set settled_at=now() where pack_id=$1', [packId]);
      return 1;
    });
  }
  return settled;
}

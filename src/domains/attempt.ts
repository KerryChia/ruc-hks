import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db';
import { fail, uuid } from '../errors';
import { getPack, privateQuestions, questionsForAttempt } from './catalog';
import { gradeFill } from './fill-matcher';
import { getPracticeState } from './practice';
import { lockUser, paperAccess, type Mode } from './entitlement';
import { rewardInviter } from './referral';

export type AttemptResult = {
  id: string; packId: string; title: string; version: number; mode: Mode; status: 'open' | 'submitted';
  correct: number | null; total: number; answers: Record<string, string | string[]> | null;
  isFirst: boolean; score: number | null; startedAt: Date; submittedAt: Date | null;
};

const fields = `a.id,a.pack_id as "packId",p.title,a.version,a.mode,case when a.submitted_at is null then 'open' else 'submitted' end as status,
  a.correct,coalesce(a.total,p.item_count) as total,a.answers,a.is_first as "isFirst",a.score::float8 as score,a.started_at as "startedAt",a.submitted_at as "submittedAt"`;

async function ownedAttempt(db: Queryable, userId: string, id: string) {
  const result = (await db.query<AttemptResult & { currentVersion: number; ranked: boolean }>(`select ${fields}, p.version as "currentVersion",a.ranked
    from attempts a join packs p on p.id=a.pack_id where a.id=$1 and a.user_id=$2 and p.status='live'`, [uuid(id), userId])).rows[0];
  if (!result) fail('NOT_FOUND', '未找到对应作答。');
  if (result.version !== result.currentVersion) fail('VERSION_MISMATCH', '作答版本已不可用。');
  const { currentVersion: _version, ranked, ...entry } = result;
  return { entry, ranked };
}

// Transaction-aware so callers that must charge before opening (Agent handoff) can
// run licence purchase, free-opening accounting and attempt creation atomically.
export async function startAttemptTx(tx: Queryable, userId: string, packId: string, mode: Mode = 'paper') {
  if (mode !== 'paper' && mode !== 'collection') fail('MODE_INVALID', '练习模式无效。');
  await lockUser(tx, userId);
  const { pack, version, isFree, authored, isSample } = await paperAccess(tx, userId, packId, mode);
  const { count } = (await tx.query<{ count: number }>(`select coalesce(sum(p.item_count),0)::int as count
    from attempts a join packs p on p.id=a.pack_id where a.user_id=$1 and a.started_at>now()-interval '1 day'`, [userId])).rows[0];
  // The daily cap protects paid openings; the free sample course is exempt.
  if (!isSample && count + pack.itemCount > 300) fail('DAILY_QUESTION_LIMIT', '已达到每日 300 题的打开上限。');
  const id = randomUUID();
  await tx.query('insert into attempts(id,user_id,pack_id,version,mode,ranked) values($1,$2,$3,$4,$5,$6)',
    [id, userId, packId, version, mode, !authored && mode === 'paper']);
  if (isFree) await tx.query('insert into free_opens(attempt_id,user_id,pack_id) values($1,$2,$3)', [id, userId, packId]);
  // Opening a live pack is the invitee's first real use, so this is where the inviter
  // earns the reward. The free demo pack is excluded: a bare demo click farms nothing.
  if (!isSample) await rewardInviter(tx, userId);
  return { id, packId, title: pack.title, questions: await questionsForAttempt(tx, packId) };
}

export async function startAttempt(db: Database, userId: string, packId: string, mode: Mode = 'paper') {
  return db.transaction(tx => startAttemptTx(tx, userId, packId, mode));
}

export async function getAttempt(db: Queryable, userId: string, id: string) {
  const { entry } = await ownedAttempt(db, userId, id);
  return { ...entry, questions: await questionsForAttempt(db, entry.packId) };
}

export async function recentAttempts(db: Queryable, userId: string) {
  return (await db.query<AttemptResult>(`select ${fields} from attempts a join packs p on p.id=a.pack_id
    where a.user_id=$1 and p.status='live' order by a.started_at desc limit 20`, [userId])).rows;
}

// Graded drill answers already live in practice_records; submission snapshots them
// into the attempt so score, leaderboards and AI review keep working unchanged.
// Accuracy counts objective questions only; subjective ones count toward completion
// once drafted or marked mastered.
export async function submitFromRecords(db: Database, userId: string, id: string) {
  return db.transaction(async tx => {
    await lockUser(tx, userId);
    const { entry, ranked } = await ownedAttempt(tx, userId, id);
    if (entry.submittedAt) return entry;
    const questions = await privateQuestions(tx, entry.packId);
    const records = await getPracticeState(tx, userId, entry.packId);
    const objective = questions.filter(q => q.qtype !== 'subjective');
    const answers: Record<string, string | string[]> = {};
    let objCorrect = 0;
    let completed = 0;
    for (const q of questions) {
      const rec = records[q.id];
      if (!rec) continue;
      if (q.qtype === 'subjective') {
        const text = (rec.draft[0] ?? '').trim();
        if (text) answers[q.id] = rec.draft[0];
        if (rec.mastered || text) completed += 1;
        continue;
      }
      if (!rec.result) continue;
      answers[q.id] = q.qtype === 'fill' ? rec.draft.slice(0, q.fields.length) : rec.result.choice ?? '';
      if (rec.result.correct) objCorrect += 1;
      completed += 1;
    }
    const objTotal = objective.length;
    const total = questions.length;
    const answered = Object.keys(answers).length;
    const timing = (await tx.query<{ elapsed: number; median: number | null; count: number }>(`select
      extract(epoch from (clock_timestamp()-(select started_at from attempts where id=$2)))::float8 as elapsed,
      percentile_cont(0.5) within group (order by extract(epoch from submitted_at-started_at)::float8) as median,
      count(*)::int as count from attempts where pack_id=$1 and is_first and submitted_at is not null`, [entry.packId, id])).rows[0];
    const baseline = timing.count >= 5 && timing.median && timing.median > 0 ? timing.median : total * 108;
    const speed = objCorrect && timing.elapsed >= answered * 2 ? Math.min(25, Math.max(0, (1 - timing.elapsed / baseline) * 25)) : 0;
    const score = Math.round((60 * objCorrect / Math.max(1, objTotal) + speed + 15 * completed / Math.max(1, total)) * 100) / 100;
    const isFirst = ranked && !(await tx.query('select id from attempts where user_id=$1 and pack_id=$2 and is_first limit 1', [userId, entry.packId])).rows.length;
    await tx.query(`update attempts set submitted_at=clock_timestamp(),answers=$2,correct=$3,total=$4,score=$5,is_first=$6 where id=$1`,
      [id, JSON.stringify(answers), objCorrect, objTotal, score, isFirst]);
    return (await ownedAttempt(tx, userId, id)).entry;
  });
}

// MCP path: the client posts its own answer map. Types are validated per question;
// objective correctness is recomputed server-side.
export async function submitAttempt(db: Database, userId: string, id: string, answers: Record<string, string | string[]>) {
  return db.transaction(async tx => {
    await lockUser(tx, userId);
    const { entry, ranked } = await ownedAttempt(tx, userId, id);
    if (entry.submittedAt) return entry;
    const questions = await privateQuestions(tx, entry.packId);
    const values = Object.entries(answers);
    const byId = new Map(questions.map(q => [q.id, q]));
    for (const [key, value] of values) {
      const q = byId.get(key);
      if (!q) fail('INVALID_ANSWER', '答案含有无效题号。');
      if (q.qtype === 'choice' || q.qtype === 'judge') {
        if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) >= q.options.length) fail('INVALID_ANSWER', '答案含有无效题号或选项。');
      } else if (q.qtype === 'fill') {
        if (!Array.isArray(value) || value.length !== q.fields.length || value.some(part => typeof part !== 'string' || part.length > 500)) fail('INVALID_ANSWER', '填空答案数量或长度无效。');
      } else if (typeof value !== 'string' || value.length > 2000) {
        fail('INVALID_ANSWER', '主观题作答过长。');
      }
    }
    const objective = questions.filter(q => q.qtype !== 'subjective');
    const correct = objective.filter(q => Object.hasOwn(answers, q.id) &&
      (q.qtype === 'fill' ? gradeFill(q.fields, answers[q.id] as string[]).every(Boolean) : answers[q.id] === q.answer)).length;
    const isFirst = ranked && !(await tx.query('select id from attempts where user_id=$1 and pack_id=$2 and is_first limit 1', [userId, entry.packId])).rows.length;
    const timing = (await tx.query<{ elapsed: number; median: number | null; count: number }>(`select
      extract(epoch from (clock_timestamp()-(select started_at from attempts where id=$2)))::float8 as elapsed,
      percentile_cont(0.5) within group (order by extract(epoch from submitted_at-started_at)::float8) as median,
      count(*)::int as count from attempts where pack_id=$1 and is_first and submitted_at is not null`, [entry.packId, id])).rows[0];
    const objTotal = objective.length;
    const total = questions.length;
    const baseline = timing.count >= 5 && timing.median && timing.median > 0 ? timing.median : total * 108;
    const speed = correct && timing.elapsed >= values.length * 2 ? Math.min(25, Math.max(0, (1 - timing.elapsed / baseline) * 25)) : 0;
    const score = Math.round((60 * correct / Math.max(1, objTotal) + speed + 15 * values.length / Math.max(1, total)) * 100) / 100;
    await tx.query(`update attempts set submitted_at=clock_timestamp(),answers=$2,correct=$3,total=$4,score=$5,is_first=$6 where id=$1`,
      [id, JSON.stringify(answers), correct, objTotal, score, isFirst]);
    return (await ownedAttempt(tx, userId, id)).entry;
  });
}

type BoardRow = { displayName: string; correct: number; total: number; score: number };
export async function leaderboard(db: Queryable, packId: string, kind: 'honor' | 'skilled') {
  if (kind !== 'honor' && kind !== 'skilled') fail('BOARD_INVALID', '不支持的榜单类型。');
  await getPack(db, packId);
  const labeled = `select a.*,u.display_name, row_number() over(partition by a.user_id order by a.submitted_at desc,a.id) as recent
     from attempts a join users u on u.id=a.user_id where a.pack_id=$1 and a.submitted_at is not null and a.ranked and u.status='active'`;
  const best = `select *,row_number() over(partition by user_id order by score desc,correct desc,submitted_at,id) as place from history
    where ${kind === 'honor' ? 'is_first' : 'recent<=3'}`;
  return (await db.query<BoardRow>(`with history as (${labeled}), best as (${best})
    select display_name as "displayName",correct,total,score::float8 as score from best where place=1 order by score desc,correct desc,submitted_at,id limit 50`, [packId])).rows;
}

import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db';
import { fail } from '../errors';
import { getAttempt } from './attempt';
import { privateQuestions, type PrivateQuestion } from './catalog';
import { post } from './credit';
import { lockUser } from './entitlement';
import { aiEnabled, chat } from './ai/provider';
import { rewardInviter } from './referral';

export type Usage = { costCc: number; feedback: string; inputTokens: number; outputTokens: number; free: boolean };
const fields = 'cost_cc as "costCc",feedback,input_tokens as "inputTokens",output_tokens as "outputTokens",free';
const MAX_OUTPUT = 1200;

function poolSize() {
  const configured = Number(process.env.FREE_TOKEN_POOL ?? 1_000_000_000);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 1_000_000_000;
}

// Tokens served from the site's free allowance. Only rows flagged free count against it
// (attempt reviews in ai_usage, per-question assistant chats in ai_asks).
export async function freeTokenStats(db: Queryable) {
  const { used } = (await db.query<{ used: number }>(
    `select coalesce(sum(t.total),0)::int as used from (
      select coalesce(sum(input_tokens+output_tokens),0) as total from ai_usage where free
      union all
      select coalesce(sum(input_tokens+output_tokens),0) as total from ai_asks where free
    ) t`)).rows[0];
  const total = poolSize();
  return { total, used, remaining: Math.max(0, total - used) };
}

const systemPrompt = [
  '你是一名校园课程的讲评助教。只依据给出的题目、学生选择、正确答案与解析作答，用简体中文。',
  '输出分三段：逐题点评、知识点小结、下一步建议。',
  '逐题点评要说明对错、错因和正确思路；知识点小结只覆盖本套题出现的知识点；下一步建议给两条具体可执行的动作。',
  '全文控制在 500 字以内，不要使用 Markdown 标题，不要提及模型、服务商或平台的技术细节。',
].join('');

function letter(index: number) {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : `选项 ${index + 1}`;
}

function buildPrompt(title: string, rows: PrivateQuestion[], answers: Record<string, string | string[]>) {
  const body = rows.map((question, index) => {
    const picked = answers[question.id];
    const lines = [`第 ${index + 1} 题：${question.stem}`];
    if (question.qtype === 'choice' || question.qtype === 'judge') {
      const pickedIndex = picked === undefined || Array.isArray(picked) ? -1 : Number(picked);
      const chosen = pickedIndex >= 0 && question.options[pickedIndex] !== undefined
        ? `${letter(pickedIndex)}. ${question.options[pickedIndex]}` : '未作答';
      const correctIndex = Number(question.answer);
      const correct = question.options[correctIndex] !== undefined ? `${letter(correctIndex)}. ${question.options[correctIndex]}` : question.answer;
      if (question.options.length) lines.push(`选项：${question.options.map((option, i) => `${letter(i)}. ${option}`).join(' / ')}`);
      lines.push(`学生选择：${chosen}`, `正确答案：${correct}`);
    } else if (question.qtype === 'fill') {
      const values = Array.isArray(picked) ? picked : [];
      lines.push(`学生作答：${values.length ? values.map((value, i) => `第${i + 1}空：${value}`).join('；') : '未作答'}`);
      lines.push(`正确答案：${question.fields.map((field, i) => `第${i + 1}空：${field.displayAnswer}`).join('；')}`);
    } else {
      lines.push(`学生作答：${typeof picked === 'string' && picked.trim() ? picked.slice(0, 500) : '未作答'}`, '正确答案：见解析中的参考答案与评分点');
    }
    lines.push(`解析：${question.explanation}`);
    return lines.join('\n');
  }).join('\n\n');
  return { system: systemPrompt, user: `练习：《${title}》，共 ${rows.length} 题。\n\n${body}` };
}

export async function grade(db: Database, userId: string, id: string): Promise<Usage> {
  if (!aiEnabled()) fail('AI_DISABLED', '讲评服务尚未启用。');
  const runId = randomUUID();
  const plan = await db.transaction(async tx => {
    await lockUser(tx, userId);
    const attempt = await getAttempt(tx, userId, id);
    if (attempt.correct === null || attempt.status !== 'submitted') fail('ATTEMPT_NOT_SUBMITTED', '先交卷，再获取讲评。');
    const existing = (await tx.query<Usage>(`select ${fields} from ai_usage where attempt_id=$1 and user_id=$2`, [id, userId])).rows[0];
    if (existing) {
      if (!existing.feedback) fail('AI_BUSY', '这次练习的讲评正在生成，请稍后刷新。');
      return { existing: true as const, usage: existing };
    }
    const limit = Number(process.env.AI_DAILY_LIMIT ?? 20);
    const { count } = (await tx.query<{ count: number }>(`select count(*)::int as count from ai_usage
      where user_id=$1 and created_at >= (date_trunc('day',now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai')`, [userId])).rows[0];
    if (count >= (Number.isFinite(limit) ? limit : 20)) fail('AI_DAILY_LIMIT', '今日讲评次数已达上限，请明天再来。');
    const questions = await privateQuestions(tx, attempt.packId);
    const prompt = buildPrompt(attempt.title, questions, attempt.answers ?? {});
    const estimate = Math.ceil((prompt.system.length + prompt.user.length) / 1.2) + 200;
    const price = (await tx.query<{ version: number; input_weight: number; output_weight: number; divisor: number }>(
      'select * from ai_prices order by version desc limit 1')).rows[0];
    const cc = (input: number, output: number) => Math.ceil((price.input_weight * input + price.output_weight * output) / price.divisor);
    const stats = await freeTokenStats(tx);
    const free = stats.remaining > 0 && stats.remaining >= estimate;
    const reserved = free ? 0 : cc(estimate, MAX_OUTPUT);
    if (reserved) await post(tx, userId, 'CC', -reserved, 'ai_reserve', `ai:reserve:${id}:${runId}`);
    await tx.query(`insert into ai_usage(attempt_id,user_id,price_version,input_tokens,output_tokens,cost_cc,feedback,free,model)
      values($1,$2,$3,0,0,0,'',false,null)`, [id, userId, price.version]);
    return { existing: false as const, reserved, free, cc, prompt };
  });
  if (plan.existing) return plan.usage;

  try {
    const result = await chat({ system: plan.prompt.system, user: plan.prompt.user, maxTokens: MAX_OUTPUT });
    const costCc = plan.free ? 0 : Math.min(plan.reserved, plan.cc(result.inputTokens, result.outputTokens));
    await db.transaction(async tx => {
      await lockUser(tx, userId);
      if (plan.reserved) {
        await post(tx, userId, 'CC', plan.reserved, 'ai_release', `ai:release:${id}:${runId}`);
        if (costCc) await post(tx, userId, 'CC', -costCc, 'ai_charge', `ai:charge:${id}:${runId}`);
      }
      await tx.query(`update ai_usage set input_tokens=$2,output_tokens=$3,cost_cc=$4,feedback=$5,free=$6,model=$7
        where attempt_id=$1 and user_id=$8`,
        [id, result.inputTokens, result.outputTokens, costCc, result.text, plan.free, result.model, userId]);
      // A delivered AI review is real use as well, whether it drew on the free pool or CC.
      await rewardInviter(tx, userId);
    });
    return { costCc, feedback: result.text, inputTokens: result.inputTokens, outputTokens: result.outputTokens, free: plan.free };
  } catch (error) {
    await db.transaction(async tx => {
      await lockUser(tx, userId);
      if (plan.reserved) await post(tx, userId, 'CC', plan.reserved, 'ai_release', `ai:release:${id}:${runId}`);
      await tx.query("delete from ai_usage where attempt_id=$1 and feedback=''", [id]);
    }).catch(() => undefined);
    throw error;
  }
}

export async function getUsage(db: Queryable, userId: string, id: string) {
  return (await db.query<Usage>(`select ${fields} from ai_usage where attempt_id=$1 and user_id=$2`, [id, userId])).rows[0] ?? null;
}

export async function usageCount(db: Queryable, userId: string) {
  return (await db.query<{ count: number }>('select count(*)::int as count from ai_usage where user_id=$1', [userId])).rows[0].count;
}

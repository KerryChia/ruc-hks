import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db';
import { fail, uuid } from '../errors';
import { freeTokenStats } from './ai-gateway';
import { privateQuestionById, type PrivateQuestion } from './catalog';
import { post } from './credit';
import { explanationAccess, lockUser } from './entitlement';

// Per-question assistant: the reference quiz room attaches the question, the
// learner's answer and (when visible) the explanation to every chat. ExamHub
// keeps its answer-protection model — the explanation only rides along for
// viewers who may see it, and the prompt forbids guessing when it does not.
export type AskMessage = { role: 'user' | 'assistant'; content: string };

const MAX_ASK_CHARS = 1000;
const MAX_HISTORY = 8;
const HISTORY_CHAR_CAP = 2000;
const MAX_OUTPUT = 1200;

export function sanitizeHistory(input: unknown): AskMessage[] {
  if (!Array.isArray(input)) return [];
  const out: AskMessage[] = [];
  for (const raw of input.slice(-MAX_HISTORY)) {
    if (!raw || typeof raw !== 'object') continue;
    const role = (raw as { role?: unknown }).role;
    const content = (raw as { content?: unknown }).content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      out.push({ role, content: content.slice(0, HISTORY_CHAR_CAP) });
    }
  }
  return out;
}

export const systemPrompt = [
  '你是这一道题的 AI 助教。只依据给出的题目、学生的作答与解析来讲解，用简体中文。',
  '先讲思路与方法，引导学生自己想通；学生明确要答案时再给。',
  '可以使用 Markdown（加粗、列表、代码块），公式沿用题面写法。',
  '解析未提供时不要编造答案，只讲方法与概念。',
  '不要提及模型、服务商或平台的技术细节。',
].join('');

type DrillRecordRow = { result: { choice?: string; fields?: boolean[]; correct: boolean } | null; draft: string[] };

type AskPlan = {
  askId: number; runId: string; free: boolean; reserved: number;
  cc: (inputTokens: number, outputTokens: number) => number;
  question: PrivateQuestion; showExplanation: boolean; history: AskMessage[]; text: string;
  record: DrillRecordRow | null;
};

export async function prepareAsk(db: Database, userId: string, attemptId: string, questionId: string, text: string, history: AskMessage[]): Promise<AskPlan> {
  if (!text.trim() || text.length > MAX_ASK_CHARS) fail('ASK_TEXT_INVALID', '请输入 1–1000 字的提问。');
  return db.transaction(async tx => {
    const attempt = (await tx.query<{ packId: string }>(`select a.pack_id as "packId" from attempts a join packs p on p.id=a.pack_id
      where a.id=$1 and a.user_id=$2 and p.status='live' and a.version=p.version`, [uuid(attemptId), userId])).rows[0];
    if (!attempt) fail('NOT_FOUND', '未找到对应的练习，请从练习页提问。');
    const question = await privateQuestionById(tx, attempt.packId, questionId);
    const showExplanation = await explanationAccess(tx, userId, attempt.packId);
    const record = (await tx.query<DrillRecordRow>(
      'select result,draft from practice_records where user_id=$1 and pack_id=$2 and question_id=$3', [userId, attempt.packId, questionId])).rows[0] ?? null;
    const limit = Number(process.env.AI_ASK_DAILY_LIMIT ?? 50);
    const { count } = (await tx.query<{ count: number }>(`select count(*)::int as count from ai_asks where user_id=$1
      and created_at >= (date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai')`, [userId])).rows[0];
    if (count >= (Number.isFinite(limit) ? limit : 50)) fail('ASK_DAILY_LIMIT', '今日提问次数已达上限，请明天再来，或先用解析复盘。');
    const price = (await tx.query<{ version: number; input_weight: number; output_weight: number; divisor: number }>(
      'select * from ai_prices order by version desc limit 1')).rows[0];
    const runId = randomUUID();
    const contextChars = question.stem.length + question.body.length + question.explanation.length + text.length
      + history.reduce((sum, message) => sum + message.content.length, 0);
    const estimate = Math.ceil(contextChars / 1.2) + 300;
    const cc = (inputTokens: number, outputTokens: number) => Math.ceil((price.input_weight * inputTokens + price.output_weight * outputTokens) / price.divisor);
    const stats = await freeTokenStats(tx);
    const free = stats.remaining > 0 && stats.remaining >= estimate;
    const reserved = free ? 0 : cc(estimate, MAX_OUTPUT);
    if (reserved) await post(tx, userId, 'CC', -reserved, 'ai_reserve', `ai:ask:reserve:${runId}`);
    const inserted = await tx.query<{ id: number }>(
      'insert into ai_asks(user_id,attempt_id,question_id) values($1,$2,$3) returning id', [userId, uuid(attemptId), questionId]);
    return {
      askId: inserted.rows[0].id, runId, free, reserved, cc, question, showExplanation,
      history: sanitizeHistory(history), text: text.trim(),
      record: record ? { result: record.result, draft: record.draft ?? [] } : null,
    };
  });
}

function answerSummary(plan: AskPlan) {
  const rec = plan.record;
  const q = plan.question;
  if (!rec || q.qtype === 'subjective') {
    const draft = rec?.draft?.[0];
    return draft ? `（主观作答草稿）${draft.slice(0, 500)}` : '未作答';
  }
  if (!rec.result) {
    const draft = (rec.draft ?? []).filter(Boolean).join('；');
    return draft ? `（未提交的草稿）${draft.slice(0, 500)}` : '未作答';
  }
  if (q.qtype === 'fill') {
    return `已提交：${(rec.draft ?? []).join('；') || '空'}（逐空${rec.result.fields?.map(valid => valid ? '对' : '错').join('/') ?? ''}）`;
  }
  const index = Number(rec.result.choice ?? -1);
  const picked = index >= 0 && q.options[index] !== undefined ? `${String.fromCharCode(65 + index)}. ${q.options[index]}` : '未作答';
  return `已选择：${picked}（${rec.result.correct ? '答对' : '答错'}）`;
}

// The message sent to the model: question surface + the learner's answer + the
// explanation only when this viewer may see it.
export function buildAskUser(plan: AskPlan) {
  const q = plan.question;
  const lines = [`【题目】${q.stem}`];
  if (q.body) lines.push(q.body);
  if (q.qtype === 'choice' || q.qtype === 'judge') {
    lines.push(`【选项】${q.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option}`).join('　')}`);
  } else if (q.qtype === 'fill') {
    lines.push(`【填空】${q.fields.map((field, index) => `第${index + 1}空 ${field.label}`).join('；')}`);
  } else {
    lines.push('【题型】主观题（解析中含参考答案与评分点）');
  }
  lines.push(`【我的作答】${answerSummary(plan)}`);
  if (plan.showExplanation) lines.push(`【解析】${q.explanation}`);
  else lines.push('【解析】未开放。不要猜测或编造答案，只讲方法、概念与排查思路。');
  lines.push(`【学生提问】${plan.text}`);
  return lines.join('\n');
}

export async function finishAsk(db: Database, userId: string, plan: AskPlan, usage: { inputTokens: number; outputTokens: number }) {
  await db.transaction(async tx => {
    await lockUser(tx, userId);
    const costCc = plan.free ? 0 : Math.min(plan.reserved, plan.cc(usage.inputTokens, usage.outputTokens));
    if (plan.reserved) {
      await post(tx, userId, 'CC', plan.reserved, 'ai_release', `ai:ask:release:${plan.runId}`);
      if (costCc) await post(tx, userId, 'CC', -costCc, 'ai_charge', `ai:ask:charge:${plan.runId}`);
    }
    await tx.query('update ai_asks set input_tokens=$2,output_tokens=$3,cost_cc=$4,free=$5 where id=$1 and user_id=$6',
      [plan.askId, usage.inputTokens, usage.outputTokens, costCc, plan.free, userId]);
  });
}

// Stream failed before settling: release the reservation and drop the placeholder row.
export async function abortAsk(db: Database, userId: string, plan: AskPlan) {
  await db.transaction(async tx => {
    await lockUser(tx, userId);
    if (plan.reserved) await post(tx, userId, 'CC', plan.reserved, 'ai_release', `ai:ask:release:${plan.runId}`);
    await tx.query('delete from ai_asks where id=$1 and user_id=$2', [plan.askId, userId]);
  }).catch(() => undefined);
}

export async function askUsageCount(db: Queryable, userId: string) {
  return (await db.query<{ count: number }>('select count(*)::int as count from ai_asks where user_id=$1', [userId])).rows[0].count;
}

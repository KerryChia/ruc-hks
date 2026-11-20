import type { Database, Queryable } from '../db';
import { fail, uuid } from '../errors';
import { privateQuestionById, privateQuestions, type PrivateQuestion, type QuestionKind } from './catalog';
import { gradeFill } from './fill-matcher';
import { explanationAccess } from './entitlement';

// Drill records mirror the standalone quiz room: one record per user × pack ×
// question, persisted server-side so progress, wrong-book and favourites survive
// re-entry on any device. Grading happens on the server; answers and explanations
// only cross the wire for a user who may see them.
export type DrillResult = { choice?: string; fields?: boolean[]; correct: boolean };
export type PracticeRecord = { result: DrillResult | null; draft: string[]; starred: boolean; mastered: boolean; everWrong: boolean; tries: number };
export type GradePayload = { kind: 'choice'; choice: string } | { kind: 'fill'; values: string[] };
export type GradeOutcome = {
  result: DrillResult;
  // Answer identity and explanation are withheld unless the viewer may see them.
  correctChoice?: string;
  explanation?: string;
  displayAnswers?: string[];
};

export async function getPracticeState(db: Queryable, userId: string, packId: string) {
  const { rows } = await db.query<{ questionId: string } & PracticeRecord>(
    'select question_id as "questionId",result,draft,starred,mastered,ever_wrong as "everWrong",tries from practice_records where user_id=$1 and pack_id=$2', [userId, packId]);
  const records: Record<string, PracticeRecord> = {};
  for (const row of rows) {
    records[row.questionId] = { result: row.result, draft: row.draft ?? [], starred: row.starred, mastered: row.mastered, everWrong: row.everWrong, tries: row.tries };
  }
  return records;
}

// Every drill mutation runs inside the open attempt that granted access.
async function openAttempt(tx: Queryable, userId: string, attemptId: string) {
  const row = (await tx.query<{ packId: string }>(`select a.pack_id as "packId" from attempts a join packs p on p.id=a.pack_id
    where a.id=$1 and a.user_id=$2 and p.status='live' and a.submitted_at is null and a.version=p.version`, [uuid(attemptId), userId])).rows[0];
  if (!row) fail('NOT_FOUND', '未找到可作答的练习，或本次练习已交卷。');
  return row;
}

async function readRecord(tx: Queryable, userId: string, packId: string, questionId: string): Promise<PracticeRecord> {
  const row = (await tx.query<{ result: DrillResult | null; draft: string[]; starred: boolean; mastered: boolean; everWrong: boolean; tries: number }>(
    'select result,draft,starred,mastered,ever_wrong as "everWrong",tries from practice_records where user_id=$1 and pack_id=$2 and question_id=$3',
    [userId, packId, questionId])).rows[0];
  return row ?? { result: null, draft: [], starred: false, mastered: false, everWrong: false, tries: 0 };
}

async function upsertRecord(tx: Queryable, userId: string, packId: string, questionId: string, record: PracticeRecord) {
  await tx.query(`insert into practice_records(user_id,pack_id,question_id,result,draft,starred,mastered,ever_wrong,tries,updated_at)
    values($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,now())
    on conflict (user_id,pack_id,question_id) do update set result=excluded.result,draft=excluded.draft,starred=excluded.starred,
      mastered=excluded.mastered,ever_wrong=excluded.ever_wrong,tries=excluded.tries,updated_at=now()`,
    [userId, packId, questionId, record.result ? JSON.stringify(record.result) : null, JSON.stringify(record.draft), record.starred, record.mastered, record.everWrong, record.tries]);
}

export async function gradeRecord(db: Database, userId: string, attemptId: string, questionId: string, payload: GradePayload): Promise<GradeOutcome> {
  return db.transaction(async tx => {
    const attempt = await openAttempt(tx, userId, attemptId);
    const question = await privateQuestionById(tx, attempt.packId, questionId);
    if (question.qtype === 'subjective') fail('INVALID_ANSWER', '主观题没有自动判分。');
    const existing = await readRecord(tx, userId, attempt.packId, questionId);
    let result: DrillResult;
    let draft = existing.draft;
    if (question.qtype === 'choice' || question.qtype === 'judge') {
      if (payload.kind !== 'choice' || !/^\d+$/.test(payload.choice) || Number(payload.choice) >= question.options.length) fail('INVALID_ANSWER', '答案选项无效。');
      const choice = String(Number(payload.choice));
      result = { choice, correct: choice === question.answer };
    } else {
      if (payload.kind !== 'fill' || payload.values.length !== question.fields.length) fail('INVALID_ANSWER', '填空数量与题目不符。');
      if (payload.values.some(value => typeof value !== 'string' || value.length > 500)) fail('INVALID_ANSWER', '填空内容过长。');
      const fields = gradeFill(question.fields, payload.values);
      result = { fields, correct: fields.every(Boolean) };
      draft = [...payload.values];
    }
    const record: PracticeRecord = { result, draft, starred: existing.starred, mastered: existing.mastered, everWrong: existing.everWrong || !result.correct, tries: existing.tries + 1 };
    await upsertRecord(tx, userId, attempt.packId, questionId, record);
    const show = await explanationAccess(tx, userId, attempt.packId);
    return {
      result,
      correctChoice: show && (question.qtype === 'choice' || question.qtype === 'judge') ? question.answer : undefined,
      explanation: show ? question.explanation : undefined,
      displayAnswers: show && question.qtype === 'fill' ? question.fields.map(field => field.displayAnswer) : undefined,
    };
  });
}

// 重新作答：清掉结果保留草稿（填空修改重做），错题标记持续保留。
export async function retryRecord(db: Database, userId: string, attemptId: string, questionId: string) {
  return db.transaction(async tx => {
    const attempt = await openAttempt(tx, userId, attemptId);
    const existing = await readRecord(tx, userId, attempt.packId, questionId);
    const record: PracticeRecord = { ...existing, result: null };
    await upsertRecord(tx, userId, attempt.packId, questionId, record);
    return record;
  });
}

export async function setStar(db: Database, userId: string, attemptId: string, questionId: string, starred: boolean) {
  return db.transaction(async tx => {
    const attempt = await openAttempt(tx, userId, attemptId);
    const record = { ...(await readRecord(tx, userId, attempt.packId, questionId)), starred };
    await upsertRecord(tx, userId, attempt.packId, questionId, record);
    return record;
  });
}

export async function setMastered(db: Database, userId: string, attemptId: string, questionId: string, mastered: boolean) {
  return db.transaction(async tx => {
    const attempt = await openAttempt(tx, userId, attemptId);
    const question = (await tx.query<{ qtype: string }>('select qtype from questions where id=$1 and pack_id=$2', [uuid(questionId), attempt.packId])).rows[0];
    if (!question || question.qtype !== 'subjective') fail('INVALID_ANSWER', '只有主观题可以标记掌握。');
    const record = { ...(await readRecord(tx, userId, attempt.packId, questionId)), mastered };
    await upsertRecord(tx, userId, attempt.packId, questionId, record);
    return record;
  });
}

// Debounced autosave of what the learner typed; never overwrites a graded result.
export async function saveDraft(db: Database, userId: string, attemptId: string, questionId: string, draft: string[]) {
  return db.transaction(async tx => {
    const attempt = await openAttempt(tx, userId, attemptId);
    if (draft.length > 8 || draft.some(value => typeof value !== 'string' || value.length > 500)) fail('INVALID_ANSWER', '草稿内容过长。');
    const existing = await readRecord(tx, userId, attempt.packId, questionId);
    if (existing.result) return existing;
    const record: PracticeRecord = { ...existing, draft };
    await upsertRecord(tx, userId, attempt.packId, questionId, record);
    return record;
  });
}

export async function clearPackRecords(db: Database, userId: string, attemptId: string) {
  return db.transaction(async tx => {
    const attempt = await openAttempt(tx, userId, attemptId);
    await tx.query('delete from practice_records where user_id=$1 and pack_id=$2', [userId, attempt.packId]);
    return { cleared: true };
  });
}

// Page-load snapshot: what this viewer may already see for graded questions —
// explanations, the correct choice, and per-blank reference answers.
export type RevealedAnswer = { explanation: string; correctChoice?: string; displayAnswers?: string[] };
export async function revealedForRecords(db: Queryable, userId: string, packId: string, records: Record<string, PracticeRecord>) {
  const show = await explanationAccess(db, userId, packId);
  if (!show) return { show: false, revealed: {} as Record<string, RevealedAnswer> };
  const questions = await privateQuestions(db, packId);
  const revealed: Record<string, RevealedAnswer> = {};
  for (const q of questions) {
    const rec = records[q.id];
    if (q.qtype === 'subjective') revealed[q.id] = { explanation: q.explanation };
    else if (rec?.result) {
      revealed[q.id] = {
        explanation: q.explanation,
        ...(q.qtype !== 'fill' ? { correctChoice: q.answer } : {}),
        ...(q.qtype === 'fill' ? { displayAnswers: q.fields.map(field => field.displayAnswer) } : {}),
      };
    }
  }
  return { show: true, revealed };
}

// Post-submission review rows: correctness is recomputed server-side from the
// answer snapshot and the private question data (fill answers run the matcher).
export type ReviewRow = {
  id: string; seq: number; ref: string | null; qtype: QuestionKind; stem: string; body: string;
  state: 'correct' | 'wrong' | 'subjective';
  yourAnswer: string | string[] | null;
  correctAnswer: string | null;   // choice/judge option index
  correctText?: string;           // display text of the reference answer
  fieldResults?: boolean[];
  explanation: string; tags: string[];
};

export function buildReviewRows(questions: readonly PrivateQuestion[], answers: Record<string, string | string[]>): ReviewRow[] {
  return questions.map(q => {
    const answer = answers[q.id];
    const base = { id: q.id, seq: q.seq, ref: q.ref, qtype: q.qtype, stem: q.stem, body: q.body, explanation: q.explanation, tags: [...q.tags] };
    if (q.qtype === 'subjective') {
      return { ...base, state: 'subjective' as const, yourAnswer: typeof answer === 'string' ? answer : null, correctAnswer: null };
    }
    if (q.qtype === 'fill') {
      const values = Array.isArray(answer) ? answer : null;
      const fieldResults = values ? gradeFill(q.fields, values) : null;
      const correct = Boolean(fieldResults && fieldResults.every(Boolean));
      return { ...base, state: (correct ? 'correct' : 'wrong') as 'correct' | 'wrong', yourAnswer: values,
        correctAnswer: null, correctText: q.fields.map(field => field.displayAnswer).join(' / '), fieldResults: fieldResults ?? undefined };
    }
    const correct = answer === q.answer;
    return { ...base, state: (correct ? 'correct' : 'wrong') as 'correct' | 'wrong', yourAnswer: typeof answer === 'string' ? answer : null,
      correctAnswer: q.answer, correctText: q.options[Number(q.answer)] };
  });
}

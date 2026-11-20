import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { closeDb, createDatabase, type Database } from '../src/db';
import { seed } from '../src/domains/catalog';
import { startAttempt } from '../src/domains/attempt';
import { issueInvite, register } from '../src/domains/identity';
import { post } from '../src/domains/credit';
import { freeTokenStats } from '../src/domains/ai-gateway';
import { abortAsk, askUsageCount, buildAskUser, finishAsk, prepareAsk, sanitizeHistory } from '../src/domains/ai-ask';

// Embedded PGlite only (like the other non-core suites): the release runner points
// core.test.ts at a shared empty scratch database and this file must not race it.
let db: Database;
let pg: PGlite | undefined;
let student: string;
let attemptId: string;
let packId: string;
const password = 'a-local-test-password';
const code = '246810';

async function firstQuestion() {
  return (await db.query<{ id: string }>('select id from questions where pack_id=$1 order by seq limit 1', [packId])).rows[0].id;
}

before(async () => {
  process.env.ANSWER_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.EMAIL_CODE_SECRET = 'ai-ask-test-secret-32-chars-minimum';
  const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  pg = new PGlite();
  await pg.exec(sql);
  db = createDatabase(pg);
  await seed(db);
  const email = 'asker@ruc.edu.cn';
  const invite = await issueInvite(db, email);
  const digest = createHmac('sha256', process.env.EMAIL_CODE_SECRET).update(`${email}:${code}`).digest('hex');
  await db.query('insert into email_codes(email,digest,issued_at,expires_at) values($1,$2,now(),now()+interval \'10 minutes\')', [email, digest]);
  student = (await register(db, { email, password, invite, code, campus: 'tongzhou' })).id;
  packId = (await db.query<{ id: string }>('select id from packs where starter_rank=1 order by id limit 1')).rows[0].id;
  attemptId = (await startAttempt(db, student, packId, 'paper')).id;
});
after(async () => { if (pg) await pg.close(); await closeDb(); });

test('sanitizeHistory caps roles, message count and characters', () => {
  assert.deepEqual(
    sanitizeHistory([{ role: 'user', content: '你好' }, { role: 'system', content: 'hack' }, 'junk', { role: 'assistant', content: 'x'.repeat(3000) }]),
    [{ role: 'user', content: '你好' }, { role: 'assistant', content: 'x'.repeat(2000) }]);
  assert.deepEqual(sanitizeHistory('nope'), []);
});

test('prepareAsk binds to an owned attempt and withholds the explanation without entitlement', async () => {
  const questionId = await firstQuestion();
  const plan = await prepareAsk(db, student, attemptId, questionId, '这道题怎么入手？', [{ role: 'user', content: '之前的问题' }]);
  assert.ok(plan.question.stem.length > 0);
  assert.equal(plan.showExplanation, false);
  const prompt = buildAskUser(plan);
  assert.match(prompt, /【解析】未开放/);
  assert.match(prompt, /【我的作答】未作答/);
  assert.match(prompt, /【学生提问】这道题怎么入手？/);
  await abortAsk(db, student, plan);
  assert.equal((await db.query('select * from ai_asks where id=$1', [plan.askId])).rows.length, 0);
  await assert.rejects(prepareAsk(db, student, '00000000-0000-4000-8000-000000000009', questionId, '别人的作答', []), { code: 'NOT_FOUND' });
});

test('entitled viewers get the explanation in context, and finishing the ask records free-pool usage', async () => {
  await db.query('update packs set author_id=$2 where id=$1', [packId, student]);
  const questionId = await firstQuestion();
  const plan = await prepareAsk(db, student, attemptId, questionId, '解释一下？', []);
  assert.equal(plan.showExplanation, true);
  assert.match(buildAskUser(plan), /【解析】/);
  assert.equal(plan.free, true);
  assert.equal(plan.reserved, 0);
  await finishAsk(db, student, plan, { inputTokens: 500, outputTokens: 200 });
  const row = (await db.query<{ inputTokens: number; outputTokens: number; free: boolean; costCc: number }>(
    'select input_tokens as "inputTokens",output_tokens as "outputTokens",free,cost_cc as "costCc" from ai_asks where id=$1', [plan.askId])).rows[0];
  assert.deepEqual(row, { inputTokens: 500, outputTokens: 200, free: true, costCc: 0 });
  assert.equal((await freeTokenStats(db)).used, 700);
});

test('exhausted free pool charges CC through reserve/charge and abort releases it', async () => {
  const balanceBefore = (await db.query<{ balance: number }>("select balance from credit_account where user_id=$1 and currency='CC'", [student])).rows[0].balance;
  await db.query(`insert into ai_usage(attempt_id,user_id,price_version,input_tokens,output_tokens,cost_cc,feedback,free)
    values($1,$2,1,1000000000,0,0,'',true)`, [attemptId, student]);
  assert.equal((await freeTokenStats(db)).remaining, 0);
  const questionId = await firstQuestion();
  const plan = await prepareAsk(db, student, attemptId, questionId, 'CC 计费路径', []);
  assert.equal(plan.free, false);
  assert.ok(plan.reserved > 0);
  const during = (await db.query<{ balance: number }>("select balance from credit_account where user_id=$1 and currency='CC'", [student])).rows[0].balance;
  assert.equal(during, balanceBefore - plan.reserved);
  await abortAsk(db, student, plan);
  const after = (await db.query<{ balance: number }>("select balance from credit_account where user_id=$1 and currency='CC'", [student])).rows[0].balance;
  assert.equal(after, balanceBefore);
});

test('daily limit blocks further asks for the same day', async () => {
  const questionId = await firstQuestion();
  await db.query(`insert into ai_asks(user_id,attempt_id,question_id,created_at)
    select $1,$2,$3,now() from generate_series(1,50)`, [student, attemptId, questionId]);
  await assert.rejects(prepareAsk(db, student, attemptId, questionId, '超限了吗', []), { code: 'ASK_DAILY_LIMIT' });
  assert.equal(await askUsageCount(db, student), 51);
});

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeDb, createDatabase, getDb, type Database } from '../src/db';
import { createInvite, createSession, issueInvite, listInvites, login, register, resolveSession } from '../src/domains/identity';
import { seed, type SeedResult } from '../src/domains/catalog';
import { acquire, approveQuote, getRubric, quote } from '../src/domains/entitlement';
import { getAttempt, leaderboard, startAttempt, submitAttempt } from '../src/domains/attempt';
import { balances, post } from '../src/domains/credit';
import { createOrder, markSimulatedPaid, reviewOrder, transparency } from '../src/domains/payment';
import { freeTokenStats, grade, usageCount } from '../src/domains/ai-gateway';
import { publishSubmission, submitPack, settleRewards } from '../src/domains/review';
import { createMcp } from '../src/mcp/server';
import { createHandoffMcp } from '../src/mcp/handoff-server';
import { createHandoff, openWithHandoff, resolveHandoff } from '../src/domains/handoff';
import { startPromotion, stopPromotion } from '../src/domains/promotion';

let db: Database;
let pg: PGlite | undefined;
let sample: SeedResult;
let student: string;
let reviewer: string;
let attemptId: string;
const password = 'a-local-test-password';
const paid = () => sample.packIds[3];

const codeSecret = 'local-test-email-code-secret-32-chars-minimum';
async function emailCode(email: string) {
  const code = '246810';
  const digest = createHmac('sha256', codeSecret).update(`${email}:${code}`).digest('hex');
  await db.query(`insert into email_codes(email,digest,issued_at,expires_at,failures,daily_issued)
    values($1,$2,now(),now()+interval '10 minutes',0,1)
    on conflict(email) do update set digest=excluded.digest,expires_at=excluded.expires_at,failures=0`, [email, digest]);
  return code;
}
async function account(prefix: string) {
  const email = `${prefix}@ruc.edu.cn`;
  const invite = await issueInvite(db, email);
  return register(db, { email, password, invite, code: await emailCode(email), campus: 'tongzhou' });
}

before(async () => {
  process.env.ANSWER_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.EMAIL_CODE_SECRET = codeSecret;
  const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const native = process.env.EXAMHUB_TEST_DATABASE_URL;
  if (native) {
    process.env.DATABASE_URL = native;
    db = getDb();
    const { name, existing } = (await db.query<{ name: string; existing: string | null }>(
      "select current_database() as name,to_regclass('users')::text as existing")).rows[0];
    assert.match(name, /^examhub_test_[a-z0-9]+$/);
    assert.equal(existing, null, 'Integration tests require an empty database');
    await db.transaction(async tx => { await tx.query(sql); });
  } else {
    pg = new PGlite();
    await pg.exec(sql);
    db = createDatabase(pg);
  }
  sample = await seed(db);
  reviewer = (await account('reviewer')).id;
  await db.query("update users set role = 'reviewer' where id = $1", [reviewer]);
});
after(async () => { if (pg) await pg.close(); await closeDb(); });

test('email verification is mandatory, while legacy email-bound invites remain single use', async () => {
  const email = 'student@ruc.edu.cn';
  const invite = await issueInvite(db, email);
  await assert.rejects(register(db, { email, password, invite, code: '' }), { code: 'CODE_INVALID' });
  await assert.rejects(register(db, { email: 'wrong@ruc.edu.cn', password, invite, code: await emailCode('wrong@ruc.edu.cn') }), { code: 'INVITE_INVALID' });
  await assert.rejects(register(db, { email: 'student@example.org', password, invite, code: '246810' }), { code: 'EMAIL_DOMAIN_NOT_ALLOWED' });
  student = (await register(db, { email, password, invite, code: await emailCode(email), campus: 'suzhou' })).id;
  await assert.rejects(register(db, { email, password, invite, code: await emailCode(email) }), { code: 'INVITE_INVALID' });
  const session = await login(db, email, password);
  assert.equal((await resolveSession(db, session))?.id, student);
  assert.equal((await balances(db, student)).CC, 30);
  await assert.rejects(login(db, email, 'invalid'), { code: 'INVALID_LOGIN' });
});

test('registration works without an invite, and generated invite links are single use', async () => {
  const noInvite = 'no-invite@ruc.edu.cn';
  const noInviteId = (await register(db, { email: noInvite, password, code: await emailCode(noInvite) })).id;
  assert.equal((await balances(db, noInviteId)).CC, 0);
  // Registration signs the new account in immediately instead of bouncing to the login page.
  assert.equal((await resolveSession(db, await createSession(db, noInviteId)))?.id, noInviteId);

  const invite = await createInvite(db, reviewer);
  const invited = 'invited@ruc.edu.cn';
  await register(db, { email: invited, password, invite, code: await emailCode(invited) });
  const history = await listInvites(db, reviewer);
  assert.equal(history.length, 1);
  assert.ok(history[0].usedAt);
  assert.equal(history[0].usedBy?.startsWith('同学 '), true);

  const second = 'second@ruc.edu.cn';
  await assert.rejects(register(db, { email: second, password, invite, code: await emailCode(second) }), { code: 'INVITE_INVALID' });
});

test('the inviter is paid only after the invitee actually opens a pack, and only once', async () => {
  const referrer = (await account('referrer')).id;
  const baseline = (await balances(db, referrer)).CC;
  const invite = await createInvite(db, referrer);
  const email = 'referral@ruc.edu.cn';
  const invitee = (await register(db, { email, password, invite, code: await emailCode(email) })).id;
  assert.equal((await balances(db, invitee)).CC, 30, 'the invitee still starts with 30 CC');
  assert.equal((await balances(db, referrer)).CC, baseline, 'signing up alone pays the inviter nothing');

  await startAttempt(db, invitee, sample.packIds[0]);
  assert.equal((await balances(db, referrer)).CC, baseline + 30, 'the inviter is paid on the first opening');
  await startAttempt(db, invitee, sample.packIds[0]);
  const rewards = await db.query<{ count: number }>("select count(*)::int as count from ledger_entry where user_id=$1 and reason='invite_reward'", [referrer]);
  assert.equal(rewards.rows[0].count, 1, 'the reward is posted once per invitee');
  assert.equal((await balances(db, referrer)).CC, baseline + 30);

  // Staff invitations record the relationship but never pay a staff account.
  const staffInvite = await createInvite(db, reviewer);
  const staffEmail = 'staff-invited@ruc.edu.cn';
  const staffInvitee = (await register(db, { email: staffEmail, password, invite: staffInvite, code: await emailCode(staffEmail) })).id;
  const staffBefore = (await balances(db, reviewer)).CC;
  await startAttempt(db, staffInvitee, sample.packIds[0]);
  assert.equal((await balances(db, reviewer)).CC, staffBefore);
});

test('third free open in 30 days is denied, and the fourth pack is locked', async () => {
  const two = await Promise.all([startAttempt(db, student, sample.packIds[0]), startAttempt(db, student, sample.packIds[0])]);
  assert.notEqual(two[0].id, two[1].id);
  assert.equal(two[0].questions.length > 0, true);
  assert.equal(Object.hasOwn(two[0].questions[0], 'answer'), false);
  assert.equal(Object.hasOwn(two[0].questions[0], 'explanation'), false);
  await assert.rejects(startAttempt(db, student, sample.packIds[0]), { code: 'FREE_LIMIT' });
  await assert.rejects(startAttempt(db, student, paid()), { code: 'PACK_LOCKED' });
  await assert.rejects(startAttempt(db, student, sample.packIds[0], 'collection'), { code: 'COLLECTION_REQUIRES_LICENSE' });
});

test('binding quotes to a browser approval prevents agent spending and duplicate debit', async () => {
  const q = await quote(db, student, paid(), 'practice');
  await assert.rejects(acquire(db, student, q.id), { code: 'CONFIRMATION_REQUIRED' });
  await approveQuote(db, student, q.id);
  const [a, b] = await Promise.all([acquire(db, student, q.id), acquire(db, student, q.id)]);
  assert.equal(a.licenseId, b.licenseId);
  assert.equal((await balances(db, student)).CC, 25);
});

test('grade on the server, accept only one first submission, and unlock rubric only after submission', async () => {
  const [a, b] = await Promise.all([startAttempt(db, student, paid()), startAttempt(db, student, paid())]);
  attemptId = a.id;
  await assert.rejects(getRubric(db, student, a.id), { code: 'ATTEMPT_NOT_SUBMITTED' });
  const answer = '1'; // First question of the first paid synthetic pack.
  const [r1, r2] = await Promise.all([
    submitAttempt(db, student, a.id, { [a.questions[0].id]: answer }),
    submitAttempt(db, student, b.id, {})
  ]);
  assert.equal(+r1.isFirst + +r2.isFirst, 1);
  assert.equal(r1.correct, 1);
  assert.equal(r2.correct, 0);
  assert.equal((await getRubric(db, student, a.id))[0].answer, answer);
  assert.equal((await leaderboard(db, paid(), 'honor')).length, 1);
  assert.equal((await getAttempt(db, student, a.id)).status, 'submitted');
  assert.equal(await usageCount(db, student), 0);
});

test('pending sandbox orders do not count; repeated approval credits once', async () => {
  const a = await createOrder(db, student, 1000);
  const b = await createOrder(db, reviewer, 1000);
  assert.notEqual(a.amountCents, b.amountCents);
  await markSimulatedPaid(db, student, a.id);
  assert.equal((await transparency(db)).creditedCents, 0);
  assert.equal((await transparency(db)).pendingCount, 1);
  await assert.rejects(reviewOrder(db, student, a.id, true), { code: 'FORBIDDEN' });
  await Promise.all([reviewOrder(db, reviewer, a.id, true), reviewOrder(db, reviewer, a.id, true)]);
  assert.equal((await transparency(db)).creditedCents, a.amountCents);
  assert.equal((await balances(db, student)).CC, 1025);
});

test('AI review calls the provider once, records real usage, and draws on the free pool', async () => {
  const seen: { model?: string } = {};
  const stub = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.on('end', () => {
      seen.model = (JSON.parse(body) as { model?: string }).model;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        model: 'gpt-6-luna',
        choices: [{ message: { content: '逐题点评：第 1 题答对，第 2 题错在忽略边界。知识点小结：栈与树的边。下一步建议：隔天重做并复述定义。' } }],
        usage: { prompt_tokens: 320, completion_tokens: 90 },
      }));
    });
  });
  await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve));
  const { port } = stub.address() as AddressInfo;
  process.env.AI_API_BASE = `http://127.0.0.1:${port}/v1`;
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_MODEL = 'gpt-6-luna';
  process.env.FREE_TOKEN_POOL = '100000';
  try {
    const before = (await balances(db, student)).CC;
    const first = await grade(db, student, attemptId);
    const second = await grade(db, student, attemptId);
    assert.equal(seen.model, 'gpt-6-luna');
    assert.equal(first.free, true);
    assert.equal(first.costCc, 0);
    assert.match(first.feedback, /逐题点评/);
    assert.equal(first.inputTokens, 320);
    assert.equal(first.outputTokens, 90);
    assert.deepEqual(first, second);
    assert.equal((await balances(db, student)).CC, before);
    assert.equal(await usageCount(db, student), 1);
    const stats = await freeTokenStats(db);
    assert.equal(stats.used, 410);
    assert.equal(stats.total, 100000);
    assert.equal(stats.remaining, 99590);

    // Exhausting the allowance moves the next review onto the CC ledger.
    process.env.FREE_TOKEN_POOL = '1';
    const extra = await startAttempt(db, student, paid());
    await submitAttempt(db, student, extra.id, {});
    const charged = await grade(db, student, extra.id);
    assert.equal(charged.free, false);
    assert.ok(charged.costCc > 0);
    assert.equal((await balances(db, student)).CC, before - charged.costCc);
  } finally {
    process.env.FREE_TOKEN_POOL = '100000';
    await new Promise<void>(resolve => stub.close(() => resolve()));
  }
});

test('publication awards once, and the quality gate defers the balance', async () => {
  const before = await balances(db, student);
  const packId = await submitPack(db, student, {
    courseId: sample.courseIds[0], title: '结构练习', licenseNote: '作者原创并授权作为校内学习练习使用。',
    questions: [{ stem: '栈先入后出吗？', options: ['是', '否'], answer: '0', explanation: '栈支持后进先出。', tags: ['线性结构'] }]
  });
  await assert.rejects(publishSubmission(db, student, packId, true), { code: 'FORBIDDEN' });
  await Promise.all([publishSubmission(db, reviewer, packId, true), publishSubmission(db, reviewer, packId, true)]);
  assert.ok((await balances(db, student)).CC > before.CC);
  assert.equal(await settleRewards(db), 0);
});

test('ledger prohibits overspend and rejects a conflicting idempotency key', async () => {
  const before = (await balances(db, student)).CC;
  await assert.rejects(db.transaction(tx => post(tx, student, 'CC', -before - 1, 'test', 'overdraw')), { code: 'INSUFFICIENT_CC' });
  await db.transaction(tx => post(tx, student, 'CC', 2, 'test', 'counter'));
  await assert.rejects(db.transaction(tx => post(tx, student, 'CC', 3, 'test', 'counter')), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('MCP SDK client completes BYO flow without creating AI usage', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcp(db, student, ['packs:read', 'packs:acquire', 'attempts:write', 'attempts:read']);
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const call = async (name: string, args: object) => {
    const result = await client.callTool({ name, arguments: { ...args } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools.map(t => t.name);
    assert.ok(!tools.includes('ai_grade'));
    const before = await usageCount(db, student);
    assert.ok((await call('search_packs', { keyword: '综合' })).length > 0);
    const packId = sample.packIds[4];
    const q = await call('quote_pack', { packId, license: 'practice' });
    await approveQuote(db, student, q.id);
    await call('acquire_pack', { quoteId: q.id, confirm: true });
    const attempt = await call('get_pack_content', { packId });
    await call('submit_attempt', { attemptId: attempt.id, answers: {}, selfGraded: 100 });
    const result = await call('get_result', { attemptId: attempt.id });
    assert.equal(result.correct, 0);
    assert.ok((await call('get_grading_rubric', { attemptId: attempt.id })).length > 0);
    assert.equal(await usageCount(db, student), before);
  } finally {
    await client.close();
    await server.close();
  }
});

test('a handoff code opens only its bound pack, charges once, and expires', async () => {
  const agent = (await account('agent-handoff')).id;
  const packId = sample.packIds[9];
  const created = await createHandoff(db, agent, { mode: 'pack', packId });
  assert.match(created.code, /^EH(-[0-9A-Z]{4}){4}$/);
  assert.equal(created.packId, packId);
  assert.equal(created.budgetCc, 5);
  const before = (await balances(db, agent)).CC;
  const opened = await openWithHandoff(db, created.code);
  assert.equal(opened.chargedCc, 5);
  assert.equal((await balances(db, agent)).CC, before - 5);
  assert.ok(opened.questions.length > 0);
  assert.equal(Object.hasOwn(opened.questions[0], 'answer'), false);
  const again = await openWithHandoff(db, created.code);
  assert.equal(again.attemptId, opened.attemptId);
  assert.equal(again.chargedCc, 0);
  assert.equal((await balances(db, agent)).CC, before - 5);
  await assert.rejects(openWithHandoff(db, created.code, { packId: sample.packIds[10] }), { code: 'HANDOFF_USED' });
  await assert.rejects(createHandoff(db, agent, { mode: 'catalog', budgetCc: 7 }), { code: 'HANDOFF_BUDGET_INVALID' });

  const expired = await createHandoff(db, agent, { mode: 'catalog', budgetCc: 10 });
  await db.query("update handoff_codes set expires_at=now()-interval '1 minute' where id=$1", [expired.id]);
  assert.equal(await resolveHandoff(db, expired.code), null);
  await assert.rejects(openWithHandoff(db, expired.code), { code: 'HANDOFF_INVALID' });
});

test('handoff MCP server exposes a narrow toolset and binds every attempt call', async () => {
  const agent = (await account('agent-mcp')).id;
  const created = await createHandoff(db, agent, { mode: 'catalog', budgetCc: 10 });
  const handoff = await resolveHandoff(db, created.code);
  assert.ok(handoff);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createHandoffMcp(db, handoff);
  const client = new Client({ name: 'handoff-test', version: '1.0.0' });
  const call = async (name: string, args: object = {}) => {
    const result = await client.callTool({ name, arguments: { ...args } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools.map(t => t.name).sort();
    assert.deepEqual(tools, ['get_balances', 'get_grading_rubric', 'get_result', 'handoff_status', 'list_packs', 'open_pack', 'submit_attempt']);
    const status = await call('handoff_status');
    assert.equal(status.opened, false);
    assert.equal(status.remainingCc, 10);
    assert.ok((await call('list_packs', { keyword: '数据结构' })).length > 0);
    const opened = await call('open_pack', { packId: sample.packIds[9] });
    assert.equal(opened.chargedCc, 5);
    const submitted = await call('submit_attempt', { attemptId: opened.attemptId, answers: {} });
    assert.equal(submitted.status, 'submitted');
    assert.ok((await call('get_grading_rubric', { attemptId: opened.attemptId })).length > 0);

    const foreign = await client.callTool({ name: 'get_result', arguments: { attemptId } });
    assert.equal(foreign.isError, true);
    assert.match((foreign.content as { text: string }[])[0].text, /HANDOFF_BOUND/);
    const browse = await client.callTool({ name: 'list_packs', arguments: {} });
    assert.equal(browse.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test('a free-all campaign opens paid packs without charging or consuming free openings', async () => {
  const camper = (await account('campaign')).id;
  const before = (await balances(db, camper)).CC;
  const promotion = await startPromotion(db, 1);
  assert.ok(new Date(promotion.endsAt).getTime() > Date.now());

  const attempt = await startAttempt(db, camper, paid());
  assert.ok(attempt.questions.length > 0);
  assert.equal((await balances(db, camper)).CC, before);
  const { count } = (await db.query<{ count: number }>('select count(*)::int as count from free_opens where user_id=$1', [camper])).rows[0];
  assert.equal(count, 0);

  await submitAttempt(db, camper, attempt.id, {});
  assert.ok((await getRubric(db, camper, attempt.id)).length > 0);
  assert.equal((await quote(db, camper, sample.packIds[4], 'practice')).priceCc, 0);
  assert.ok((await startAttempt(db, camper, sample.packIds[5], 'collection')).id);

  await stopPromotion(db);
  await assert.rejects(startAttempt(db, camper, sample.packIds[9]), { code: 'PACK_LOCKED' });
});

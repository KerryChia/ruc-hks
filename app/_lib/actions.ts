'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '../../src/db';
import { campuses, createInvite, createMcpToken, createSession, login, logout, register, revokeMcpTokens, sendVerificationCode } from '../../src/domains/identity';
import { startAttempt, submitFromRecords } from '../../src/domains/attempt';
import { acquire, approveQuote, quote } from '../../src/domains/entitlement';
import { createHandoff, revokeHandoffs } from '../../src/domains/handoff';
import { grade } from '../../src/domains/ai-gateway';
import { publishSubmission, submitPack } from '../../src/domains/review';
import { createOrder, markSimulatedPaid, reviewOrder } from '../../src/domains/payment';
import { clearPackRecords, gradeRecord, retryRecord, saveDraft, setMastered, setStar, type GradePayload } from '../../src/domains/practice';
import { SESSION_COOKIE, buildHandoffMessage, readScopes, segment, sessionCookie } from './presentation';
import { WebError, approvalFrom, campusEmailFrom, centsFrom, formText, identifier, licenseFrom, passwordFrom, requireTermsAgreement, uploadFrom } from './validation';
import { actionUser, aiEnabled, publicProblem, sandboxEnabled, sessionToken, type FormState } from './web';

async function run(work: () => Promise<FormState | string>): Promise<FormState> {
  let outcome: FormState | string;
  try { outcome = await work(); }
  catch (error) { return { error: publicProblem(error) }; }
  if (typeof outcome === 'string') redirect(outcome);
  return outcome;
}

async function setSession(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, sessionCookie(process.env.SECURE_COOKIES));
}

export async function loginAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    const email = campusEmailFrom(data);
    const password = passwordFrom(data);
    await setSession(await login(await getDb(), email, password));
    return '/';
  });
}

export async function registerAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    const email = campusEmailFrom(data);
    const password = passwordFrom(data);
    const invite = formText(data, 'invite').trim();
    const code = formText(data, 'code').trim();
    const campus = formText(data, 'campus');
    requireTermsAgreement(data);
    if (!/^\d{6}$/.test(code)) throw new WebError('CODE_INVALID', '请输入 6 位邮箱验证码。');
    if (invite.length > 256) throw new WebError('INVITE_INVALID', '邀请码格式不正确。');
    if (campus && !campuses.some(value => value === campus)) {
      throw new WebError('INVALID_CAMPUS', '请选择可用的校区。');
    }
    const db = await getDb();
    const account = await register(db, { email, password, code, ...(invite ? { invite } : {}), ...(campus ? { campus } : {}) });
    await setSession(await createSession(db, account.id));
    return '/';
  });
}

export async function verificationAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    await sendVerificationCode(await getDb(), campusEmailFrom(data));
    return { notice: '验证码已发送，请在 10 分钟内完成注册。' };
  });
}

export async function inviteAction(_: FormState, _data: FormData): Promise<FormState> {
  return run(async () => {
    const user = await actionUser();
    const token = await createInvite(await getDb(), user.id);
    revalidatePath('/account');
    const origin = process.env.EXAMHUB_PUBLIC_ORIGIN ?? 'https://examhub.kerrychia.site';
    return { inviteLink: `${origin}/register?invite=${encodeURIComponent(token)}`, notice: '邀请链接已生成，30 天内有效，仅可使用一次。' };
  });
}

export async function logoutAction(): Promise<FormState> {
  return run(async () => {
    const token = await sessionToken();
    try { if (token) await logout(await getDb(), token); }
    finally { (await cookies()).set(SESSION_COOKIE, '', { ...sessionCookie(process.env.SECURE_COOKIES), maxAge: 0 }); }
    return '/';
  });
}

export async function startAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    const user = await actionUser();
    const mode = formText(data, 'mode') === 'collection' ? 'collection' : 'paper';
    const started = await startAttempt(await getDb(), user.id, identifier(formText(data, 'packId')), mode);
    return `/attempts/${segment(started.id)}`;
  });
}

// Drill server actions. They never throw across the wire: the practice UI maps a
// failed outcome onto its sync chip and keeps the optimistic local state.
export type DrillOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function drillRun<T>(work: () => Promise<T>): Promise<DrillOutcome<T>> {
  return work()
    .then(value => ({ ok: true as const, value }))
    .catch((error: unknown) => ({ ok: false as const, ...publicProblem(error) }));
}

export async function gradeQuestionAction(input: { attemptId: string; questionId: string; choice?: string; values?: string[] }) {
  return drillRun(async () => {
    const user = await actionUser();
    const payload: GradePayload = input.choice !== undefined
      ? { kind: 'choice', choice: input.choice }
      : { kind: 'fill', values: input.values ?? [] };
    return gradeRecord(await getDb(), user.id, identifier(input.attemptId), identifier(input.questionId), payload);
  });
}

export async function retryQuestionAction(input: { attemptId: string; questionId: string }) {
  return drillRun(async () => {
    const user = await actionUser();
    return retryRecord(await getDb(), user.id, identifier(input.attemptId), identifier(input.questionId));
  });
}

export async function starQuestionAction(input: { attemptId: string; questionId: string; starred: boolean }) {
  return drillRun(async () => {
    const user = await actionUser();
    return setStar(await getDb(), user.id, identifier(input.attemptId), identifier(input.questionId), input.starred === true);
  });
}

export async function masterQuestionAction(input: { attemptId: string; questionId: string; mastered: boolean }) {
  return drillRun(async () => {
    const user = await actionUser();
    return setMastered(await getDb(), user.id, identifier(input.attemptId), identifier(input.questionId), input.mastered === true);
  });
}

export async function draftQuestionAction(input: { attemptId: string; questionId: string; draft: string[] }) {
  return drillRun(async () => {
    const user = await actionUser();
    return saveDraft(await getDb(), user.id, identifier(input.attemptId), identifier(input.questionId), Array.isArray(input.draft) ? input.draft : []);
  });
}

export async function clearDrillAction(input: { attemptId: string }) {
  return drillRun(async () => {
    const user = await actionUser();
    return clearPackRecords(await getDb(), user.id, identifier(input.attemptId));
  });
}

export async function submitDrillAction(input: { attemptId: string }) {
  return drillRun(async () => {
    const user = await actionUser();
    const id = identifier(input.attemptId);
    const db = await getDb();
    const entry = await submitFromRecords(db, user.id, id);
    revalidatePath(`/attempts/${segment(id)}`);
    return { status: entry.status, score: entry.score, correct: entry.correct, total: entry.total };
  });
}

export async function quoteAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    const user = await actionUser();
    const result = await quote(await getDb(), user.id, identifier(formText(data, 'packId')), licenseFrom(data));
    return `/quotes/${segment(result.id)}`;
  });
}

export async function buyAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    const user = await actionUser();
    const id = identifier(formText(data, 'quoteId'));
    const db = await getDb();
    await approveQuote(db, user.id, id);
    await acquire(db, user.id, id);
    revalidatePath('/account');
    revalidatePath(`/quotes/${segment(id)}`);
    return `/quotes/${segment(id)}`;
  });
}

export async function quoteLookupAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    await actionUser();
    return `/quotes/${segment(identifier(formText(data, 'quoteId').trim()))}`;
  });
}

export async function handoffPackAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    const user = await actionUser();
    const created = await createHandoff(await getDb(), user.id, { mode: 'pack', packId: identifier(formText(data, 'packId')) });
    revalidatePath('/account');
    return {
      handoff: {
        code: created.code,
        message: buildHandoffMessage({ code: created.code, mode: 'pack', packTitle: created.packTitle, priceCc: created.priceCc, budgetCc: created.budgetCc, expiresAt: created.expiresAt }),
        expiresAt: created.expiresAt.toISOString(),
      },
    };
  });
}

export async function handoffCatalogAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    const user = await actionUser();
    const budgetCc = Number(formText(data, 'budget'));
    const created = await createHandoff(await getDb(), user.id, { mode: 'catalog', budgetCc });
    revalidatePath('/account');
    return {
      handoff: {
        code: created.code,
        message: buildHandoffMessage({ code: created.code, mode: 'catalog', priceCc: 5, budgetCc: created.budgetCc, expiresAt: created.expiresAt }),
        expiresAt: created.expiresAt.toISOString(),
      },
    };
  });
}

export async function revokeHandoffAction(): Promise<FormState> {
  return run(async () => {
    const user = await actionUser();
    await revokeHandoffs(await getDb(), user.id);
    revalidatePath('/account');
    return { notice: '已撤销全部 Agent 口令，正在使用的客户端会立即失效。' };
  });
}

export async function tokenAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    const user = await actionUser();
    if (formText(data, 'intent') === 'revoke') {
      await revokeMcpTokens(await getDb(), user.id);
      return { notice: '此账户的全部 MCP 令牌已撤销。' };
    }
    const scopes = readScopes(data.getAll('scope'));
    if (!scopes.length) throw new WebError('NO_SCOPES', '请选择至少一项权限。');
    return { token: await createMcpToken(await getDb(), user.id, scopes), notice: '令牌已创建。请复制并妥善保管；离开页面后不再展示。' };
  });
}

export async function gradeAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    if (!aiEnabled()) throw new WebError('AI_DISABLED', '讲评服务尚未启用。');
    const user = await actionUser();
    if (formText(data, 'confirmCc') !== 'yes') throw new WebError('CONFIRMATION_REQUIRED', '请先确认生成讲评。');
    const result = await grade(await getDb(), user.id, identifier(formText(data, 'attemptId')));
    revalidatePath('/account');
    return {
      notice: result.free ? '本次讲评由免费 token 额度承担，未扣积分。' : `讲评完成；本次费用 ${result.costCc} CC。`,
      feedback: result.feedback,
    };
  });
}

export async function uploadAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    const user = await actionUser();
    const id = await submitPack(await getDb(), user.id, await uploadFrom(data));
    revalidatePath('/review');
    return { notice: `已提交审核。投稿编号：${id}` };
  });
}

export async function publishAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    const user = await actionUser(true);
    await publishSubmission(await getDb(), user.id, identifier(formText(data, 'packId')), approvalFrom(data));
    revalidatePath('/');
    revalidatePath('/review');
    return '/review';
  });
}

function requireSandbox() {
  if (!sandboxEnabled()) throw new WebError('SANDBOX_DISABLED', '支付沙箱未启用。');
}

export async function orderAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    requireSandbox();
    const user = await actionUser();
    await createOrder(await getDb(), user.id, centsFrom(data));
    revalidatePath('/sandbox');
    return { notice: '沙箱订单已创建。实际模拟金额以订单列表为准；不会产生真实扣款。' };
  });
}

export async function payAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    requireSandbox();
    const user = await actionUser();
    await markSimulatedPaid(await getDb(), user.id, identifier(formText(data, 'orderId')));
    revalidatePath('/sandbox');
    return { notice: '已登记模拟付款，等待审核。' };
  });
}

export async function reviewOrderAction(_: FormState, data: FormData): Promise<FormState> {
  return run(async () => {
    requireSandbox();
    const user = await actionUser(true);
    await reviewOrder(await getDb(), user.id, identifier(formText(data, 'orderId')), approvalFrom(data));
    revalidatePath('/sandbox');
    revalidatePath('/account');
    return { notice: '审核决定已保存。' };
  });
}

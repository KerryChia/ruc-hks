import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '../../src/db';
import { DomainError } from '../../src/errors';
import { resolveSession } from '../../src/domains/identity';
import { SESSION_COOKIE } from './presentation';
import { WebError } from './validation';

export const sandboxEnabled = () => process.env.ENABLE_PAYMENT_SANDBOX === '1';
export const aiEnabled = () => Boolean(process.env.AI_API_KEY && process.env.AI_API_BASE);
export const sessionToken = async () => (await cookies()).get(SESSION_COOKIE)?.value;
export const currentUser = cache(async () => {
  const token = await sessionToken();
  return token ? resolveSession(await getDb(), token) : null;
});

export function canReview(role: string) { return role === 'reviewer' || role === 'admin'; }

export async function pageUser() {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}

export async function actionUser(reviewer = false) {
  const user = await currentUser();
  if (!user) throw new WebError('UNAUTHENTICATED', '请先登录，再重试。');
  if (reviewer && !canReview(user.role)) throw new WebError('FORBIDDEN', '当前账户没有审核权限。');
  return user;
}

const translations: Record<string, string> = {
  FREE_LIMIT: '近 30 天内的免费开卷次数已用完。可在账户中继续已有练习，或获取练习授权。',
  INVALID_LOGIN: '邮箱或密码不正确。', INVITE_INVALID: '邀请码无效、已使用，或与此邮箱不符。',
  EMAIL_DOMAIN_NOT_ALLOWED: '该邮箱不属于允许注册的学校域名。', INSUFFICIENT_CC: 'CC 余额不足。',
  CONFIRMATION_REQUIRED: '请先在页面上确认授权报价。', QUOTE_EXPIRED: '报价已过期，请重新申请报价。',
  COLLECTION_REQUIRES_LICENSE: '此操作需要题集授权。', ATTEMPT_NOT_SUBMITTED: '交卷后才能查看答案与解析。',
  FORBIDDEN: '当前账户无权执行此操作。', NOT_FOUND: '未找到该记录，或你无权查看。',
};

export function publicProblem(error: unknown) {
  if (error instanceof WebError) return { code: error.code, message: error.message };
  if (error instanceof DomainError) return { code: error.code, message: translations[error.code] ?? error.message };
  return { code: 'UNAVAILABLE', message: '暂时无法完成操作，请稍后重试。' };
}

export type HandoffCopy = { code: string; message: string; expiresAt: string };
export type FormState = { error?: { code: string; message: string }; notice?: string; token?: string; inviteLink?: string; feedback?: string; handoff?: HandoffCopy };
export type FormAction = (state: FormState, data: FormData) => Promise<FormState>;

export async function readResult<T>(get: () => T | Promise<T>) {
  try { return { ok: true as const, value: await get() }; }
  catch (error) { return { ok: false as const, error: publicProblem(error) }; }
}

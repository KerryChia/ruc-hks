import { z } from 'zod';
import { submissionSchema } from '../../src/domains/review';

export class WebError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WebError';
  }
}

export function formText(data: FormData, key: string) {
  const value = data.get(key);
  return typeof value === 'string' ? value : '';
}

export function identifier(value: string) {
  if (!/^[\w-]{1,128}$/.test(value)) throw new WebError('INVALID_ID', '无效的编号。');
  return value;
}

export const emailField = z.email().max(254);
export function emailFrom(data: FormData) {
  const email = emailField.safeParse(formText(data, 'email').trim().toLowerCase());
  if (!email.success) throw new WebError('INVALID_EMAIL', '请输入有效的邮箱地址。');
  return email.data;
}

export function campusEmailFrom(data: FormData) {
  const raw = (formText(data, 'studentId') || formText(data, 'email')).trim().toLowerCase();
  const local = raw.endsWith('@ruc.edu.cn') ? raw.slice(0, -'@ruc.edu.cn'.length) : raw;
  if (!/^[a-z0-9._-]{2,32}$/.test(local)) {
    throw new WebError('EMAIL_DOMAIN_NOT_ALLOWED', '请输入 2–32 位学号，系统会自动补全 @ruc.edu.cn。');
  }
  const email = emailField.safeParse(`${local}@ruc.edu.cn`);
  if (!email.success) throw new WebError('INVALID_EMAIL', '请输入有效的学号。');
  return email.data;
}

export function requireTermsAgreement(data: FormData) {
  if (formText(data, 'agreement') !== 'agree') {
    throw new WebError('TERMS_NOT_ACCEPTED', '请先阅读并勾选同意《用户条款》和《隐私政策》。');
  }
}

export function passwordFrom(data: FormData) {
  const password = formText(data, 'password');
  if (password.length < 1 || password.length > 256) throw new WebError('INVALID_PASSWORD', '请输入有效的密码。');
  return password;
}

export const ALLOWED_LICENSES = ['practice', 'read', 'collection'] as const;
export function licenseFrom(data: FormData) {
  const result = z.enum(ALLOWED_LICENSES).safeParse(formText(data, 'license'));
  if (!result.success) throw new WebError('INVALID_LICENSE', '请选择授权类型。');
  return result.data;
}

export async function uploadFrom(data: FormData) {
  const courseId = identifier(formText(data, 'courseId'));
  const title = formText(data, 'title').trim();
  const licenseNote = formText(data, 'licenseNote').trim();
  if (title.length < 2 || title.length > 100 || licenseNote.length < 10 || licenseNote.length > 500) {
    throw new WebError('INVALID_SUBMISSION', '题包标题须为 2–100 个字符，授权说明须为 10–500 个字符。');
  }
  const file = data.get('json');
  if (!file || typeof file === 'string' || !file.size || file.size > 512 * 1024) {
    throw new WebError('INVALID_FILE', '请选择不超过 512 KB 的 JSON 文件。');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await file.text()); } catch {
    throw new WebError('INVALID_JSON', '无法解析该文件，请检查 JSON 格式和 UTF-8 编码。');
  }
  const raw = parsed && typeof parsed === 'object' && 'questions' in parsed ? parsed.questions : parsed;
  const result = submissionSchema.shape.questions.safeParse(raw);
  if (!result.success) {
    const at = result.error.issues[0]?.path;
    const where = at?.length ? `第 ${Number(at[0]) + 1} 题的 ${String(at[1] ?? '题目')} 字段无效。` : '';
    throw new WebError('INVALID_QUESTIONS', `${where}请按示例提供 1–100 道题、每题 2–6 个不同选项及 1–5 个知识点，答案用从 0 开始的字符串下标。`);
  }
  return { courseId, title, licenseNote, questions: result.data };
}

export function centsFrom(data: FormData) {
  const amount = formText(data, 'amount');
  if (amount !== '10' && amount !== '30' && amount !== '49') throw new WebError('INVALID_AMOUNT', '请选择可用的沙箱档位。');
  return Number(amount) * 100;
}

export function approvalFrom(data: FormData) {
  const choice = formText(data, 'decision');
  if (choice !== 'approve' && choice !== 'reject') throw new WebError('INVALID_DECISION', '请选择通过或驳回。');
  return choice === 'approve';
}

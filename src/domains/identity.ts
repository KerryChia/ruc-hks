import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import nodemailer from 'nodemailer';
import type { Database, Queryable } from '../db';
import { fail } from '../errors';
import { openAccounts, post } from './credit';
import { INVITE_SIGNUP_CC } from './referral';

export const campuses = ['tongzhou', 'zhongguancun', 'suzhou'] as const;
export const mcpScopes = ['profile:read', 'packs:read', 'packs:acquire', 'attempts:write', 'attempts:read', 'credits:read'] as const;
export type Profile = { id: string; email: string; displayName: string; campus: string | null; role: 'student' | 'reviewer' | 'admin' };
const profileFields = 'id,email,display_name as "displayName",campus,role';
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');
const validToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);
const argon = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
let dummyHash: Promise<string> | undefined;

function normalizeEmail(raw: string) {
  const email = raw.trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}@ruc\.edu\.cn$/.test(email)) fail('EMAIL_DOMAIN_NOT_ALLOWED', '仅支持 @ruc.edu.cn 邮箱。');
  return email;
}

export async function issueInvite(db: Queryable, rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  const token = opaque();
  await db.query("insert into invitations(token_hash,email,expires_at) values($1,$2,now()+interval '7 days')", [hashToken(token), email]);
  return token;
}

export async function createInvite(db: Queryable, userId: string) {
  const token = opaque();
  await db.query("insert into invitations(token_hash,email,expires_at,created_by) values($1,null,now()+interval '30 days',$2)", [hashToken(token), userId]);
  return token;
}

export async function listInvites(db: Queryable, userId: string) {
  return (await db.query<{ createdAt: Date; expiresAt: Date; usedAt: Date | null; usedBy: string | null }>(`select i.created_at as "createdAt",
      i.expires_at as "expiresAt",i.used_at as "usedAt",u.display_name as "usedBy"
    from invitations i left join users u on u.id=i.used_by
    where i.created_by=$1 order by i.created_at desc limit 8`, [userId])).rows;
}

function digestCode(email: string, code: string) {
  const secret = process.env.EMAIL_CODE_SECRET;
  if (!secret || secret.length < 32) fail('MAIL_DISABLED', '验证码邮件尚未配置，请使用邀请码。');
  return createHmac('sha256', secret).update(`${email}:${code}`).digest('hex');
}

export async function sendVerificationCode(db: Queryable, rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  if ((await db.query("select 1 from users where email=$1 and status='active'", [email])).rows.length) {
    fail('EMAIL_TAKEN', '该邮箱已注册，请直接登录。');
  }
  const url = process.env.SMTP_URL;
  const from = process.env.SMTP_FROM;
  if (!url || !from) fail('MAIL_DISABLED', '验证码邮件服务暂时不可用，请稍后再试。');
  const code = randomInt(0, 1000000).toString().padStart(6, '0');
  const digest = digestCode(email, code);
  const issued = (await db.query(`insert into email_codes(email,digest,issued_at,expires_at) values($1,$2,now(),now()+interval '10 minutes')
    on conflict(email) do update set digest=excluded.digest, issued_at=now(), expires_at=excluded.expires_at, failures=0,
      daily_issued=case when (email_codes.issued_at at time zone 'Asia/Shanghai')::date=(now() at time zone 'Asia/Shanghai')::date then email_codes.daily_issued+1 else 1 end
    where email_codes.issued_at <= now()-interval '60 seconds' and (email_codes.daily_issued < 5 or (email_codes.issued_at at time zone 'Asia/Shanghai')::date < (now() at time zone 'Asia/Shanghai')::date)
    returning email`, [email, digest])).rows.length;
  if (!issued) fail('CODE_RATE_LIMITED', '发送过于频繁，请稍后再试。');
  try {
    const endpoint = new URL(url);
    if (!['smtp:', 'smtps:'].includes(endpoint.protocol)) throw new Error('Unsupported SMTP protocol');
    const secure = endpoint.protocol === 'smtps:';
    const transport = nodemailer.createTransport({
      host: endpoint.hostname, port: Number(endpoint.port) || (secure ? 465 : 587), secure, requireTLS: !secure,
      auth: endpoint.username ? { user: decodeURIComponent(endpoint.username), pass: decodeURIComponent(endpoint.password) } : undefined,
      connectionTimeout: 5000, socketTimeout: 10000, disableFileAccess: true, disableUrlAccess: true
    });
    try {
      await transport.sendMail({
        from,
        to: email,
        subject: 'ExamHub 校园练习站 · 注册验证码',
        text: `你的 ExamHub 校园练习站注册验证码是：${code}\n\n10 分钟内有效，共 6 位数字。若非本人操作，请忽略本邮件。\n\n—— ExamHub 校园练习站\nexamhub.kerrychia.site`,
      });
    } finally { transport.close(); }
  } catch {
    fail('MAIL_FAILED', '邮件发送失败，请稍后重试或使用邀请码。');
  }
}

export async function register(db: Database, input: { email: string; password: string; campus?: string; invite?: string; code: string }) {
  const email = normalizeEmail(input.email);
  if (input.password.length < 8 || Buffer.byteLength(input.password) > 256) fail('PASSWORD_WEAK', '密码须为 8 位或以上（最多 256 字节）。');
  const campus = input.campus || null;
  if (campus && !campuses.some(c => c === campus)) fail('CAMPUS_INVALID', '请选择有效校区。');
  const invite = input.invite?.trim();
  const code = input.code.trim();
  if (!/^\d{6}$/.test(code)) fail('CODE_INVALID', '请输入 6 位邮箱验证码。');
  if (invite && !validToken(invite)) fail('INVITE_INVALID', '邀请码无效、已用尽或已过期。');
  const passwordHash = await hash(input.password, argon);
  const id = randomUUID();
  const registered = await db.transaction(async tx => {
    if (invite) {
      const invitation = (await tx.query<{ email: string | null }>(
        'select email from invitations where token_hash=$1 and expires_at>now() and used_at is null for update',
        [hashToken(invite)],
      )).rows[0];
      if (!invitation || (invitation.email && invitation.email !== email)) fail('INVITE_INVALID', '邀请码无效、已用尽或已过期。');
    }
    const matched = await tx.query('update email_codes set expires_at=now() where email=$1 and digest=$2 and failures<5 and expires_at>now() returning email', [email, digestCode(email, code)]);
    if (!matched.rows.length) {
      await tx.query('update email_codes set failures=failures+1 where email=$1 and failures<5 and expires_at>now()', [email]);
      return false;
    }
    const created = await tx.query(`insert into users(id,email,password_hash,email_verified_at,display_name,campus)
      values ($1,$2,$3,now(),$4,$5) on conflict(email) do nothing returning id`,
      [id, email, passwordHash, `同学 ${id.slice(0, 8).toUpperCase()}`, campus]);
    if (!created.rows.length) fail('EMAIL_TAKEN', '该邮箱已注册，请直接登录。');
    if (invite) {
      await tx.query('update invitations set used_at=now(),used_by=$2 where token_hash=$1', [hashToken(invite), id]);
    }
    await openAccounts(tx, id);
    if (invite) await post(tx, id, 'CC', INVITE_SIGNUP_CC, 'invite_signup', `signup:${id}`);
    return true;
  });
  if (!registered) fail('CODE_INVALID', '验证码无效、过期或尝试过多。');
  return { id };
}

export async function login(db: Queryable, rawEmail: string, password: string) {
  const email = normalizeEmail(rawEmail);
  if (!password || Buffer.byteLength(password) > 256) fail('INVALID_LOGIN', '邮箱或密码不正确。');
  const reserved = await db.query(`insert into login_limits values ($1,1,now()) on conflict(email) do update set
    failures=case when login_limits.window_started <= now()-interval '15 minutes' then 1 else login_limits.failures+1 end,
    window_started=case when login_limits.window_started <= now()-interval '15 minutes' then now() else login_limits.window_started end
    where login_limits.failures<10 or login_limits.window_started <= now()-interval '15 minutes' returning email`, [email]);
  if (!reserved.rows.length) fail('LOGIN_RATE_LIMITED', '登录尝试过多，请 15 分钟后再试。');
  const user = (await db.query<{ id: string; password_hash: string }>('select id,password_hash from users where email=$1 and status=\'active\'', [email])).rows[0];
  const target = user?.password_hash ?? await (dummyHash ??= hash(opaque(), argon));
  if (!await verify(target, password) || !user) fail('INVALID_LOGIN', '邮箱或密码不正确。');
  await db.query('delete from login_limits where email=$1', [email]);
  return createSession(db, user.id);
}

// Registration and login share the same seven-day session so a new account lands signed in.
export async function createSession(db: Queryable, userId: string) {
  const token = opaque();
  await db.query("insert into sessions values($1,$2,now()+interval '7 days')", [hashToken(token), userId]);
  return token;
}

export async function resolveSession(db: Queryable, token?: string) {
  if (!token || !validToken(token)) return null;
  return (await db.query<Profile>(`select ${profileFields} from users where status='active' and id=(select user_id from sessions where token_hash=$1 and expires_at>now())`, [hashToken(token)])).rows[0] ?? null;
}

export async function logout(db: Queryable, token?: string) {
  if (token && validToken(token)) await db.query('delete from sessions where token_hash=$1', [hashToken(token)]);
}

export async function userProfile(db: Queryable, userId: string) {
  const profile = (await db.query<Profile>(`select ${profileFields} from users where id=$1 and status='active'`, [userId])).rows[0];
  if (!profile) fail('FORBIDDEN', '账号不可用。');
  return profile;
}

export async function requireReviewer(db: Queryable, userId: string) {
  if ((await userProfile(db, userId)).role === 'student') fail('FORBIDDEN', '需要审题权限。');
}

export async function createMcpToken(db: Queryable, userId: string, requested: string[]) {
  const scopes = [...new Set(requested)].filter(scope => mcpScopes.some(s => s === scope));
  if (!scopes.length) fail('MCP_SCOPE_REQUIRED', '至少选择一项 Agent 权限。');
  const token = opaque();
  await db.query("insert into mcp_tokens values($1,$2,$3,now()+interval '7 days')", [hashToken(token), userId, scopes]);
  return token;
}

export async function revokeMcpTokens(db: Queryable, userId: string) {
  await db.query('delete from mcp_tokens where user_id=$1', [userId]);
}

export async function resolveMcpToken(db: Queryable, token: string) {
  if (!validToken(token)) return null;
  return (await db.query<{ userId: string; scopes: string[] }>(`select t.user_id as "userId",t.scopes from mcp_tokens t join users u on u.id=t.user_id
    where t.token_hash=$1 and t.expires_at>now() and u.status='active'`, [hashToken(token)])).rows[0] ?? null;
}

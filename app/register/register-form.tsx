'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import { Submit } from '../_components/form';
import { registerAction, verificationAction } from '../_lib/actions';
import type { FormState } from '../_lib/web';

const initial: FormState = {};
const studentIdPattern = '[A-Za-z0-9._-]{2,32}';

export function RegisterForm({ invite }: { invite?: string }) {
  const [state, dispatch] = useActionState(registerAction, initial);
  const [sendState, setSendState] = useState<FormState>({});
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [sentTo, setSentTo] = useState('');
  const studentIdRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function sendCode() {
    const input = studentIdRef.current;
    const studentId = input?.value.trim() ?? '';
    if (!input?.checkValidity() || !new RegExp(`^${studentIdPattern}$`).test(studentId)) {
      input?.reportValidity();
      setSendState({ error: { code: 'INVALID_STUDENT_ID', message: '请先填写有效的校园邮箱（学号）。' } });
      return;
    }
    setSending(true);
    setSendState({});
    try {
      const data = new FormData();
      data.set('studentId', studentId);
      const result = await verificationAction({}, data);
      setSendState(result);
      if (!result.error) {
        setSentTo(`${studentId}@ruc.edu.cn`);
        setCooldown(60);
      }
    } catch {
      setSendState({ error: { code: 'NETWORK_ERROR', message: '验证码发送失败，请检查网络后重试。' } });
    } finally {
      setSending(false);
    }
  }

  return <form action={dispatch} className="form-stack register-form">
    <label className="field">校园邮箱（学号）<span className="email-composer"><input ref={studentIdRef} name="studentId" autoComplete="username" pattern={studentIdPattern} title="请输入 2–32 位学号，仅限字母、数字、点、下划线或连字符" required maxLength={32} autoCapitalize="none" spellCheck={false} /><span className="email-suffix">@ruc.edu.cn</span></span><small>请只填写 @ 前面的部分。</small></label>
    <div className="field code-field">邮箱验证码
      <div className="code-control"><input name="code" inputMode="numeric" pattern="\d{6}" title="请输入 6 位数字验证码" placeholder="6 位数字" required maxLength={6} autoComplete="one-time-code" />
        <button className="button secondary code-send" type="button" onClick={sendCode} disabled={sending || cooldown > 0}>{sending ? '发送中…' : cooldown > 0 ? `${cooldown}s 后重发` : '发送验证码'}</button>
      </div>
      <small>{sentTo ? `已发送至 ${sentTo}，10 分钟内有效。` : '所有账户均需邮箱验证，请先填写学号再获取验证码。'}</small>
    </div>
    {(sendState.error || sendState.notice) && <p className={`notice ${sendState.error ? 'danger' : 'success'}`} role={sendState.error ? 'alert' : 'status'}>{sendState.error?.message ?? sendState.notice}{sendState.error && <code>{sendState.error.code}</code>}</p>}
    <label className="field">新密码<input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={256} /><small>至少 8 个字符。</small></label>
    <label className="field">邀请码（选填）<input name="invite" defaultValue={invite} maxLength={256} autoComplete="off" spellCheck={false} /><small>{invite ? '邀请链接已自动填入；如果链接已失效，可以清空后继续注册。' : '没有邀请码可以留空，不影响注册。'}</small></label>
    <div className="agreement-field">
      <input id="terms-agreement" name="agreement" value="agree" type="checkbox" required />
      <label htmlFor="terms-agreement">我已阅读并同意 <Link href="/terms" target="_blank" rel="noreferrer">《用户条款》</Link> 和 <Link href="/privacy" target="_blank" rel="noreferrer">《隐私政策》</Link>，并了解 ExamHub 不是学校官方考试系统。</label>
    </div>
    {state.error && <p className="notice danger" role="alert">{state.error.message} <code>{state.error.code}</code></p>}
    <Submit>注册</Submit>
  </form>;
}

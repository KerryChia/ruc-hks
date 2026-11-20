'use client';

import { useActionState, useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { useFormStatus } from 'react-dom';
import type { FormAction, FormState } from '../_lib/web';

const initial: FormState = {};

export function ActionForm({ action, children, className }: { action: FormAction; children: ReactNode; className?: string }) {
  const [state, dispatch] = useActionState(action, initial);
  const [copied, setCopied] = useState(false);
  const [copiedHandoff, setCopiedHandoff] = useState<'message' | 'code' | null>(null);
  const inviteRef = useRef<HTMLInputElement>(null);
  const handoffRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setCopied(false), [state.inviteLink]);
  useEffect(() => setCopiedHandoff(null), [state.handoff]);
  async function copyInvite() {
    if (!state.inviteLink) return;
    try {
      await navigator.clipboard.writeText(state.inviteLink);
    } catch {
      inviteRef.current?.select();
      document.execCommand('copy');
    }
    setCopied(true);
  }
  async function copyHandoff(kind: 'message' | 'code') {
    if (!state.handoff) return;
    const value = kind === 'message' ? state.handoff.message : state.handoff.code;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      handoffRef.current?.select();
      document.execCommand('copy');
    }
    setCopiedHandoff(kind);
  }
  return <form action={dispatch} className={className ?? 'form-stack'}>
    {children}
    {state.error && <p className="notice danger" role="alert">{state.error.message} <code>{state.error.code}</code></p>}
    {state.notice && <p className="notice success" role="status">{state.notice}</p>}
    {state.feedback && <pre className="feedback">{state.feedback}</pre>}
    {state.token && <label className="field">新令牌<textarea className="token" readOnly rows={3} value={state.token} onFocus={event => event.currentTarget.select()} /></label>}
    {state.inviteLink && <div className="invite-link-card">
      <span>邀请链接（仅展示一次）</span>
      <div><input ref={inviteRef} readOnly value={state.inviteLink} onFocus={event => event.currentTarget.select()} aria-label="邀请链接" /><button type="button" onClick={copyInvite}>{copied ? '已复制' : '复制链接'}</button></div>
      <small>被邀请者打开链接后，邀请码会自动填入注册表单；邮箱验证码仍需自行获取。</small>
    </div>}
    {state.handoff && <div className="handoff-card">
      <span>发给 Agent 的这段话（仅展示一次）</span>
      <textarea ref={handoffRef} className="handoff-text" readOnly rows={10} value={state.handoff.message} onFocus={event => event.currentTarget.select()} aria-label="发给 Agent 的口令说明" />
      <div className="handoff-actions">
        <button type="button" onClick={() => copyHandoff('message')}>{copiedHandoff === 'message' ? '已复制这段话' : '复制这段话'}</button>
        <button type="button" className="ghost" onClick={() => copyHandoff('code')}>{copiedHandoff === 'code' ? '已复制口令' : '只复制口令'}</button>
      </div>
      <small>口令 {new Date(state.handoff.expiresAt).toLocaleString('zh-CN')} 前有效。只发给自己的 Agent，不要发到群聊或截图区。</small>
    </div>}
  </form>;
}

export function Submit({ children, variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger' }) {
  const { pending } = useFormStatus();
  return <button {...props} className={`button ${variant} ${className}`} type="submit" disabled={pending || props.disabled}>{pending ? '处理中…' : children}</button>;
}

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageTitle } from '../_components/ui';
import { currentUser } from '../_lib/web';
import { RegisterForm } from './register-form';

export const metadata = { title: '注册' };

export default async function Register({ searchParams }: { searchParams: Promise<{ invite?: string | string[] }> }) {
  if (await currentUser()) redirect('/account');
  const query = await searchParams;
  const rawInvite = typeof query.invite === 'string' ? query.invite : '';
  const invite = /^[A-Za-z0-9_-]{43}$/.test(rawInvite) ? rawInvite : '';
  return <div className="narrow auth-page">
    <PageTitle title="注册校园账户" back={['/login', '返回登录']} description="使用校园邮箱（学号）注册，所有账户均需邮箱验证码；邀请码可选。" />
    {rawInvite && !invite && <p className="notice danger" role="alert">这条邀请链接无效或格式不正确，可以继续使用邮箱验证码注册。</p>}
    {invite && <div className="invite-applied"><span>已应用邀请</span><strong>{invite.slice(-8)}</strong><p>邀请码已自动填入，注册成功后新账户将获得 30 CC 起始额度；你首次开卷后，邀请你的同学也会获得 30 CC。</p></div>}
    <section className="panel section tight"><RegisterForm invite={invite} /></section>
    <p>已有账户？ <Link href="/login">登录</Link></p>
    <p className="legal-consent auth-consent">注册需要完成校园邮箱验证。一个邮箱只能注册一个账户。</p>
  </div>;
}

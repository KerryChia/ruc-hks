import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ActionForm, Submit } from '../_components/form';
import { PageTitle } from '../_components/ui';
import { loginAction } from '../_lib/actions';
import { currentUser } from '../_lib/web';

export const metadata = { title: '登录' };

export default async function Login() {
  if (await currentUser()) redirect('/account');
  return <div className="narrow auth-page">
    <PageTitle title="登录" back={['/', '课程题库']} description="使用校园邮箱（学号）登录，邮箱将自动补全为 @ruc.edu.cn。" />
    <section className="panel"><ActionForm action={loginAction}>
      <label className="field">校园邮箱（学号）<span className="email-composer"><input name="studentId" autoComplete="username" pattern="[A-Za-z0-9._-]{2,32}" title="请输入 2–32 位学号，仅限字母、数字、点、下划线或连字符" required maxLength={32} autoCapitalize="none" spellCheck={false} /><span className="email-suffix">@ruc.edu.cn</span></span><small>请只填写 @ 前面的部分。</small></label>
      <label className="field">密码<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
      <Submit>登录</Submit>
    </ActionForm></section>
    <p>还没有账户？ <Link href="/register">注册校园账户</Link></p>
    <p className="legal-consent auth-consent">继续使用即表示你同意 <Link href="/terms">《用户条款》</Link> 与 <Link href="/privacy">《隐私政策》</Link>。</p>
  </div>;
}

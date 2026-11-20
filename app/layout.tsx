import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PromoBar } from './_components/promo-bar';
import { SearchProvider } from './_components/search';
import { SiteHeader } from './_components/site-header';
import { logoutAction } from './_lib/actions';
import { currentPromotion } from './_lib/promotion';
import { canReview, currentUser, readResult, sandboxEnabled } from './_lib/web';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ExamHub · 校园练习站', template: '%s · ExamHub' },
  description: '按课程在线练习、查看成绩与解析，发现由学习贡献者分享的优质题包。',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const result = await readResult(currentUser);
  const user = result.ok ? result.value : null;
  const promotion = await currentPromotion();
  return <html lang="zh-CN"><body>
    <a className="skip" href="#main">跳到主要内容</a>
    <SearchProvider>
      <SiteHeader user={user ? { name: user.displayName, reviewer: canReview(user.role), sandbox: sandboxEnabled() } : null} logoutAction={logoutAction} />
      {promotion && <PromoBar promotion={promotion} />}
      <main id="main" className="container main-content">{children}</main>
      <footer className="footer"><div className="container footer-inner">
        <div className="footer-brand"><strong>ExamHub<span>.</span></strong><p>把每一份认真练习，变成看得见的进步。</p></div>
        <div className="footer-links"><Link href="/">在线练习</Link><Link href="/courses">全部题库</Link><Link href="/resources">原始试卷</Link><Link href="/mcp">Agent 接入</Link><Link href="/upload">贡献题包</Link><Link href="/account">我的学习</Link><Link href="/terms">用户条款</Link><Link href="/privacy">隐私政策</Link></div>
      </div></footer>
    </SearchProvider>
  </body></html>;
}

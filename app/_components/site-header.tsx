'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ActionForm, Submit } from './form';
import { SearchTrigger } from './search';
import type { FormAction } from '../_lib/web';

type HeaderUser = { name: string; reviewer: boolean; sandbox: boolean };

export function LogoMark() {
  return <span className="brand-icon" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 28 28" fill="none"><path d="M5 6.5 14 3l9 3.5v10L14 25l-9-8.5v-10Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="m9 13 3.2 3.2L19.5 9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>;
}

function MenuIcon({ close }: { close: boolean }) {
  return <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">{close ? <path d="m6 6 12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}</svg>;
}

export function SiteHeader({ user, logoutAction }: { user: HeaderUser | null; logoutAction: FormAction }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => { setMenuOpen(false); }, [pathname]);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const practiceActive = pathname === '/' || (!['/account', '/upload', '/review', '/sandbox', '/login', '/register', '/resources', '/courses'].some(path => pathname.startsWith(path)));
  const uploadActive = pathname.startsWith('/upload');
  const coursesActive = pathname === '/courses' || pathname.startsWith('/courses/');
  const accountActive = pathname.startsWith('/account');

  return <header className={`topbar${scrolled ? ' scrolled' : ''}`}>
    <div className="container nav-layout">
      <Link href="/" className="wordmark" aria-label="ExamHub 首页"><LogoMark /><span>ExamHub<span className="wordmark-dot">.</span></span></Link>
      <nav className="nav desktop-nav" aria-label="主导航">
        <Link href="/" className={practiceActive ? 'active' : ''} aria-current={practiceActive ? 'page' : undefined}>在线练习</Link>
        <Link href="/courses" className={coursesActive ? 'active' : ''} aria-current={coursesActive ? 'page' : undefined}>全部题库</Link>
        <Link href="/upload" className={uploadActive ? 'active' : ''} aria-current={uploadActive ? 'page' : undefined}>贡献题包</Link>
        {user && <Link href="/account" className={accountActive ? 'active' : ''} aria-current={accountActive ? 'page' : undefined}>我的学习</Link>}
      </nav>
      <div className="nav-actions">
        <SearchTrigger />
        <SearchTrigger variant="icon" className="mobile-search" />
        {user ? <details className="user-menu">
          <summary><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><span className="user-name">{user.name}</span><span aria-hidden="true">⌄</span></summary>
          <div className="user-dropdown">
            <div className="user-dropdown-head"><strong>{user.name}</strong><span>ExamHub 学习者</span></div>
            <Link href="/account">我的学习与积分</Link>
            {user.reviewer && <Link href="/review">题包审核</Link>}
            {user.sandbox && <Link href="/sandbox">充值沙箱</Link>}
            <ActionForm action={logoutAction} className="nav-form"><Submit variant="quiet">退出登录</Submit></ActionForm>
          </div>
        </details> : <div className="auth-actions"><Link href="/login">登录</Link><Link href="/register" className="button primary">注册</Link></div>}
        <button className="mobile-menu-button" type="button" onClick={() => setMenuOpen(value => !value)} aria-expanded={menuOpen} aria-label={menuOpen ? '关闭菜单' : '打开菜单'}><MenuIcon close={menuOpen} /></button>
      </div>
    </div>
    {menuOpen && <nav className="mobile-nav" aria-label="移动端导航">
      <Link href="/" className={practiceActive ? 'active' : ''}>在线练习<span>→</span></Link>
      <Link href="/courses" className={coursesActive ? 'active' : ''}>全部题库<span>→</span></Link>
      <Link href="/upload" className={uploadActive ? 'active' : ''}>贡献题包<span>→</span></Link>
      {user ? <>
        <Link href="/account" className={accountActive ? 'active' : ''}>我的学习<span>→</span></Link>
        {user.reviewer && <Link href="/review">题包审核<span>→</span></Link>}
        {user.sandbox && <Link href="/sandbox">充值沙箱<span>→</span></Link>}
        <ActionForm action={logoutAction} className="mobile-logout"><Submit variant="quiet">退出登录</Submit></ActionForm>
      </> : <div className="mobile-auth"><Link href="/login" className="button secondary">登录</Link><Link href="/register" className="button primary">注册账户</Link></div>}
    </nav>}
  </header>;
}

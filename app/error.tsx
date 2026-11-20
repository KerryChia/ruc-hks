'use client';

import Link from 'next/link';

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <div className="narrow"><header className="page-title"><h1>暂时无法加载</h1><p>请重试，或返回课程题库。</p></header>
    <div className="inline"><button className="button primary" type="button" onClick={reset}>重试</button><Link href="/" className="button secondary">返回课程题库</Link></div>
  </div>;
}

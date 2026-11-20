import Link from 'next/link';
import type { ReactNode } from 'react';

export type LegalSection = { id: string; title: string; content: ReactNode };

export function LegalPage({ eyebrow, title, summary, effectiveDate, sections }: {
  eyebrow: string;
  title: string;
  summary: string;
  effectiveDate: string;
  sections: LegalSection[];
}) {
  return <article className="legal-page">
    <header className="legal-header">
      <Link href="/" className="back"><span aria-hidden="true">←</span> 返回 ExamHub</Link>
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{summary}</p>
      <div className="legal-meta"><span>生效日期：{effectiveDate}</span><span>版本：1.0</span><span>适用站点：examhub.kerrychia.site</span></div>
    </header>
    <div className="legal-layout">
      <aside className="legal-toc" aria-label="目录">
        <strong>本页目录</strong>
        <nav>{sections.map((section, index) => <a key={section.id} href={`#${section.id}`}><span>{String(index + 1).padStart(2, '0')}</span>{section.title}</a>)}</nav>
        <div className="legal-toc-note"><span>要点</span><p>ExamHub 是校园练习与学习交流工具，不是学校官方考试系统。</p></div>
      </aside>
      <div className="legal-content">
        <div className="legal-intro">{summary}</div>
        {sections.map((section, index) => <section id={section.id} key={section.id}>
          <div className="legal-section-title"><span>{String(index + 1).padStart(2, '0')}</span><h2>{section.title}</h2></div>
          {section.content}
        </section>)}
        <footer className="legal-contact">
          <strong>还有疑问？</strong>
          <p>请通过向你发放 ExamHub 注册邀请码或验证码的站点管理员联系我们，并在请求中注明“用户条款”或“隐私政策”。我们会在核验身份后尽快处理。</p>
        </footer>
      </div>
    </div>
  </article>;
}

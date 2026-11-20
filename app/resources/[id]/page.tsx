import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '../../../src/db';
import { getResourceCourse, practiceCourseFor, RESOURCE_COLLECTIONS } from '../../../src/domains/resources';
import { Badge, PageTitle, Problem } from '../../_components/ui';
import { currentPromotion } from '../../_lib/promotion';
import { pageUser, readResult } from '../../_lib/web';

export const metadata = { title: '课程资料' };

function readableSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default async function ResourceCoursePage({ params }: { params: Promise<{ id: string }> }) {
  await pageUser();
  const promotion = await currentPromotion();
  const { id } = await params;
  const result = await readResult(async () => {
    const db = await getDb();
    const detail = await getResourceCourse(db, id);
    return { ...detail, practice: await practiceCourseFor(db, detail.course.name) };
  });
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound();
  if (!result.ok) return <><PageTitle title="课程资料" back={['/resources', '全部资料']} /><Problem error={result.error} /></>;
  const { course, files, practice } = result.value;
  const collection = RESOURCE_COLLECTIONS[course.collection as keyof typeof RESOURCE_COLLECTIONS];
  const groups = [...new Map(files.map(file => [file.category, files.filter(item => item.category === file.category)])).entries()];
  return <>
    <PageTitle title={course.name} description={`${collection?.name ?? '课程资料'} · ${files.length} 份文件 · ${readableSize(course.sizeBytes)}`} back={['/resources', '全部资料']}>
      <Badge positive={Boolean(promotion)}>{promotion ? '限时免费 · 登录可见' : '登录可见'}</Badge>
    </PageTitle>
    {practice ? (
      <section className="practice-entry">
        <div className="practice-entry-copy">
          <span className="practice-entry-kicker">先做题，再翻资料</span>
          <h2>{practice.name} · 已有可作答题包</h2>
          <p>{practice.packCount} 套真题 · {practice.questionCount} 道可判分题 · 自动批改与 AI 点评</p>
        </div>
        <Link className="button" href={`/${encodeURIComponent(practice.slug)}`}>开始答题 <span aria-hidden="true">→</span></Link>
      </section>
    ) : (
      <section className="practice-entry pending">
        <div className="practice-entry-copy">
          <span className="practice-entry-kicker">待拆题</span>
          <h2>本科目还没有可作答的题包</h2>
          <p>下方是原始试卷与资料，题目尚未拆成可判分形式。可以先看文件，题目正在整理。</p>
        </div>
      </section>
    )}
    <section className="resource-detail-head">
      <div className="resource-contributor"><span className="contributor-avatar">{course.contributor.slice(0, 1).toUpperCase()}</span><div><span>资料贡献者</span><a href={course.contributorUrl} target="_blank" rel="noreferrer">{course.contributor} ↗</a></div></div>
      <div className="resource-detail-note"><strong>版权说明</strong><p>{collection?.note ?? '资料版权归原作者及相应权利人所有。'}请勿商用、转售或对外传播。</p></div>
      <a className="button secondary" href={course.repository} target="_blank" rel="noreferrer">查看原始仓库 ↗</a>
    </section>
    <div className="resource-file-groups">{groups.map(([category, rows]) => <section className="resource-file-group" key={category}>
      <div className="resource-file-heading"><h2>{category}</h2><span>{rows.length} 份</span></div>
      <ul className="resource-file-list">{rows.map(file => {
        const viewable = ['pdf', 'md', 'txt', 'cpp', 'h', 'ipynb', 'csv', 'py'].includes(file.extension);
        const href = `/api/resources/${file.id}`;
        return <li key={file.id}>
          <span className={`file-badge ext-${file.extension}`}>{file.extension.toUpperCase()}</span>
          <div className="resource-file-copy"><h3>{file.title}</h3><p>{[file.term, file.instructor, readableSize(file.sizeBytes)].filter(Boolean).join(' · ')}</p></div>
          <a className="button secondary resource-file-action" href={href} target={viewable ? '_blank' : undefined} rel={viewable ? 'noreferrer' : undefined} download={viewable ? undefined : true}>
            {viewable ? '查看' : '下载'} <span aria-hidden="true">{viewable ? '↗' : '↓'}</span>
          </a>
        </li>;
      })}</ul>
    </section>)}</div>
    <p className="resource-footnote"><Link href="/resources" className="back">← 返回全部资料</Link></p>
  </>;
}

import Link from 'next/link';
import { getDb } from '../../src/db';
import { listResourceCourses, RESOURCE_COLLECTIONS } from '../../src/domains/resources';
import { Badge, Empty, PageTitle, Problem } from '../_components/ui';
import { currentPromotion, promotionDeadline } from '../_lib/promotion';
import { currentUser, readResult } from '../_lib/web';

export const metadata = { title: '原始试卷' };

function folderCount(categories: string[]) {
  return categories.filter(Boolean).slice(0, 3);
}

export default async function Resources() {
  const [courses, user, promotion] = await Promise.all([readResult(async () => listResourceCourses(await getDb())), currentUser(), currentPromotion()]);
  const groups = courses.ok ? Object.keys(RESOURCE_COLLECTIONS).map(key => ({
    key: key as keyof typeof RESOURCE_COLLECTIONS,
    meta: RESOURCE_COLLECTIONS[key as keyof typeof RESOURCE_COLLECTIONS],
    courses: courses.value.filter(course => course.collection === key),
  })) : [];
  const totalFiles = courses.ok ? courses.value.reduce((sum, course) => sum + course.fileCount, 0) : 0;
  return <>
    <PageTitle title="原始试卷" description="这里只存放考试原件与答案，供核对与离线查看。要动手练习，请回到课程页进入题库。" back={['/', '返回首页']}>
      {courses.ok && <Badge>{courses.value.length} 门课程 · {totalFiles} 份原件</Badge>}
      {promotion && <Badge positive>限时免费</Badge>}
    </PageTitle>
    <section className="resource-notice">
      <span className="resource-notice-mark">i</span>
      <div><strong>这里是题库的原料仓，不是练习入口</strong><p>试卷原件保留原始来源与贡献者，版权归原作者及相应权利人所有。仅限校园学习使用，请勿商用或对外传播。</p>
        {promotion && <p className="resource-promo-line">限时免费至 {promotionDeadline(promotion)}：全部资料免费查看与下载，登录校园账户即可。</p>}</div>
      <div className="resource-notice-actions">{!user && <Link href="/login" className="button secondary">登录后查看</Link>}<Link href="/" className="button">去在线练习 <span aria-hidden="true">→</span></Link></div>
    </section>
    {!courses.ok ? <Problem error={courses.error} /> : totalFiles === 0 ? <Empty>资料库正在整理中。</Empty> : groups.map(group => group.courses.length > 0 && <section className="resource-group" key={group.key}>
      <div className="section-heading resource-group-heading"><div><span className="eyebrow">{group.key === 'gsai' ? 'GSAI COURSE MATERIALS' : 'PAST EXAM ARCHIVE'}</span><h2>{group.meta.name}</h2><p>{group.meta.description}</p></div>
        <a href={group.meta.repository} target="_blank" rel="noreferrer" className="source-pill"><span className="contributor-avatar">{group.meta.contributor.slice(0, 1).toUpperCase()}</span><span>贡献者<strong>{group.meta.contributor}</strong></span><span aria-hidden="true">↗</span></a>
      </div>
      <div className="resource-grid">{group.courses.map((course, index) => <article className={`resource-card tone-${index % 4}`} key={course.id}>
        <div className="resource-card-top"><span className="resource-folder" aria-hidden="true">/{String(index + 1).padStart(2, '0')}</span><span className="resource-count">{course.fileCount} 份</span></div>
        <Link href={`/resources/${course.id}`} className="resource-card-title">{course.name}<span aria-hidden="true">↗</span></Link>
        <div className="resource-tags">{folderCount(course.categories).map(category => <span key={category}>{category}</span>)}</div>
        <div className="resource-card-bottom"><span>贡献者 <a href={course.contributorUrl} target="_blank" rel="noreferrer">{course.contributor}</a></span><Link href={`/resources/${course.id}`}>{user ? '查看资料' : '登录查看'} <span aria-hidden="true">→</span></Link></div>
      </article>)}</div>
      <p className="resource-source-note">来源：<a href={group.meta.repository} target="_blank" rel="noreferrer">{group.meta.repository.replace('https://github.com/', '')}</a> · {group.meta.note}</p>
    </section>)}
  </>;
}

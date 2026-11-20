import Link from 'next/link';
import { getDb } from '../../src/db';
import { listCourses } from '../../src/domains/catalog';
import { courseKey, listResourceCourses } from '../../src/domains/resources';
import { Badge, Empty, PageTitle, Problem } from '../_components/ui';
import { courseHref } from '../_lib/presentation';
import { readResult } from '../_lib/web';

export const metadata = { title: '全部题库' };

export default async function AllCourses() {
  const result = await readResult(async () => {
    const db = await getDb();
    const [courses, resources] = await Promise.all([listCourses(db), listResourceCourses(db)]);
    return { courses, resources };
  });
  if (!result.ok) return <><PageTitle title="全部题库" back={['/', '返回首页']} /><Problem error={result.error} /></>;
  const { courses, resources } = result.value;

  // A course is "ready" when at least one live pack exists. Everything else still has
  // raw papers waiting to be mined, so it is surfaced as a queue rather than hidden.
  const ready = courses.filter(course => course.packCount > 0);
  const readyKeys = new Set(ready.map(course => courseKey(course.name)));
  const papers = new Map(resources.map(course => [courseKey(course.name), course]));
  // Drop auto-generated duplicates of a ready course and courses with no papers at all,
  // otherwise the queue is full of empty shells that will never be worked on.
  const pending = courses.filter(course => course.packCount === 0 && !readyKeys.has(courseKey(course.name)) && papers.has(courseKey(course.name)));
  const paperFor = (name: string) => papers.get(courseKey(name)) ?? null;
  const packTotal = ready.reduce((sum, course) => sum + course.packCount, 0);

  return <>
    <PageTitle title="全部题库" description="所有课程的练习入口。已上线的可以直接开练，标为待拆题的还在把试卷原件转成可判分题目。" back={['/', '返回首页']}>
      <Badge>{ready.length} 门可练习 · {packTotal} 套题包</Badge>
      {pending.length > 0 && <Badge>{pending.length} 门待拆题</Badge>}
    </PageTitle>

    <section className="section tight" aria-labelledby="ready-title">
      <div className="section-heading"><div><span className="eyebrow">READY TO PRACTICE</span><h2 id="ready-title">可直接练习</h2><p>题目已入库，自动判分，可看解析与 AI 点评。</p></div><Badge>{ready.length} 门</Badge></div>
      {ready.length === 0 ? <Empty>还没有可练习的课程。</Empty> : <ul className="record-list pack-list">
        {ready.map((course, index) => <li key={course.id} className="record-row">
          <span className="pack-index">{String(index + 1).padStart(2, '0')}</span>
          <div className="record-content">
            <h3><Link href={courseHref(course.slug)}>{course.name}</Link></h3>
            <p>{course.packCount} 套题包 · 贡献者 {course.contributor}</p>
          </div>
          <Badge positive>{course.sampleCount > 0 ? '含完整样例' : '已上线'}</Badge>
          <Link className="button secondary" href={courseHref(course.slug)}>进入课程 <span aria-hidden="true">→</span></Link>
        </li>)}
      </ul>}
    </section>

    {pending.length > 0 && <section className="section tight" aria-labelledby="pending-title">
      <div className="section-heading"><div><span className="eyebrow">IN THE QUEUE</span><h2 id="pending-title">待拆题</h2><p>这些课程的原始试卷已收录，但还没拆成可判分题目。可以先看原件。</p></div><Badge>{pending.length} 门</Badge></div>
      <ul className="record-list pack-list">
        {pending.map((course, index) => {
          const paper = paperFor(course.name);
          return <li key={course.id} className="record-row">
            <span className="pack-index">{String(index + 1).padStart(2, '0')}</span>
            <div className="record-content"><h3>{course.name}</h3><p>{paper ? `${paper.fileCount} 份原始试卷与资料` : '暂无原始试卷'}</p></div>
            <Badge>待拆题</Badge>
            {paper
              ? <Link className="button secondary" href={`/resources/${paper.id}`}>查看原件 <span aria-hidden="true">→</span></Link>
              : <span className="button secondary disabled" aria-disabled="true">整理中</span>}
          </li>;
        })}
      </ul>
    </section>}
  </>;
}

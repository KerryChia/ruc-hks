import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '../../src/db';
import { leaderboard } from '../../src/domains/attempt';
import { getCourseBySlug, searchPacks } from '../../src/domains/catalog';
import { resourceCourseFor } from '../../src/domains/resources';
import { Badge, Empty, PageTitle, Problem } from '../_components/ui';
import { courseHref, decodeCourseParam, segment } from '../_lib/presentation';
import { currentPromotion } from '../_lib/promotion';
import { readResult } from '../_lib/web';

export const metadata = { title: '课程题库' };

type Entry = Awaited<ReturnType<typeof leaderboard>>[number];
function Board({ title, detail, rows }: { title: string; detail: string; rows: Entry[] }) {
  return <section className="panel board-panel">
    <div className="board-heading"><span className="board-icon">↗</span><div><h3>{title}</h3><p className="muted">{detail}</p></div></div>
    {rows.length === 0 ? <Empty>暂无上榜记录，等你来拿下第一。</Empty> : <div className="table-scroll"><table aria-label={title}>
      <thead><tr><th scope="col">名次</th><th scope="col">昵称</th><th scope="col">答对</th><th scope="col">得分</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={`${row.displayName}-${index}`}><td><span className={`rank rank-${index + 1}`}>{String(index + 1).padStart(2, '0')}</span></td><td><strong>{row.displayName}</strong></td><td>{row.correct} / {row.total}</td><td><strong className="board-score">{row.score}</strong></td></tr>)}</tbody>
    </table></div>}
  </section>;
}

export default async function Course({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ pack?: string | string[] }> }) {
  const [{ slug: encodedSlug }, { pack }] = await Promise.all([params, searchParams]);
  const slug = decodeCourseParam(encodedSlug);
  if (slug === null) notFound();
  const data = await readResult(async () => {
    const db = await getDb();
    const course = await getCourseBySlug(db, slug);
    const packs = await searchPacks(db, { courseId: course.id });
    return { course, packs, papers: await resourceCourseFor(db, course.name) };
  });
  if (!data.ok && data.error.code === 'NOT_FOUND') notFound();
  if (!data.ok) return <><PageTitle title="课程题库" back={['/#courses', '全部课程']} /><Problem error={data.error} /></>;
  const { course, packs, papers } = data.value;
  const promotion = await currentPromotion();
  const selected = packs.find(row => row.id === pack) ?? packs[0];
  const boards = selected && await readResult(async () => {
    const db = await getDb();
    return Promise.all([leaderboard(db, selected.id, 'honor'), leaderboard(db, selected.id, 'skilled')]);
  });
  return <>
    <PageTitle title={course.name} description={`贡献者 ${course.contributor} · ${packs.length} 套练习`} back={['/#courses', '全部课程']}>
      <span className="title-contributor"><span className="contributor-avatar">{course.contributor.slice(0, 1).toUpperCase()}</span>{course.contributor}</span>
    </PageTitle>
    <section className="section tight" aria-labelledby="pack-list-title">
      <div className="section-heading"><div><span className="eyebrow">PRACTICE COLLECTION</span><h2 id="pack-list-title">在线练习</h2><p>{promotion ? '限时免费期间全部题包开放，随时开始。' : '选择一套题包，按照自己的节奏开始。'}</p></div><Badge>{packs.length} 个题包</Badge></div>
      {packs.length === 0 ? <Empty>本课程暂无可在线作答的题包。</Empty> : <ul className="record-list pack-list">
        {packs.map((row, index) => <li key={row.id} className="record-row">
          <span className="pack-index">{String(index + 1).padStart(2, '0')}</span>
          <div className="record-content"><h3><Link href={`/packs/${segment(row.id)}`}>{row.title}</Link></h3><p>{row.itemCount} 道题 · 贡献者 {row.contributor}</p></div>
          <Badge positive={Boolean(row.starterRank) || Boolean(promotion)}>{promotion ? '限时免费' : row.starterRank ? '限次免费' : '需要授权'}</Badge>
          <Link className="button secondary" href={`/packs/${segment(row.id)}`}>查看题包 <span aria-hidden="true">→</span></Link>
        </li>)}
      </ul>}
    </section>
    {papers && <section className="section tight" aria-labelledby="papers-title">
      <div className="section-heading">
        <div><span className="eyebrow">RAW PAPERS</span><h2 id="papers-title">原始试卷</h2><p>{papers.fileCount} 份原始试卷与答案，登录后可查看原件。</p></div>
        <Link className="button secondary" href={`/resources/${papers.id}`}>打开资料 <span aria-hidden="true">→</span></Link>
      </div>
    </section>}
    {selected && boards && <section id="leaderboards" className="section" aria-labelledby="boards-title">
      <div className="section-heading"><div><span className="eyebrow">LEADERBOARD</span><h2 id="boards-title">练习榜单</h2><p>{selected.title}</p></div></div>
      <div className="inline selector" aria-label="切换榜单题包">{packs.map(row => <Link key={row.id} href={`${courseHref(course.slug)}?pack=${segment(row.id)}#leaderboards`} className={`button ${row.id === selected.id ? 'primary' : 'secondary'}`} aria-current={row.id === selected.id ? 'true' : undefined}>{row.title}</Link>)}</div>
      {!boards.ok ? <Problem error={boards.error} /> : <div className="two-col">
        <Board title="首答榜" detail="每位同学的首次交卷成绩。" rows={boards.value[0]} />
        <Board title="熟练榜" detail="最近三次有效练习中的最佳成绩。" rows={boards.value[1]} />
      </div>}
    </section>}
  </>;
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '../../src/db';
import { listSubmissions } from '../../src/domains/review';
import { Badge, Empty, PageTitle, Problem, Status } from '../_components/ui';
import { segment } from '../_lib/presentation';
import { canReview, pageUser, readResult, sandboxEnabled } from '../_lib/web';

export const metadata = { title: '题包审核' };

export default async function Review() {
  const user = await pageUser();
  if (!canReview(user.role)) notFound();
  const result = await readResult(async () => listSubmissions(await getDb(), user.id));
  return <>
    <PageTitle title="题包审核" description="核对题目质量、答案与授权说明后，再决定是否发布。" back={['/', '课程题库']}>
      {sandboxEnabled() && <Link href="/sandbox#sandbox-review" className="button secondary">沙箱订单审核</Link>}
    </PageTitle>
    {!result.ok ? <Problem error={result.error} /> : result.value.length === 0 ? <Empty>目前没有等待审核的投稿。</Empty> : <ul className="record-list">
      {result.value.map(row => <li key={row.id} className="record-row">
        <div className="record-content"><h3>{row.title}</h3><p>{row.itemCount} 道题 · {row.licenseNote}</p></div>
        <Status value={row.status} />{row.authorId === user.id ? <Badge>不能审核本人投稿</Badge> : <Link className="button secondary" href={`/review/${segment(row.id)}`}>查看投稿</Link>}
      </li>)}
    </ul>}
  </>;
}

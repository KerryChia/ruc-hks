import { notFound } from 'next/navigation';
import { getDb } from '../../../src/db';
import { getSubmission } from '../../../src/domains/review';
import { ActionForm, Submit } from '../../_components/form';
import { Badge, PageTitle, Problem, Status } from '../../_components/ui';
import { publishAction } from '../../_lib/actions';
import { optionLabel } from '../../_lib/presentation';
import { canReview, pageUser, readResult } from '../../_lib/web';

export const metadata = { title: '审核投稿' };

export default async function ReviewSubmission({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageUser();
  if (!canReview(user.role)) notFound();
  const { id } = await params;
  const result = await readResult(async () => getSubmission(await getDb(), user.id, id));
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound();
  const back: [string, string] = ['/review', '返回审核队列'];
  if (!result.ok) return <><PageTitle title="审核投稿" back={back} /><Problem error={result.error} /></>;
  const row = result.value;
  return <>
    <PageTitle title={row.title} back={back}><Status value={row.status} /></PageTitle>
    <div className="panel section tight"><h2>授权说明</h2><p>{row.licenseNote}</p></div>
    {row.status === 'reviewing' && <section className="section exercise" aria-labelledby="review-questions">
      <h2 id="review-questions">投稿内容（仅审核可见）</h2>
      {row.questions.map(item => <article className="panel explanation" key={item.id}>
        <h3><span className="question-number">{item.seq}</span>{item.stem}</h3>
        <ul className="read-options">{item.options.map((option, index) => <li key={index}>
          <span className="choice-letter">{optionLabel(String(index))}</span> {option} {item.answer === String(index) && <Badge positive>投稿答案</Badge>}
        </li>)}</ul>
        <p>{item.explanation}</p><p className="muted">知识点：{item.tags.join('、')}</p>
      </article>)}
      <ActionForm action={publishAction} className="form-stack">
        <input type="hidden" name="packId" value={row.id} />
        <div className="inline"><Submit name="decision" value="approve">通过并发布</Submit><Submit variant="danger" name="decision" value="reject">驳回投稿</Submit></div>
      </ActionForm>
    </section>}
  </>;
}

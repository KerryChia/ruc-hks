import { notFound } from 'next/navigation';
import { getDb } from '../../../../src/db';
import { getReadContent } from '../../../../src/domains/entitlement';
import { Badge, PageTitle, Problem } from '../../../_components/ui';
import { optionLabel, drillQuestions, segment } from '../../../_lib/presentation';
import { pageUser, readResult } from '../../../_lib/web';

export const metadata = { title: '阅读题目' };

export default async function ReadPack({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageUser();
  const { id } = await params;
  const result = await readResult(async () => getReadContent(await getDb(), user.id, id));
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound();
  const back: [string, string] = [`/packs/${segment(id)}`, '返回题包'];
  if (!result.ok) return <><PageTitle title="阅读题目" back={back} /><Problem error={result.error} /></>;
  return <>
    <PageTitle title={result.value.pack.title} description="阅读模式不显示答案，不计入练习或榜单。" back={back}><Badge>只读</Badge></PageTitle>
    <div className="exercise">{drillQuestions(result.value.questions).map(question => <article className="panel explanation" key={question.id}>
      <h2><span className="question-number">{String(question.seq).padStart(2, '0')}</span>{question.stem}</h2>
      {question.body && <p className="muted">{question.body}</p>}
      {question.options.length > 0 && <ul className="read-options">{question.options.map((option, index) => <li key={index}><span className="choice-letter">{optionLabel(String(index))}</span> {option}</li>)}</ul>}
      {question.fields.length > 0 && <p className="muted">填空：{question.fields.map((field, index) => `第${index + 1}空 ${field.label}`).join('；')}</p>}
      {question.qtype === 'subjective' && <p className="muted">主观题，作答后对照参考答案自评。</p>}
    </article>)}</div>
  </>;
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '../../../src/db';
import { getAttempt } from '../../../src/domains/attempt';
import { getPack } from '../../../src/domains/catalog';
import { getRubric } from '../../../src/domains/entitlement';
import { buildReviewRows, getPracticeState, revealedForRecords } from '../../../src/domains/practice';
import { freeTokenStats, getUsage } from '../../../src/domains/ai-gateway';
import { AnswerReview, ScoreReveal } from '../../_components/answer-review';
import { PracticeDrill } from '../../_components/practice-drill';
import { ActionForm, Submit } from '../../_components/form';
import { Badge, Empty, PageTitle, Problem } from '../../_components/ui';
import { gradeAction } from '../../_lib/actions';
import { drillQuestions, segment } from '../../_lib/presentation';
import { aiEnabled, pageUser, readResult } from '../../_lib/web';

export const metadata = { title: '练习与成绩' };

export default async function Attempt({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageUser();
  const { id } = await params;
  if (!/^[\w-]{1,128}$/.test(id)) notFound();
  const db = await getDb();
  const result = await readResult(async () => getAttempt(db, user.id, id));
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound();
  if (!result.ok) return <><PageTitle title="查看练习" back={['/', '课程题库']} /><Problem error={result.error} /></>;
  const attempt = result.value;
  const packUrl = `/packs/${segment(attempt.packId)}`;

  if (attempt.status !== 'submitted') {
    const pack = await readResult(async () => getPack(db, attempt.packId));
    const records = await getPracticeState(db, user.id, attempt.packId);
    const { show, revealed } = await revealedForRecords(db, user.id, attempt.packId, records);
    return <>
      <PageTitle title={attempt.title} description="一题一卡：点选即刻判分，键盘 A–D／1–4 选中后回车提交，← → 翻题。随时可交卷。" back={[packUrl, '返回题包']}><Badge>作答中</Badge></PageTitle>
      <PracticeDrill attemptId={attempt.id} packId={attempt.packId}
        packTitle={pack.ok ? pack.value.title : attempt.title}
        packSubtitle={pack.ok ? pack.value.subtitle ?? '' : ''}
        packNotes={pack.ok ? pack.value.notes ?? '' : ''}
        mode={attempt.mode}
        questions={drillQuestions(attempt.questions)}
        initialRecords={records} initialRevealed={revealed} showExplanations={show} aiAssistant={aiEnabled()} />
    </>;
  }

  const rubric = await readResult(async () => getRubric(db, user.id, attempt.id));
  const ai = aiEnabled() ? await readResult(async () => {
    return { usage: await getUsage(db, user.id, attempt.id), stats: await freeTokenStats(db) };
  }) : null;
  const rows = rubric.ok ? buildReviewRows(rubric.value, attempt.answers ?? {}) : [];
  return <>
    <PageTitle title={attempt.title} description="练习已完成。看见结果，也看见下一次进步的方向。" back={[packUrl, '返回题包']}><Badge positive>已交卷</Badge></PageTitle>
    <section className="result-hero" aria-label="本次练习成绩">
      <div className="score-block"><span className="eyebrow">YOUR SCORE</span><div><ScoreReveal score={attempt.score ?? 0} /><span>分</span></div><p>每一次认真作答，都值得被记录。</p></div>
      <div className="result-metrics"><div><span>答对题目（客观题）</span><strong>{attempt.correct ?? '—'}<small> / {attempt.total ?? '—'}</small></strong></div><div><span>练习记录</span><strong className="result-kind">{attempt.mode === 'collection' ? '题集练习' : attempt.isFirst ? '首次交卷' : '练习已完成'}</strong></div></div>
      <span className="result-check" aria-hidden="true">✓</span>
    </section>
    <section className="section" aria-labelledby="rubric-title">
      <div className="section-heading"><div><span className="eyebrow">REVIEW & LEARN</span><h2 id="rubric-title">答题解析</h2><p>不只记住答案，也理解答案背后的思路。</p></div></div>
      {!rubric.ok ? rubric.error.code === 'RUBRIC_REQUIRES_LICENSE' ? <div className="panel locked-review"><span className="locked-icon">◇</span><div><h3>解析已为认真练习的你准备好</h3><p>取得练习或题集授权后，即可查看参考答案与完整解析。</p></div><Link className="button primary" href={packUrl}>查看题包授权</Link></div> : <Problem error={rubric.error} /> : rubric.value.length === 0 ? <Empty>此练习暂无解析。</Empty> :
        <AnswerReview rows={rows} />}
    </section>
    {aiEnabled() && <section className="panel exercise section tight ai-panel"><span className="eyebrow">AI REVIEW</span><h2>AI 讲评</h2>
      <p>基于本次作答逐题分析错因、归纳知识点，并给出下一步复习动作。同一份作答只生成一次，不影响成绩与榜单。</p>
      {ai?.ok && ai.value.usage ? <div className="ai-result">
        <pre className="feedback">{ai.value.usage.feedback}</pre>
        <p className="muted">本次{ai.value.usage.free ? '由免费 token 额度承担，未扣积分' : `费用 ${ai.value.usage.costCc} CC`}；本站免费额度已提供 {ai.value.stats.total.toLocaleString('zh-CN')} token，剩余 {ai.value.stats.remaining.toLocaleString('zh-CN')}。</p>
      </div> : <ActionForm action={gradeAction}><input name="attemptId" type="hidden" value={attempt.id} />
        <label className="scope"><input type="checkbox" name="confirmCc" value="yes" required /><span>同意生成讲评（优先使用免费 token 额度，用尽后按用量扣 CC）</span></label>
        <Submit variant="secondary">生成讲评</Submit>
      </ActionForm>}
    </section>}
    <p className="section tight"><Link className="button secondary" href={packUrl}>返回题包</Link></p>
  </>;
}

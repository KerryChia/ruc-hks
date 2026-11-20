import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '../../../src/db';
import { getCourse, getPack } from '../../../src/domains/catalog';
import { ActionForm, Submit } from '../../_components/form';
import { Badge, PageTitle, Problem } from '../../_components/ui';
import { handoffPackAction, quoteAction, startAction } from '../../_lib/actions';
import { courseHref, segment } from '../../_lib/presentation';
import { promotionDeadline, currentPromotion } from '../../_lib/promotion';
import { currentUser, readResult } from '../../_lib/web';

export const metadata = { title: '题包详情' };

export default async function Pack({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[\w-]{1,128}$/.test(id)) notFound();
  const result = await readResult(async () => {
    const db = await getDb();
    const pack = await getPack(db, id);
    const course = await getCourse(db, pack.courseId);
    return { pack, course };
  });
  if (!result.ok && result.error.code === 'NOT_FOUND') notFound();
  if (!result.ok) return <><PageTitle title="题包详情" back={['/', '课程题库']} /><Problem error={result.error} /></>;
  const { pack: row, course } = result.value;
  const coursePath = courseHref(course.slug);
  const user = await currentUser();
  const promotion = await currentPromotion();
  return <>
    <PageTitle title={row.title} back={[coursePath, `返回${course.name}`]} description={`${row.itemCount} 道题 · 贡献者 ${row.contributor}`}>
      <Badge positive={Boolean(row.starterRank) || Boolean(promotion) || row.isSample}>{promotion ? '限时免费' : row.isSample ? '免费样例 · 无需授权' : row.starterRank ? '限次免费作答' : '练习须授权'}</Badge>
    </PageTitle>
    <div className="pack-detail-grid">
      <section className="panel practice-panel pack-start-card">
        <span className="eyebrow">READY WHEN YOU ARE</span><h2>准备好开始了吗？</h2>
        <p>{row.isSample ? '完整免费样例：一题一卡即时判分，键盘 ← → 翻题，错题收藏自动保存，随时交卷出成绩。' : '交卷前只展示题干与选项。完成后即可查看得分，取得授权后可继续查看答案与解析。'}</p>
        <div className="pack-facts"><div><strong>{row.itemCount}</strong><span>精选题目</span></div><div><strong>∞</strong><span>按自己的节奏</span></div><div><strong>↗</strong><span>交卷即出成绩</span></div></div>
        {user ? <ActionForm action={startAction}><input type="hidden" name="packId" value={row.id} /><Submit className="start-button">开始作答 <span aria-hidden="true">→</span></Submit></ActionForm>
          : <Link className="button primary start-button" href="/login">登录后开始 <span aria-hidden="true">→</span></Link>}
        <Link className="back leaderboard-link" href={`${coursePath}?pack=${segment(row.id)}#leaderboards`}>看看这道题的练习榜单 <span aria-hidden="true">↗</span></Link>
      </section>
      <aside className="pack-side">
        {row.isSample ? <section className="panel license-panel"><span className="eyebrow">ACCESS</span><h2>免费样例</h2>
          <p>这套题包是完整开放的教学样例：无需授权即可练习与题集作答，交卷后也能直接查看答案解析。</p>
          <p className="muted">错题本、收藏与作答进度会保存在你的账户里，换设备也不会丢。</p>
        </section> : <section className="panel license-panel"><span className="eyebrow">ACCESS</span><h2>{promotion ? '限时免费' : '题包授权'}</h2>
          {promotion ? <>
            <p>活动期间全部题包免费开放：无需授权即可练习、阅读与题集作答，交卷后也能直接查看答案解析。</p>
            <p className="muted">活动至 {promotionDeadline(promotion)}。结束后恢复原授权规则，已获得的授权继续有效。</p>
          </> : <>
          <p>{row.starterRank ? '此题包每 30 天可免费打开两次，查看解析需授权。' : '已取得练习授权可直接开始；尚未授权可在此获取报价。'}</p>
          <p className="muted">生成报价不扣费。核对授权和 CC 金额后，再确认兑换。</p>
          {user ? <ActionForm action={quoteAction}>
            <input type="hidden" name="packId" value={row.id} />
            <label className="field">授权类型<select name="license" defaultValue="practice"><option value="practice">练习</option><option value="read">阅读</option><option value="collection">题集</option></select></label>
            <Submit variant="secondary">查看报价 <span aria-hidden="true">→</span></Submit>
          </ActionForm> : <Link className="button secondary" href="/login">登录后获取报价</Link>}
          </>}
        </section>}
        {user && <details className="more-modes"><summary>其他练习模式 <span>＋</span></summary>
          <p className="muted">阅读与题集模式均不计入榜单。</p>
          <div className="inline"><Link className="button secondary" href={`/packs/${segment(row.id)}/read`}>阅读题目</Link>
            <ActionForm action={startAction}><input type="hidden" name="packId" value={row.id} /><input type="hidden" name="mode" value="collection" /><Submit variant="secondary">题集作答</Submit></ActionForm></div>
        </details>}
      </aside>
    </div>
    <section className="section handoff-section" aria-labelledby="agent-handoff">
      <div className="section-heading">
        <div><span className="eyebrow">HAND TO YOUR AGENT</span><h2 id="agent-handoff">让本机 Agent 打开这套题</h2>
          <p>生成一段带一次性口令的话，粘给你的 Claude / Cursor / 任意 MCP 客户端。Agent 凭口令取题并当助教，拿不到你的密码，也读不到账户里别的东西。</p></div>
        <Link href="/mcp" className="back">接入说明 →</Link>
      </div>
      {user ? <div className="handoff-generate"><ActionForm action={handoffPackAction}>
        <input type="hidden" name="packId" value={row.id} /><Submit>生成 Agent 口令</Submit>
      </ActionForm></div> : <div className="handoff-generate"><Link className="button secondary" href="/login">登录后生成口令</Link></div>}
    </section>
  </>;
}

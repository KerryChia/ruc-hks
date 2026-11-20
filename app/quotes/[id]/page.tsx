import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '../../../src/db';
import { balances } from '../../../src/domains/credit';
import { getQuote } from '../../../src/domains/entitlement';
import { ActionForm, Submit } from '../../_components/form';
import { Badge, PageTitle, Problem } from '../../_components/ui';
import { buyAction, startAction } from '../../_lib/actions';
import { formatDate, licenseName, segment } from '../../_lib/presentation';
import { pageUser, readResult } from '../../_lib/web';

export const metadata = { title: '确认授权报价' };

export default async function Quote({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageUser();
  const { id } = await params;
  const result = await readResult(async () => {
    const db = await getDb();
    return { quote: await getQuote(db, user.id, id), balance: (await balances(db, user.id)).CC };
  });
  if (!result.ok) {
    if (result.error.code === 'NOT_FOUND') notFound();
    return <><PageTitle title="授权报价" back={['/', '课程题库']} /><Problem error={result.error} /></>;
  }
  const { quote, balance } = result.value;
  const packUrl = `/packs/${segment(quote.packId)}`;
  const acquired = Boolean(quote.permissionId);
  return <div className="narrow">
    <PageTitle title="确认授权报价" back={[packUrl, '返回题包']} description="浏览报价不会扣费。请核对信息，再选择是否用 CC 兑换。" />
    <section className="panel">
      <div className="title-row"><h2>{quote.title}</h2><Badge positive={acquired}>{acquired ? '授权已取得' : quote.expired ? '已过期' : '可确认'}</Badge></div>
      <dl className="details">
        <div><dt>授权类型</dt><dd>{licenseName(quote.license)}{quote.license === 'read' ? ' · 长期有效' : ' · 30 天'}</dd></div>
        <div><dt>报价</dt><dd><strong>{quote.priceCc} CC</strong></dd></div>
        <div><dt>当前余额</dt><dd>{balance} CC</dd></div>
        <div><dt>有效至</dt><dd>{formatDate(quote.expiresAt)}</dd></div>
      </dl>
      {acquired ? quote.license === 'read' ? <Link className="button primary" href={`${packUrl}/read`}>阅读题目</Link> : <ActionForm action={startAction}>
        <input type="hidden" name="packId" value={quote.packId} /><input type="hidden" name="mode" value={quote.license === 'collection' ? 'collection' : 'paper'} />
        <Submit>{quote.license === 'collection' ? '开始题集作答' : '开始作答'}</Submit>
      </ActionForm> : quote.expired ?
        <Link className="button secondary" href={packUrl}>返回题包重新报价</Link> : <ActionForm action={buyAction} key={quote.id}>
          <input type="hidden" name="quoteId" value={quote.id} />
          <p className="muted">同一授权在有效期内不会重复扣费。</p>
          <Submit>确认兑换 {quote.priceCc} CC</Submit>
        </ActionForm>}
    </section>
  </div>;
}

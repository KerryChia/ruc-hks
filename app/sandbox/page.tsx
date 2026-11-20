import { notFound } from 'next/navigation';
import { getDb } from '../../src/db';
import { listOrders, transparency } from '../../src/domains/payment';
import { ActionForm, Submit } from '../_components/form';
import { Badge, Empty, PageTitle, Problem, Status } from '../_components/ui';
import { orderAction, payAction, reviewOrderAction } from '../_lib/actions';
import { formatCents, formatDate } from '../_lib/presentation';
import { canReview, pageUser, readResult, sandboxEnabled } from '../_lib/web';

export const metadata = { title: '充值沙箱' };

export default async function Sandbox() {
  if (!sandboxEnabled()) notFound();
  const user = await pageUser();
  const reviewer = canReview(user.role);
  const result = await readResult(async () => {
    const db = await getDb();
    return Promise.all([listOrders(db, user.id), transparency(db), reviewer ? listOrders(db, user.id, true) : []]);
  });
  const counts = result.ok ? result.value[1] : null;
  return <>
    <PageTitle title="充值沙箱" description="仅模拟下单、付款与入账，未连接任何支付渠道，不会扣除真实资金。" back={['/account', '返回账户']}><Badge>模拟环境</Badge></PageTitle>
    <div className="two-col">
      <section className="panel"><h2>创建模拟订单</h2><p>系统会在所选档位上添加分位尾数，以区分订单。请勿向任何人转账。</p>
        <ActionForm action={orderAction}><label className="field">模拟充值档位<select name="amount" defaultValue="10"><option value="10">¥10 · 1,000 CC</option><option value="30">¥30 · 3,300 CC</option><option value="49">¥49 · 5,700 CC</option></select></label><Submit>创建订单</Submit></ActionForm>
      </section>
      <section className="panel"><h2>沙箱入账统计</h2><p>仅审核通过的订单计入已入账金额。</p>
        {counts && <dl className="details"><div><dt>已入账 · {counts.creditedCount} 笔</dt><dd>{formatCents(counts.creditedCents)}</dd></div><div><dt>待审核 · {counts.pendingCount} 笔</dt><dd>{formatCents(counts.pendingCents)}</dd></div></dl>}
      </section>
    </div>
    {!result.ok ? <Problem error={result.error} /> : <>
      <section className="section" aria-labelledby="own-orders"><h2 id="own-orders">我的沙箱订单</h2>
        {result.value[0].length === 0 ? <Empty>暂无订单，可在上方选择档位进行模拟。</Empty> : <ul className="record-list">{result.value[0].map(row => <li key={row.id} className="record-row order-row">
          <div className="record-content"><h3>{formatCents(row.amountCents)} <small>模拟金额</small></h3><p>{formatDate(row.createdAt)} · 编号 {row.id}</p></div>
          <Status value={row.status} />
          {row.status === 'awaiting_payment' && <ActionForm action={payAction}><input type="hidden" name="orderId" value={row.id} /><Submit variant="secondary">标记模拟付款</Submit></ActionForm>}
        </li>)}</ul>}
      </section>
      {reviewer && <section className="section" id="sandbox-review" aria-labelledby="sandbox-review-title"><h2 id="sandbox-review-title">审核模拟付款</h2>
        {result.value[2].length === 0 ? <Empty>暂无待审核付款。</Empty> : <ul className="record-list">{result.value[2].map(row => <li key={row.id} className="record-row order-row">
          <div className="record-content"><h3>{formatCents(row.amountCents)} <small>模拟金额</small></h3><p>{formatDate(row.createdAt)} · 编号 {row.id}</p></div>
          {row.userId === user.id ? <Badge>本人订单不可审核</Badge> : <ActionForm action={reviewOrderAction}>
            <input type="hidden" name="orderId" value={row.id} /><div className="inline"><Submit name="decision" value="approve">批准入账</Submit><Submit variant="danger" name="decision" value="reject">驳回</Submit></div>
          </ActionForm>}
        </li>)}</ul>}
      </section>}
    </>}
  </>;
}

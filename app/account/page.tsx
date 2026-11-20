import Link from 'next/link';
import { getDb } from '../../src/db';
import { recentAttempts } from '../../src/domains/attempt';
import { balances, history } from '../../src/domains/credit';
import { listInvites } from '../../src/domains/identity';
import { listHandoffs } from '../../src/domains/handoff';
import { ActionForm, Submit } from '../_components/form';
import { Badge, Empty, PageTitle, Problem, Status } from '../_components/ui';
import { handoffCatalogAction, inviteAction, quoteLookupAction, revokeHandoffAction, tokenAction } from '../_lib/actions';
import { formatDate, MCP_SCOPES, segment } from '../_lib/presentation';
import { currentPromotion } from '../_lib/promotion';
import { pageUser, readResult, sandboxEnabled } from '../_lib/web';

export const metadata = { title: '我的学习' };

const reasons: Record<string, string> = {
  invite_signup: '邀请码注册奖励', invite_reward: '邀请好友奖励', unlock_pack: '兑换题包授权', topup: '沙箱充值', topup_bonus: '沙箱充值赠送',
  ai_charge: 'AI 讲评', ai_reserve: '点评费用预留', ai_release: '退回点评费用预留',
  upload_reward: '投稿发布奖励', upload_final: '投稿奖励结算', upload_reputation: '投稿贡献奖励', agent_handoff: 'Agent 口令开卷',
  reward_over_cap: '超额奖励转为 RP', quality_penalty: '投稿质量扣分',
};

export default async function Account() {
  const user = await pageUser();
  const promotion = await currentPromotion();
  const result = await readResult(async () => {
    const db = await getDb();
    return Promise.all([balances(db, user.id), history(db, user.id), recentAttempts(db, user.id), listInvites(db, user.id), listHandoffs(db, user.id)]);
  });
  const role = { student: '学生', reviewer: '审核员', admin: '管理员' }[user.role];
  return <>
    <PageTitle title={`你好，${user.displayName}`} description={user.email}><Badge>{role}</Badge></PageTitle>
    {result.ok ? <>
      <div className="wallet-grid">
        <section className="wallet-card cc"><span className="wallet-icon">CC</span><div><span>可用积分</span><strong>{result.value[0].CC}</strong><small>{promotion ? '限时免费期间练习不扣 CC' : '用于兑换授权与练习点评'}</small></div>{sandboxEnabled() && <Link href="/sandbox">充值沙箱 ↗</Link>}</section>
        <section className="wallet-card rp"><span className="wallet-icon">RP</span><div><span>贡献积分</span><strong>{result.value[0].RP}</strong><small>每一次优质分享的印记</small></div><Link href="/upload">贡献题包 ↗</Link></section>
      </div>
      <section className="section" aria-labelledby="recent-attempts"><div className="section-heading"><div><span className="eyebrow">KEEP GOING</span><h2 id="recent-attempts">最近练习</h2></div><Link href="/#courses" className="back">发现更多练习 →</Link></div>
        {result.value[2].length === 0 ? <Empty>暂无练习。<Link href="/#courses">前往课程题库</Link>，开始你的第一次练习。</Empty> :
        <ul className="record-list">{result.value[2].map(row => <li className="record-row" key={row.id}>
          <span className={`attempt-dot ${row.status}`} aria-hidden="true" />
          <div className="record-content"><h3>{row.title}</h3><p>{formatDate(row.startedAt)}</p></div><Status value={row.status} />
          <Link className="button secondary" href={`/attempts/${segment(row.id)}`}>{row.status === 'submitted' ? '查看成绩' : '继续作答'}</Link>
        </li>)}</ul>}
      </section>
      <section className="section" aria-labelledby="ledger"><div className="section-heading"><div><span className="eyebrow">ACTIVITY</span><h2 id="ledger">积分流水</h2></div></div>
        {result.value[1].length === 0 ? <Empty>暂无积分变动记录。</Empty> : <div className="panel table-scroll"><table aria-labelledby="ledger"><thead><tr><th scope="col">时间</th><th scope="col">事项</th><th scope="col">变动</th></tr></thead>
          <tbody>{result.value[1].map((entry, index) => <tr key={index}><td>{formatDate(entry.createdAt)}</td><td>{reasons[entry.reason] ?? entry.reason}</td><td className={entry.delta > 0 ? 'credit-add' : ''}>{entry.delta > 0 ? '+' : ''}{entry.delta} {entry.currency}</td></tr>)}</tbody>
        </table></div>}
      </section>
    </> : <Problem error={result.error} />}
    {result.ok && <section className="section invite-section" aria-labelledby="invite-friends">
      <div className="section-heading"><div><span className="eyebrow">INVITE FRIENDS</span><h2 id="invite-friends">邀请同学</h2><p>生成一条带邀请码的注册链接。被邀请者仍需完成校园邮箱验证码验证，邀请码会自动填入。</p></div></div>
      <div className="invite-panel">
        <div className="invite-panel-copy"><span className="invite-panel-icon">+30</span><div><strong>邀请新同学，双方各得 30 CC</strong><p>被邀请者注册后先获得 30 CC 起始额度；等他首次开卷（免费卷或已解锁的题包）或使用 AI 讲评后，你也会获得 30 CC。链接 30 天内有效，仅可使用一次。</p></div></div>
        <ActionForm action={inviteAction} className="invite-generate"><Submit>生成邀请链接</Submit></ActionForm>
      </div>
      {result.value[3].length > 0 && <ul className="invite-history">
        <li className="invite-history-head"><span>生成时间</span><span>状态</span><span>有效期</span></li>
        {result.value[3].map((invite, index) => {
          const expired = !invite.usedAt && new Date(invite.expiresAt).getTime() <= Date.now();
          return <li key={index}><span>{formatDate(invite.createdAt)}</span><span className={invite.usedAt ? 'invite-used' : expired ? 'invite-expired' : 'invite-active'}>{invite.usedAt ? `已由 ${invite.usedBy ?? '同学'} 使用` : expired ? '已过期' : '待使用'}</span><span>{formatDate(invite.expiresAt)} 前</span></li>;
        })}
      </ul>}
    </section>}
    <details className="advanced-settings section"><summary><span><strong>高级设置</strong><small>MCP 令牌与 Agent 报价</small></span><span>展开 +</span></summary>
      <div className="two-col">
        <div className="panel"><h2>MCP 令牌</h2><p>仅勾选客户端需要的权限。令牌只展示一次；使用自己的 AI 客户端，不通过令牌消耗站内 AI 额度。</p>
          <ActionForm action={tokenAction}>
            <fieldset className="proof"><legend>授予权限</legend><div className="scope-list">{MCP_SCOPES.map(([scope, label]) => <label className="scope" key={scope}>
              <input name="scope" value={scope} type="checkbox" /><span>{label} <small><code>{scope}</code></small></span>
            </label>)}</div></fieldset>
            <Submit name="intent" value="create">创建令牌</Submit>
            <details><summary>撤销全部 MCP 令牌</summary><p className="muted">撤销后，使用这些令牌的客户端必须重新配置。</p><Submit variant="danger" name="intent" value="revoke">确认撤销全部</Submit></details>
          </ActionForm>
        </div>
        <div className="panel"><h2>查看 Agent 报价</h2><p>Agent 不能直接扣费。粘贴它返回的报价编号，在网页核对并确认兑换。</p>
          <ActionForm action={quoteLookupAction}>
            <label className="field">报价编号<input name="quoteId" required maxLength={36} autoComplete="off" spellCheck={false} /></label>
            <Submit variant="secondary">查看报价</Submit>
          </ActionForm>
        </div>
      </div>
      <div className="handoff-panel">
        <div className="handoff-panel-copy">
          <h2>Agent 口令（免配置）</h2>
          <p>不填客户端配置，只把一段话粘给 Agent。口令 30 分钟内有效，只能买一套题，预算用完即止；失效后可随时撤销。</p>
        </div>
        <ActionForm action={handoffCatalogAction} className="handoff-catalog-form">
          <label className="field">可花预算<select name="budget" defaultValue="10"><option value="5">5 CC · 一套练习</option><option value="10">10 CC · 预留解析余量</option><option value="20">20 CC · 宽松上限</option></select></label>
          <Submit variant="secondary">生成目录口令</Submit>
        </ActionForm>
        <ActionForm action={revokeHandoffAction} className="handoff-revoke"><Submit variant="quiet">撤销全部口令</Submit></ActionForm>
      </div>
      {result.ok && result.value[4].length > 0 && <ul className="invite-history handoff-history">
        <li className="invite-history-head"><span>生成时间</span><span>范围</span><span>状态</span></li>
        {result.value[4].map(row => {
          const expired = new Date(row.expiresAt).getTime() <= Date.now();
          const status = row.revokedAt ? '已撤销' : row.attemptId ? '已开卷' : expired ? '已过期' : '待使用';
          return <li key={row.id}><span>{formatDate(row.createdAt)}</span><span>{row.packTitle ?? '目录 · 任选一套'}</span><span className={status === '待使用' ? 'invite-active' : 'invite-expired'}>{status}</span></li>;
        })}
      </ul>}
      <p className="handoff-doc-link"><Link href="/mcp">查看三种接入方式与客户端配置片段 →</Link></p>
    </details>
  </>;
}

import Link from 'next/link';
import { CopyBlock } from '../_components/copy-block';
import { Badge, PageTitle } from '../_components/ui';

export const metadata = {
  title: 'Agent 接入',
  description: '把 ExamHub 题库接入 Claude、Cursor 或任意 MCP 客户端：一次性口令、长期令牌与本机 stdio 三种方式。',
};

const origin = 'https://examhub.kerrychia.site';
const PLACEHOLDER = 'EH-7QK3-M9XT-2P4L-7DVN';

const httpConfig = `{
  "mcpServers": {
    "examhub": {
      "type": "http",
      "url": "${origin}/api/mcp",
      "headers": { "Authorization": "Bearer ${PLACEHOLDER}" }
    }
  }
}`;

const desktopConfig = `{
  "mcpServers": {
    "examhub": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "${origin}/api/mcp",
        "--header", "Authorization: Bearer ${PLACEHOLDER}"
      ]
    }
  }
}`;

const curlProbe = `curl -s ${origin}/api/mcp \\
  -H "Authorization: Bearer ${PLACEHOLDER}" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;

const handoffTools: [string, string][] = [
  ['handoff_status', '看这个口令能做什么：绑定的题、剩余预算、有效期'],
  ['list_packs', '目录口令专用：列已上架题包，挑一套'],
  ['open_pack', '扣费并开卷，返回题干与选项（不含答案）；重复调用不重复扣'],
  ['submit_attempt', '交卷，服务端判分'],
  ['get_result', '读成绩'],
  ['get_grading_rubric', '交卷后读答案与解析，用来复盘'],
  ['get_balances', '读 CC / RP 余额'],
];

const tokenTools: [string, string][] = [
  ['get_profile', '读校区与昵称'],
  ['search_packs / get_pack / get_leaderboard', '搜题包、看元信息、看双榜'],
  ['quote_pack / acquire_pack', '出报价；购买必须先在浏览器批准报价'],
  ['get_pack_content / submit_attempt', '开卷拉题、交卷判分'],
  ['get_result / get_grading_rubric', '成绩与解析'],
  ['get_balances / get_credit_history', '余额与流水'],
];

export default function McpPage() {
  return <>
    <PageTitle title="把你的 AI 变成 ExamHub 助教" description="ExamHub 用 MCP 把题库、判卷和积分开放给任何客户端。平台不卖模型算力：模型用你自己的，站内只提供内容与服务端评分。">
      <Badge>MCP Streamable HTTP</Badge>
    </PageTitle>

    <section className="section mcp-intro">
      <div className="mcp-cards">
        <article className="panel mcp-card">
          <span className="eyebrow">01 / 最省事</span>
          <h2>一次性口令</h2>
          <p>在任意题包页点「生成 Agent 口令」，得到一段话。整段复制，粘给你的 Agent 即可，不用改任何配置文件。</p>
          <ul><li>30 分钟有效，只对应一套题</li><li>扣费有上限，开卷后才延长到 2 小时</li><li>拿不到密码、账户资料或其他题</li></ul>
          <Link className="button secondary" href="/#courses">去挑一套题 →</Link>
        </article>
        <article className="panel mcp-card">
          <span className="eyebrow">02 / 每天用</span>
          <h2>长期令牌</h2>
          <p>在账户页按权限创建令牌，7 天过期，可随时全部撤销。适合装进 Cursor、Claude Desktop 反复使用。</p>
          <ul><li>6 个权限域，按需勾选</li><li>购买题包必须由你在浏览器批准报价</li><li>令牌只展示一次，库内只存哈希</li></ul>
          <Link className="button secondary" href="/account">创建令牌 →</Link>
        </article>
        <article className="panel mcp-card">
          <span className="eyebrow">03 / 自建</span>
          <h2>本机 stdio</h2>
          <p>在应用运行环境内用 stdio 启动，适合自己写客户端或做离线实验，令牌通过环境变量传入。</p>
          <ul><li>进程内直连数据库</li><li>不需要公网入口</li><li>同样受权限与每日额度约束</li></ul>
          <Link className="back" href="#stdio">看启动命令 ↓</Link>
        </article>
      </div>
    </section>

    <section className="section" id="handoff" aria-labelledby="handoff-title">
      <div className="section-heading"><div><span className="eyebrow">FASTEST PATH</span><h2 id="handoff-title">三步：从题包到 AI 助教</h2><p>整个过程不需要命令行，也不需要理解 MCP 协议。</p></div></div>
      <ol className="mcp-steps">
        <li><strong>挑一套题</strong><span>在课程页进入任意题包，右侧点「生成 Agent 口令」。</span></li>
        <li><strong>复制整段话</strong><span>这段话里已经写好口令、接入地址、先调哪个工具，以及费用与有效期。</span></li>
        <li><strong>粘给 Agent</strong><span>Agent 会先确认范围，再扣费开卷，然后用它自己的模型逐题讲解、追问、批改。</span></li>
      </ol>
      <CopyBlock label="这段话长这样（口令是示例，已失效）" value={`用 ExamHub 帮我做这套题：数据结构 · 基础练习 A
口令：${PLACEHOLDER}

接入：把这个口令当作 Bearer 令牌，连接 ${origin}/api/mcp（MCP Streamable HTTP，不需要 OAuth）。
第一步调用 handoff_status 确认题目与费用；第二步调用 open_pack 取题（本次最多扣 5 CC；仍在免费额度内则不扣）。
拿到题目后，请用你自己的模型逐题讲解、追问、按知识点补练习；交卷调用 submit_attempt，之后可以用 get_grading_rubric 复盘错题。

边界：口令在 30 分钟内有效，只对应这一套题；开卷后 2 小时内可交卷。不要转发到群聊，也不要把口令回显给我。`} note="口令只存哈希，页面关闭后无法再次查看；丢了就重新生成，旧的会在 30 分钟后自动失效。" />
    </section>

    <section className="section" id="config" aria-labelledby="config-title">
      <div className="section-heading"><div><span className="eyebrow">CLIENT CONFIG</span><h2 id="config-title">客户端配置片段</h2><p>把占位口令替换成你自己的令牌或口令。长期令牌在账户页生成。</p></div></div>
      <div className="two-col">
        <CopyBlock label="Cursor / VS Code（HTTP）" value={httpConfig} note="写入 .cursor/mcp.json 或对应的 MCP 配置位置，重启客户端。" />
        <CopyBlock label="Claude Desktop（经 mcp-remote）" value={desktopConfig} note="需要本机有 Node.js；首次运行会下载 mcp-remote。" />
      </div>
      <div className="two-col mcp-config-row">
        <CopyBlock label="命令行自检" value={curlProbe} note="返回工具列表即说明令牌有效；401 表示口令过期或写错了。" />
        <div className="panel" id="stdio">
          <span className="eyebrow">STDIO</span><h2>本机进程</h2>
          <p>在上海实例或本地开发环境内直接启动，令牌放环境变量，不要写进命令行历史。</p>
          <CopyBlock label="启动命令" value={`EXAMHUB_MCP_TOKEN=${PLACEHOLDER} npm run --silent mcp`} note="stdio 进程需要与应用相同的 DATABASE_URL。" />
        </div>
      </div>
    </section>

    <section className="section" aria-labelledby="tools-title">
      <div className="section-heading"><div><span className="eyebrow">TOOLS</span><h2 id="tools-title">Agent 能做什么</h2><p>口令与长期令牌挂载的是两套不同的工具集：口令更窄，令牌更全。</p></div></div>
      <div className="two-col">
        <div className="panel table-scroll"><table aria-label="口令模式工具"><thead><tr><th scope="col">口令模式</th><th scope="col">作用</th></tr></thead>
          <tbody>{handoffTools.map(([name, use]) => <tr key={name}><td><code>{name}</code></td><td>{use}</td></tr>)}</tbody>
        </table></div>
        <div className="panel table-scroll"><table aria-label="账户令牌工具"><thead><tr><th scope="col">账户令牌</th><th scope="col">作用</th></tr></thead>
          <tbody>{tokenTools.map(([name, use]) => <tr key={name}><td><code>{name}</code></td><td>{use}</td></tr>)}</tbody>
        </table></div>
      </div>
    </section>

    <section className="section" aria-labelledby="safety-title">
      <div className="section-heading"><div><span className="eyebrow">BOUNDARIES</span><h2 id="safety-title">安全边界</h2></div></div>
      <ul className="mcp-boundaries">
        <li><strong>不卖算力。</strong>没有 <code>ai_grade</code> 工具，Agent 的讲解与批改都跑在它自己的模型上；站内 AI 讲评只面向网页作答的用户。</li>
        <li><strong>答案不在题里。</strong>拉题只返回题干与选项；交卷后、且授权有效、版本一致时才给解析。</li>
        <li><strong>分数由服务端算。</strong>客户端自称的分数不进榜，首答由数据库唯一索引保证只记一次。</li>
        <li><strong>口令是消费凭证。</strong>它能扣的 CC 不超过生成时设定的预算，只对应一套题；泄露的直接后果有上限。</li>
        <li><strong>还没做 OAuth。</strong>目前是手工令牌，OAuth 2.1 与动态发现仍在路线图上；因此令牌要当密码保管。</li>
      </ul>
    </section>

    <section className="section mcp-cta">
      <div><h2>先试一次口令，再决定要不要配令牌</h2><p>口令模式最适合演示与合作：一段话发过去，对方就能用他自己的 AI 做你这套题。</p></div>
      <div className="inline"><Link className="button primary" href="/#courses">挑一套题生成口令</Link><Link className="button secondary" href="/account">管理令牌与口令</Link></div>
    </section>
  </>;
}

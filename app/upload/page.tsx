import { getDb } from '../../src/db';
import { listCourses } from '../../src/domains/catalog';
import { CopyBlock } from '../_components/copy';
import { ActionForm, Submit } from '../_components/form';
import { Badge, Empty, PageTitle, Problem } from '../_components/ui';
import { uploadAction } from '../_lib/actions';
import { pageUser, readResult } from '../_lib/web';

export const metadata = { title: '投稿题包' };
const example = JSON.stringify({ questions: [{ stem: '栈遵循什么顺序？', options: ['后进先出', '先进先出'], answer: '0', explanation: '后放入的元素最先从栈顶取出。', tags: ['线性结构'] }] }, null, 2);
const specUrl = 'https://examhub.kerrychia.site/upload/format.md';
const agentPrompt = `我要把一些题目材料投稿到 ExamHub（校园题库站）。

第一步，请先完整读取格式规范：
${specUrl}

第二步，按规范把下面的材料整理成题包 JSON：
1. 只输出一个 JSON 文件，结构为 {"questions":[...]}，UTF-8 编码，不超过 512 KB，题目数量 1–100 道。
2. 只支持选项题：判断题写成两个选项（如"正确"/"错误"）并用 "0"/"1" 作答案；不要生成填空题或主观题。
3. 每题必须有 stem、options（2–6 个且互不相同）、answer（字符串下标）、explanation（尽量 30 字以上）、tags（1–5 个）。
4. tags 只能从规范里对应课程的词表中挑选，不要自造；同时告诉我你选的 courseId 和课程名。
5. 不要编造材料里没有的题目，题干和选项照原文整理；解析缺失时用自己的话补写。
6. 完成后告诉我：建议标题、10–500 字的授权说明草稿、题目数量与知识点分布，并把 JSON 存成 examhub-pack.json。

我的材料如下（文件路径、粘贴文本或图片都可以）：
<<把材料贴在这里，或告诉我文件在哪个路径>>`;

export default async function Upload() {
  await pageUser();
  const result = await readResult(async () => listCourses(await getDb()));
  const eligibleCourses = result.ok ? result.value.filter(course => course.tags.length > 0) : [];
  return <>
    <PageTitle title="投稿题包" description="仅投稿原创或已取得授权的练习，不上传真实考试试卷、未授权资料或个人信息。" back={['/', '课程题库']}><Badge>发布前审核</Badge></PageTitle>
    <div className="two-col">
      <section className="panel"><h2>题包信息</h2>
        {!result.ok ? <Problem error={result.error} /> : eligibleCourses.length === 0 ? <Empty>暂无已配置投稿知识点的课程，请联系管理员。</Empty> :
          <ActionForm action={uploadAction}>
            <label className="field">所属课程<select name="courseId" defaultValue="" required><option value="" disabled>请选择课程</option>{eligibleCourses.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select><small>仅列出已配置投稿知识点的课程。</small></label>
            <label className="field">题包标题<input name="title" required minLength={2} maxLength={100} /></label>
            <label className="field">授权说明<textarea name="licenseNote" rows={4} required minLength={10} maxLength={500} placeholder="例如：本人原创并授权在本站供学习练习使用。" /></label>
            <label className="field">题目文件<input name="json" type="file" accept=".json,application/json" required /><small>UTF-8 编码，最大 512 KB。</small></label>
            <Submit>提交审核</Submit>
          </ActionForm>}
      </section>
      <section className="panel sample"><h2>JSON 格式示例</h2><p>每道题提供题干、选项、答案、解析和知识点。答案用从 <code>0</code> 开始的字符串下标。</p><pre>{example}</pre>
        {eligibleCourses.length > 0 && <details><summary>查看课程可用知识点</summary><dl className="details">
          {eligibleCourses.map(course => <div key={course.id}><dt>{course.name}</dt><dd>{course.tags.join('、')}</dd></div>)}
        </dl></details>}
      </section>
    </div>
    <section className="section agent-convert" aria-labelledby="agent-convert">
      <div className="section-heading"><div><span className="eyebrow">AGENT ASSIST</span><h2 id="agent-convert">让本地 Agent 先把格式转好</h2><p>把下面这段话连同材料发给你的 Agent（Claude Code、WorkBuddy、Cursor 等）。它会先读 <a href="/upload/format.md">格式规范</a>，再按课程词表把材料整理成可直接上传的 JSON。</p></div></div>
      <CopyBlock label="发给 Agent 的一段话" text={agentPrompt} rows={16}
        note={`规范地址 ${specUrl} 可直接被 Agent 读取（Markdown，含各课程的 courseId 与知识点词表）。生成的文件请回到上方表单上传，单文件不超过 512 KB。`} />
    </section>
  </>;
}

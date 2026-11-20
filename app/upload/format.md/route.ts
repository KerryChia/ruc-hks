import { getDb } from '../../../src/db';
import { listCourses } from '../../../src/domains/catalog';

export const dynamic = 'force-dynamic';

const origin = 'https://examhub.kerrychia.site';

type Row = Awaited<ReturnType<typeof listCourses>>[number];

function spec(courses: Row[]) {
  const vocabulary = courses.map(course =>
    `| \`${course.id}\` | ${course.name} | ${course.tags.join('、')} |`).join('\n');
  return `# ExamHub 题包投稿规范（v1）

> 机器可读规范，给本地 Agent 使用。站点：${origin}　投稿页：${origin}/upload
> 读完本文件后，把用户的材料整理成第 4 节定义的 JSON，交给用户在投稿页上传。

## 1. 任务边界

- 你在帮用户把题目材料（PDF / Word / 图片 / 粘贴文本 / 已整理的题库文件）转换成 ExamHub 可以接受的题包 JSON。
- 只整理材料里真实存在的题目。**不要编造题目、不要让模型"生成"新题**。题干、选项、答案照材料原文整理。
- 材料里缺解析时，可以用自己的话补写一条简短的解析（说明考点与判断依据），不要编造与答案冲突的解释。
- 输出必须是单个 JSON 文件，UTF-8 无 BOM，不超过 512 KB。

## 2. 硬性限制

- 题目数量 1–100 道。
- **只支持选项题**：单选与判断。判断题请写成两个选项（如 \`["正确","错误"]\`），答案用 \`"0"\`（正确）或 \`"1"\`（错误）。填空、计算过程、主观论述不在本题包格式内。
- 同一套卷内不得出现重复题干（按去空白、转小写后比较）。
- 同一份题目重复投稿会被指纹去重拒绝。

## 3. 题包 JSON 结构

上传页只需要题目数组，课程、标题、授权说明在网页表单里填写。也接受带完整字段的对象，多出的字段会被忽略。

\`\`\`json
{
  "questions": [
    {
      "stem": "栈遵循什么顺序存取元素？",
      "options": ["后进先出", "先进先出", "随机存取"],
      "answer": "0",
      "explanation": "栈只在栈顶插入和删除，最后压入的元素最先弹出，因此是后进先出。",
      "tags": ["线性结构"]
    }
  ]
}
\`\`\`

### 每道题的字段

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| \`stem\` | string | 题干，2–1000 字，不要带题号前缀 |
| \`options\` | string[] | 2–6 个选项，每个 1–300 字，选项内容必须互不相同 |
| \`answer\` | string | 正确选项的下标，字符串形式，取值 \`"0"\`–\`"5"\`，必须小于选项个数 |
| \`explanation\` | string | 解析，1–4000 字；**30 字以上**才有较高奖励 |
| \`tags\` | string[] | 1–5 个知识点，必须来自第 5 节该课程的词表 |

## 4. 提交方式

1. 用户在 ${origin}/upload 选择课程、填写题包标题和授权说明，再上传这个 JSON 文件。
2. 投稿进入人工审核（待审上限 5 套），通过后才公开。审核可退回或要求修改。
3. 命令行方式（仅站点维护者）：\`npm run db -- import-pack pack.json --check\` 只校验不落库；把 \`--check\` 换成作者校园邮箱则提交审核。这种方式需要完整的 \`courseId\`、\`title\`、\`licenseNote\`，可选 \`year\`（1980–2100）与 \`sourceType\`（\`past_exam\` 或 \`mock\`）。

## 5. 课程与知识点词表

\`tags\` 只能取该课程下列词表中的原样字符串，不要自造、不要改写、不要用同义词。

| courseId | 课程 | 可用知识点 |
| --- | --- | --- |
${vocabulary}

## 6. 自查清单（输出前逐条确认）

- [ ] 文件是合法 JSON，只有一个顶层 \`questions\` 数组，没有注释、没有多余文本。
- [ ] 每题 2–6 个选项且互不相同，\`answer\` 是字符串下标且指向真实存在的选项。
- [ ] 每题至少 1 个 \`tags\`，且全部来自所选课程的词表。
- [ ] 没有重复题干；题目数量在 1–100 之间。
- [ ] 没有把填空题、主观题硬塞成选项题。
- [ ] 材料里没有姓名、学号、联系方式等个人信息。

## 7. 奖励与禁止事项

- 审核通过后按题量与解析质量发放 CC：每题解析满 30 字发 5 CC，否则 2 CC，单套上限 800 CC；同一课程、同一月份的总额另有上限，超出部分转为贡献值 RP。
- 禁止投稿：真实考试原卷、未获授权的教辅或网络资料、含个人信息的材料、需要付费才能合法传播的内容。合规责任由投稿人承担。
`;
}

export async function GET() {
  try {
    const courses = (await listCourses(await getDb())).filter(course => course.tags.length > 0);
    return new Response(spec(courses), {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'cache-control': 'public, max-age=300',
      },
    });
  } catch {
    return new Response('# ExamHub 题包投稿规范\n\n格式规范暂时无法生成，请稍后重试或直接联系站点管理员。\n',
      { status: 503, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
  }
}

// Fill in missing answer keys for parsed exam papers by asking the configured model.
// Only high-confidence, in-range options are accepted; everything else stays pending so
// a wrong guess never silently becomes an official answer.
import { readFile, writeFile } from 'node:fs/promises';
import { chat } from '../src/domains/ai/provider';

type Question = { number: number; stem: string; options: string[]; judge: boolean };
type File = { key: string; course: string; title: string; questions: Question[] };
type Answer = { index: number; why: string; confidence: string };

const system = [
  '你是中国人民大学计算机类课程的资深助教，负责为历年试卷补全选择题答案。',
  '只输出一个 JSON 对象，不要任何解释文字，不要 Markdown 代码块。',
  '输出格式：{"answers":[{"n":题号,"a":正确选项下标,"why":"不超过30字的依据","conf":"high"}]}',
  'a 是选项下标，从 0 开始。判断题为二选一，0 表示正确，1 表示错误。',
  '如果你不确定，把 conf 设为 low，不要猜。',
].join('\n');

const letter = (i: number) => String.fromCharCode(65 + i);

function buildPrompt(file: File, batch: Question[]) {
  const lines = [`课程：${file.course}`, `试卷：${file.title}`, '', '请为下列题目选出唯一正确选项：'];
  for (const q of batch) {
    lines.push(`\n【第 ${q.number} 题】${q.stem}`);
    q.options.forEach((option, i) => lines.push(`${letter(i)}. ${option}`));
  }
  return lines.join('\n');
}

function extract(text: string) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as { answers?: { n: number; a: number; why?: string; conf?: string }[] };
  } catch {
    return null;
  }
}

async function main() {
  const input = JSON.parse(await readFile(new URL('../data/exam-pending.json', import.meta.url), 'utf8')) as File[];
  const out: Record<string, Answer> = {};
  let asked = 0;
  let accepted = 0;
  let failed = 0;
  for (const file of input) {
    for (let i = 0; i < file.questions.length; i += 6) {
      const batch = file.questions.slice(i, i + 6);
      let reply: string;
      try {
        const result = await chat({ system, user: buildPrompt(file, batch), maxTokens: 1200 });
        reply = result.text;
      } catch (error) {
        failed += batch.length;
        console.error(`call failed ${file.title} @${i}: ${(error as Error).message}`);
        continue;
      }
      const parsed = extract(reply);
      if (!parsed?.answers) {
        failed += batch.length;
        console.error(`unparsable ${file.title} @${i}`);
        continue;
      }
      for (const item of parsed.answers) {
        asked += 1;
        const question = batch.find(row => row.number === item.n);
        if (!question) continue;
        if (item.conf !== 'high') continue;
        if (!Number.isInteger(item.a) || item.a < 0 || item.a >= question.options.length) continue;
        accepted += 1;
        out[`${file.key}#${question.number}`] = { index: item.a, why: (item.why ?? '').slice(0, 60), confidence: item.conf };
      }
      console.log(`${file.title} @${i}: ${parsed.answers.length} returned`);
    }
  }
  const target = process.env.ANSWERS_OUT ?? '/tmp/exam-answers.json';
  await writeFile(target, JSON.stringify(out, null, 1), 'utf8');
  console.log(`asked=${asked} accepted=${accepted} failed=${failed} total=${Object.keys(out).length}`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});

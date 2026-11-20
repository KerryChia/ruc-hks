// Import the complete quiz.kerrychia.site question bank (extracted to data/dsa-bank.json)
// as the free sample course on the homepage. Idempotent: re-running replaces the packs'
// questions and drill records in place without touching unrelated content.
import { readFile } from 'node:fs/promises';
import { closeDb, getDb } from '../src/db';
import { insertBankQuestions, type BankQuestionInput } from '../src/domains/catalog';

type BankPack = { id: string; head: string; name: string; short: string; subtitle: string; notes: string };
type BankField = { label: string; kind: string; answer: string; accepted?: string[]; displayAnswer?: string };
type BankQuestion = {
  id: string; pack: string; type: 'choice' | 'judge' | 'fill' | 'subjective';
  correct: string; stem: string; body: string; explanation: string;
  fields: BankField[]; options: { value: string; text: string }[];
};

const courseId = '30000000-0000-4000-8000-000000000001';
const packIdFor = (index: number) => `30000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`;
// 原文真题卷按资料归类；模拟卷用 mock，其余板块是课程课件练习。
const sourceTypeFor = (packId: string) => packId === 'T' || packId === 'U' ? 'past_exam' : ['P', 'Q', 'R'].includes(packId) ? 'mock' : 'courseware';

async function main() {
  const bank = JSON.parse(await readFile(new URL('../data/dsa-bank.json', import.meta.url), 'utf8')) as {
    packs: BankPack[]; questions: BankQuestion[]; retiredIds: string[];
  };
  const db = getDb();
  const packs = bank.packs;
  const packMeta = new Map(packs.map(pack => [pack.id, pack]));
  const grouped = new Map<string, BankQuestion[]>();
  for (const question of bank.questions) {
    if (!packMeta.has(question.pack)) throw new Error(`题 ${question.id} 指向不存在的板块 ${question.pack}`);
    const list = grouped.get(question.pack) ?? [];
    list.push(question);
    grouped.set(question.pack, list);
  }

  const counts: Record<string, number> = {};
  let imported = 0;
  await db.transaction(async tx => {
    await tx.query(`insert into courses(id,code,name,campus,term,tags,slug) values($1,'CS204','数据结构与算法',null,'2025 秋','{}','数据结构与算法')
      on conflict (id) do update set name=excluded.name, code=excluded.code, term=excluded.term, slug=excluded.slug`, [courseId]);
    for (const [index, pack] of packs.entries()) {
      const packId = packIdFor(index);
      // 重复导入前先清掉这包的题目与刷题记录；作答历史保留（attempt 版本校验会拦截失效作答）。
      await tx.query('delete from practice_records where pack_id=$1', [packId]);
      await tx.query('delete from questions where pack_id=$1', [packId]);
      await tx.query(`insert into packs(id,course_id,title,subtitle,notes,year,source_type,license_note,starter_rank,status,price_cc,is_sample,item_count)
        values($1,$2,$3,$4,$5,2025,$6,'数据结构与算法期中完整样例（源自 quiz.kerrychia.site），免费开放。',null,'live',0,true,$7)
        on conflict (id) do update set title=excluded.title, subtitle=excluded.subtitle, notes=excluded.notes,
          source_type=excluded.source_type, item_count=excluded.item_count, is_sample=true, status='live'`,
        [packId, courseId, `${pack.head} · ${pack.name}`, pack.subtitle, pack.notes, sourceTypeFor(pack.id), grouped.get(pack.id)?.length ?? 0]);
      const items: BankQuestionInput[] = (grouped.get(pack.id) ?? []).map(question => {
        counts[question.type] = (counts[question.type] ?? 0) + 1;
        if (question.type === 'choice') {
          const answer = question.options.findIndex(option => option.value === question.correct);
          return { ref: question.id, qtype: 'choice', stem: question.stem, body: question.body, explanation: question.explanation,
            options: question.options.map(option => option.text), answer: String(answer), tags: [packMeta.get(question.pack)?.short ?? '综合'] };
        }
        if (question.type === 'judge') {
          return { ref: question.id, qtype: 'judge', stem: question.stem, body: question.body, explanation: question.explanation,
            options: ['正确', '错误'], answer: question.correct === 'true' ? '0' : '1', tags: [packMeta.get(question.pack)?.short ?? '综合'] };
        }
        if (question.type === 'fill') {
          return { ref: question.id, qtype: 'fill', stem: question.stem, body: question.body, explanation: question.explanation,
            fields: question.fields, tags: [packMeta.get(question.pack)?.short ?? '综合'] };
        }
        return { ref: question.id, qtype: 'subjective', stem: question.stem, body: question.body, explanation: question.explanation,
          tags: [packMeta.get(question.pack)?.short ?? '综合'] };
      });
      await insertBankQuestions(tx, packId, items);
      imported += items.length;
      console.log(`板块 ${pack.id} ${pack.name}: ${items.length} 题`);
    }
  });
  console.log(`导入完成：${packs.length} 个板块，共 ${imported} 题（${JSON.stringify(counts)}）。`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(closeDb);

// Import packs mined paper-by-paper by sub-agents. Course is resolved by slug so that
// no duplicate course rows appear; pack ids are deterministic for idempotent reruns.
import { readFile } from 'node:fs/promises';
import { closeDb, getDb } from '../src/db';
import { insertBankQuestions, type BankQuestionInput } from '../src/domains/catalog';

type Pack = {
  id: string; courseSlug: string; title: string; subtitle: string; notes: string; year: number;
  itemCount: number;
  questions: { ref: string; qtype: 'choice' | 'judge'; stem: string; options: string[]; answer: string; explanation: string; tags: string[] }[];
};

async function main() {
  const bank = JSON.parse(await readFile(new URL('../data/exam-packs-agent.json', import.meta.url), 'utf8')) as { packs: Pack[] };
  const db = getDb();
  let imported = 0;
  await db.transaction(async tx => {
    for (const pack of bank.packs) {
      const course = (await tx.query<{ id: string }>('select id from courses where slug=$1', [pack.courseSlug])).rows[0];
      if (!course) throw new Error(`missing course ${pack.courseSlug}`);
      await tx.query('delete from practice_records where pack_id=$1', [pack.id]);
      await tx.query('delete from questions where pack_id=$1', [pack.id]);
      await tx.query(
        `insert into packs(id,course_id,title,subtitle,notes,year,source_type,license_note,starter_rank,status,price_cc,is_sample,item_count)
         values($1,$2,$3,$4,$5,$6,'past_exam',$7,null,'live',0,false,$8)
         on conflict (id) do update set course_id=excluded.course_id, title=excluded.title, subtitle=excluded.subtitle,
           notes=excluded.notes, year=excluded.year, license_note=excluded.license_note,
           item_count=excluded.item_count, status='live', price_cc=0`,
        [pack.id, course.id, pack.title, pack.subtitle, pack.notes, pack.year,
          '课程试卷整理本，经站点运营者确认授权后收录，仅用于校内练习，禁止对外传播。', pack.questions.length]
      );
      const items: BankQuestionInput[] = pack.questions.map(question => ({
        ref: question.ref, qtype: question.qtype, stem: question.stem, body: '',
        explanation: question.explanation, options: question.options, answer: question.answer, tags: question.tags
      }));
      await insertBankQuestions(tx, pack.id, items);
      imported += items.length;
      console.log(`pack ${pack.title}: ${items.length}`);
    }
  });
  console.log(`done packs=${bank.packs.length} questions=${imported}`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(closeDb);

// Import exam packs mined from the RUC course archives into live, free practice packs.
// Idempotent: fixed pack ids, questions replaced on each run.
import { readFile } from 'node:fs/promises';
import { closeDb, getDb } from '../src/db';
import { insertBankQuestions, type BankQuestionInput } from '../src/domains/catalog';

type Pack = {
  id: string; courseId: string; courseName: string; head: string; title: string; subtitle: string;
  notes: string; year: number; sourceType: string; licenseNote: string; sourcePath: string; sourceUrl: string;
  itemCount: number;
  questions: { ref: string; qtype: 'choice' | 'judge'; stem: string; options: string[]; answer: string; explanation: string; tags: string[] }[];
};
type Course = { id: string; code: string; name: string; slug: string; exists: boolean };

async function main() {
  const bank = JSON.parse(await readFile(new URL('../data/exam-packs.json', import.meta.url), 'utf8')) as { courses: Course[]; packs: Pack[] };
  const db = getDb();
  let imported = 0;
  await db.transaction(async tx => {
    const resolved = new Map<string, string>();
    for (const course of bank.courses) {
      const existing = (await tx.query<{ id: string }>('select id from courses where slug=$1', [course.slug])).rows[0];
      if (existing) {
        resolved.set(course.id, existing.id);
        continue;
      }
      await tx.query(
        `insert into courses(id,code,name,campus,term,tags,slug) values($1,$2,$3,null,'真题练习','{}',$4)
         on conflict (id) do nothing`,
        [course.id, course.code, course.name, course.slug]
      );
      resolved.set(course.id, course.id);
    }
    for (const pack of bank.packs) {
      await tx.query('delete from practice_records where pack_id=$1', [pack.id]);
      await tx.query('delete from questions where pack_id=$1', [pack.id]);
      await tx.query(
        `insert into packs(id,course_id,title,subtitle,notes,year,source_type,license_note,starter_rank,status,price_cc,is_sample,item_count)
         values($1,$2,$3,$4,$5,$6,'past_exam',$7,null,'live',0,false,$8)
         on conflict (id) do update set title=excluded.title, subtitle=excluded.subtitle, notes=excluded.notes,
           year=excluded.year, license_note=excluded.license_note, item_count=excluded.item_count, status='live', price_cc=0`,
        [pack.id, resolved.get(pack.courseId) ?? pack.courseId, pack.title, pack.subtitle, pack.notes, pack.year, pack.licenseNote, pack.questions.length]
      );
      const items: BankQuestionInput[] = pack.questions.map(question => ({
        ref: question.ref,
        qtype: question.qtype,
        stem: question.stem,
        body: '',
        explanation: question.explanation,
        options: question.options,
        answer: question.answer,
        tags: question.tags
      }));
      await insertBankQuestions(tx, pack.id, items);
      imported += items.length;
      console.log(`pack ${pack.title}: ${items.length}`);
    }
  });
  console.log(`done packs=${bank.packs.length} questions=${imported} courses=${bank.courses.map(c => c.name).join(',')}`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(closeDb);

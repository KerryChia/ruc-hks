import { readFile, stat } from 'node:fs/promises';
import { closeDb, getDb } from '../src/db';
import { listCourses, seed, syncCourseSources } from '../src/domains/catalog';
import { syncResources, type ResourceManifest } from '../src/domains/resources';
import { issueInvite } from '../src/domains/identity';
import { settleRewards, submitPack, validateSubmission } from '../src/domains/review';
import { promotionStatus, startPromotion, stopPromotion } from '../src/domains/promotion';

async function main() {
  const [command, value, flag] = process.argv.slice(2);
  const db = getDb();
  if (command === 'migrate') {
    const sql = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
    await db.transaction(async tx => { await tx.query(sql); });
    console.log('Database schema applied.');
  } else if (command === 'seed') {
    const { courseIds, packIds } = await seed(db);
    console.log(`Synthetic content: ${courseIds.length} courses, ${packIds.length} packs.`);
  } else if (command === 'sources') {
    const { entries, files } = await syncCourseSources(db);
    console.log(`Public source directory index: ${entries} entries, ${files} linked files (no original files uploaded).`);
  } else if (command === 'resources') {
    const manifest = JSON.parse(await readFile(new URL('../data/resources.json', import.meta.url), 'utf8')) as ResourceManifest;
    const result = await syncResources(db, manifest);
    console.log(`Course resources synced: ${result.courses} courses, ${result.files} files.`);
  } else if (command === 'courses') {
    for (const course of await listCourses(db)) console.log(`${course.id}\t${course.name}\t/${course.slug}`);
  } else if (command === 'invite' && value) {
    console.log(await issueInvite(db, value));
  } else if (command === 'reviewer' && value) {
    const result = await db.query("update users set role='reviewer' where email=$1 and status='active' and role='student' returning id", [value.toLowerCase()]);
    if (!result.rows.length) throw new Error('No active student matched.');
    console.log('Reviewer role granted.');
  } else if (command === 'campaign') {
    if (value === 'start') {
      const days = Number(flag ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Usage: campaign start DAYS (1-365)');
      const promotion = await startPromotion(db, days);
      console.log(`Free campaign "${promotion.title}" active until ${new Date(promotion.endsAt).toISOString()}.`);
    } else if (value === 'stop') {
      await stopPromotion(db);
      console.log('Free campaign stopped. Pricing rules are back in force.');
    } else {
      const status = await promotionStatus(db);
      console.log(status.current
        ? `${status.running ? 'Active' : 'Expired'}: ${status.current.title} ${new Date(status.current.startsAt).toISOString()} -> ${new Date(status.current.endsAt).toISOString()}`
        : 'No campaign has been configured.');
    }
  } else if (command === 'settle-rewards') {
    console.log(`Settled ${await settleRewards(db)} upload rewards.`);
  } else if (command === 'import-pack' && value) {
    if ((await stat(value)).size > 2 * 1024 * 1024) throw new Error('Input exceeds 2 MiB.');
    const input: unknown = JSON.parse(await readFile(value, 'utf8'));
    const data = await validateSubmission(db, input);
    if (flag === '--check') {
      console.log(JSON.stringify({ valid: true, courseId: data.courseId, title: data.title, questions: data.questions.length }));
    } else {
      if (!flag) throw new Error('Use --check or supply the author’s campus email.');
      const author = (await db.query<{ id: string }>("select id from users where email=$1 and status='active'", [flag.toLowerCase()])).rows[0];
      if (!author) throw new Error('No active author matched.');
      console.log(JSON.stringify({ status: 'reviewing', packId: await submitPack(db, author.id, data), questions: data.questions.length }));
    }
  } else {
    throw new Error('Usage: npm run db -- migrate | seed | sources | resources | courses | invite EMAIL | reviewer EMAIL | settle-rewards | campaign start DAYS|stop|status | import-pack FILE (--check|EMAIL)');
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(closeDb);

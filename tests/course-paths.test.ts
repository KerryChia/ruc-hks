import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createDatabase } from '../src/db';
import * as catalog from '../src/domains/catalog';
import * as links from '../app/_lib/presentation';

const probability = '10000000-0000-4000-8000-000000000002';
const oldPack = '20000000-0000-4000-8000-000000000011';
const schema = () => readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');

async function withDb(run: (db: ReturnType<typeof createDatabase>, client: PGlite) => Promise<void>) {
  const client = new PGlite();
  try { await run(createDatabase(client), client); }
  finally { await client.close(); }
}

test('course links use one encoded root component and retain the path query on old links', () => {
  const slug = '概率论与数理统计';
  const path = `/${encodeURIComponent(slug)}`;
  assert.equal(links.courseHref(slug), path);
  assert.equal(links.courseRedirectLocation(slug, '?pack=id&mode=paper'), `${path}?pack=id&mode=paper`);
});

test('the App Router parameter is decoded once before looking up the Unicode slug', () => {
  const slug = '概率论与数理统计';
  assert.equal(links.decodeCourseParam(encodeURIComponent(slug)), slug);
  assert.equal(links.decodeCourseParam(slug), slug);
  assert.equal(links.decodeCourseParam('%E6%A6'), null);
  assert.equal(links.decodeCourseParam('%252F'), '%2F');
});

test('legacy course migration preserves IDs and foreign keys and is safe to rerun', async () => {
  await withDb(async (db, client) => {
    await client.exec(`create table courses(id uuid primary key,code text not null,name text not null,campus text not null,term text not null,tags text[] not null,unique(code,campus,term));
      insert into courses values ('${probability}','MA102','概率论基础','zhongguancun','演示学期','{}');
      insert into courses values ('10000000-0000-4000-8000-000000000010','OTHER','重名课程','tongzhou','测试学期','{}');
      create table legacy_packs(id uuid primary key,course_id uuid not null references courses);
      insert into legacy_packs values ('${oldPack}','${probability}');`);
    const statement = await schema();
    await client.exec(statement);
    await client.exec(statement);
    const course = await catalog.getCourseBySlug(db, '概率论与数理统计');
    assert.equal(course.id, probability);
    assert.equal(course.name, '概率论与数理统计');
    assert.equal((await catalog.getCourse(db, '10000000-0000-4000-8000-000000000010')).slug, '课程-10000000-0000-4000-8000-000000000010');
    assert.equal((await db.query('select course_id from legacy_packs where id=$1', [oldPack])).rows[0].course_id, probability);
    await assert.rejects(catalog.getCourseBySlug(db, 'login'), { code: 'NOT_FOUND' });
    await assert.rejects(catalog.getCourseBySlug(db, '无此课程'), { code: 'NOT_FOUND' });
  });
});

test('all source directories are indexed as GitHub links, not question data', async () => {
  process.env.ANSWER_KEY = Buffer.alloc(32, 7).toString('base64');
  await withDb(async (db, client) => {
    await client.exec(await schema());
    await catalog.seed(db);
    await catalog.syncCourseSources(db);
    await catalog.syncCourseSources(db);
    const courses = await catalog.listCourses(db);
    assert.equal(courses.reduce((total, c) => total + c.resourceCount, 0), 138);
    assert.equal(courses.reduce((total, c) => total + c.packCount, 0), 15);
    const entries = (await db.query<{ count: number }>('select count(*)::int as count from course_sources')).rows[0].count;
    assert.equal(entries, 25);
    const course = await catalog.getCourseBySlug(db, '概率论与数理统计');
    const sources = await catalog.listCourseSources(db, course.id);
    assert.equal(course.id, probability);
    assert.equal(sources.length, 1);
    assert.match(sources[0].url, /^https:\/\/github\.com\/lru0612\/GSAI-2th-courses\/tree\/cb704b0d6dac0915eb3049c92fdd4f6e6d9615b9\/First_sem\/Probability%20and%20Statistics$/);
    assert.deepEqual(Object.keys(sources[0]).sort(), ['fileCount', 'name', 'url']);
  });
});

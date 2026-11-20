import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createDatabase } from '../src/db';
import { getResourceCourse, listResourceCourses, searchResourceCourses, syncResources, type ResourceManifest } from '../src/domains/resources';

test('imported course materials keep their source attribution and file metadata', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    const db = createDatabase(pg);
    const manifest = JSON.parse(await readFile(new URL('../data/resources.json', import.meta.url), 'utf8')) as ResourceManifest;
    const expectedCourses = manifest.courses.length;
    const expectedFiles = manifest.courses.reduce((sum, course) => sum + course.files.length, 0);
    const synced = await syncResources(db, manifest);
    assert.deepEqual(synced, { courses: expectedCourses, files: expectedFiles });

    const courses = await listResourceCourses(db);
    assert.equal(courses.length, expectedCourses);
    assert.equal(courses.reduce((sum, course) => sum + course.fileCount, 0), expectedFiles);
    assert.ok(courses.some(course => course.contributor === 'Inkkdot'));
    assert.ok(courses.some(course => course.contributor === 'lru0612'));

    // The library is a raw-paper warehouse: only question-bearing files may ship.
    const allowed = new Set(['小测', '期中', '期末', '期中 + 小测', '练习题']);
    assert.ok(manifest.courses.every(course => course.files.every(file => allowed.has(file.category))));

    const first = courses.find(course => course.name === '数据结构与算法I');
    assert.ok(first);
    const detail = await getResourceCourse(db, first.id);
    assert.equal(detail.course.contributor, 'Inkkdot');
    assert.equal(detail.files.length, 26);
    assert.ok(detail.files.every(file => /^[a-f0-9]{64}\.[a-z0-9]+$/.test(file.storageKey)));

    const search = await searchResourceCourses(db, '算法');
    assert.ok(search.length > 0);
    assert.ok(search.every(course => course.name.includes('算法') || course.contributor.toLowerCase().includes('算法')));
  } finally {
    await pg.close();
  }
});

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const parsed = JSON.parse(readFileSync(`${ROOT}/.work/parsed.json`, 'utf8'));
const meta = JSON.parse(readFileSync(`${ROOT}/data/exam-papers.json`, 'utf8'));
const answers = (() => {
  try { return JSON.parse(readFileSync(`${ROOT}/.work/answers.json`, 'utf8')); } catch { return {}; }
})();

const bySha = new Map();
for (const course of meta.courses) for (const file of course.exams) bySha.set(file.sha256, { ...file, courseName: course.name });

const COURSES = {
  '数据结构与算法I': { id: '30000000-0000-4000-8000-000000000001', code: 'CS204', name: '数据结构与算法', slug: '数据结构与算法', exists: true },
  '数据库系统概论': { id: '40000000-0000-4000-8000-000000000002', code: 'CS305', name: '数据库系统概论', slug: '数据库系统概论', exists: false }
};

const letter = i => String.fromCharCode(65 + i);

function yearOf(term = '') {
  const range = term.match(/(\d{4})-(\d{4})/);
  const spring = /第二学期|春/.test(term);
  if (range) return spring ? Number(range[2]) : Number(range[1]);
  return 2024;
}

function headOf(category = '') {
  if (/期末/.test(category)) return '期末';
  if (/期中/.test(category)) return '期中';
  return '小测';
}

const packs = [];
const seenFingerprint = new Map();
const seenStem = new Set();
let dropped = 0;
let crossCourse = 0;

for (const row of parsed) {
  if (!row.found) continue;
  const info = bySha.get(row.key);
  const course = COURSES[row.course];
  if (!info || !course) { crossCourse++; continue; }
  const fingerprint = createHash('sha256').update(row.questions.map(q => q.stem.replace(/\s+/g, '')).sort().join('|')).digest('hex').slice(0, 16);
  if (seenFingerprint.has(fingerprint)) { dropped++; continue; }
  seenFingerprint.set(fingerprint, true);

  const questions = [];
  for (const q of row.questions) {
    const key = `${course.id}:${q.stem.replace(/\s+/g, '').toLowerCase()}`;
    if (seenStem.has(key)) continue;
    seenStem.add(key);
    const qtype = q.judge ? 'judge' : 'choice';
    const options = qtype === 'judge' ? ['正确', '错误'] : q.options;
    const explanation = qtype === 'judge' ? `正确答案：${q.answer === 0 ? '正确' : '错误'}。` : `正确答案：${letter(q.answer)}. ${options[q.answer]}。`;
    questions.push({
      ref: `r${questions.length + 1}`,
      qtype,
      stem: q.stem,
      options,
      answer: String(q.answer),
      explanation,
      tags: ['真题'],
      section: q.label || ''
    });
  }
  if (!questions.length) { dropped++; continue; }

  packs.push({
    id: `40000000-0000-4000-9000-${info.sha256.slice(0, 12)}`,
    courseId: course.id,
    courseName: course.name,
    head: headOf(info.category),
    title: `${headOf(info.category)} · ${info.title}`,
    subtitle: [info.instructor, info.term.replace('学年', '')].filter(Boolean).join(' · '),
    notes: `${course.name}课程资料 ${info.term}，整理自课程试卷库。`,
    year: yearOf(info.term),
    sourceType: 'past_exam',
    licenseNote: '课程试卷整理本，经站点运营者确认授权后收录，仅用于校内练习，禁止对外传播。',
    sourcePath: info.sourcePath,
    sourceUrl: info.sourceUrl,
    itemCount: questions.length,
    questions
  });
}

const total = packs.reduce((s, p) => s + p.itemCount, 0);
const byCourse = {};
for (const p of packs) byCourse[p.courseName] = (byCourse[p.courseName] || 0) + p.itemCount;

const courses = Object.values(COURSES).filter(c => packs.some(p => p.courseId === c.id));
writeFileSync(`${ROOT}/data/exam-packs.json`, JSON.stringify({ generatedAt: new Date().toISOString(), courses, packs }, null, 1));
console.log(`packs=${packs.length} questions=${total} duplicatesSkipped=${dropped} unmatched=${crossCourse}`);
console.log(byCourse);
for (const p of packs) console.log(`${String(p.itemCount).padStart(3)} ${p.courseName} | ${p.title} | ${p.subtitle}`);

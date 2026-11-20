import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';

const [rucRoot, gsaiRoot, storeRoot, output] = process.argv.slice(2);
if (!rucRoot || !gsaiRoot || !storeRoot || !output) {
  throw new Error('Usage: build-resource-manifest <ruc-root> <gsai-root> <store-dir> <output.json>');
}

const allowed = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'zip', 'md', 'txt', 'cpp', 'h', 'ipynb', 'csv', 'py']);
const mime: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8',
  cpp: 'text/plain; charset=utf-8', h: 'text/plain; charset=utf-8', py: 'text/plain; charset=utf-8',
  ipynb: 'application/json', csv: 'text/csv; charset=utf-8',
};
const rucOrder = [
  '数据结构与算法I', '数据库系统概论', '编译原理', '程设1', '人工智能与Python程序设计',
  '算法分析与设计', '数据结构与算法荣誉课程I', 'Fa-数据思维', '程序设计实践', '程序设计II',
  '高级程序设计II', '机器学习基础（荣誉课程）', '运筹学基础', 'ACM-ICPC算法分析与设计',
  'JAVA程序设计', 'java课程',
];
const gsaiCourses: Record<string, { name: string; term: string; order: number }> = {
  'AI  Intro': { name: '人工智能引论', term: '大二上学期', order: 100 },
  'Data structure and algorithm': { name: '数据结构与算法', term: '大二上学期', order: 101 },
  ICS: { name: '计算机系统导论', term: '大二上学期', order: 102 },
  'Math Basis': { name: '人工智能数学基础', term: '大二上学期', order: 103 },
  'Probability and Statistics': { name: '概率论与数理统计', term: '大二上学期', order: 104 },
  Algorithm: { name: '算法分析与设计', term: '大二下学期', order: 105 },
  ML: { name: '机器学习基础', term: '大二下学期', order: 106 },
  Optimization: { name: '最优化理论与方法', term: '大二下学期', order: 107 },
  ICS2: { name: '计算机系统导论2', term: '大二下学期', order: 108 },
};
const categoryNames: Record<string, string> = {
  Labs: '实验', hwk: '作业', reports: '实验报告', books: '参考书', 题目: '练习题',
  '期中+小测': '期中 + 小测',
};

type ManifestFile = {
  id: string; title: string; category: string; term: string | null; instructor: string | null;
  extension: string; mime: string; sizeBytes: number; storageKey: string; sourcePath: string;
  sourceUrl: string; sha256: string; sortOrder: number;
};
type ManifestCourse = {
  id: string; collection: string; name: string; repository: string; repositoryName: string;
  contributor: string; contributorUrl: string; sortOrder: number; files: ManifestFile[];
};
type Manifest = {
  version: 1; generatedAt: string;
  collections: Array<{ key: string; name: string; description: string; repository: string; contributor: string; contributorUrl: string }>;
  courses: ManifestCourse[];
};

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function hashFile(file: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}
async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
    if (entry.name.startsWith('.')) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}
function repoUrl(repo: string, relativePath: string, kind: 'blob' | 'tree') {
  return `https://github.com/${repo}/${kind}/main/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}
function safeTitle(filename: string) {
  const withoutExtension = basename(filename, extname(filename));
  return withoutExtension.replace(/^\d{8,}_[\p{Script=Han}A-Za-z]+_/u, '').trim() || '课程资料';
}
function categoryFor(value: string | undefined) {
  if (!value) return '课程资料';
  return categoryNames[value] ?? value;
}

async function main() {
await mkdir(storeRoot, { recursive: true });
const skipped: string[] = [];
const courses: ManifestCourse[] = [];

async function makeFile(repo: string, fullPath: string, sourcePath: string, term: string | null, instructor: string | null, category: string, order: number): Promise<ManifestFile | null> {
  const extension = extname(fullPath).slice(1).toLowerCase();
  const fileName = basename(fullPath);
  if (!allowed.has(extension) || /z-lib|z-library/i.test(fileName)) {
    skipped.push(sourcePath);
    return null;
  }
  const info = await stat(fullPath);
  const sha256 = await hashFile(fullPath);
  const storageKey = `${sha256}.${extension}`;
  const target = join(storeRoot, storageKey);
  try { await stat(target); } catch { await copyFile(fullPath, target); }
  return {
    id: `rf_${digest(`${repo}:${sourcePath}`).slice(0, 24)}`,
    title: safeTitle(fileName),
    category,
    term,
    instructor,
    extension,
    mime: mime[extension] ?? 'application/octet-stream',
    sizeBytes: info.size,
    storageKey,
    sourcePath,
    sourceUrl: repoUrl(repo, sourcePath, 'blob'),
    sha256,
    sortOrder: order,
  };
}

const rucRepo = 'Inkkdot/ruc-exam-archive';
for (const [courseIndex, courseName] of rucOrder.entries()) {
  const courseRoot = join(rucRoot, 'files', courseName);
  const sourceFiles = await walk(courseRoot);
  const files: ManifestFile[] = [];
  for (const fullPath of sourceFiles) {
    const parts = relative(rucRoot, fullPath).split(sep);
    const sourcePath = parts.join('/');
    const file = await makeFile(rucRepo, fullPath, sourcePath, parts[2] ?? null, parts[3]?.split(' ')[0] ?? null, categoryFor(parts[4]), files.length);
    if (file) files.push(file);
  }
  if (!files.length) continue;
  courses.push({
    id: `rc_${digest(`ruc-exam-archive:${courseName}`).slice(0, 16)}`,
    collection: 'ruc-exam-archive', name: courseName,
    repository: `https://github.com/${rucRepo}`,
    repositoryName: rucRepo,
    contributor: 'Inkkdot', contributorUrl: 'https://github.com/Inkkdot',
    sortOrder: courseIndex, files,
  });
}

const gsaiRepo = 'lru0612/GSAI-2th-courses';
for (const [folder, meta] of Object.entries(gsaiCourses)) {
  const prefix = meta.order >= 105 ? 'Second_sem' : 'First_sem';
  const courseRoot = join(gsaiRoot, prefix, folder);
  const sourceFiles = await walk(courseRoot);
  const files: ManifestFile[] = [];
  for (const fullPath of sourceFiles) {
    const parts = relative(gsaiRoot, fullPath).split(sep);
    const sourcePath = parts.join('/');
    const category = parts.length > 3 ? categoryFor(parts[2]) : '课程资料';
    const file = await makeFile(gsaiRepo, fullPath, sourcePath, meta.term, null, category, files.length);
    if (file) files.push(file);
  }
  if (!files.length) continue;
  courses.push({
    id: `rc_${digest(`gsai:${folder}`).slice(0, 16)}`,
    collection: 'gsai', name: meta.name,
    repository: `https://github.com/${gsaiRepo}`,
    repositoryName: gsaiRepo,
    contributor: 'lru0612', contributorUrl: 'https://github.com/lru0612',
    sortOrder: meta.order, files,
  });
}

const manifest: Manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  collections: [
    { key: 'ruc-exam-archive', name: '历年试题资料', description: '按课程、学年与教学班整理的历年小测、期中与期末资料。', repository: `https://github.com/${rucRepo}`, contributor: 'Inkkdot', contributorUrl: 'https://github.com/Inkkdot' },
    { key: 'gsai', name: 'GSAI 大二课程资料', description: 'GSAI 大二课程课件、实验、作业、复习资料与参考书。', repository: `https://github.com/${gsaiRepo}`, contributor: 'lru0612', contributorUrl: 'https://github.com/lru0612' },
  ],
  courses,
};

await mkdir(join(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  courses: courses.length,
  files: courses.reduce((sum, course) => sum + course.files.length, 0),
  bytes: courses.reduce((sum, course) => sum + course.files.reduce((total, file) => total + file.sizeBytes, 0), 0),
  skipped,
}, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });

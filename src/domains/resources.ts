import type { Database, Queryable } from '../db';
import { fail } from '../errors';

export type ResourceFileInput = {
  id: string; title: string; category: string; term: string | null; instructor: string | null;
  extension: string; mime: string; sizeBytes: number; storageKey: string; sourcePath: string;
  sourceUrl: string; sha256: string; sortOrder: number;
};
export type ResourceCourseInput = {
  id: string; collection: string; name: string; repository: string; repositoryName: string;
  contributor: string; contributorUrl: string; sortOrder: number; files: ResourceFileInput[];
};
export type ResourceManifest = {
  version: number; generatedAt: string;
  collections: Array<{ key: string; name: string; description: string; repository: string; contributor: string; contributorUrl: string }>;
  courses: ResourceCourseInput[];
};
export type ResourceCourse = Omit<ResourceCourseInput, 'files'> & {
  fileCount: number; sizeBytes: number; categories: string[];
};
export type ResourceFile = Omit<ResourceFileInput, 'sortOrder'> & { courseId: string };

const idPattern = /^(rc|rf)_[a-f0-9]{16,24}$/;
const storagePattern = /^[a-f0-9]{64}\.[a-z0-9]+$/;

export const RESOURCE_COLLECTIONS = {
  'ruc-exam-archive': {
    name: '历年试题原件',
    description: '按课程、学年与教学班整理的历年小测、期中试卷原件及参考答案。',
    note: '原始试卷与答案的著作权归中国人民大学及相关授课教师所有，经站点运营者确认授权后收录。',
    repository: 'https://github.com/Inkkdot/ruc-exam-archive',
    contributor: 'Inkkdot',
  },
  gsai: {
    name: 'GSAI 课程练习题',
    description: 'GSAI 各课程的练习题与复习题，仅保留题目类文件。',
    note: '练习题由 lru0612 整理，经站点运营者确认授权后收录。',
    repository: 'https://github.com/lru0612/GSAI-2th-courses',
    contributor: 'lru0612',
  },
} as const;

export async function syncResources(db: Database, manifest: ResourceManifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.courses)) throw new Error('Unsupported resource manifest');
  const courseIds = new Set<string>();
  const fileIds = new Set<string>();
  await db.transaction(async tx => {
    await tx.query('delete from resource_files');
    await tx.query('delete from resource_courses');
    for (const course of manifest.courses) {
      if (!idPattern.test(course.id) || courseIds.has(course.id)) throw new Error(`Invalid resource course id: ${course.id}`);
      courseIds.add(course.id);
      await tx.query(`insert into resource_courses(id,collection,name,repository,repository_name,contributor,contributor_url,sort_order)
        values($1,$2,$3,$4,$5,$6,$7,$8)`, [course.id, course.collection, course.name, course.repository, course.repositoryName, course.contributor, course.contributorUrl, course.sortOrder]);
      for (const file of course.files) {
        if (!idPattern.test(file.id) || fileIds.has(file.id)) throw new Error(`Invalid resource file id: ${file.id}`);
        if (!storagePattern.test(file.storageKey) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) throw new Error(`Invalid resource file metadata: ${file.id}`);
        fileIds.add(file.id);
        await tx.query(`insert into resource_files(id,course_id,title,category,term,instructor,extension,mime,size_bytes,storage_key,source_path,source_url,sha256,sort_order)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [file.id, course.id, file.title, file.category, file.term, file.instructor, file.extension, file.mime, file.sizeBytes, file.storageKey, file.sourcePath, file.sourceUrl, file.sha256, file.sortOrder]);
      }
    }
  });
  return { courses: courseIds.size, files: fileIds.size };
}

export async function listResourceCourses(db: Queryable) {
  return (await db.query<ResourceCourse>(`select c.id,c.collection,c.name,c.repository,c.repository_name as "repositoryName",
      c.contributor,c.contributor_url as "contributorUrl",c.sort_order as "sortOrder",count(f.id)::int as "fileCount",
      coalesce(sum(f.size_bytes),0)::int as "sizeBytes",coalesce(array_agg(distinct f.category) filter (where f.category is not null),'{}') as categories
    from resource_courses c left join resource_files f on f.course_id=c.id
    group by c.id order by c.sort_order,c.name`)).rows;
}

export async function getResourceCourse(db: Queryable, id: string) {
  if (!idPattern.test(id)) fail('NOT_FOUND', '未找到该资料目录。');
  const course = (await db.query<ResourceCourse>(`select c.id,c.collection,c.name,c.repository,c.repository_name as "repositoryName",
      c.contributor,c.contributor_url as "contributorUrl",c.sort_order as "sortOrder",count(f.id)::int as "fileCount",
      coalesce(sum(f.size_bytes),0)::int as "sizeBytes",coalesce(array_agg(distinct f.category) filter (where f.category is not null),'{}') as categories
    from resource_courses c left join resource_files f on f.course_id=c.id where c.id=$1 group by c.id`, [id])).rows[0];
  if (!course) fail('NOT_FOUND', '未找到该资料目录。');
  const files = (await db.query<ResourceFile>(`select id,course_id as "courseId",title,category,term,instructor,extension,mime,
      size_bytes::int as "sizeBytes",storage_key as "storageKey",source_path as "sourcePath",source_url as "sourceUrl",sha256
    from resource_files where course_id=$1 order by sort_order,title`, [id])).rows;
  return { course, files };
}

// Resource course names and practice course names drifted apart ("数据结构与算法I" vs
// "数据结构与算法"). Resolve the practice course that actually holds live packs so the
// resource page can route into practice instead of dead-ending at downloads.
export const courseKey = (name: string) => name
  .replace(/\s+/g, '')
  .replace(/[（(][^）)]*[）)]/g, '')
  .replace(/[IVXⅠⅡⅢ]+$/g, '')
  .replace(/[0-9]+$/g, '')
  .toLowerCase();

export async function practiceCourseFor(db: Queryable, resourceName: string) {
  const rows = (await db.query<{ id: string; name: string; slug: string; packCount: number; questionCount: number }>(
    `select c.id,c.name,c.slug,count(distinct p.id)::int as "packCount",count(q.id)::int as "questionCount"
       from courses c join packs p on p.course_id=c.id and p.status='live'
       left join questions q on q.pack_id=p.id
      group by c.id,c.name,c.slug order by "questionCount" desc`)).rows;
  if (!rows.length) return null;
  const target = courseKey(resourceName);
  const exact = rows.find(row => row.name.replace(/\s+/g, '') === resourceName.replace(/\s+/g, ''));
  if (exact) return exact;
  const normalised = rows.filter(row => courseKey(row.name) === target);
  if (normalised.length === 1) return normalised[0];
  if (normalised.length > 1) return normalised[0];
  const prefix = rows.filter(row => courseKey(row.name).startsWith(target) || target.startsWith(courseKey(row.name)));
  return prefix.length === 1 ? prefix[0] : null;
}

// Reverse lookup: from a practice course to the raw paper folder that feeds it.
export async function resourceCourseFor(db: Queryable, courseName: string) {
  const rows = (await db.query<{ id: string; name: string; fileCount: number }>(
    `select c.id,c.name,count(f.id)::int as "fileCount" from resource_courses c
       left join resource_files f on f.course_id=c.id group by c.id,c.name`)).rows;
  if (!rows.length) return null;
  const target = courseKey(courseName);
  const exact = rows.find(row => row.name.replace(/\s+/g, '') === courseName.replace(/\s+/g, ''));
  if (exact) return exact;
  const matched = rows.filter(row => courseKey(row.name) === target);
  if (matched.length) return matched[0];
  const prefix = rows.filter(row => courseKey(row.name).startsWith(target) || target.startsWith(courseKey(row.name)));
  return prefix.length === 1 ? prefix[0] : null;
}

export async function getResourceFile(db: Queryable, id: string) {  if (!idPattern.test(id)) fail('NOT_FOUND', '未找到该文件。');
  const file = (await db.query<ResourceFile>(`select id,course_id as "courseId",title,category,term,instructor,extension,mime,
      size_bytes::int as "sizeBytes",storage_key as "storageKey",source_path as "sourcePath",source_url as "sourceUrl",sha256
    from resource_files where id=$1`, [id])).rows[0];
  if (!file) fail('NOT_FOUND', '未找到该文件。');
  return file;
}

export async function searchResourceCourses(db: Queryable, keyword: string) {
  const query = keyword.trim().slice(0, 80);
  if (!query) return [];
  return (await db.query<ResourceCourse>(`select c.id,c.collection,c.name,c.repository,c.repository_name as "repositoryName",
      c.contributor,c.contributor_url as "contributorUrl",c.sort_order as "sortOrder",count(f.id)::int as "fileCount",
      coalesce(sum(f.size_bytes),0)::int as "sizeBytes",coalesce(array_agg(distinct f.category) filter (where f.category is not null),'{}') as categories
    from resource_courses c left join resource_files f on f.course_id=c.id
    where position(lower($1) in lower(c.name || ' ' || c.contributor || ' ' || c.collection))>0
    group by c.id order by c.sort_order limit 6`, [query])).rows;
}

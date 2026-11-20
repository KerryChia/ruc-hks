import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from '../db';
import { fail, uuid } from '../errors';
import { courseSourceIndex } from './course-sources';

const courseFields = 'id,code,name,campus,term,tags,slug';
const courseSlug = /^\p{Script=Han}[\p{Script=Han}0-9A-Za-z·（）-]{0,99}$/u;
const packFields = 'p.id,p.course_id as "courseId",p.title,p.subtitle,p.notes,p.year,p.source_type as "sourceType",p.starter_rank as "starterRank",p.price_cc as "priceCc",p.status,p.is_sample as "isSample",p.item_count as "itemCount",coalesce(u.display_name,\'sol\') as "contributor"';
const contributorField = `coalesce((select string_agg(distinct cu.display_name,'、') from packs cp join users cu on cu.id=cp.author_id where cp.course_id=courses.id and cp.status='live'),'sol') as "contributor"`;
export type Course = { id: string; code: string; name: string; slug: string; campus: string | null; term: string; tags: string[]; contributor: string };
export type Pack = { id: string; courseId: string; title: string; subtitle: string | null; notes: string | null; year: number; sourceType: string; starterRank: number | null; priceCc: number; status: string; isSample: boolean; itemCount: number; contributor: string };
export type QuestionKind = 'choice' | 'judge' | 'fill' | 'subjective';
export type PublicField = { label: string; kind: string };
export type PublicQuestion = { id: string; seq: number; ref: string | null; qtype: QuestionKind; stem: string; body: string; options: string[]; fields: PublicField[]; tags: string[] };
export type PrivateField = PublicField & { answer: string; accepted: string[]; displayAnswer: string };
export type PrivateQuestion = Omit<PublicQuestion, 'fields'> & { fields: PrivateField[]; answer: string; explanation: string };
export type SeedResult = { courseIds: string[]; packIds: string[] };

export const questionSchema = z.object({
  stem: z.string().trim().min(2).max(1000), options: z.array(z.string().trim().min(1).max(300)).min(2).max(6),
  answer: z.string().regex(/^[0-5]$/), explanation: z.string().trim().min(1).max(4000),
  tags: z.array(z.string().trim().min(1).max(40)).min(1).max(5)
}).refine(q => Number(q.answer) < q.options.length && new Set(q.options).size === q.options.length, '选项需互不相同，且答案须指向有效的选项编号');
export type QuestionInput = z.infer<typeof questionSchema>;

function answerKey() {
  const key = Buffer.from(process.env.ANSWER_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('ANSWER_KEY must contain 32 base64-encoded bytes');
  return key;
}

function encrypt(id: string, value: Pick<PrivateQuestion, 'answer' | 'explanation' | 'fields'>) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', answerKey(), iv);
  cipher.setAAD(Buffer.from(id));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}

function decrypt(id: string, input: string): Pick<PrivateQuestion, 'answer' | 'explanation' | 'fields'> {
  const [iv, tag, ciphertext] = input.split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', answerKey(), iv);
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(tag);
  const parsed = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as Omit<Pick<PrivateQuestion, 'answer' | 'explanation' | 'fields'>, 'fields'> & { fields?: PrivateField[] };
  // Rows written before typed questions have no field answers in the payload.
  return { ...parsed, fields: parsed.fields ?? [] };
}

export async function listCourses(db: Queryable) {
  return (await db.query<Course & { packCount: number; resourceCount: number; sampleCount: number }>(`select c.*, count(p.id)::int as "packCount",
      count(p.id) filter (where p.is_sample)::int as "sampleCount",
      (select coalesce(sum(file_count),0)::int from course_sources s where s.course_id=c.id) as "resourceCount",
      coalesce(string_agg(distinct u.display_name,'、'),'sol') as "contributor"
    from courses c left join packs p on p.course_id=c.id and p.status='live'
    left join users u on u.id=p.author_id
    group by c.id order by (count(p.id) filter (where p.is_sample)) desc,(count(p.id)>0) desc,c.name`)).rows;
}

export async function getCourse(db: Queryable, id: string) {
  const item = (await db.query<Course>(`select ${courseFields},${contributorField} from courses where id=$1`, [uuid(id)])).rows[0];
  if (!item) fail('NOT_FOUND', '未找到这门课。');
  return item;
}

export async function getCourseBySlug(db: Queryable, slug: string) {
  if (!courseSlug.test(slug)) fail('NOT_FOUND', '未找到这门课。');
  const item = (await db.query<Course>(`select ${courseFields},${contributorField} from courses where slug=$1`, [slug])).rows[0];
  if (!item) fail('NOT_FOUND', '未找到这门课。');
  return item;
}

export async function listCourseSources(db: Queryable, courseId: string) {
  return (await db.query<{ name: string; fileCount: number; url: string }>(`select source_name as name,file_count as "fileCount",url
    from course_sources where course_id=$1 order by source_name,url`, [uuid(courseId)])).rows;
}

export async function syncCourseSources(db: Database) {
  await db.transaction(async tx => {
    for (const source of courseSourceIndex) {
      if (!source.referenceExistingCourse) {
        if (!courseSlug.test(source.title)) throw new Error(`Invalid course path for ${source.key}`);
        await tx.query(`insert into courses(id,code,name,campus,term,tags,slug) values($1,$2,$3,null,'资料归档','{}',$3)
          on conflict(id) do nothing`, [source.courseId, source.key, source.title]);
      }
      await tx.query(`insert into course_sources(source_key,course_id,source_name,url,file_count) values($1,$2,$3,$4,$5)
        on conflict(source_key) do update set course_id=excluded.course_id,source_name=excluded.source_name,url=excluded.url,file_count=excluded.file_count`,
        [source.key, source.courseId, source.sourceName, source.url, source.count]);
    }
  });
  return { entries: courseSourceIndex.length, files: courseSourceIndex.reduce((sum, source) => sum + source.count, 0) };
}

export async function searchPacks(db: Queryable, params: { courseId?: string; keyword?: string; campus?: string; year?: number; sourceType?: string } = {}) {
  const where = ["p.status='live'"];
  const args: unknown[] = [];
  function add(template: string, value: unknown) { where.push(template.replaceAll('?', `$${args.push(value)}`)); }
  if (params.courseId) add('p.course_id=?', uuid(params.courseId));
  if (params.campus) add('c.campus=?', params.campus);
  if (params.year !== undefined && Number.isInteger(params.year)) add('p.year=?', params.year);
  if (params.sourceType) add('p.source_type=?', params.sourceType);
  if (params.keyword?.trim()) add('position(lower(?) in lower(p.title || \' \' || c.name || \' \' || coalesce(u.display_name,\'sol\')))>0', params.keyword.trim().slice(0, 100));
  return (await db.query<Pack & { courseName: string }>(`select ${packFields},c.name as "courseName" from packs p join courses c on p.course_id=c.id left join users u on u.id=p.author_id where ${where.join(' and ')}
    order by p.starter_rank nulls last,p.year desc,p.title,p.id limit 100`, args)).rows;
}

export async function getPack(db: Queryable, id: string) {
  const item = (await db.query<Pack>(`select ${packFields} from packs p left join users u on u.id=p.author_id where p.id=$1 and p.status='live'`, [uuid(id)])).rows[0];
  if (!item) fail('NOT_FOUND', '未找到已上架的套卷。');
  return item;
}

// Keep the student question projection separate from the answer-bearing one.
export async function questionsForAttempt(db: Queryable, packId: string) {
  return (await db.query<PublicQuestion>('select id,seq,ref,qtype,stem,body,options,fields,tags from questions where pack_id=$1 order by seq', [packId])).rows;
}

export async function privateQuestions(db: Queryable, packId: string): Promise<PrivateQuestion[]> {
  const { rows } = await db.query<PublicQuestion & { answer_data: string }>('select id,seq,ref,qtype,stem,body,options,fields,tags,answer_data from questions where pack_id=$1 order by seq', [packId]);
  return rows.map(({ answer_data, ...question }) => ({ ...question, ...decrypt(question.id, answer_data) }));
}

export async function privateQuestionById(db: Queryable, packId: string, questionId: string): Promise<PrivateQuestion> {
  const row = (await db.query<PublicQuestion & { answer_data: string }>('select id,seq,ref,qtype,stem,body,options,fields,tags,answer_data from questions where id=$1 and pack_id=$2', [uuid(questionId), packId])).rows[0];
  if (!row) fail('NOT_FOUND', '题目不存在。');
  const { answer_data, ...question } = row;
  return { ...question, ...decrypt(question.id, answer_data) };
}

export async function insertQuestions(tx: Queryable, packId: string, items: QuestionInput[]) {
  for (const [i, data] of items.entries()) {
    const id = randomUUID();
    await tx.query('insert into questions(id,pack_id,seq,stem,options,answer_data,tags) values($1,$2,$3,$4,$5,$6,$7)',
      [id, packId, i + 1, data.stem, JSON.stringify(data.options), encrypt(id, { answer: data.answer, explanation: data.explanation, fields: [] }), data.tags]);
  }
}

// Import path for full banks (board packs with all four question kinds). The web
// upload flow stays choice-only; this is the validated escape hatch used by scripts.
export type BankFieldInput = { label: string; kind: string; answer: string; accepted?: string[]; displayAnswer?: string };
export type BankQuestionInput = {
  ref: string; qtype: QuestionKind; stem: string; body?: string; explanation: string;
  options?: string[]; answer?: string; fields?: BankFieldInput[]; tags: string[];
};

const kindNames: Record<QuestionKind, string> = { choice: '单项选择', judge: '判断题', fill: '填空题', subjective: '主观题' };

export function validateBankQuestion(input: BankQuestionInput): void {
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(input.ref)) throw new Error(`题号不合法：${input.ref}`);
  if (input.stem.trim().length < 2 || input.stem.length > 1000) throw new Error(`题干长度不合法：${input.ref}`);
  if ((input.body ?? '').length > 4000) throw new Error(`题干补充过长：${input.ref}`);
  if (!input.explanation.trim() || input.explanation.length > 4000) throw new Error(`解析缺失或过长：${input.ref}`);
  if (!input.tags.length || input.tags.some(tag => !tag.trim() || tag.length > 40) || input.tags.length > 5) throw new Error(`知识点标签不合法：${input.ref}`);
  if (input.qtype === 'choice') {
    const options = input.options ?? [];
    if (options.length < 2 || options.length > 6 || new Set(options).size !== options.length || options.some(option => !option.trim() || option.length > 300)) throw new Error(`选项不合法：${input.ref}`);
    if (!/^\d+$/.test(input.answer ?? '') || Number(input.answer) >= options.length) throw new Error(`答案不指向有效选项：${input.ref}`);
  } else if (input.qtype === 'judge') {
    if (input.answer !== '0' && input.answer !== '1') throw new Error(`判断题答案不合法：${input.ref}`);
  } else if (input.qtype === 'fill') {
    const fields = input.fields ?? [];
    if (!fields.length || fields.length > 8) throw new Error(`填空数量不合法：${input.ref}`);
    for (const field of fields) {
      if (!field.label.trim() || field.label.length > 100) throw new Error(`填空标签不合法：${input.ref}`);
      if (!['text', 'number', 'sequence', 'expression'].includes(field.kind)) throw new Error(`填空类型不合法：${input.ref}`);
      if (!field.answer.trim() || field.answer.length > 200) throw new Error(`填空答案缺失或过长：${input.ref}`);
      if ((field.accepted ?? []).length > 10 || (field.accepted ?? []).some(value => !value.trim() || value.length > 200)) throw new Error(`填空备选答案不合法：${input.ref}`);
      if ((field.displayAnswer ?? field.answer).length > 200) throw new Error(`填空展示答案过长：${input.ref}`);
    }
  }
}

export async function insertBankQuestions(tx: Queryable, packId: string, items: BankQuestionInput[]) {
  for (const [i, data] of items.entries()) {
    validateBankQuestion(data);
    const id = randomUUID();
    const options = data.qtype === 'fill' || data.qtype === 'subjective' ? [] : data.options ?? [];
    const fields = data.qtype === 'fill' ? (data.fields ?? []).map(({ label, kind }) => ({ label, kind })) : [];
    const privateFields = data.qtype === 'fill' ? (data.fields ?? []).map(({ label, kind, answer, accepted, displayAnswer }) => ({ label, kind, answer, accepted: accepted ?? [], displayAnswer: displayAnswer ?? answer })) : [];
    await tx.query('insert into questions(id,pack_id,seq,ref,qtype,stem,body,options,fields,answer_data,tags) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, packId, i + 1, data.ref, data.qtype, data.stem, data.body ?? '', JSON.stringify(options), JSON.stringify(fields),
        encrypt(id, { answer: data.qtype === 'fill' || data.qtype === 'subjective' ? '' : data.answer ?? '', explanation: data.explanation, fields: privateFields }), data.tags]);
  }
}

const demoCourses = [
  { code: 'CS201', name: '数据结构', campus: 'tongzhou', tags: ['线性结构', '树', '复杂度'] },
  { code: 'MA102', name: '概率论与数理统计', campus: 'zhongguancun', tags: ['古典概率', '条件概率', '期望'] },
  { code: 'ST101', name: '应用统计学', campus: 'suzhou', tags: ['描述统计', '抽样', '推断'] }
];
const courseIdFor = (i: number) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
const packIdFor = (i: number, j: number) => `20000000-0000-4000-8000-${String(i * 10 + j + 1).padStart(12, '0')}`;

function demoQuestions(course: number, pack: number): QuestionInput[] {
  const n = pack + 3;
  const tag = demoCourses[course].tags;
  const item = (stem: string, options: string[], answer: string, explanation: string, key: number) => ({ stem, options, answer, explanation, tags: [tag[key]] });
  if (course === 0) return [
    item(`容量为 ${n} 的栈中，依次压入 A、B、C 后，第一次出栈的元素是？`, ['A', 'C', 'B', '无法确定'], '1', '栈遵循后进先出。C 最后入栈，因此最先弹出。', 0),
    item(`一棵含 ${n} 个结点的非空树有几条边？`, [`${n}`, `${n + 1}`, `${n - 1}`, '0'], '2', '每个非根结点恰有一条连接父结点的边，因此总边数为结点数减一。', 1),
    item(`若遍历恰访问每个元素 ${n} 次，元素总数为 m，时间复杂度是？`, ['O(m)', 'O(log m)', 'O(m²)', 'O(1)'], '0', '固定次数属于常数因子，访问次数随元素数量线性增长。', 2)
  ];
  if (course === 1) return [
    item(`从标号 1 至 ${n} 的纸条中等概率抽取一张，抽到 1 的概率是？`, [`1/${n - 1}`, `1/${n}`, `1/${n + 1}`, '1'], '1', '有且仅有一个有利的等可能结果。', 0),
    item('若 A 和 B 独立，且 P(B)>0，P(A|B) 等于？', ['P(B)', '1', 'P(A)', '0'], '2', '用 P(A∩B)=P(A)P(B) 代入条件概率。', 1),
    item(`随机变量恒等于 ${n}，其期望为？`, [`${n}`, '0', `${n + 1}`, '无法确定'], '0', '常数变量的期望等于该常数。', 2)
  ];
  return [
    item(`数列 ${n}、${n + 1}、${n + 2} 的中位数是？`, [`${n}`, `${n + 1}`, `${n + 2}`, '0'], '1', '排序后奇数个数列的中间位置是中位数。', 0),
    item('简单随机不放回抽样，每个同样大小的样本组合应当如何？', ['按名字排序', '机会相同', '总是包含首项', '永不重叠'], '1', '简单随机抽样让所有大小相同的样本组合等可能。', 1),
    item(`若原数据标准差为 ${n}，每项增加同一常数，标准差为？`, ['0', `${n + 1}`, `${n}`, `${n * 2}`], '2', '平移不改变数据与均值的差，因此标准差不变。', 2)
  ];
}

export async function seed(db: Database): Promise<SeedResult> {
  const courseIds = demoCourses.map((_, i) => courseIdFor(i));
  const packIds: string[] = [];
  await db.transaction(async tx => {
    for (const [i, course] of demoCourses.entries()) {
      const id = courseIds[i];
      await tx.query("insert into courses(id,code,name,campus,term,tags,slug) values($1,$2,$3,$4,'演示学期',$5,$3) on conflict(id) do nothing", [id, course.code, course.name, course.campus, course.tags]);
      for (const [j, title] of ['基础练习 A', '基础练习 B', '基础练习 C', '综合模拟 A', '综合模拟 B'].entries()) {
        const packId = packIdFor(i, j);
        packIds.push(packId);
        const questions = demoQuestions(i, j);
        const result = await tx.query(`insert into packs(id,course_id,title,year,source_type,license_note,starter_rank,status,item_count)
          values($1,$2,$3,2026,'mock','ExamHub 合成演示题，不是学校真题。',$4,'live',$5) on conflict(id) do nothing returning id`,
          [packId, id, `${course.name} · ${title}`, j < 3 ? j + 1 : null, questions.length]);
        if (result.rows.length) await insertQuestions(tx, packId, questions);
      }
    }
  });
  return { courseIds, packIds };
}

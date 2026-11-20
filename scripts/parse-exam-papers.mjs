import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(process.cwd(), '.work');
const TEXT = path.join(ROOT, 'text');
const index = JSON.parse(readFileSync(path.join(ROOT, 'index.json'), 'utf8'));

const SECTION = /^\s*(?:[一二三四五六七八九十]\s*[、.．]|（[一二三四五六七八九十]）)\s*(.{0,14})$/;
const SECTION_WORD = /^\s*(选择题|判断题|填空题|简答题|计算题|综合题|论述题|编程题|阅读程序|程序填空)/;
const QSTART = /^\s*(\d{1,2})\s*[.．、]\s*(?=\S)/;
const OPTION = /(?:^|[\s\u3000])([A-F])\s*[.．、)）]\s*/g;
const OPTION_PAREN = /(?:^|[\s\u3000])[（(]\s*([A-F])\s*[)）]\s*/g;
const KEY_RANGE = /^\s*(\d{1,2})\s*[-—~至]\s*(\d{1,2})\s*[.．、:：]?\s*((?:[A-F]\s*){3,})\s*$/;
const KEY_PAIR = /(\d{1,2})\s*[.．、:：]\s*([A-F])(?![A-Za-z])/g;
const BLANK = /[（(]\s*([A-F√×✓✗对错是否]{1,2})\s*[)）]/;

const clean = text => text.replace(/\u00a0/g, ' ').replace(/[ \t]{2,}/g, ' ').replace(/[\u3000]+/g, ' ').trim();

function keys(lines) {
  const map = new Map();
  for (const line of lines) {
    const range = line.match(KEY_RANGE);
    if (range) {
      const from = Number(range[1]);
      range[3].trim().split(/\s+/).forEach((letter, i) => map.set(from + i, letter.toUpperCase()));
      continue;
    }
    if (/答案/.test(line) && line.length < 160) {
      let m;
      KEY_PAIR.lastIndex = 0;
      while ((m = KEY_PAIR.exec(line))) map.set(Number(m[1]), m[2]);
    }
  }
  return map;
}

function splitOptions(text) {
  for (const pattern of [OPTION, OPTION_PAREN]) {
    const marks = [];
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text))) marks.push({ letter: m[1], start: m.index + (m[0].startsWith(' ') ? 1 : 0), body: m.index + m[0].length });
    if (marks.length < 2) continue;
    if (marks.map(x => x.letter).join('') !== 'ABCDEF'.slice(0, marks.length)) continue;
    const options = marks.map((mark, i) => clean(text.slice(mark.body, i + 1 < marks.length ? marks[i + 1].start : text.length)));
    if (options.every(Boolean)) return options;
  }
  return null;
}

function parse(text) {
  const lines = text.split('\n').map(clean);
  const key = keys(lines);
  const out = [];
  const rejected = [];
  let section = '';
  let current = null;

  const flush = () => {
    if (!current) return;
    const stemRaw = clean(current.stem.join(' '));
    const options = splitOptions(current.optionText.join(' '));
    const blank = stemRaw.match(BLANK);
    const judge = /判断/.test(current.section) || (blank && /[√×✓✗对错是否]/.test(blank[1]));
    let finalOptions = options;
    let answer = -1;
    if (judge) {
      finalOptions = ['正确', '错误'];
      if (blank && /[√✓对是]/.test(blank[1])) answer = 0;
      else if (blank && /[×✗错否]/.test(blank[1])) answer = 1;
    } else {
      if (blank && /^[A-F]$/.test(blank[1])) answer = blank[1].charCodeAt(0) - 65;
      else if (key.has(current.number)) answer = key.get(current.number).charCodeAt(0) - 65;
    }
    const stem = stemRaw.replace(BLANK, '（　）').replace(/\s{2,}/g, ' ').trim();
    const seq = current.number;
    if (!finalOptions) return rejected.push({ seq, why: '选项无法切分', sample: stem.slice(0, 36) });
    if (stem.length < 8 || stem.length > 1000) return rejected.push({ seq, why: '题干长度异常', sample: stem.slice(0, 36) });
    if (finalOptions.length < 2 || finalOptions.length > 6) return rejected.push({ seq, why: '选项数量异常', sample: stem.slice(0, 36) });
    if (new Set(finalOptions).size !== finalOptions.length) return rejected.push({ seq, why: '选项重复', sample: stem.slice(0, 36) });
    if (finalOptions.some(o => !o || o.length > 300)) return rejected.push({ seq, why: '选项长度异常', sample: stem.slice(0, 36) });
    if (answer < 0 || answer >= finalOptions.length) return out.push({ number: seq, stem, options: finalOptions, answer: -1, judge: Boolean(judge), pending: true });
    out.push({ number: seq, stem, options: finalOptions, answer, judge: Boolean(judge) });
    current = null;
  };

  for (const line of lines) {
    if (SECTION_WORD.test(line)) { flush(); section = line.slice(0, 6); continue; }
    const sec = line.match(SECTION);
    if (sec && /选择|判断|填空|简答|计算|综合|论述|编程|阅读|程序/.test(sec[1] || '')) { flush(); section = sec[1]; continue; }
    const start = line.match(QSTART);
    if (start && !/^\s*[A-F]\s*[.．、)）]/.test(line)) {
      flush();
      current = { number: Number(start[1]), stem: [line.slice(start[0].length)], optionText: [], section };
      continue;
    }
    if (!current) continue;
    const looksOption = /^\s*[（(]?[A-F]\s*[.．、)）]/.test(line) || /[\s\u3000][B-F]\s*[.．、)）]/.test(line);
    if (looksOption) current.optionText.push(line);
    else if (current.optionText.length) current.optionText.push(line);
    else current.stem.push(line);
  }
  flush();

  const seen = new Set();
  const unique = [];
  for (const q of out) {
    const k = q.stem.replace(/\s+/g, '').toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(q);
  }
  return { questions: unique, rejected };
}

const rows = [];
for (const item of index) {
  if (!item.course) continue;
  let text = '';
  try { text = readFileSync(path.join(TEXT, `${item.key}.txt`), 'utf8'); } catch { continue; }
  const { questions, rejected } = parse(text);
  rows.push({
    key: item.key, id: item.id, course: item.course, title: item.title, ext: item.ext, term: item.term, category: item.category,
    found: questions.length, four: questions.filter(q => q.options.length === 4).length,
    judge: questions.filter(q => q.judge).length, rejected: rejected.length, questions
  });
}
rows.sort((a, b) => b.found - a.found);
writeFileSync(path.join(ROOT, 'parsed.json'), JSON.stringify(rows, null, 1));
const total = rows.reduce((s, r) => s + r.found, 0);
console.log(`files=${rows.length} withQ=${rows.filter(r => r.found).length} questions=${total}`);
for (const r of rows) if (r.found) console.log(`${String(r.found).padStart(3)}q ${String(r.judge).padStart(2)}j ${r.ext.padEnd(5)} ${r.course.slice(0, 9).padEnd(10)} | ${r.title}`);

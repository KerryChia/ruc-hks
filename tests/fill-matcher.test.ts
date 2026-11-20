import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeFill, matchesField, normalizeAnswer } from '../src/domains/fill-matcher';

const field = (overrides: Partial<Parameters<typeof matchesField>[1]> = {}) => ({
  label: '答案', kind: 'text', answer: 'O(log n)', accepted: ['O(logn)', 'log n'], displayAnswer: 'O(log n)', ...overrides,
});

test('text blanks compare normalized input against answer and accepted alternatives', () => {
  assert.equal(matchesField('O(log n)', field()), true);
  assert.equal(matchesField('O（log n）', field()), true);   // 全角括号经 NFKC 归一
  assert.equal(matchesField('o(LOG  n)', field()), true);    // 大小写与空格忽略
  assert.equal(matchesField('O(logn)', field()), true);      // accepted 备选
  assert.equal(matchesField('O(log n)；', field()), true);   // 尾部标点剥离
  assert.equal(matchesField('O(n)', field()), false);
  assert.equal(matchesField('', field()), false);
  assert.equal(matchesField('   ', field()), false);
});

test('number blanks require a finite decimal and exact numeric equality', () => {
  const number = field({ kind: 'number', answer: '127', accepted: [] });
  assert.equal(matchesField('127', number), true);
  assert.equal(matchesField('+127.0', number), true);
  assert.equal(matchesField('1.27e2', number), true);
  assert.equal(matchesField('−127', field({ kind: 'number', answer: '-127', accepted: [] })), true); // Unicode 减号
  assert.equal(matchesField('abc', number), false);
  assert.equal(matchesField('1.2.7', number), false);  // 非十进制数字
  assert.equal(matchesField('128', number), false);
});

test('sequence blanks compare ordered integers and ignore brackets and separators', () => {
  const sequence = field({ kind: 'sequence', answer: '1,2,3,4,6,5', accepted: [] });
  assert.equal(matchesField('[1,2,3,4,6,5]', sequence), true);
  assert.equal(matchesField('1，2、3 4；6，5', sequence), true);
  assert.equal(matchesField('1 2 3 4 6 5', sequence), true);
  assert.equal(matchesField('1,2,3,4,5,6', sequence), false);  // 顺序不同
  assert.equal(matchesField('1,2,3,4,6', sequence), false);    // 个数不同
  assert.equal(matchesField('a,b,c', sequence), false);
});

test('gradeFill returns one boolean per blank and is correct only when all blanks pass', () => {
  const fields = [field(), field({ kind: 'number', answer: '127', accepted: [] })];
  assert.deepEqual(gradeFill(fields, ['O（log n）', '127']), [true, true]);
  assert.deepEqual(gradeFill(fields, ['O(logn)', '128']), [true, false]);
  assert.deepEqual(gradeFill(fields, []), [false, false]);
  assert.deepEqual(gradeFill(fields, ['O(log n)', undefined]), [true, false]);
});

test('normalization covers NFKC, case, dash, multiplication and division signs', () => {
  assert.equal(normalizeAnswer('Ｏ（ｌｏｇ ｎ）'), 'o(logn)');
  assert.equal(normalizeAnswer('3×4÷2'), '3*4/2');
  assert.equal(normalizeAnswer('−1–2—3'), '-1-2-3');
  assert.equal(normalizeAnswer('P(A)。'), 'p(a)');
});

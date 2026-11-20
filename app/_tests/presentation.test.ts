import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drillQuestions, readScopes, sessionCookie } from '../_lib/presentation';

test('drill projection serializes only the public surface: no answers, accepted alternatives or explanations', () => {
  const source = [{
    id: 'q', seq: 1, ref: 'A101', qtype: 'fill' as const, stem: '题干', body: '',
    options: [], tags: ['复杂度'],
    answer: 'O(log n)', explanation: '解析',
    fields: [{ label: '复杂度', kind: 'text', answer: 'O(log n)', accepted: ['O(logn)'], displayAnswer: 'O(log n)' }],
  }];
  assert.deepEqual(drillQuestions(source), [{
    id: 'q', seq: 1, ref: 'A101', qtype: 'fill', stem: '题干', body: '',
    options: [], tags: ['复杂度'], fields: [{ label: '复杂度', kind: 'text' }],
  }]);
});

test('drill projection copies arrays so later mutation cannot leak into the source rows', () => {
  const source = [{
    id: 'q', seq: 2, ref: null, qtype: 'choice' as const, stem: '题干', body: '',
    options: ['甲', '乙'], tags: ['标签'], answer: '0', explanation: '解析', fields: [],
  }];
  const projected = drillQuestions(source);
  projected[0].options.push('丙');
  projected[0].tags.push('改');
  projected[0].fields.push({ label: '改', kind: 'text' });
  assert.equal(source[0].options.length, 2);
  assert.equal(source[0].tags.length, 1);
  assert.equal(source[0].fields.length, 0);
});

test('BYO token scopes are allowlisted and never include AI spending', () => {
  assert.deepEqual(readScopes(['profile:read', 'ai:use', 'admin', 'profile:read']), ['profile:read']);
  assert.deepEqual(readScopes(['ai:use']), []);
  assert.deepEqual(readScopes([]), []);
});

test('session cookie is private and transport security is opt-in for local HTTP', () => {
  assert.deepEqual(sessionCookie('1'), { httpOnly: true, sameSite: 'lax', secure: true, path: '/' });
  assert.equal(sessionCookie(undefined).secure, false);
});

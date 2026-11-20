import assert from 'node:assert/strict';
import { test } from 'node:test';
import { campusEmailFrom, requireTermsAgreement } from '../_lib/validation';

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

test('campus email is composed from a student id and always uses the ruc domain', () => {
  assert.equal(campusEmailFrom(form({ studentId: '20230001' })), '20230001@ruc.edu.cn');
  assert.equal(campusEmailFrom(form({ studentId: 'student.name-01' })), 'student.name-01@ruc.edu.cn');
  assert.equal(campusEmailFrom(form({ studentId: '20230001@RUC.EDU.CN' })), '20230001@ruc.edu.cn');
});

test('non-ruc domain and invalid student ids are rejected by the server', () => {
  assert.throws(() => campusEmailFrom(form({ studentId: 'someone@example.com' })), error => error instanceof Error && 'code' in error && error.code === 'EMAIL_DOMAIN_NOT_ALLOWED');
  assert.throws(() => campusEmailFrom(form({ studentId: 'a@ruc.edu.cn' })), error => error instanceof Error && 'code' in error && error.code === 'EMAIL_DOMAIN_NOT_ALLOWED');
  assert.throws(() => campusEmailFrom(form({ studentId: '学号' })), error => error instanceof Error && 'code' in error && error.code === 'EMAIL_DOMAIN_NOT_ALLOWED');
});

test('registration requires explicit agreement to the terms and privacy policy', () => {
  assert.throws(() => requireTermsAgreement(form({})), error => error instanceof Error && 'code' in error && error.code === 'TERMS_NOT_ACCEPTED');
  assert.throws(() => requireTermsAgreement(form({ agreement: 'no' })), error => error instanceof Error && 'code' in error && error.code === 'TERMS_NOT_ACCEPTED');
  assert.doesNotThrow(() => requireTermsAgreement(form({ agreement: 'agree' })));
});

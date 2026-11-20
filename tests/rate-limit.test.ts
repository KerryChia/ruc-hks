import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRateLimit, rateLimitHeaders } from '../src/rate-limit';

function requestFrom(ip: string) {
  return new Request('https://examhub.kerrychia.site/api/search', { headers: { 'x-forwarded-for': ip } });
}

test('rate limits are enforced per client IP and expose retry metadata', () => {
  const ip = '203.0.113.41';
  assert.equal(checkRateLimit(requestFrom(ip), 'test-search', 2, 10_000).allowed, true);
  assert.equal(checkRateLimit(requestFrom(ip), 'test-search', 2, 10_000).allowed, true);
  const limited = checkRateLimit(requestFrom(ip), 'test-search', 2, 10_000);
  assert.equal(limited.allowed, false);
  assert.equal(limited.remaining, 0);
  assert.ok(limited.retryAfter >= 1);
  assert.equal(rateLimitHeaders(limited)['X-RateLimit-Limit'], '2');
});

test('different scopes and different IPs do not share a bucket', () => {
  assert.equal(checkRateLimit(requestFrom('203.0.113.42'), 'test-one', 1, 10_000).allowed, true);
  assert.equal(checkRateLimit(requestFrom('203.0.113.42'), 'test-two', 1, 10_000).allowed, true);
  assert.equal(checkRateLimit(requestFrom('203.0.113.43'), 'test-one', 1, 10_000).allowed, true);
});

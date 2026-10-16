import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_URL, issueUrl, locationLine, stripPaths, uaSummary } from '../src/platform/bugreport-url.ts';

const fields = { version: '0.1.0 (abc1234)', mode: 'hosted folder', browser: 'Chrome 141 / Windows', location: 'map m1, story step 12', manifest: 'format 1', errors: '- TypeError: x' };

test('issue URL uses the template and the field ids', () => {
  const u = new URL(issueUrl(fields, 'owner/repo'));
  assert.equal(u.origin + u.pathname, 'https://github.com/owner/repo/issues/new');
  assert.equal(u.searchParams.get('template'), 'bug_report.yml');
  for (const k of ['version', 'mode', 'browser', 'location', 'manifest', 'errors']) assert.ok(u.searchParams.get(k));
  assert.equal(u.searchParams.get('save'), null);
});

test('long fields are trimmed under the URL limit', () => {
  const big = { ...fields, errors: 'e'.repeat(20000), save: 's'.repeat(20000) };
  assert.ok(issueUrl(big, 'owner/repo').length <= MAX_URL);
});

test('paths and emails are stripped', () => {
  const s = stripPaths('at C:\\Users\\bob\\x\\main.ts:1 http://localhost:5180/src/a.ts mail bob@example.com /home/bob/y/z.js'); // scan:allow
  assert.ok(!/bob/.test(s), s);
  assert.match(s, /main\.ts/);
});

test('UA summary and location', () => {
  assert.equal(uaSummary('Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/141.0 Safari/537 Edg/141.0'), 'Edge 141 / Windows');
  assert.equal(locationLine({ battle: 5, wave: 0 }), 'battle 5 wave 1');
  assert.equal(locationLine({}), 'title screen');
});

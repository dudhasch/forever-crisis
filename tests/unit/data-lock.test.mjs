// The data pack (extractor recipe + text templates) is hosted outside the repository and pinned here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const lock = JSON.parse(readFileSync(new URL('../../extractor/data.lock.json', import.meta.url), 'utf8'));

test('data.lock.json pins one immutable pack', () => {
  assert.match(lock.sha256, /^[0-9a-f]{64}$/);
  assert.equal(lock.file, `ffcx-data-${lock.catalogRevision}-${lock.sha256.slice(0, 12)}.zip`);
  assert.ok(Number.isInteger(lock.size) && lock.size > 0);
  assert.ok(lock.base === '' || /^https:\/\/[^/]+\/[\w-]+$/.test(lock.base), 'base is an https container URL or empty');
});
